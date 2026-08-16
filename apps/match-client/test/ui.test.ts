// Product-UI workstream — the pure layers under the squad experience:
// the wallet-error normalizer and the transaction-flow state machine.
// (DOM renderers are exercised in the live browser walk; these modules are
// deliberately DOM-free so the CONTRACT is unit-testable.)
import { describe, expect, test } from 'vitest';
import { normalizeWalletError } from '../src/ui/errors.js';
import { createTxFlow, txStateLine, TX_STATES } from '../src/ui/tx.js';

describe('normalizeWalletError', () => {
  const cases: Array<[string, unknown, string]> = [
    ['user rejection by code', { code: 4001, message: 'User rejected the request.' }, 'rejected'],
    ['user rejection by text', new Error('MetaMask Tx Signature: User denied transaction signature'), 'rejected'],
    ['request already pending', { code: -32002, message: 'Request of type wallet_requestPermissions already pending' }, 'pending'],
    ['insufficient funds', new Error('insufficient funds for gas * price + value'), 'funds'],
    ['wrong network', new Error('Unrecognized chain ID 0x1'), 'network'],
    ['disconnected', { code: 4900, message: 'disconnected from chain' }, 'disconnected'],
    ['replaced', new Error('nonce too low: transaction replaced'), 'replaced'],
    ['revert', new Error('execution reverted: NotTeamOwner(7)'), 'reverted'],
    ['rpc down', new Error('fetch failed: connect ECONNREFUSED'), 'rpc'],
    ['metadata', new Error('failed to load player metadata'), 'metadata'],
  ];
  for (const [label, err, kind] of cases)
    test(label, () => {
      const out = normalizeWalletError(err);
      expect(out.kind).toBe(kind);
      expect(out.message).not.toMatch(/0x|code|revert|ECONN|-32002/);   // calm surface
      expect(out.detail.length).toBeGreaterThan(0);                     // truth preserved
    });

  test('unknown garbage never throws and stays retryable', () => {
    for (const junk of [null, undefined, 42, 'boom', { weird: true }]) {
      const out = normalizeWalletError(junk);
      expect(out.kind).toBe('unknown');
      expect(out.retryable).toBe(true);
    }
  });

  test('revert detail keeps the contract reason for the details affordance', () => {
    const out = normalizeWalletError(new Error('execution reverted: NotTeamOwner(7)'));
    expect(out.detail).toContain('NotTeamOwner');
  });
});

describe('createTxFlow', () => {
  test('walks the full multi-leg mint shape, emitting every transition', () => {
    const seen: string[] = [];
    const flow = createTxFlow({ action: 'Mint my team', onChange: (s: { state: string }) => seen.push(s.state) });
    flow.preparing('create team');
    flow.wallet();
    flow.submitted('0xabc');
    expect(flow.snapshot.txHash).toBe('0xabc');
    flow.confirming();
    flow.legDone();
    flow.preparing('mint squad');
    flow.wallet();
    flow.submitted('0xdef');
    flow.confirming();
    flow.legDone();
    flow.indexing();
    flow.success();
    expect(flow.snapshot.state).toBe('success');
    expect(flow.snapshot.legsDone).toBe(2);
    expect(seen[0]).toBe('preparing');
    expect(seen[seen.length - 1]).toBe('success');
    for (const s of seen) expect(TX_STATES).toContain(s);
  });

  test('failure carries the normalized error into the line', () => {
    const flow = createTxFlow({ action: 'Mint' });
    flow.preparing();
    flow.failure(normalizeWalletError({ code: 4001, message: 'User rejected the request.' }));
    expect(flow.snapshot.state).toBe('failure');
    expect(txStateLine(flow.snapshot)).toContain('declined');
  });

  test('a broken onChange listener never breaks the flow', () => {
    const flow = createTxFlow({ action: 'X', onChange: () => { throw new Error('render exploded'); } });
    expect(() => { flow.preparing(); flow.success(); }).not.toThrow();
    expect(flow.snapshot.state).toBe('success');
  });

  test('reset returns to idle with nothing sticky', () => {
    const flow = createTxFlow({ action: 'X' });
    flow.preparing('leg'); flow.submitted('0x1'); flow.failure(normalizeWalletError('x'));
    flow.reset();
    expect(flow.snapshot).toMatchObject({ state: 'idle', leg: null, txHash: null, error: null, legsDone: 0 });
  });

  test('every state renders a human line with the leg named', () => {
    for (const state of TX_STATES.filter(s => s !== 'idle' && s !== 'failure')) {
      const line = txStateLine({ state, leg: 'mint squad', error: null });
      expect(line.length).toBeGreaterThan(0);
    }
    expect(txStateLine({ state: 'wallet', leg: 'create team', error: null })).toContain('create team');
  });
});
