# Fobal Protocol — Deployment

## Path to production

```
LOCAL (Anvil)
   ↓   full lifecycle demo + tests green
Base Sepolia
   ↓   live integration, indexer wiring, frontend against real addresses
security review
   ↓   internal review against SECURITY.md / TRUST_MODEL.md
external audit
   ↓   professional Solidity audit; remediate findings
Base mainnet
```

**Nothing is deployed to mainnet by this repository.** The scripts below
produce exactly the commands to deploy when the team decides to. `--broadcast`
is required to actually send transactions; without it every command is a dry
run.

## Environment

Copy `.env.example` to `.env` and fill it. **Never commit `.env`** (it is
gitignored). Secrets are read from the environment, never from source.

```
BASE_SEPOLIA_RPC_URL   RPC endpoint for Base Sepolia
BASE_RPC_URL           RPC endpoint for Base mainnet (unused until audited)
BASESCAN_API_KEY       for contract verification on Basescan
FOBAL_ADMIN            governance authority — a MULTISIG on mainnet
FOBAL_TREASURY         fee / pot recipient
FOBAL_GENERATOR_SIGNER address whose key signs squad-generation payloads
FOBAL_ENGINE_SIGNER    address whose key signs match results
```

The deployer account (the key passed via `--account` or `--private-key`) MUST
equal `FOBAL_ADMIN`: it grants roles during wiring. Rotate roles to a multisig
after deployment if the deployer is a hot key.

## Local (Anvil)

```bash
anvil                                   # terminal 1
forge script script/DemoLifecycle.s.sol \
  --rpc-url http://localhost:8545 --broadcast   # terminal 2
```

`DemoLifecycle` runs the entire vertical slice on a live node: deploy, wire,
mint two 11-player squads, create + stake + lock a match, sign + settle a
result, apply progression, list and buy an evolved player — printing each
milestone. It uses Anvil's well-known keys; never use those elsewhere.

## Base Sepolia

```bash
# dry run (no transactions)
forge script script/Deploy.s.sol --rpc-url base_sepolia --account fobal-deployer

# broadcast + verify on Basescan
forge script script/Deploy.s.sol \
  --rpc-url base_sepolia \
  --account fobal-deployer \
  --broadcast \
  --verify
```

`Deploy` reads the `FOBAL_*` env vars, deploys all eight contracts, wires
roles (MINTER→generator, PROGRESSION→progression, LOCK→escrow, ESCROW→escrow),
sets the renderer, enables native ETH staking, and writes
`deployments/<chainId>.json`.

### Post-deploy configuration (as `FOBAL_ADMIN`)
```bash
# enable an ERC-20 stake asset (e.g. a future SAIRI) — governance only
cast send $ASSET_REGISTRY "setAsset(address,(bool,uint96,uint96,uint32))" \
  $SAIRI "(true,1000000000000000000,1000000000000000000000000,10000)" \
  --rpc-url base_sepolia --account fobal-deployer
```

## Verification

`--verify` with `BASESCAN_API_KEY` verifies automatically. Manual:
```bash
forge verify-contract <address> src/FobalPlayer.sol:FobalPlayer \
  --chain base-sepolia --watch \
  --constructor-args $(cast abi-encode "constructor(address)" $FOBAL_ADMIN)
```
Repeat per contract with its constructor args (see `Deploy.s.sol`).

## Deployment artifact

`deployments/<chainId>.json` is machine-readable for the frontend/indexer:
```json
{
  "chainId": "84532",
  "FobalPlayer": "0x...",
  "FobalAvatarRenderer": "0x...",
  "FobalPlayerGenerator": "0x...",
  "FobalTeamRegistry": "0x...",
  "FobalAssetRegistry": "0x...",
  "FobalProgression": "0x...",
  "FobalMatchEscrow": "0x...",
  "FobalMarketplace": "0x..."
}
```
ABIs are emitted to `out/<Contract>.sol/<Contract>.json` by `forge build`;
import the `abi` field directly into a viem/wagmi client.

## Handoff to a multisig (recommended before mainnet)
After deploy, transfer `DEFAULT_ADMIN_ROLE` on each contract to a Safe and
have the deployer renounce it:
```bash
cast send $CONTRACT "grantRole(bytes32,address)" $DEFAULT_ADMIN_ROLE $SAFE ...
cast send $CONTRACT "renounceRole(bytes32,address)" $DEFAULT_ADMIN_ROLE $DEPLOYER ...
```
Do this for all eight contracts. The signer keys (generator, engine) can also
be pointed at Safes — `SignatureChecker` verifies ERC-1271 signatures.
