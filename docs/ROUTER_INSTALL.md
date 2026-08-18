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
