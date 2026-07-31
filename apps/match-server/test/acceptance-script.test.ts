// The acceptance runner (tools/staging-acceptance.mjs) is what proves a
// staging deploy; this keeps the script itself honest by running its fast
// mode against a real local server — if the script bit-rots against the
// protocol, this fails before an infra run does.
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { startMatchServer } from '../src/index.js';

const exec = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('staging acceptance script', () => {
  test('fast mode passes against a live local server', async () => {
    const server = await startMatchServer({
      port: 0,
      createKey: 'acc-test-create-key',
      storeRoot: mkdtempSync(join(tmpdir(), 'fobal-acc-')),
      autoDrive: true,
      helloTimeoutMs: 2000,   // keeps the script's hello-timeout check quick
    });
    try {
      const { stdout } = await exec(
        join(REPO, 'node_modules', '.bin', 'tsx'),
        ['tools/staging-acceptance.mjs', '--server', `http://127.0.0.1:${server.port}`,
          '--key', 'acc-test-create-key', '--fast'],
        { cwd: REPO, timeout: 90_000 },
      );
      expect(stdout).toContain('0 failed');
      expect(stdout).not.toContain('✗');
    } finally {
      await server.close();
    }
  }, 110_000);
});
