// Mainnet DRY RUN of one holder round on a REAL coin's holders. Sends NOTHING.
//   snapshot the coin's holders twice (open, then close ~N s later: gPA on Token-2022, memcmp mint @0, slice {32,40},
//   no dataSize), weight = min(open, close), exclusions, account kinds of the candidates, a full allocation of a
//   hypothetical pool balance (exact BigInt, cap, rent(0) rule, MAX_RECIPIENTS), then the payout batches: every
//   batch tx is BUILT and its size measured; the first batch is SIMULATED (a funded wallet stands in for the pool).
// Usage: node scripts/dryrun-round.mjs [mint] [poolSol] [secondsBetweenSnapshots]
import { dryEnv } from './_env.mjs'
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'

const mint = process.argv[2] || 'SYLxv8TvHf5uAzAFhnTvyoYyxAuGYpjN3qYVWE6pump'
const poolSol = Number(process.argv[3] ?? 2)
const gap = Number(process.argv[4] ?? 20)
const standIn = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
await dryEnv()
const { config } = await import('../config.js')
const sol = await import('../solana.js')
const store = await import('../store.js')
const M = await import('../math.js')
const rounds = await import('../rounds.js')
const launch = await import('../launch.js')
const paysol = await import('../paysol.js')
store.loadAllStores()
const conn = sol.getConnection()
const r0 = await sol.loadRent()
const root = await launch.adoptRoot(mint) // registers the coin so its own keys join the exclusions
const t0 = Date.now()
const open = await rounds.snapshotHolders(mint)
console.log(`open snapshot: ${open.size} holders (${Date.now() - t0} ms, one getProgramAccounts)`)
await new Promise(r => setTimeout(r, gap * 1000))
const close = await rounds.snapshotHolders(mint)
console.log(`close snapshot after ${gap}s: ${close.size} holders`)
const weights = M.minWeights(open, close)
const excluded = rounds.roundExclusions(root.holderPool)
const minTokensRaw = BigInt(Math.floor(config.holderMinTokens)) * 1_000_000n
const offCurve = [...weights.keys()].filter(o => M.isReservedKey(o))
const ranked = M.rankEligible(weights, { excluded, minTokensRaw })
const dust = [...weights].filter(([o, w]) => !M.isReservedKey(o) && !excluded.has(o) && w < minTokensRaw).length
console.log(`weights (min of both): ${weights.size} · off-curve / reserved owners excluded: ${offCurve.length} (they hold ${(Number(offCurve.reduce((s, o) => s + weights.get(o), 0n)) / 1e15 * 100).toFixed(2)}% of supply: curve / PumpSwap pool / vaults) · dust < ${config.holderMinTokens} tokens: ${dust} · eligible: ${ranked.length}`)
const window = ranked.slice(0, config.maxRecipients + 100).map(x => x.owner)
const kinds = await sol.walletKinds(window)
const missing = [...kinds.values()].filter(k => k.kind === 'wallet' && k.lamports === 0n).length
const progs = [...kinds.values()].filter(k => k.kind === 'program').length
console.log(`account kinds of the top ${window.length}: ${missing} have no SOL account (rent rule applies), ${progs} program-owned (never paid)`)
const poolLamports = sol.toLamports(poolSol)
const plan = rounds.planRound({ open, close, poolLamports, kinds, excluded, rent: r0 })
const paid = plan.items.reduce((s, i) => s + i.lamports, 0n)
const cap = (plan.budget * BigInt(config.maxWalletShareBps)) / 10_000n
console.log(`\nhypothetical pool ${poolSol} SOL → budget ${sol.sol(plan.budget)} SOL (pool − rent(0) − ${config.poolMarginSol} margin − ${sol.sol(paysol.roundFeeLamports(Math.min(ranked.length, config.maxRecipients)))} fees)`)
console.log(`paid ${plan.items.length} holders · Σ ${sol.sol(paid)} SOL + leftover ${sol.sol(plan.leftover)} = ${sol.sol(paid + plan.leftover)} (exact: ${paid + plan.leftover === plan.budget}) · max share ${sol.sol(plan.items.reduce((m, i) => (i.lamports > m ? i.lamports : m), 0n))} ≤ cap ${sol.sol(cap)} · min share ${sol.sol(plan.items.reduce((m, i) => (i.lamports < m ? i.lamports : m), 10n ** 18n))}`)
const missingPaid = plan.items.filter(i => kinds.get(i.wallet)?.lamports === 0n)
console.log(`missing accounts paid: ${missingPaid.length} (each ≥ rent(0) ${r0}: ${missingPaid.every(i => i.lamports >= r0)}) · capped: ${plan.items.filter(i => i.lamports === cap).length}`)
// below the payable floor (MIN_PAYOUT × 10000 / MAX_WALLET_SHARE_BPS) no holder can be paid, whoever holds: such a pool
// opens no round and keeps none open (rounds.js roundWorthy / close). Checked on these REAL holders:
const floor = rounds.roundFloorLamports()
const under = rounds.planRound({ open, close, poolLamports: r0 + sol.toLamports(config.poolMarginSol) + paysol.roundFeeLamports(Math.min(ranked.length, config.maxRecipients)) + floor - 1n, kinds, excluded, rent: r0 })
console.log(`payable floor ${sol.sol(floor)} SOL: a budget 1 lamport below it (${sol.sol(under.budget)} SOL) pays ${under.items.length} of ${ranked.length} real holders (must be 0)`)
// the open threshold sets aside a WHOLE round's worst-case fees: a pool 1 lamport above it closes with a budget ≥ the
// floor (it pays someone or chains the next round), never open → skipped → reopen every window
const atOpen = rounds.planRound({ open, close, poolLamports: rounds.roundOpenThreshold() + 1n, kinds, excluded, rent: r0 })
console.log(`open threshold ${sol.sol(rounds.roundOpenThreshold())} SOL (reserve + ${config.maxRecipients}-payee fees + floor): a pool 1 lamport above it closes with budget ${sol.sol(atOpen.budget)} SOL ≥ floor: ${atOpen.budget >= floor} (pays ${atOpen.items.length} of ${ranked.length})`)
const batches = M.chunkItems(plan.items, config.payoutsPerTx)
const { blockhash } = await conn.getLatestBlockhash('confirmed')
const sizes = []
let simOk = true
for (let i = 0; i < batches.length; i++) {
  const b = batches[i]
  const units = 5_000 + 600 * b.length
  const payer = i === 0 ? standIn : root.holderPool
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: [...sol.budgetIxs(units), ...b.map(x => sol.transferIx(payer, x.wallet, x.lamports))] }).compileToV0Message())
  sizes.push(tx.serialize().length)
  if (i === 0) {
    const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
    simOk = !r.value.err
    console.log(`\nbatch 1 of ${batches.length} (${b.length} transfers, a funded wallet standing in for the pool) SIMULATED: ${r.value.err ? 'FAILED ' + JSON.stringify(r.value.err) : 'OK'} · ${r.value.unitsConsumed} CU`)
    if (r.value.err) console.log((r.value.logs || []).slice(-6).join('\n'))
  }
}
console.log(`batch tx sizes (bytes, limit 1232): ${sizes.join(', ')} · fee per batch ${sol.txFeeLamports(5_000 + 600 * config.payoutsPerTx)} lamports`)
const ok = simOk && paid + plan.leftover === plan.budget && sizes.every(s => s <= 1232) && under.items.length === 0 && under.budget === floor - 1n && atOpen.budget >= floor
console.log(ok ? '\nROUND DRY RUN OK — nothing was sent.' : '\nROUND DRY RUN FAILED — read above.')
process.exit(ok ? 0 : 1)
