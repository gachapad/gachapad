// Mainnet SIMULATION of pump's sweep_creator_fee (curve bucket → creator vault) on real coins. Sends NOTHING.
// pump.fun's 2026-10 upgrade leaves v3 trades' creator fee on the curve until this permissionless sweep; an un-swept
// bucket blocks distribute and fee-sharing creation (6095 CreatorFeesNotSwept). Checks our hand-built instruction
// against the live program and reads the simulated curve: the bucket must be 0 afterwards.
// Usage: node scripts/dryrun-sweep.mjs <mint> [mint ...]
import { dryEnv } from './_env.mjs'
import { TransactionMessage, VersionedTransaction, ComputeBudgetProgram, PublicKey } from '@solana/web3.js'

await dryEnv()
const pump = await import('../pump.js')
const sol = await import('../solana.js')
const payer = new PublicKey('5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9') // any funded wallet: it only pays the (simulated) fee
const conn = sol.getConnection()
let bad = 0
for (const mint of process.argv.slice(2)) {
  const bucket = await pump.readCurveFeeBucket(mint)
  const ixs = await pump.curveSweepIxs({ payer, mint })
  console.log(`=== ${mint}\nbucket ${sol.sol(bucket).toFixed(6)} SOL · sweep instructions ${ixs.length}`)
  if (!ixs.length) continue
  const { blockhash } = await conn.getLatestBlockhash('confirmed')
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), ...ixs] }).compileToV0Message()
  const bc = pump.bondingCurvePda(new PublicKey(mint)).toBase58()
  const r = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: [bc] } })
  const acc = r.value.accounts?.[0]
  const after = acc ? pump.curveCreatorFeeBucket(Buffer.from(acc.data[0], 'base64')) : null
  if (r.value.err || after !== 0n) bad++
  console.log(`${r.value.err ? `SIMULATION FAILED ${JSON.stringify(r.value.err)}` : 'SIMULATED OK'} · ${r.value.unitsConsumed} CU · bucket after ${after == null ? '?' : sol.sol(after).toFixed(6)} SOL`)
  for (const l of (r.value.logs || []).filter(l => /Error|failed/.test(l)).slice(0, 4)) console.log('  ' + l)
}
console.log(bad ? '\nSOMETHING FAILED — read above.' : '\nSWEEP DRY RUN OK — nothing was sent.')
process.exit(bad ? 1 : 0)
