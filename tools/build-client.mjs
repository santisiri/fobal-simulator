// Assemble the static hosted client (B3) from the repo — no bundler, the
// client is plain modules on purpose. Layout of the output:
//
//   dist/client/index.html          match client shell (config injected)
//   dist/client/lobby.html          lobby page (config injected)
//   dist/client/src/*.js            client modules (paths unchanged)
//   dist/client/golden/index.html   the golden reference, BYTE-IDENTICAL —
//                                   verified by hash; the build ABORTS if the
//                                   copy differs from the repo root file
//
//   node tools/build-client.mjs \
//     --lobby-url https://lobby-staging.fobal.ai \
//     --match-ws  wss://matches-staging.fobal.ai \
//     [--out dist/client]
//
// Deploy (see infra notes in the PR / agent prompt):
//   aws s3 sync dist/client s3://fobal-staging-client-<account>/ --delete
//   aws cloudfront create-invalidation --distribution-id <id> --paths '/*'
//
// Every rewrite below is asserted: if a pattern is missing (someone
// refactored the client), the build fails loudly instead of shipping a
// silently broken site.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv){
  const out = {};
  for (let i = 0; i < argv.length; i++){
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const lobbyUrl = args['lobby-url'];
const matchWs = args['match-ws'];
if (!lobbyUrl || !matchWs){
  console.error('usage: node tools/build-client.mjs --lobby-url <https://…> --match-ws <wss://…> [--out dist/client]');
  process.exit(1);
}
const outDir = resolve(root, args.out ?? 'dist/client');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** apply replacements, asserting every pattern matched exactly once */
function rewrite(name, text, replacements){
  for (const [from, to] of replacements){
    const count = text.split(from).length - 1;
    if (count !== 1)
      throw new Error(`${name}: expected exactly 1 occurrence of ${JSON.stringify(from)}, found ${count} — the client changed; update tools/build-client.mjs`);
    text = text.replace(from, to);
  }
  return text;
}

const CONFIG_SNIPPET = (extra = {}) =>
  `<script>window.FOBAL_CONFIG = ${JSON.stringify({
    lobbyUrl, matchWsUrl: matchWs, goldenUrl: '/golden/index.html', ...extra,
  })};</script>\n<script type="module">`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'golden'), { recursive: true });

// 1. the golden reference — copied, never transformed
const goldenSrc = readFileSync(join(root, 'index.html'));
writeFileSync(join(outDir, 'golden', 'index.html'), goldenSrc);
if (sha(readFileSync(join(outDir, 'golden', 'index.html'))) !== sha(goldenSrc))
  throw new Error('golden copy is not byte-identical — aborting');

// 2. client modules, path structure preserved
cpSync(join(root, 'apps/match-client/src'), join(outDir, 'src'), { recursive: true });

// 3. the shell — golden iframe now lives at /golden/, module path flattens,
//    config injected right before the module script
const shell = readFileSync(join(root, 'apps/match-client/public/index.html'), 'utf8');
writeFileSync(join(outDir, 'index.html'), rewrite('index.html', shell, [
  ['<iframe src="/index.html"', '<iframe src="/golden/index.html"'],
  ["from '../src/net.js'", "from './src/net.js'"],
  ["from '../src/render.js'", "from './src/render.js'"],
  ["from '../src/puppet.js'", "from './src/puppet.js'"],
  ['<script type="module">', CONFIG_SNIPPET()],
]));

// 4. the lobby page — config only
const lobby = readFileSync(join(root, 'apps/match-client/public/lobby.html'), 'utf8');
writeFileSync(join(outDir, 'lobby.html'), rewrite('lobby.html', lobby, [
  ['<script type="module">', CONFIG_SNIPPET()],
]));

// 5. the web app surfaces (onboarding, hub, play + shared design system).
//    Static and self-contained; relative paths resolve at the dist root. A
//    FOBAL_CONFIG snippet is injected so play.html can find the relocated
//    golden (/golden/index.html) and the lobby URL — same config the shell
//    and lobby receive.
cpSync(join(root, 'apps/web/public/styles'), join(outDir, 'styles'), { recursive: true });
cpSync(join(root, 'apps/web/public/js'), join(outDir, 'js'), { recursive: true });
const webConfig = `<script>window.FOBAL_CONFIG = ${JSON.stringify({
  lobbyUrl, matchWsUrl: matchWs, goldenUrl: '/golden/index.html',
})};</script>\n<link rel="stylesheet" href="styles/fobal.css">`;
for (const page of ['onboarding.html', 'hub.html', 'play.html']) {
  const html = readFileSync(join(root, 'apps/web/public', page), 'utf8');
  writeFileSync(join(outDir, page), rewrite(page, html, [
    ['<link rel="stylesheet" href="styles/fobal.css">', webConfig],
  ]));
}

console.log(`client built → ${outDir}`);
console.log(`  lobby:  ${lobbyUrl}`);
console.log(`  match:  ${matchWs}`);
console.log(`  golden: /golden/index.html (sha256 ${sha(goldenSrc).slice(0, 12)}…, byte-identical)`);
