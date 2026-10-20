// Mainnet SIMULATION of pump.fun's creator-fee sweeps on real coins. Sends NOTHING.
// pump.fun's 2026-10 upgrade leaves creator fees in buckets until a permissionless sweep:
//   - curve: pump `sweep_creator_fee` (BondingCurve.creator_fee → creator vault); blocks distribute + fee-sharing
//     creation (pump 6095 CreatorFeesNotSwept)
//   - pool (graduated coins): pump-amm `sweep_creator_fee` (Pool.creator_fees → coin-creator vault ATA); blocks the
//     consolidation / fee sharing of a graduated coin (pump-amm 6081, pump-fees 6033)
// Checks our hand-built instructions against the live programs and reads the simulated accounts: each bucket must be 0.
// Usage: node scripts/dryrun-sweep.mjs <mint> [mint ...]
import { dryEnv } from './_env.mjs'
import { TransactionMessage, VersionedTransaction, ComputeBudgetProgram, PublicKey } from '@solana/web3.js'

await dryEnv()
const pump = await import('../pump.js')
const sol = await import('../solana.js')
const payer = new PublicKey('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9') // any funded wallet: it only pays the (simulated) fee
const conn = sol.getConnection()
let bad = 0

async function simulate(label, ixs, account, readBucket) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed')
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 150_000 }), ...ixs] }).compileToV0Message()
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [account] } })
  const acc = r.value.accounts?.[0]
  const after = acc ? readBucket(Buffer.from(acc.data[0], 'base64')) : null
  if (r.value.err || after !== 0n) bad++
  console.log(`${label}: ${r.value.err ? `SIMULATION FAILED ${JSON.stringify(r.value.err)}` : 'SIMULATED OK'} · ${r.value.unitsConsumed} CU · bucket after ${after == null ? '?' : sol.sol(after).toFixed(6)} SOL`)
  for (const l of (r.value.logs || []).filter(l => /Error|failed/.test(l)).slice(0, 4)) console.log('  ' + l)
}

for (const mint of process.argv.slice(2)) {
  console.log(`=== ${mint}`)
  const curveBucket = await pump.readCurveFeeBucket(mint)
  const curveIxs = await pump.curveSweepIxs({ payer, mint })
  console.log(`curve bucket ${sol.sol(curveBucket).toFixed(6)} SOL · sweep instructions ${curveIxs.length}`)
  if (curveIxs.length) await simulate('curve sweep', curveIxs, pump.bondingCurvePda(new PublicKey(mint)).toBase58(), pump.curveCreatorFeeBucket)
  const poolBucket = await pump.readPoolFeeBucket(mint)
  const poolIxs = await pump.poolSweepIxs({ payer, mint })
  console.log(`pool bucket ${sol.sol(poolBucket).toFixed(6)} SOL · sweep instructions ${poolIxs.length}`)
  if (poolIxs.length) await simulate('pool sweep', poolIxs, pump.canonicalPumpPoolPda(new PublicKey(mint)).toBase58(), d => pump.poolFeeBuckets(d).creator)
}
console.log(bad ? '\nSOMETHING FAILED — read above.' : '\nSWEEP DRY RUN OK — nothing was sent.')
process.exit(bad ? 1 : 0)
