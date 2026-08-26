// ONE design system, two dev roots.
//
// apps/web pages are served from apps/web/public (they link styles/fobal.css);
// apps/match-client pages are served from apps/match-client (they link
// ../src/ui/ui.css). Neither root can reach the other's file, so the shared
// block is COPIED — mechanically, never by hand, because hand-copying is
// exactly how the two halves drifted apart before.
//
//   node tools/sync-tokens.mjs          write ui.css from fobal.css
//   node tools/sync-tokens.mjs --check  verify they match (used by the test)
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE = 'apps/web/public/styles/fobal.css';
export const TARGET = 'apps/match-client/src/ui/ui.css';
const START = '/* @shared-system:start';
const END = '/* @shared-system:end */';

export function sharedBlock(css){
  const a = css.indexOf(START);
  const b = css.indexOf(END);
  if (a < 0 || b < 0) throw new Error('shared-system markers missing');
  return css.slice(a, b + END.length);
}

export function readBoth(){
  const source = sharedBlock(readFileSync(join(root, SOURCE), 'utf8'));
  const targetCss = readFileSync(join(root, TARGET), 'utf8');
  const target = targetCss.includes(START) ? sharedBlock(targetCss) : null;
  return { source, target, targetCss };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]){
  const { source, target, targetCss } = readBoth();
  if (process.argv.includes('--check')){
    if (source === target) { console.log('tokens in sync'); process.exit(0); }
    console.error(`OUT OF SYNC — run: node tools/sync-tokens.mjs`);
    process.exit(1);
  }
  const next = target === null
    ? `${source}\n\n${targetCss}`
    : targetCss.replace(sharedBlock(targetCss), source);
  writeFileSync(join(root, TARGET), next);
  console.log(`synced ${source.length} bytes → ${TARGET}`);
}
