// Scripted acceptance run for the server-facing sections of
// docs/STAGING_ACCEPTANCE_TEST.md (runtime health, match API, determinism
// and replay). AWS-side checks (IAM, S3 layout, alarms, cost) stay with the
// infra operator. Run with tsx (workspace packages are TypeScript):
//
//   FOBAL_CREATE_KEY=... npx tsx tools/staging-acceptance.mjs --server https://matches-staging.fobal.ai
//
// Options:
//   --server  base URL (default http://localhost:8473)
//   --key     create key (default: FOBAL_CREATE_KEY env)
//   --fast    skip the full-time wait and everything after it (pre-full-time
//             checks only; a full run takes ~5 minutes because the created
//             match plays out in real time)
//
// Exits 0 only if every check passes. The created match stays on the server
// (and in the S3 mirror) — its spectator token is printed so a human can
// watch the acceptance match live.
import { MatchEngine } from '@fobal/engine';
import { ReplayFile } from '@fobal/protocol';
import { sampleManifest } from '@fobal/protocol/samples';
import { verifyResult } from '@fobal/match-server';
import WebSocket from 'ws';

function parseArgs(argv){
  const out = {};
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a === '--fast') out.fast = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const server = (args.server ?? 'http://localhost:8473').replace(/\/+$/, '');
const wsBase = server.replace(/^http/, 'ws');
const key = args.key ?? process.env.FOBAL_CREATE_KEY;
if (!key){
  console.error('missing create key: set FOBAL_CREATE_KEY or pass --key');
  process.exit(1);
}

