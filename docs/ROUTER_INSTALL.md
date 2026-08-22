# Installing the renderer router (P1)

One transaction, no visual change, fully reversible. Run it **before** any new
art exists, so the art migration never touches the collection's only mutable
pointer again.

## Why this exists

`FobalPlayer.renderer` is the protocol's single mutable cross-contract
pointer. `FobalPlayer.tokenURI` has **no try/catch**, and
`setRenderer(address(0))` reverts, so there is no off switch. Point that lever
directly at a fresh art renderer and one unlucky seed takes metadata down for
the entire collection, with recovery gated on a single keystore EOA.

The router makes `tokenURI` **total** — a renderer that reverts, returns
malformed data, or burns all its gas degrades to the fallback renderer and
then to an inline identity card — and turns every future art change into a
revertible storage write, per token, per cohort, or wholesale.

## Steps

**1. Prove the current pointer** (never trust a doc for a rollback target):

    cast call $PLAYER "renderer()(address)" --rpc-url https://sepolia.base.org

Expect `0xB103DCe9f0A45c0FDE4d34AdB53836e9c43aB5dF`. If it differs, stop and
update `docs/ONCHAIN_DEPLOYMENTS.md` first — that address is the undo button.

**2. Prove parity on a fork** — the acceptance gate, no gas spent:

    cd contracts && forge test --match-contract RouterParityFork \
      --fork-url https://sepolia.base.org -vv

Must report every existing token byte-identical. This test constructs the
router against the live renderer and compares `tokenURI` hashes one by one.

**2b. Rehearse the WHOLE sequence**, including the step that writes storage:

    cd contracts && forge test --match-contract RouterInstallRehearsal \
      --fork-url https://sepolia.base.org -vv

This impersonates the recorded admin and actually performs step 5 against
forked state, then rolls it back, so the first `setRenderer` on the real chain
is not the first time anyone has watched it happen. It also proves the
property the router exists for: with the default lane pointed at a renderer
that reverts on every call, every token still resolves; with BOTH lanes
broken, the inline identity card still answers.

Last rehearsed 2026-08-22 against Base Sepolia — 11 tokens byte-identical
before, through, and after the install; rollback restored them byte for byte;
**the install itself costs 9,683 gas**.

The rehearsal asserts the admin role still sits on the address recorded in
`docs/ONCHAIN_DEPLOYMENTS.md` and fails with that instruction if it has moved.

**3. Deploy the router** (deploying changes nothing on its own; it reads the
live pointer itself so it cannot be wired to a stale address):

    FOBAL_PLAYER=0x52F5828dA509D6043c2619F048687BEdfA4789d4 \
    FOBAL_ROUTER_ADMIN=<timelock or admin address> \
    forge script script/DeployRouter.s.sol --rpc-url base_sepolia \
      --account fobal-admin --broadcast --verify

**4. Prove the deployed instance too**, against the deployed bytecode rather
than a local build:

    cast call <ROUTER> "tokenURI(uint256)(string)" 1 --rpc-url https://sepolia.base.org
    cast call $PLAYER  "tokenURI(uint256)(string)" 1 --rpc-url https://sepolia.base.org

Diff them. They must be identical for every token 1–11.

**5. Install** — the only state-changing step:

    cast send $PLAYER "setRenderer(address)" <ROUTER> \
      --account fobal-admin --rpc-url https://sepolia.base.org

This emits `RendererChanged` plus `BatchMetadataUpdate(1, 11)`, so
marketplaces re-pull. Output does not change by a byte.

**6. Verify, then record** the router address in
`docs/ONCHAIN_DEPLOYMENTS.md`.

## Rollback

    cast send $PLAYER "setRenderer(address)" 0xB103DCe9f0A45c0FDE4d34AdB53836e9c43aB5dF \
      --account fobal-admin --rpc-url https://sepolia.base.org

Instant and total. Nothing else needs undoing — the router holds no art and
takes no roles on `FobalPlayer`.

## Governance note

`ROUTER_ADMIN_ROLE` should be a `TimelockController` (48h) in production so
art changes are announced rather than instant. `FobalPlayer`'s own
`DEFAULT_ADMIN_ROLE` is deliberately **not** moved by this slice: transferring
it is itself irreversible, and keeping it separate means the timelock can
never lock you out of the rollback above.
