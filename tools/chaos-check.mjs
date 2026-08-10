// M2 chaos proof — SIGKILL the match server mid-load, restart it on the
// same store, and verify what the brief demands: matches RESUME (from the
// persisted internal snapshot + command log) and clients RECONNECT (the
// real MatchConnection, real backoff — not a test double).
//
//   npx tsx tools/chaos-check.mjs --matches 10
//
// Reported honestly: resume rewinds up to internalEvery (1800 ticks = 30s)
// — the price of snapshot-cadence durability, also visible in the numbers.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { sampleManifest } from '@fobal/protocol/samples';
import { MatchConnection } from '../apps/match-client/src/net.js';

function parseArgs(argv){
  const out = {};
  for (let i = 0; i < argv.length; i++)
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
  return out;
}
const args = parseArgs(process.argv.slice(2));
const MATCHES = Number(args.matches ?? 10);
const PORT = Number(args.port ?? 8498);
const CREATE_KEY = 'chaos-ck';
const base = `http://127.0.0.1:${PORT}`;
const store = mkdtempSync(join(tmpdir(), 'fobal-chaos-'));

try {
  await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) });
  console.error(`port ${PORT} is already serving — kill the squatter first`);
  process.exit(1);
} catch { /* free */ }

let server = null;
const bootServer = async () => {
  server = spawn('npx', ['tsx', 'apps/match-server/src/index.ts'], {
    env: {
      ...process.env, PORT: String(PORT),
      FOBAL_SECRET: 'chaos-secret', FOBAL_CREATE_KEY: CREATE_KEY,
      FOBAL_STORE: store, FOBAL_MAX_ROOMS: '50',
      FOBAL_MAX_CONN_PER_IP: '100000',
    },
    stdio: 'ignore',
    detached: true,           // its own process group — SIGKILL the GROUP
  });
  for (let i = 0; i < 100; i++){
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* booting */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('server never became healthy');
};
const killServer = () => { try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ } };
process.on('exit', killServer);

await bootServer();

// ---- create matches and attach REAL clients -------------------------------
const conns = [];
for (let i = 0; i < MATCHES; i++){
  const manifest = sampleManifest({ matchId: `chaos-${i}`, seed: 2000 + i, createdAt: new Date().toISOString() });
  const res = await fetch(`${base}/matches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${CREATE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  if (res.status !== 201){ console.error(`create ${i}: ${res.status}`); process.exit(1); }
  const { spectatorToken } = await res.json();
  const conn = new MatchConnection({
    url: `ws://127.0.0.1:${PORT}`, matchId: `chaos-${i}`, token: spectatorToken,
    socketFactory: url => new WebSocket(url),
    maxRetries: 20,
  }).connect();
  conns.push(conn);
}
// let matches run a while so there's real state to lose and recover
console.error(`playing ${MATCHES} matches for 40s before the kill…`);
await new Promise(r => setTimeout(r, 40_000));
const preKill = conns.map(c => c.lastFrame?.tick ?? -1);

// ---- the chaos ------------------------------------------------------------
console.error('SIGKILL the server process group');
killServer();
await new Promise(r => setTimeout(r, 2500));
const statusesDuringOutage = conns.map(c => c.status);

console.error('restarting on the same store…');
await bootServer();

// wait for every client's backoff to land
const deadline = Date.now() + 45_000;
while (Date.now() < deadline && conns.some(c => c.status !== 'live'))
  await new Promise(r => setTimeout(r, 500));
const reconnected = conns.filter(c => c.status === 'live').length;

const resumed = conns.map(c => c.lastFrame?.tick ?? -1);
await new Promise(r => setTimeout(r, 5000));
const later = conns.map(c => c.lastFrame?.tick ?? -1);
const advancing = later.filter((t, i) => t > resumed[i]).length;
const rewinds = resumed.map((t, i) => preKill[i] - t);

console.log(JSON.stringify({
  matches: MATCHES,
  statusesDuringOutage: [...new Set(statusesDuringOutage)],
  reconnected,
  advancing,
  rewindTicks: {
    max: Math.max(...rewinds),
    avg: Math.round(rewinds.reduce((a, b) => a + b, 0) / rewinds.length),
    withinInternalCadence: rewinds.every(r => r <= 1800 + 360),
  },
}));

for (const c of conns) c.close();
killServer();
process.exit(0);