let passed = 0, failed = 0;
const section = (title) => console.log(`\n${title}`);
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
async function check(name, fn){
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}${typeof detail === 'string' && detail ? ` — ${detail}` : ''}`);
    passed++;
  } catch (err){
    console.log(`  ✗ ${name} — ${err.message}`);
    failed++;
  }
}

/** WebSocket wrapper: parsed-message queue + predicate waits. */
class Sock {
  constructor(ws){
    this.ws = ws;
    this.messages = [];
    this.waiters = [];
    this.isClosed = false;
    this.closed = new Promise(res => ws.on('close', () => { this.isClosed = true; res(); }));
    ws.on('message', raw => {
      try { this.messages.push(JSON.parse(raw.toString())); } catch { /* not JSON */ }
      for (const w of this.waiters.splice(0)) w();
    });
    ws.on('error', () => {});
  }
  static open(){
    return new Promise((res, rej) => {
      const ws = new WebSocket(wsBase);
      ws.on('open', () => res(new Sock(ws)));
      ws.on('error', rej);
    });
  }
  send(obj){ this.ws.send(JSON.stringify(obj)); }
  async next(pred, timeoutMs = 8000){
    const deadline = Date.now() + timeoutMs;
    for (;;){
      const hit = this.messages.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline)
        throw new Error(`timeout; got: ${this.messages.map(m => m.type).join(',') || 'nothing'}`);
      await new Promise(res => {
        this.waiters.push(res);
        setTimeout(res, Math.min(250, Math.max(1, deadline - Date.now())));
      });
    }
  }
  close(){ try { this.ws.close(); } catch { /* already closed */ } }
}

const auth = (token) => ({ authorization: `Bearer ${token}` });
const sleep = (ms) => new Promise(res => setTimeout(res, ms));

/** fetch with retries: the server's state is what's under test, not the
 *  runner's network — a transient DNS/connection failure during a long run
 *  must not fail a check. Each attempt is individually bounded, and the
 *  final error carries the underlying cause so a flake diagnoses itself. */
async function fetchRetry(url, init = {}, attempts = 6){
  let lastErr;
  for (let i = 1; i <= attempts; i++){
    try { return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }); }
    catch (err){ lastErr = err; if (i < attempts) await sleep(Math.min(1000 * i, 5000)); }
  }
  const cause = lastErr?.cause?.code ?? lastErr?.cause?.message;
  throw new Error(`${lastErr?.message ?? 'fetch failed'}${cause ? ` (${cause})` : ''} after ${attempts} attempts`);
}

const matchId = `acc-${Date.now()}`;
const manifest = sampleManifest({ matchId, seed: Math.floor(Math.random() * 2 ** 31), createdAt: new Date().toISOString() });
const teamIds = manifest.teams.map(t => t.teamId);
let tokens = null;      // { matchId, tokens: {teamId: token}, spectatorToken }

console.log(`FOBAL acceptance run against ${server}`);
console.log(`matchId: ${matchId}${args.fast ? '  (--fast: pre-full-time checks only)' : ''}`);

// ---- runtime health --------------------------------------------------------
section('runtime health');
await check('GET /health returns 200 ok', async () => {
  const res = await fetchRetry(`${server}/health`);
  assert(res.status === 200, `status ${res.status}`);
  const body = await res.json();
  assert(body.ok === true, 'ok !== true');
  return `activeRooms=${body.activeRooms}`;
});

// ---- match API -------------------------------------------------------------
section('match API');
await check('POST /matches without create key returns 401', async () => {
  const res = await fetchRetry(`${server}/matches`, { method: 'POST', body: JSON.stringify(manifest) });
  assert(res.status === 401, `status ${res.status}`);
});
await check('POST /matches with invalid JSON returns 400', async () => {
  const res = await fetchRetry(`${server}/matches`, { method: 'POST', headers: auth(key), body: '{nope' });
  assert(res.status === 400, `status ${res.status}`);
});
await check('POST /matches with valid manifest returns 201 + tokens', async () => {
  const res = await fetchRetry(`${server}/matches`, {
    method: 'POST', headers: { ...auth(key), 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert(res.status === 201, `status ${res.status}`);
  tokens = await res.json();
  assert(tokens.matchId === matchId, 'matchId mismatch');
  for (const teamId of teamIds) assert(tokens.tokens[teamId], `missing token for ${teamId}`);
  assert(tokens.spectatorToken, 'missing spectatorToken');
});
await check('duplicate matchId returns a client error, no second room', async () => {
  const res = await fetchRetry(`${server}/matches`, {
    method: 'POST', headers: { ...auth(key), 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert(res.status === 400, `status ${res.status}`);
  const body = await res.json();
  assert(String(body.error ?? '').includes('already exists'), `error: ${body.error}`);
});
await check('GET result without token returns 401', async () => {
  const res = await fetchRetry(`${server}/matches/${matchId}/result`);
  assert(res.status === 401, `status ${res.status}`);
});
await check('GET result before full time returns 404', async () => {
  const res = await fetchRetry(`${server}/matches/${matchId}/result`, { headers: auth(tokens.spectatorToken) });
  assert(res.status === 404, `status ${res.status}`);
});

// ---- websocket -------------------------------------------------------------
section('websocket');
await check('hello with invalid token is rejected and closed', async () => {
  const sock = await Sock.open();
  sock.send({ type: 'hello', matchId, token: 'not-a-token' });
  const err = await sock.next(m => m.type === 'error');
  assert(err.code === 'unauthorized', `code ${err.code}`);
  await Promise.race([sock.closed, sleep(5000)]);
  assert(sock.isClosed, 'socket not closed after rejection');
});
await check('socket without hello is terminated (hello timeout)', async () => {
  const sock = await Sock.open();
  await Promise.race([sock.closed, sleep(15_000)]);
  assert(sock.isClosed, 'silent socket still open after 15s');
});

const spectator = await Sock.open();
let welcome = null;
await check('spectator hello receives welcome + live stream', async () => {
  spectator.send({ type: 'hello', matchId, token: tokens.spectatorToken });
  welcome = await sock_next_welcome(spectator);
  assert(welcome.matchId === matchId && welcome.role === 'spectator', 'bad welcome');
  assert(welcome.snapshot && welcome.manifest, 'welcome missing snapshot/manifest');
  const live = await spectator.next(m => m.type === 'delta' || m.type === 'snapshot', 10_000);
  return `first ${live.type} at tick ${live.delta?.tick ?? live.snapshot?.tick}`;
});
function sock_next_welcome(sock){ return sock.next(m => m.type === 'welcome', 10_000); }

const controller = await Sock.open();
await check('controller command with the wrong team token is rejected', async () => {
  controller.send({ type: 'hello', matchId, token: tokens.tokens[teamIds[0]] });
  await sock_next_welcome(controller);
  controller.send({ type: 'command', command: {
    kind: 'tactical', commandId: 'acc-wrong-team', teamId: teamIds[1],
    payload: { type: 'patch', patch: { pressing: 0.5 } },
  } });
  const rej = await controller.next(m => m.type === 'command_rejected' && m.commandId === 'acc-wrong-team');
  assert(rej.code === 'unauthorized', `code ${rej.code}`);
});
await check('controller command with the right token is acked', async () => {
  controller.send({ type: 'command', command: {
    kind: 'tactical', commandId: 'acc-ok', teamId: teamIds[0],
    payload: { type: 'patch', patch: { pressing: 0.7 } },
  } });
  const ack = await controller.next(m => m.type === 'command_ack' && m.commandId === 'acc-ok');
  return `seq ${ack.seq}, effectiveTick ${ack.effectiveTick}`;
});
await check('malformed command is rejected and the room survives', async () => {
  controller.send({ type: 'command', command: { kind: 'nonsense' } });
  await controller.next(m => m.type === 'command_rejected' && m.code === 'malformed');
  controller.send({ type: 'ping', t: 42 });
  const pong = await controller.next(m => m.type === 'pong' && m.t === 42);
  assert(pong, 'no pong after malformed command');
});
await check('reconnect with resumeFromSeq replays the event stream', async () => {
  await spectator.next(m => m.type === 'event', 15_000);   // stream has events
  spectator.close();
  await spectator.closed;
  const again = await Sock.open();
  again.send({ type: 'hello', matchId, token: tokens.spectatorToken, resumeFromSeq: 0 });
  const w = await sock_next_welcome(again);
  const first = await again.next(m => m.type === 'event', 10_000);
  assert(first.event.seq === 0, `first replayed event seq ${first.event.seq}, expected 0`);
  await again.next(m => m.type === 'event' && m.event.seq >= w.eventSeq, 10_000);
  again.close();
  return `replayed from 0 through ${w.eventSeq}`;
});
controller.close();

// ---- full time, result, replay, determinism --------------------------------
if (!args.fast){
  section('full time (the match plays out in real time; ~4 minutes)');
  // the room broadcasts the result over WS at finalization, and an
  // ESTABLISHED socket keeps working through runner-side DNS/connect trouble
  // that breaks fresh HTTP connections — so watch both channels. Holding the
  // socket open also exercises long-lived WSS through the ALB for a full
  // match. (attach() re-sends the result, so connecting late is safe too.)
  const resultWatch = await Sock.open();
  resultWatch.send({ type: 'hello', matchId, token: tokens.spectatorToken });
  await sock_next_welcome(resultWatch);
  let result = null;
  await check('match reaches full time and serves a result', async () => {
    const deadline = Date.now() + 480_000;
    let via = 'http';
    for (;;){
      const wsResult = resultWatch.messages.find(m => m.type === 'result');
      if (wsResult){ result = wsResult.result; via = 'ws'; break; }
      let res = null;
      try { res = await fetchRetry(`${server}/matches/${matchId}/result`, { headers: auth(tokens.spectatorToken) }, 2); }
      catch { /* transient network failure — keep polling until the deadline */ }
      if (res?.status === 200){ result = await res.json(); break; }
      assert(Date.now() < deadline, 'no result within 8 minutes');
      await sleep(10_000);
    }
    return `finalScore ${result.finalScore.join('-')} at tick ${result.finalTick} (via ${via})`;
  });
  resultWatch.close();
  await check('result signature verifies (Ed25519)', async () => {
    assert(result, 'skipped: no result (previous check failed)');
    assert(result.signature?.algorithm === 'Ed25519', 'missing signature');
    assert(verifyResult(result), 'signature does not verify');
  });
  await check('repeated result reads are byte-identical (idempotent signing)', async () => {
    const [a, b] = await Promise.all([
      fetchRetry(`${server}/matches/${matchId}/result`, { headers: auth(tokens.spectatorToken) }).then(r => r.text()),
      fetchRetry(`${server}/matches/${matchId}/result`, { headers: auth(tokens.spectatorToken) }).then(r => r.text()),
    ]);
    assert(a === b, 'result bytes differ between reads');
  });

  let replay = null;
  await check('GET /replay returns a valid fobal-replay document', async () => {
    assert(result, 'skipped: no result (previous check failed)');
    const res = await fetchRetry(`${server}/matches/${matchId}/replay`, { headers: auth(tokens.spectatorToken) });
    assert(res.status === 200, `status ${res.status}`);
    replay = ReplayFile.parse(await res.json());
    assert(replay.finalStateHash === result.finalStateHash, 'replay/result hash mismatch');
    return `${replay.commands.length} commands, ${replay.events.length} events`;
  });
  await check('local re-execution of the replay reproduces the staging hash', async () => {
    assert(replay, 'skipped: no replay (previous check failed)');
    const engine = MatchEngine.replay(replay.manifest, replay.commands);
    const local = engine.result();
    assert(local.finalStateHash === result.finalStateHash,
      `local ${local.finalStateHash} != server ${result.finalStateHash}`);
    assert(local.finalScore.join('-') === result.finalScore.join('-'), 'score mismatch');
    return `finalStateHash ${local.finalStateHash} reproduced locally`;
  });
  await check('goal clips are served and deterministic across reads', async () => {
    assert(result, 'skipped: no result (previous check failed)');
    const get = () => fetchRetry(`${server}/matches/${matchId}/replays/goals`, { headers: auth(tokens.spectatorToken) });
    const first = await get();
    assert(first.status === 200, `status ${first.status}`);
    const a = await first.text();
    const b = await (await get()).text();
    assert(a === b, 'clip bytes differ between reads');
    const clips = JSON.parse(a).clips;
    assert(clips.length === result.goals.length, `${clips.length} clips for ${result.goals.length} goals`);
    return `${clips.length} clip(s)`;
  });
}

// ---- summary ---------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
if (tokens){
  console.log(`\nacceptance match stays available — watch or inspect it:`);
  console.log(`  matchId: ${matchId}`);
  console.log(`  spectator token: ${tokens.spectatorToken}`);
}
process.exit(failed ? 1 : 0);
