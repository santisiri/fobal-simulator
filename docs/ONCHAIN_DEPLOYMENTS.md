# On-chain deployments (recovered record)

The live addresses were previously recorded **nowhere in the repository** —
`contracts/deployments/*.json` is gitignored, so the only copy was on the
deployer's laptop and in a chat log. Recovering the renderer pointer is a
prerequisite for the art migration, because it is the exact value a rollback
has to restore.

## Base Sepolia (chainId 84532) — deployed 2026-08-14

| contract | address |
|---|---|
| FobalPlayer | `0x52F5828dA509D6043c2619F048687BEdfA4789d4` |
| FobalAvatarRenderer (v1, **currently installed**) | `0xB103DCe9f0A45c0FDE4d34AdB53836e9c43aB5dF` |
| FobalRendererRouter (deployed 2026-08-23, **not installed**) | `0x93C5c6a849d32921BB364BfB1a63e072c4DF2955` |
| FobalPlayerGenerator | `0xC3b29a5417b2bb64AE1DC9A5539261a16f2Cf178` |
| FobalTeamRegistry | `0x22d6518ee6f80d9D772f56D52b0EA9E08A9aad90` |
| FobalAssetRegistry | `0x7975B26cA8e4d5DBF138b21093DAEe9118225A86` |
| FobalProgression | `0x13C21C844084F50931fC6781105031c4b9ba43E2` |
| FobalMatchEscrow | `0xD3E65006F0eFeACe5C6b90DDaFdA36b6D1F82A60` |
| FobalMarketplace | `0x35f0CF848cB276AFf36745bEF65ccd80C03169E3` |

State as recovered on 2026-08-18:

- `renderer()` = `0xB103DCe9f0A45c0FDE4d34AdB53836e9c43aB5dF`
- `nextTokenId()` = `12` (tokens 1–11 exist)
- `DEFAULT_ADMIN_ROLE` held by `0x26250e47500943464290A77ae3508a3001d9B69d`
- `supportsInterface(0x49064906)` = true (ERC-4906 metadata refresh)

### Router, verified against the deployed bytecode 2026-08-23

Deployed but **not installed** — `FobalPlayer.renderer()` still points at v1.

- `version()` = `router-v1`, runtime 5,244 B (matches the local build exactly)
- both lanes wrap v1: `defaultRenderer()` = `fallbackRenderer()` = `0xB103DCe9…`
- `ROUTER_ADMIN_ROLE` and `DEFAULT_ADMIN_ROLE` held by `0x26250e47500943464290A77ae3508a3001d9B69d`
- **all 11 tokens hash identically** through the router and through the collection

Note the router has no existence check of its own, so calling it DIRECTLY for
a nonexistent id returns the fallback card rather than reverting. That path is
unreachable in practice: `FobalPlayer.tokenURI` calls `_requireOwned` before it
reaches any renderer, and `tokenURI(12)` still reverts `ERC721NonexistentToken`.

Re-verify any of it without trusting this file:

    cast call 0x52F5828dA509D6043c2619F048687BEdfA4789d4 "renderer()(address)" --rpc-url https://sepolia.base.org

**This table is the rollback target.** If a renderer swap ever needs undoing,
`setRenderer(0xB103DCe9f0A45c0FDE4d34AdB53836e9c43aB5dF)` restores v1 exactly.

No mainnet deployment exists, by design.
