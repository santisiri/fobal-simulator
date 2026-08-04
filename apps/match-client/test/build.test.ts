// B3 — the hosted-client build. The invariants that matter: the golden file
// ships byte-identical, every path rewrite lands, config is injected, and a
// client refactor that breaks a rewrite pattern fails the BUILD (and this
// test), never the deployed site.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const sha = (buf: Buffer | string) => createHash('sha256').update(buf).digest('hex');

describe('build-client', () => {
  test('assembles a hosted client: byte-identical golden, rewritten paths, injected config', () => {
    const out = join(mkdtempSync(join(tmpdir(), 'fobal-build-')), 'client');
    execFileSync('node', [
      join(root, 'tools/build-client.mjs'),
      '--lobby-url', 'https://lobby-staging.fobal.ai',
      '--match-ws', 'wss://matches-staging.fobal.ai',
      '--out', out,
    ], { cwd: root });

    // the golden reference is untouched by construction
    expect(sha(readFileSync(join(out, 'golden/index.html'))))
      .toBe(sha(readFileSync(join(root, 'index.html'))));

    const shell = readFileSync(join(out, 'index.html'), 'utf8');
    expect(shell).toContain('<iframe src="/golden/index.html"');
    expect(shell).not.toContain("from '../src/");
    expect(shell).toContain("from './src/net.js'");
    expect(shell).toContain('"matchWsUrl":"wss://matches-staging.fobal.ai"');
    expect(shell).toContain('"goldenUrl":"/golden/index.html"');

    const lobby = readFileSync(join(out, 'lobby.html'), 'utf8');
    expect(lobby).toContain('"lobbyUrl":"https://lobby-staging.fobal.ai"');

    // modules ship unmodified
    expect(sha(readFileSync(join(out, 'src/puppet.js'))))
      .toBe(sha(readFileSync(join(root, 'apps/match-client/src/puppet.js'))));
  });

  test('missing args fail fast', () => {
    expect(() => execFileSync('node', [join(root, 'tools/build-client.mjs')], { cwd: root, stdio: 'pipe' }))
      .toThrow();
  });
});
