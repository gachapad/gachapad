// Mainnet DRY RUN of the site's trade path (/quote + /tx/swap). Sends NOTHING.
// For a curve coin (pump SDK buyInstructions / sellInstructions) and a graduated coin (pump-swap-sdk buyQuoteInput /
// sellBaseInput on the canonical pool): quote, build the unsigned tx exactly as /tx/swap does (the user is the ONLY
// signer), and SIMULATE it (sigVerify off) — a buy from a funded wallet, a sell from a real holder of the coin.
// Plus: a pair that is not SOL↔one of our coins is refused (the engine is no open quote proxy), repeated quotes of one
// coin share one state read, and the /tx/send refusal of an engine-signed tx.
// Usage: node scripts/dryrun-swap.mjs [curveMint] [graduatedMint]
import { dryEnv } from './_env.mjs'
import { VersionedTransaction } from '@solana/web3.js'

const curveMint = process.argv[2] || 'GtJrSFQP4ooq58dBbJBB8qQ1soxqzp1UuJGPTvvYpump'
const gradMint = process.argv[3] || 'SYLxv8TvHf5uAzAFhnTvyoYyxAuGYpjN3qYVWE6pump'
const buyer = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
await dryEnv()
const sol = await import('../solana.js')
const store = await import('../store.js')
const trades = await import('../trades.js')
const rounds = await import('../rounds.js')
const registry = await import('../registry.js')
const M = await import('../math.js')
store.loadAllStores()
// /quote + /tx/swap serve our own coins only: register the two stand-ins in this throwaway data dir
for (const [m, s] of [[curveMint, 'CURVE'], [gradMint, 'GRAD']]) registry.putCoin({ mint: m, symbol: s, name: s, parent: null, level: 0, root: false, creator: buyer, shares: [], createdAt: Date.now(), hidden: false, external: true, sharing: null, swept: true })
const conn = sol.getConnection()
await sol.loadRent()
let ok = true

async function simTx(label, b64, signer) {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'))
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map(k => k.toBase58())
  console.log(`  ${label}: ${r.value.err ? 'FAILED ' + JSON.stringify(r.value.err) : 'SIMULATED OK'} · ${r.value.unitsConsumed} CU · ${Buffer.from(b64, 'base64').length} bytes · sole signer = the user: ${signers.length === 1 && signers[0] === signer}`)
  if (r.value.err) { console.log('   ' + (r.value.logs || []).slice(-6).join('\n   ')); return false }
  return signers.length === 1 && signers[0] === signer
}
async function holderOf(mint) {
  const snap = await rounds.snapshotHolders(mint)
  const best = [...snap].filter(([o]) => !M.isReservedKey(o)).sort((a, b) => (b[1] > a[1] ? 1 : -1))
  return best.length ? { wallet: best[0][0], amount: best[0][1] } : null
}

for (const [label, mint] of [['curve coin', curveMint], ['graduated coin', gradMint]]) {
  console.log(`\n=== ${label} ${mint}`)
  try {
    const qb = await trades.quote({ input: 'SOL', output: mint, amount: String(50_000_000), slippageBps: 300 })
    console.log(`  /quote buy 0.05 SOL → ${JSON.stringify({ route: qb.route, outAmount: qb.outAmount, minOut: qb.minOut, priceImpactPct: qb.priceImpactPct, feeBps: qb.feeBps })}`)
    const b = await trades.buildSwap({ wallet: buyer, input: 'SOL', output: mint, amount: String(50_000_000), slippageBps: 300 })
    ok = (await simTx(`/tx/swap buy (route ${b.route})`, b.tx, buyer)) && ok
    const h = await holderOf(mint)
    if (!h) { console.log('  no holder found for a sell simulation'); continue }
    const sellAmt = (h.amount / 10n) > 0n ? h.amount / 10n : h.amount
    const qs = await trades.quote({ input: mint, output: 'SOL', amount: sellAmt.toString(), slippageBps: 300 })
    console.log(`  /quote sell ${Number(sellAmt) / 1e6} tokens → ${JSON.stringify({ route: qs.route, outAmount: qs.outAmount, minOut: qs.minOut, priceImpactPct: qs.priceImpactPct, feeBps: qs.feeBps })}`)
    const s = await trades.buildSwap({ wallet: h.wallet, input: mint, output: 'SOL', amount: sellAmt.toString(), slippageBps: 300 })
    ok = (await simTx(`/tx/swap sell by holder ${h.wallet.slice(0, 6)}… (route ${s.route})`, s.tx, h.wallet)) && ok
  } catch (e) { ok = false; console.log(`  ERROR ${e.message}`) }
}
console.log('\n=== a pair that is not SOL ↔ one of our coins is refused (no open quote proxy)')
{
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
  const e1 = await trades.quote({ input: USDC, output: 'SOL', amount: '5000000', slippageBps: 100 }).then(() => null, x => x)
  const e2 = await trades.quote({ input: USDC, output: curveMint, amount: '5000000', slippageBps: 100 }).then(() => null, x => x)
  console.log(`  USDC → SOL: ${e1 ? `refused ${e1.code} (${e1.message})` : 'QUOTED (bug)'} · USDC → coin: ${e2 ? `refused ${e2.code} (${e2.message})` : 'QUOTED (bug)'}`)
  if (!e1 || !e2) ok = false
}
console.log('\n=== 20 quotes of one coin with 20 different amounts share one state read (2 s)')
{
  await new Promise(r => setTimeout(r, 2500)) // let the state from the quotes above expire: the first quote below reads fresh
  let calls = 0
  const orig = conn._rpcRequest
  conn._rpcRequest = (m, a) => { calls++; return orig(m, a) }
  const t0 = Date.now()
  for (let i = 0; i < 20; i++) await trades.quote({ input: 'SOL', output: gradMint, amount: String(10_000_000 + i * 7919), slippageBps: 300 })
  conn._rpcRequest = orig
  console.log(`  ${calls} RPC calls for 20 quotes in ${Date.now() - t0} ms (uncached: ≈ 4 per quote = 80)`)
  if (calls < 1 || calls > 8) ok = false
}
console.log('\n=== /tx/send refuses a tx that needs an engine key')
{
  const { Keypair, TransactionMessage, VersionedTransaction: VT } = await import('@solana/web3.js')
  const engine = sol.getEngine()
  const tx = new VT(new TransactionMessage({ payerKey: engine.publicKey, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [sol.transferIx(engine.publicKey, Keypair.generate().publicKey, 1n)] }).compileToV0Message())
  tx.sign([engine])
  const e = await trades.relay(Buffer.from(tx.serialize()).toString('base64'), { send: false }).then(() => null, x => x)
  console.log(`  engine-signed tx → ${e ? `refused ${e.code} (${e.message})` : 'ACCEPTED (bug)'}`)
  if (!e || e.code !== 403) ok = false
}
console.log(ok ? '\nSWAP DRY RUN OK — nothing was sent.' : '\nSWAP DRY RUN FAILED — read above.')
process.exit(ok ? 0 : 1)
