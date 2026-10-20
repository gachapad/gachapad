# Gachapad engine

One Node 22 ESM process and one data directory. It launches coins, locks their pump.fun fee sharing, cranks distribution, converts each coin's pool to USDC, rips packs into the coin's vault, runs burn-to-pull and buys and burns $GACHA. Overview and trust model: [`../README.md`](../README.md).

| file | what |
|---|---|
| `config.js` | Everything comes from env. Fail-closed `configProblems`. Every tunable has its default here. |
| `solana.js` | Connection, engine and burn keys, **frozen derivations** `gpump-coin:v1:` / `gpump-pool:v1:` / `gpump-vault:v1:` + mint, `settleTx` (same-bytes rebroadcast, "not landed" only on finalized proof). |
| `pump.js` | pump.fun create (+buy), bonding curves, PumpSwap pools, creator vaults, the fee-sharing lock, distribute, trade builders. |
| `launch.js` | prepare → submit → register → lock → sweep. Machine (`packCode`) validation, pinned in metadata. Root adoption. |
| `distribute.js` | The permissionless crank. It books only measured deltas, never an estimate. |
| `packs.js` + `cc.js` + `gacha.js` | Per-coin machines: Collector Crypt pack purchase, open, card into the coin's vault (`stock`). pump.fun's `gacha-inventory` is read for display only. |
| `pulls.js` | Burn-to-pull: quote, burn verification, freeze, draw, delivery, `unseen` re-reads, resolve. |
| `burner.js` | The burn wallet buys $GACHA (curve or PumpSwap, built and simulated by the engine) → `burnChecked`. |
| `store.js` | Durable money stores (fsync, fail closed), journals, quarantine. |
| `index.js` | Express API, SSE, micro-cache, rate limits, admin, loops. |

## Run

```bash
npm install
node test.js && node test-packs.js && node test-freeze.mjs && node test-pulls.mjs && node test-pull-flow.mjs
node scripts/dev-engine.mjs --reset      # offline, seeded fake data
node index.js                            # production: reads .env (see .env.example and DEPLOY.md)
```

Mainnet dry runs simulate only and send nothing. They use throwaway keys and `RPC_URL` (falling back to a public RPC):
- `scripts/canary.mjs`
- `scripts/dryrun-launch.mjs`, `scripts/dryrun-lock.mjs`, `scripts/dryrun-distribute.mjs`, `scripts/dryrun-swap.mjs`, `scripts/dryrun-burn.mjs`
- `scripts/dryrun-pull.mjs <mint> <holder> <tokens>`
- `scripts/dryrun-sweep.mjs <mint>`: pump.fun's `sweep_creator_fee` (the curve's creator-fee bucket, which must be swept before a distribute or a fee-sharing lock)
- `scripts/probe-packs.mjs`

## Money rules

- Journal the intent (raw bytes, signature, last valid block height) before the first broadcast. Rebroadcast the same bytes only. Mark "not landed" only on finalized-height proof.
- Book measured deltas only.
- The kill switch (`data/KILL`, `POST /admin/kill`) is checked right before every send.
- The derivation strings are forever. Renaming them orphans every coin's pool and vault.
- One pull in flight per machine. A burn counts only when it is finalized, carries exactly one Gachapad memo, was built on the quote's blockhash, and burns at least the quote from the quoting wallet.
