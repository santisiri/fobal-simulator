// Extracts the game's inline <script> from index.html (the golden reference)
// so it can be executed headlessly in Node. The extraction is positional, not
// parsed: the game script is the last bare <script> block before </body>.
// Usage as CLI:  node tools/extract-inline-script.mjs [outfile]
// Usage as lib:  import { extractInlineScript } from './extract-inline-script.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function extractInlineScript(htmlPath = join(REPO_ROOT, 'index.html')){
  const html = readFileSync(htmlPath, 'utf8');
  const open = html.lastIndexOf('<script>');
  if (open === -1) throw new Error('no bare <script> block found in ' + htmlPath);
  const start = open + '<script>'.length;
  const end = html.indexOf('</script>', start);
  if (end === -1) throw new Error('unterminated <script> block in ' + htmlPath);
  const src = html.slice(start, end);
  if (!src.includes("'use strict'")) throw new Error('extracted block does not look like the game script');
  if (!src.includes('window.__simulate')) throw new Error('extracted block is missing the headless QA API');
  return src;
}

if (process.argv[1] === fileURLToPath(import.meta.url)){
  const out = process.argv[2] || join(REPO_ROOT, 'build', 'golden-engine.js');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, extractInlineScript());
  console.log('wrote', out);
}
