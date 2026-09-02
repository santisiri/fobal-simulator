// Assemble the static hosted client (B3) from the repo — no bundler, the
// client is plain modules on purpose. Layout of the output:
//
//   dist/client/app.html            the unified app shell (workstream J) —
//                                   /, /onboarding, /squad, /market, /lobby,
//                                   /play all render here; only /invite still
//                                   hands off (the email landing page below)
//   dist/client/app/*.js            the app's modules (apps/app/src, paths
//                                   unchanged)
//   dist/client/index.html          match client shell (config injected)
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
  ['href="../src/ui/ui.css"', 'href="./src/ui/ui.css"'],
  ["from '../src/net.js'", "from './src/net.js'"],
  ["from '../src/render.js'", "from './src/render.js'"],
  ["from '../src/puppet.js'", "from './src/puppet.js'"],
  ['<script type="module">', CONFIG_SNIPPET()],
]));

// (lobby.html was absorbed into app.html in J4 — /lobby renders in the app)

// (squad.html was absorbed into app.html in J2 — /squad renders in the app)

// (market.html was absorbed into app.html in J3 — /market renders in the app)

// 4b. the invitation landing page — config only (it reads the lobby URL to
//     fetch the invite context before anyone signs in)
const invite = readFileSync(join(root, 'apps/match-client/public/invite.html'), 'utf8');
writeFileSync(join(outDir, 'invite.html'), rewrite('invite.html', invite, [
  ['<script type="module">', CONFIG_SNIPPET()],
]));

// 4c. the unified app shell (workstream J). Its modules ship under /app with
//     their internal structure preserved; app.html's entry script is the ONE
//     place that imports across roots, so only these specifiers re-point.
cpSync(join(root, 'apps/app/src'), join(outDir, 'app'), { recursive: true });
const app = readFileSync(join(root, 'apps/app/public/app.html'), 'utf8');
//     References are ROOT-ABSOLUTE: the app is served for nested paths
//     (/market/42) by the router function, where relative URLs would 404.
writeFileSync(join(outDir, 'app.html'), rewrite('app.html', app, [
  ['href="../../match-client/src/ui/ui.css"', 'href="/src/ui/ui.css"'],
  ["from '../../match-client/src/lobbyService.js'", "from '/src/lobbyService.js'"],
  ["from '../../match-client/src/clubClaim.js'", "from '/src/clubClaim.js'"],
  ["from '../../match-client/src/ui/playerCard.js'", "from '/src/ui/playerCard.js'"],
  ["from '../../match-client/src/ui/playerDetail.js'", "from '/src/ui/playerDetail.js'"],
  ["from '../../match-client/src/ui/formation.js'", "from '/src/ui/formation.js'"],
  ["from '../../match-client/src/ui/tactics.js'", "from '/src/ui/tactics.js'"],
  ["from '../../match-client/src/ui/money.js'", "from '/src/ui/money.js'"],
  ["from '../../match-client/src/ui/tx.js'", "from '/src/ui/tx.js'"],
  ["from '../../match-client/src/ui/errors.js'", "from '/src/ui/errors.js'"],
  ["from '../../web/public/js/avatar.js'", "from '/js/avatar.js'"],
  ["from '../../web/public/js/squad.js'", "from '/js/squad.js'"],
  ["from '../../web/public/js/club.js'", "from '/js/club.js'"],
  ["from '../src/shell.js'", "from '/app/shell.js'"],
  ['<script type="module">', CONFIG_SNIPPET()],
]));

// 5. the shared web modules + the canonical token sheet. No web PAGES
//    remain (play.html was the last, absorbed in J5) — js/ carries the
//    generated avatar renderer and club helpers the app imports, and
//    styles/fobal.css stays published as the design system's source of
//    truth (ui.css carries its byte-identical shared block).
cpSync(join(root, 'apps/web/public/styles'), join(outDir, 'styles'), { recursive: true });
cpSync(join(root, 'apps/web/public/js'), join(outDir, 'js'), { recursive: true });

console.log(`client built → ${outDir}`);
console.log(`  lobby:  ${lobbyUrl}`);
console.log(`  match:  ${matchWs}`);
console.log(`  golden: /golden/index.html (sha256 ${sha(goldenSrc).slice(0, 12)}…, byte-identical)`);
