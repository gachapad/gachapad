# Deploy

1. Copy `.env.example` to `.env` (chmod 600) and fill it in. Run `node index.js` under a process manager.
2. Put a reverse proxy with TLS in front of `PORT`. Turn off response buffering for `/events` (SSE).
3. The site is a static Vite build. Its host rewrites `/api/*`, `/m/*`, `/img/*` and `/events` to the engine. See `../vercel.json`.
4. Launch the ROOT coin on pump.fun, then adopt it with `POST /admin/root/adopt` and set `ROOT_MINT`.

## Live flags

Every flag defaults to off. Turn them on one at a time, and watch each one work before turning on the next:

1. `LAUNCH_ENABLED`: coins can be launched from the site. Needs the ROOT adopted and the canary green.
2. `DISTRIBUTE_LIVE`: crank pump.fun's distribution. 80% lands in each coin's pool, 20% in the burn wallet.
3. `CONVERT_LIVE`: each pool swaps SOL → USDC into its vault (checked and simulated).
4. `RIP_LIVE`: buy a pack from the coin's machine when its vault holds the price. The card stays in the vault.
5. `PULLS_LIVE`: holders can burn the coin to pull a card.
6. `DELIVER_LIVE`: send each drawn card to its wallet.
7. `BURN_LIVE`: the burn wallet buys and burns $Gachapad.

Kill switch: `touch data/KILL` or `POST /admin/kill`.

Admin actions:
- `POST /admin/burn-pull/<id>/resolve {retry|restock|void}`
- `POST /admin/pack/<id>/resolve`
