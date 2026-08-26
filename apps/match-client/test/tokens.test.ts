// ONE design system, proven. The web app and the match client are served
// from two different dev roots, so the shared block is copied into
// ui.css by tools/sync-tokens.mjs. Hand-copying is how the two halves
// drifted apart before (a goalkeeper kit the chain never had, a lobby
// wearing last season's palette) — this test makes drift a build failure.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { readBoth, SOURCE, TARGET } from '../../../tools/sync-tokens.mjs';

describe('the shared design system', () => {
  test('ui.css carries a byte-identical copy of the fobal.css shared block', () => {
    const { source, target } = readBoth();
    expect(target, `${TARGET} has no shared-system block — run node tools/sync-tokens.mjs`).not.toBeNull();
    expect(target, `${TARGET} drifted from ${SOURCE} — run node tools/sync-tokens.mjs`).toBe(source);
  });

  test('no surface redefines a token the system owns', () => {
    const owned = ['--bg:', '--panel:', '--green:', '--purple:', '--ink:', '--hairline:'];
    for (const page of ['lobby', 'squad', 'market', 'invite', 'index']){
      const html = readFileSync(`apps/match-client/public/${page}.html`, 'utf8');
      const root = html.slice(html.indexOf(':root {'), html.indexOf('}', html.indexOf(':root {')));
      for (const token of owned)
        expect(root, `${page}.html redefines ${token} — it must inherit from ui.css`).not.toContain(token);
    }
  });
});
