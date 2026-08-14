# Base Sepolia deploy — the M5 activation runbook

The one ceremony that turns the NFT-teams feature on for real players.
Executed start-to-finish by **the human** on their own machine — the four
protocol keys never touch an agent, a chat, or the repository. Sairi's only
part is the AWS redeploy at the end (no keys involved). Rehearsed
end-to-end against a local anvil before this document was written; every
command below ran verbatim there.

**Testnet only.** Nothing in this runbook may be pointed at Base mainnet.
Every key created here is a throwaway that must never hold real value;
mainnet (if it ever happens) gets fresh keys, a multisig admin, and its own
ceremony.

---

## 0. One-time tooling

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

```bash
cd contracts && forge install --no-git foundry-rs/forge-std@v1.16.2 && forge install --no-git OpenZeppelin/openzeppelin-contracts@v5.4.0 && forge build
```

Optional confidence pass: `forge test` (87 unit/fuzz/invariant tests).

## 1. Identities — four addresses, four fresh keys

Generate four brand-new keypairs (`cast wallet new`, four times):

| Identity | Purpose | Where the key lives |
|---|---|---|
| **admin** (= treasury on testnet) | deploys, holds `DEFAULT_ADMIN_ROLE`, receives fees | foundry keystore (step below) |
| **generator signer** | signs EIP-712 `SquadMint` — the only mint path | password manager; used once in step 5, testnet-only |
| **engine signer** | signs EIP-712 `MatchResult` for escrow settlement (unused until on-chain settlement wiring exists) | password manager |
| **player wallet** | YOUR squad's owner — imports into the browser wallet (MetaMask) that signs into the lobby | password manager + MetaMask. Never your real wallet. |

Record all four **addresses**. Import only the admin key into the keystore —
the prompt reads it interactively, so it never lands in shell history:

```bash
cast wallet import fobal-admin --interactive
```

## 2. Fund two of them

Base Sepolia ETH from the Coinbase Developer Platform faucet or Alchemy's
faucet (or bridge Sepolia ETH via the official Base bridge):

- **admin** — deploy gas (the eight contracts are large; get ~0.05 ETH)
- **player wallet** — mint + registry gas (~0.01 ETH)

## 3. Environment — `contracts/.env` (gitignored; ADDRESSES ONLY, no keys)

```
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASESCAN_API_KEY=<your basescan/etherscan api key>
FOBAL_ADMIN=0x<admin address>
FOBAL_TREASURY=0x<admin address again — testnet treasury>
FOBAL_GENERATOR_SIGNER=0x<generator signer address>
FOBAL_ENGINE_SIGNER=0x<engine signer address>
```

Foundry auto-loads `.env` from the project root. The public
`sepolia.base.org` endpoint is fine here and later for the lobby (reads
only); if you ever switch to a keyed RPC URL (Alchemy/QuickNode), that URL
becomes a secret — it would go to Secrets Manager, not `envs.ts`.

## 4. Deploy + verify

```bash
cd contracts && forge script script/Deploy.s.sol --rpc-url base_sepolia --account fobal-admin --broadcast --verify
```

The broadcaster must be the admin (the script grants roles mid-deploy) —
`--account fobal-admin` does exactly that, prompting for the keystore
password. If Basescan verification flakes, re-run the same command with
`--resume --verify`; the deploy itself is not repeated.

Output: the eight addresses, plus the artifact
`contracts/deployments/84532.json` (gitignored — it's only addresses, but
keep it; step 7 reads from it).

## 5. Mint your squad

Production minting will be a signed *service*; until it exists,
`script/MintSquad.s.sol` is the stand-in: creates your registry team, mints
a generator-signed 11 (GK first — roster order is the XI), declares the
roster. This is the one step that takes raw keys via env — **the testnet
exception**; unset them right after.

```bash
cd contracts && export FOBAL_GENERATOR_PK=<generator key> FOBAL_RECIPIENT_PK=<player wallet key> FOBAL_TEAM_NAME="YOUR CLUB NAME" && forge script script/MintSquad.s.sol --rpc-url base_sepolia --broadcast && unset FOBAL_GENERATOR_PK FOBAL_RECIPIENT_PK
```

**Write down the printed `registry team id`** — it's what you type at the
lobby's LINK NFT SQUAD box.

## 6. Smoke the chain

```bash
cast call $(python3 -c "import json;print(json.load(open('contracts/deployments/84532.json'))['FobalTeamRegistry'])") "ownerOfTeam(uint64)(address)" <team id> --rpc-url https://sepolia.base.org
```

Expect your player wallet's address. Bonus: open the FobalPlayer contract
on sepolia.basescan.org → token 1 → the tokenURI renders the generative
pixel avatar entirely on-chain.

## 7. Activate the platform

1. Hand the three values to Claude Code — "activate chain on staging:
   rpc `<url>`, player `<address>`, registry `<address>`" — which fills
   `infra/cdk/lib/envs.ts` `staging.chain` (a one-commit PR; the field is
   deliberately in code, not a deploy context, so no later deploy can
   silently drop it). Merge it.
2. Paste to Sairi:

   > Pull main, re-apply the cfn-exec inline policy
   > (infra/iam/FobalCloudFormationExecution.json — standing rule), deploy
   > fobal-staging-match-server with the usual contexts (same image tag —
   > env-only change), then rebuild/sync/invalidate the staging client
   > (lobby.html changed in PR #52). Smoke: lobby-staging /health 200.
   > Report statuses.

Prod follows the same two steps with `production.chain` once staging
proves out.

## 8. The M5 proof (you, in Chrome, MetaMask on the Base Sepolia network)

1. play-staging.fobal.ai → LOBBY → **🦊 SIGN IN WITH WALLET** → MetaMask
   prompts with the human-readable challenge → sign (no gas, no tx).
2. ON-CHAIN TEAM card → type your registry team id → **LINK NFT SQUAD** →
   *"YOUR CLUB NAME — 11 players take the field."*
3. Second tab, email login, challenge yourself, accept — your NFTs play a
   real authoritative staging match.
4. Sign in with the same wallet from another browser/device → identical
   squad, no setup — the brief's second-device proof, now on a public
   testnet.

## Security invariants (recap)

- Keys in keystore/password manager only; `.env` carries addresses, never
  keys; the MintSquad env keys are testnet throwaways, unset after use.
- No key is ever pasted into a chat, an agent prompt, or a command line
  argument (keystore prompts and env files only).
- Sairi never holds keys — AWS redeploys only. Claude only merges the
  address commit; addresses are public information.
- The generator/engine signers hold zero on-chain roles by design (bounded
  blast radius: a leaked signer can fake plausible squads/results within
  caps, never steal or seize) — treat them as secrets anyway.
