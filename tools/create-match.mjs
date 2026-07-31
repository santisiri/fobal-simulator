// Create a match on a running match server and print everything needed to
// watch or control it from apps/match-client. Run with tsx (workspace
// packages are TypeScript):
//
//   FOBAL_CREATE_KEY=... npx tsx tools/create-match.mjs
//   npx tsx tools/create-match.mjs --server https://matches-staging.fobal.ai --key <createKey>
//
// Options:
//   --server    base URL (default http://localhost:8473)
//   --key       create key (default: FOBAL_CREATE_KEY env)
//   --match-id  match id (default acc-<timestamp>)
//   --seed      manifest seed (default random)
import { sampleManifest } from '@fobal/protocol/samples';

function parseArgs(argv){
  const out = {};
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const server = (args.server ?? 'http://localhost:8473').replace(/\/+$/, '');
const key = args.key ?? process.env.FOBAL_CREATE_KEY;
if (!key){
  console.error('missing create key: set FOBAL_CREATE_KEY or pass --key');
  process.exit(1);
}

const matchId = args['match-id'] ?? `acc-${Date.now()}`;
const seed = args.seed !== undefined ? Number(args.seed) : Math.floor(Math.random() * 2 ** 31);
const manifest = sampleManifest({ matchId, seed, createdAt: new Date().toISOString() });

const res = await fetch(`${server}/matches`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify(manifest),
});
const body = await res.json();
if (res.status !== 201){
  console.error(`create failed (${res.status}): ${body.error ?? JSON.stringify(body)}`);
  process.exit(1);
}

const wsUrl = server.replace(/^http/, 'ws');
const teamName = (teamId) => manifest.teams.find(t => t.teamId === teamId)?.name ?? '';

console.log(`match created on ${server}`);
console.log('');
console.log(`  matchId:   ${body.matchId}`);
console.log(`  ws url:    ${wsUrl}`);
console.log(`  seed:      ${seed}`);
console.log('');
console.log(`  spectator token:  ${body.spectatorToken}`);
for (const [teamId, token] of Object.entries(body.tokens))
  console.log(`  controller ${teamId} (${teamName(teamId)}):  ${token}`);
console.log('');
console.log('watch it: serve the repo root and open the client in ONLINE MODE —');
console.log('  python3 -m http.server 8471');
console.log('  http://localhost:8471/apps/match-client/public/');
console.log('then paste the ws url, matchId and a token. Full time in ~3.5 minutes.');
console.log('');
console.log('after full time:');
console.log(`  curl -H "Authorization: Bearer ${body.spectatorToken}" ${server}/matches/${body.matchId}/result`);
