// Packaging guard — the image runs `npm ci --omit=dev`, so ANY package a
// shipped source file imports at runtime must live in that workspace's
// `dependencies`. A devDependency import typechecks, tests green, and then
// crash-loops the task on deploy (viem/identity.ts did exactly that, twice,
// costing a circuit-breaker rollback). This test reads the Dockerfile to
// learn what ships, so adding a workspace to the image extends the guard
// automatically.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const dockerfile = readFileSync(join(root, 'apps/match-server/Dockerfile'), 'utf8');

/** workspaces the image copies wholesale (COPY <ws> ./<ws>) */
const shipped = [...dockerfile.matchAll(/^COPY (packages\/[\w-]+|apps\/[\w-]+) \.\//gm)]
  .map(m => m[1]!);

const tsFiles = (dir: string): string[] => {
  let out: string[] = [];
  for (const entry of readdirSync(dir)){
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out = out.concat(tsFiles(full));
    else if (/\.(ts|mts|js|mjs)$/.test(entry)) out.push(full);
  }
  return out;
};

/** bare import specifiers → package names ('viem/chains' → 'viem').
 *  Only real import syntax — a loose /from ['"]/ also catches
 *  Buffer.from('1901', 'hex'). */
function importedPackages(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  const specs = [
    ...[...src.matchAll(/^\s*(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]/gm)],
    ...[...src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)],
    ...[...src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g)],
  ].map(m => m[1]!);
  return specs
    .filter(s => !s.startsWith('.') && !s.startsWith('node:'))
    .map(s => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]!));
}

describe('packaging: the production image has every runtime import', () => {
  test('the Dockerfile ships the workspaces we think it does', () => {
    expect(shipped).toContain('apps/lobby-server');
    expect(shipped).toContain('apps/match-server');
    expect(shipped.length).toBeGreaterThanOrEqual(4);
  });

  test.each(shipped)('%s imports only production dependencies', (ws) => {
    const pkg = JSON.parse(readFileSync(join(root, ws, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    const prod = new Set(Object.keys(pkg.dependencies ?? {}));
    const dev = new Set(Object.keys(pkg.devDependencies ?? {}));
    const srcDir = join(root, ws, 'src');
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir))
      for (const name of importedPackages(file))
        if (!prod.has(name))
          offenders.push(`${ws}/src${file.slice(srcDir.length)} imports "${name}"`
            + (dev.has(name) ? ' — it is a devDependency; move it to dependencies'
                             : ' — it is not declared at all'));
    expect(offenders).toEqual([]);
  });
});
