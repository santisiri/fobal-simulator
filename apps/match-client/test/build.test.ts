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

    // the unified app shell (J1): config injected, every cross-root import
    // re-pointed at the dist layout, its own modules shipped under /app
    // references are root-absolute — the app answers nested deep links
    // (/market/42), where a relative path would resolve under the link
    const app = readFileSync(join(out, 'app.html'), 'utf8');
    expect(app).toContain('"lobbyUrl":"https://lobby-staging.fobal.ai"');
    expect(app).toContain('href="/styles/fobal.css"');
    expect(app).not.toContain("from '../");
    expect(app).toContain("from '/src/lobbyService.js'");
    expect(app).toContain("from '/js/avatar.js'");
    expect(app).toContain("from '/app/shell.js'");
    expect(sha(readFileSync(join(out, 'app/shell.js'))))
      .toBe(sha(readFileSync(join(root, 'apps/app/src/shell.js'))));
    expect(sha(readFileSync(join(out, 'app/views/club.js'))))
      .toBe(sha(readFileSync(join(root, 'apps/app/src/views/club.js'))));

    // the absorbed pages are gone from the artifact — app.html is the club
    expect(() => readFileSync(join(out, 'hub.html'))).toThrow();
    expect(() => readFileSync(join(out, 'onboarding.html'))).toThrow();
  });

  test('missing args fail fast', () => {
    expect(() => execFileSync('node', [join(root, 'tools/build-client.mjs')], { cwd: root, stdio: 'pipe' }))
      .toThrow();
  });
});
