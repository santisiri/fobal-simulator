// M2 load rig — how many concurrent REALTIME matches does one match-server
// process actually sustain? Boots a fresh server subprocess, creates
// --matches rooms (autoDrive), attaches --spectators WS clients per room,
// samples for --seconds, and reports the metrics a player would feel:
//
//   tickRate   ticks/sec advanced per room (healthy = 60; lower = the match
//              itself slows down — drivers are wall-clock intervals and lag
//              compounds)
//   deltaGap   p95 ms between consecutive delta frames per room (healthy ≈
//              100ms at 10Hz)
//   pingRtt    p95 ws ping→pong round trip
//   rss        server process memory
//
//   node tools/load-test.mjs --matches 20 --spectators 2 --seconds 45
//
// Run stages with growing --matches until tickRate sags below ~57 or gaps
// blow past ~300ms — that's the knee. Numbers feed docs/SCALE.md.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { sampleManifest } from '@fobal/protocol/samples';

function parseArgs(argv){
  const out = {};
  for (let i = 0; i < argv.length; i++)
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
  return out;
}
const args = parseArgs(process.argv.slice(2));
const MATCHES = Number(args.matches ?? 10);
const SPECTATORS = Number(args.spectators ?? 2);
const SECONDS = Number(args.seconds ?? 45);
const PORT = Number(args.port ?? 8497);
const CREATE_KEY = 'load-ck';

const p95 = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};

// ---- boot a fresh server subprocess ---------------------------------------
// a squatted port silently redirects every measurement to a stale server —
// refuse to run unless the port is OURS to fill
try {
  await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
  console.error(`port ${PORT} is already serving — kill the squatter first (lsof -ti :${PORT} | xargs kill -9)`);
  process.exit(1);
} catch { /* connection refused = good */ }

const store = mkdtempSync(join(tmpdir(), 'fobal-load-'));
const server = spawn('npx', ['tsx', 'apps/match-server/src/index.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    FOBAL_SECRET: 'load-secret',
    FOBAL_CREATE_KEY: CREATE_KEY,
    FOBAL_STORE: store,
    // the rig probes BEYOND the production caps on purpose — all its
    // spectators share 127.0.0.1, and the per-IP shed (default 20) would
    // otherwise silently reject them (found the hard way at N=20)
    FOBAL_MAX_ROOMS: String(Math.max(MATCHES * 2, 50)),
    FOBAL_MAX_CONN_PER_IP: '100000',
    FOBAL_MAX_CONN: '100000',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  // own process GROUP: npx→tsx→node is a tree, and killing only the spawned
  // wrapper leaves the real server alive to squat the port for the next run
  // (the zombie source behind three corrupted ramps)
  detached: true,
});
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
const cleanup = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } };
process.on('exit', cleanup);

const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 100; i++){
  try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* booting */ }
  await new Promise(r => setTimeout(r, 200));
}

// ---- create rooms ---------------------------------------------------------
const rooms = [];
for (let i = 0; i < MATCHES; i++){
  const manifest = sampleManifest({
    matchId: `load-${i}`,
    seed: 1000 + i,
    createdAt: new Date().toISOString(),
  });
  const res = await fetch(`${base}/matches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CREATE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  if (res.status !== 201){
    console.error(`create ${i} failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const { spectatorToken } = await res.json();
  rooms.push({ matchId: `load-${i}`, spectatorToken, firstTick: -1, lastTick: -1, t0: 0, t1: 0, gaps: [], lastDeltaAt: 0 });
}

// ---- attach spectators ----------------------------------------------------
const sockets = [];
const rtts = [];
const attachDeadline = setTimeout(() => {
  console.error('spectator attach timed out (some welcome never arrived) — aborting');
  cleanup();
  process.exit(1);
}, 30_000);
await Promise.all(rooms.flatMap(room =>
  Array.from({ length: SPECTATORS }, (_, s) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
    sockets.push(ws);
    const measure = s === 0;                 // one measuring spectator per room
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', matchId: room.matchId, token: room.spectatorToken })));
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.type === 'welcome') resolve();
      if (!measure) return;
      if (msg.type === 'delta'){
        const now = performance.now();
        if (room.firstTick === -1){ room.firstTick = msg.delta.tick; room.t0 = now; }
        room.lastTick = msg.delta.tick; room.t1 = now;
        if (room.lastDeltaAt) room.gaps.push(now - room.lastDeltaAt);
        room.lastDeltaAt = now;
      }
      if (msg.type === 'pong' && msg.t) rtts.push(performance.now() - msg.t);
    });
    ws.on('error', reject);
  })),
));
clearTimeout(attachDeadline);

// settle: creations + vm boots + tsx warmup pollute the first seconds; let
// the server breathe, then zero every counter so the window is steady-state
await new Promise(r => setTimeout(r, 3000));
for (const room of rooms){
  room.firstTick = -1; room.lastTick = -1; room.t0 = 0; room.t1 = 0;
  room.gaps = []; room.lastDeltaAt = 0;
}
rtts.length = 0;

// periodic pings through the first socket of each room's measurer
const pinger = setInterval(() => {
  for (let i = 0; i < sockets.length; i += SPECTATORS){
    const ws = sockets[i];
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: performance.now() }));
  }
}, 2000);

console.error(`sampling ${MATCHES} matches × ${SPECTATORS} spectators for ${SECONDS}s…`);
await new Promise(r => setTimeout(r, SECONDS * 1000));
clearInterval(pinger);

// ---- report ---------------------------------------------------------------
const rates = rooms.filter(r => r.t1 > r.t0)
  .map(r => (r.lastTick - r.firstTick) / ((r.t1 - r.t0) / 1000));
const allGaps = rooms.flatMap(r => r.gaps);
// npx → tsx → node is a process TREE; the wrapper's own rss is meaningless.
// Sum the whole tree rooted at the spawned pid.
const rss = await new Promise((resolve) => {
  const ps = spawn('ps', ['-axo', 'pid=,ppid=,rss=']);
  let out = '';
  ps.stdout.on('data', d => { out += d; });
  ps.on('close', () => {
    const rows = out.trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
    const kids = new Map();
    for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
    const tree = new Set([server.pid]);
    const walk = (pid) => { for (const c of kids.get(pid) ?? []){ tree.add(c); walk(c); } };
    walk(server.pid);
    const total = rows.filter(([pid]) => tree.has(pid)).reduce((a, [, , r]) => a + r, 0);
    resolve(Math.round(total / 1024));
  });
});
const health = await fetch(`${base}/health`).then(r => r.json()).catch(() => ({}));

console.log(JSON.stringify({
  matches: MATCHES,
  spectators: SPECTATORS,
  seconds: SECONDS,
  tickRate: { avg: +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1), min: +Math.min(...rates).toFixed(1) },
  deltaGapMs: { p95: +p95(allGaps).toFixed(0), max: +Math.max(0, ...allGaps).toFixed(0) },
  pingRttMs: { p95: +p95(rtts).toFixed(1), n: rtts.length },
  serverRssMb: rss,
  activeRooms: health.activeRooms,
}));

for (const ws of sockets) ws.terminate();
cleanup();
process.exit(0);
