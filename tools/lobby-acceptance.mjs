// Lobby acceptance (B4) — the Phase B proof loop against a DEPLOYED lobby +
// match server pair: two fresh accounts complete challenge → accept → both
// hold controller tokens on the SAME authoritative match and a third
// connection spectates. Requires FOBAL_DEV_AUTH=1 on the lobby (staging's
// temporary login transport).
//
//   npx tsx tools/lobby-acceptance.mjs \
//     --lobby https://lobby-staging.fobal.ai \
//     --match-ws wss://matches-staging.fobal.ai
//
// Once staging retires dev auth (SES slice), pass the server-held test key
// so the script can read codes: --test-key <value of the
// fobal/staging/lobby-server/test-login-key secret>.
//
// Add --full (LAST on the command line) to also wait for full time
// (~4 minutes) and verify B5: history with mirrored outcomes, automatic
// player freeing, and rematch. Local smoke:
//   npx tsx tools/lobby-acceptance.mjs --lobby http://localhost:8485 --match-ws ws://localhost:8483
import WebSocket from 'ws';

function parseArgs(argv){
  const out = {};
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const lobby = (args.lobby ?? 'http://localhost:8485').replace(/\/+$/, '');
const matchWs = (args['match-ws'] ?? 'ws://localhost:8483').replace(/\/+$/, '');
const full = 'full' in args;
const testKey = args['test-key'];

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  ok ? passed++ : failed++;
};

const post = async (path, body, token) => {
  const res = await fetch(`${lobby}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      // the test key rides every auth request; servers without one ignore it
      ...(testKey ? { 'x-fobal-test-key': testKey } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const getState = async (token) => {
  const res = await fetch(`${lobby}/lobby`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

async function login(email){
  const req = await post('/auth/request', { email });
  if (req.status !== 200 || !req.body.devCode)
    throw new Error(`code not revealed (${req.status}) — pass --test-key on SES-auth servers: ${JSON.stringify(req.body)}`);
  const ver = await post('/auth/verify', { email, code: req.body.devCode });
  if (ver.status !== 200) throw new Error(`verify failed (${ver.status})`);
  return { token: ver.body.token, accountId: ver.body.account.accountId };
}

/** hello over WS; resolves with the first message (welcome or error) */
function wsHello(matchId, token){
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(matchWs);
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('ws timeout')); }, 15_000);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', matchId, token })));
    socket.on('message', raw => {
      clearTimeout(timer);
      resolve({ message: JSON.parse(String(raw)), close: () => socket.close() });
    });
    socket.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

// ---- run -------------------------------------------------------------------
const stamp = Date.now().toString(36);
const health = await fetch(`${lobby}/health`).then(r => r.json()).catch(() => null);
check('lobby /health answers', health?.ok === true, JSON.stringify(health));

const a = await login(`acceptance-a-${stamp}@fobal.ai`);
const b = await login(`acceptance-b-${stamp}@fobal.ai`);
check('two fresh accounts log in', !!a.token && !!b.token);

const roster = await getState(a.token);
check('roster shows the opponent online',
  roster.body.players?.some(p => p.accountId === b.accountId && p.online) === true);

const challenged = await post('/challenges', { to: b.accountId }, a.token);
check('challenge created', challenged.status === 201, `status ${challenged.status}`);

const accepted = await post(`/challenges/${challenged.body.challenge?.id}/accept`, {}, b.token);
check('challenge accepted → match created', accepted.status === 201,
  `status ${accepted.status}: ${JSON.stringify(accepted.body).slice(0, 120)}`);

const [aState, bState] = [await getState(a.token), await getState(b.token)];
const am = aState.body.match, bm = bState.body.match;
check('both players hold join info for the SAME match',
  !!am && !!bm && am.matchId === bm.matchId && am.teamId !== bm.teamId && am.token !== bm.token,
  am?.matchId ?? 'missing');

// the key VALUE is secret (unknowable here) — assert the FIELD never appears
const leaked = JSON.stringify([roster.body, challenged.body, accepted.body, aState.body, bState.body]);
check('no create-key field in any client payload', !/"create[_-]?key"/i.test(leaked));

if (am && bm){
  const wa = await wsHello(am.matchId, am.token);
  check('player A hello → controller welcome on their team',
    wa.message.type === 'welcome' && wa.message.role === 'controller' && wa.message.teamId === am.teamId,
    `${wa.message.type}/${wa.message.role ?? wa.message.code}`);
  const wb = await wsHello(bm.matchId, bm.token);
  check('player B hello → controller welcome on the other team',
    wb.message.type === 'welcome' && wb.message.role === 'controller' && wb.message.teamId === bm.teamId,
    `${wb.message.type}/${wb.message.role ?? wb.message.code}`);
  const ws3 = await wsHello(am.matchId, am.spectatorToken);
  check('third connection spectates via the shared token',
    ws3.message.type === 'welcome' && ws3.message.role === 'spectator',
    `${ws3.message.type}/${ws3.message.role ?? ws3.message.code}`);
  wa.close(); wb.close(); ws3.close();

  if (!full){
    await post(`/matches/${am.matchId}/leave`, {}, a.token);
    await post(`/matches/${bm.matchId}/leave`, {}, b.token);
    const after = await getState(a.token);
    check('leave frees the players', after.body.match === null);
  } else {
    // B5 — ride the match to full time and verify the lifecycle
    console.log('\n--full: waiting for full time (~4 minutes real time)…');
    const history = async (token) => {
      const res = await fetch(`${lobby}/history`, { headers: { authorization: `Bearer ${token}` } });
      return (await res.json()).matches ?? [];
    };
    let entry = null;
    const deadline = Date.now() + 6.5 * 60_000;
    while (Date.now() < deadline){
      await new Promise(r => setTimeout(r, 15_000));
      entry = (await history(a.token)).find(m => m.matchId === am.matchId);
      if (entry?.outcome) break;
    }
    check('history reports the finished match with an outcome', !!entry?.outcome,
      entry ? `${entry.outcome} ${JSON.stringify(entry.score)}` : 'never finished');
    if (entry?.outcome){
      const entryB = (await history(b.token)).find(m => m.matchId === bm.matchId);
      const flip = { W: 'L', L: 'W', D: 'D' };
      check('both players see mirrored outcomes and scores',
        !!entryB && entryB.outcome === flip[entry.outcome]
          && JSON.stringify(entryB.score) === JSON.stringify([entry.score[1], entry.score[0]]),
        entryB ? `${entry.outcome}${JSON.stringify(entry.score)} vs ${entryB.outcome}${JSON.stringify(entryB.score)}` : 'B has no entry');
      const freed = await getState(a.token);
      check('full time auto-frees the players (no LEAVE needed)', freed.body.match === null);
      const rematch = await post('/challenges', { to: b.accountId, rematchOf: am.matchId }, a.token);
      check('rematch challenge accepted', rematch.status === 201, `status ${rematch.status}`);
      if (rematch.status === 201)
        await post(`/challenges/${rematch.body.challenge.id}/decline`, {}, a.token);
    }
  }
}

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed ? 1 : 0);
