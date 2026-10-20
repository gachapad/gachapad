# Gachapad

**Every coin gets a gacha machine.** Gachapad is a launchpad built on pump.fun's packs update.

When you launch a coin, you pick one of the Collector Crypt machines pump.fun now sells. The coin's trading fees buy packs from that machine. Every card stays inside the coin's machine. Anyone holding the coin can burn it to pull one card, and a Solana block picks which.

Site: [gachapad.tech](https://www.gachapad.tech)

## How it works

1. **Launch.** You create a normal pump.fun coin through the site and pick its machine, for example Pokémon $25, One Piece $50 or Sports $100. The machine is written into the coin's metadata and never changes.
2. **Fees are locked.** In the same flow, the coin's creator fees are split with pump.fun's own fee sharing, and the admin is revoked, so the split can't be changed by anyone:

   | share | goes to |
   |---|---|
   | 80% | the coin's own pool. It is swapped to USDC and buys packs from the coin's machine. |
   | 20% | the burn wallet. It buys $Gachapad and burns it. |

3. **Packs are ripped.** When a coin's vault holds the pack price, the engine buys a pack from that coin's machine. The card goes into the coin's vault wallet and stays there. That is the machine's stock.
4. **Pull.** A holder burns the coin to pull one card from the stock, and the card is sent to their wallet.

## Pulls

- **Price.** One pull costs the average insured value of the cards in the machine plus 10%, paid in the coin.
  - The coin is priced at its *lowest* fresh on-chain reading over the last 10 minutes, so a pump never makes a pull cheaper.
  - The readings must cover at least 80% of that window.
- **One pull at a time per machine.** The quote saves the exact list of cards that can be won. No second pull can start on that machine until this one finishes.
- **The burn.** Your wallet signs a `burnChecked` of the coin plus a memo `gachapad:pull:<id>`. The engine only accepts the burn when all of these hold:
  - the transaction is **finalized**;
  - it carries exactly one Gachapad memo, which is ours;
  - it burns at least the quote, of this coin, from this wallet;
  - it lowers that wallet's balance;
  - it was built on the quote's blockhash. That prevents replays and durable-nonce tricks.
- **The pick.**
  1. After the burn, the card list is frozen and hashed.
  2. The seed block is set `DRAW_DELAY_SLOTS` (40) slots ahead. Nobody, including us, can know that block while the list could still change.
  3. Then:
     ```
     seed = sha256(first finalized blockhash at or after seedSlot | pull id | burn signature | list hash)
     card = list[seed mod n]
     ```
  4. The vault sends that card to the wallet.
- **Verify any pull.** Each pull's page on the site shows the frozen list, its hash, the seed slot, the burn signature and the chosen index. You can recompute the seed from public chain data with `pullSeed` and `pickCard` in [`backend/pulls.js`](backend/pulls.js).

## Trust model

**You can check these on-chain:**
- the fee split and its revoked admin, in each coin's pump.fun fee-sharing config;
- every pack purchase;
- every card sitting in a coin's vault wallet;
- every burn;
- every card sent out;
- every $Gachapad buy-and-burn.

**You trust the operator to run this code.** The engine key derives every coin's pool and vault wallet, so the vaults are custodial. Publishing the code lets you see exactly what the engine does. Every action it takes is a public transaction you can audit against this code.

Public wallets:

| wallet | address |
|---|---|
| engine (derives each coin's pool + vault) | `FhuYdff46JbCnVDStVuh5HkP5CsKH6eLrxXVWw6eQi5u` |
| burn (buys + burns $Gachapad) | `AYW38MBmyP8piAMRooaQjjgKC7nyurJANfzEpp4NVX1E` |
| protocol (0% share, required by pump.fun) | `DjNATX9boK9Ta9Ta7agvFgpiWpScgFFGocrzcgsKfrTA` |

The cards are Collector Crypt cards. Each is an NFT backed by a real graded slab (PSA, CGC or BGS) held by Collector Crypt.

## Safety

- **Everything that moves money is behind its own live flag, and every flag defaults to off:** `LAUNCH_ENABLED`, `DISTRIBUTE_LIVE`, `CONVERT_LIVE`, `RIP_LIVE`, `PULLS_LIVE`, `DELIVER_LIVE` and `BURN_LIVE`.
- **Kill switch.** It is checked right before every send.
- **Journal first.** Every transaction is journaled (raw bytes and signature) before its first broadcast.
  - It is only ever rebroadcast with the same bytes.
  - It is marked "not landed" only on finalized proof.
- **Simulation.** Swaps and pack purchases are simulated and checked against an allowlist before they are signed.
- **Tests.** `test.js` (502 checks), `test-packs.js`, `test-freeze.mjs`, `test-pulls.mjs`, and `test-pull-flow.mjs`, which plays the full pull flow against a fake chain, including replay, lapse, lagging-RPC, crash-resume and failed-burn cases.
- **Adversarial review.** An adversarial review of the pull money path found one critical, two high and three medium issues. All are fixed and covered by `test-pull-flow.mjs`.

## Layout

```
backend/   the engine: Node 22 ESM, Express, one process, one data dir
  pulls.js     burn-to-pull: quotes, burn verification, freeze, draw, delivery
  packs.js     per-coin machines: rip packs, stock
  launch.js    launch → lock fee sharing → adopt
  distribute.js, burner.js, pump.js, solana.js, store.js, registry.js, config.js
  scripts/     mainnet dry runs (simulate only, send nothing) + the offline dev engine
src/       the site: Vite + React
public/    static images
```

## Run locally

```bash
npm install && (cd backend && npm install)
node backend/scripts/dev-engine.mjs --reset   # offline engine with seeded fake data on :3071
npm run dev                                   # site on :5207
cd backend && node test.js && node test-packs.js && node test-freeze.mjs && node test-pulls.mjs && node test-pull-flow.mjs
```

Production configuration: [`backend/.env.example`](backend/.env.example) and [`backend/DEPLOY.md`](backend/DEPLOY.md).

## License

MIT, see [LICENSE](LICENSE).
