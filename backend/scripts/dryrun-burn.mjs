// Mainnet SIMULATION of the burner's two transactions against stand-in ROOTs. Sends NOTHING.
//   [1] the burner's OWN ROOT buy (burner.buildRootBuy: pump curve or PumpSwap, built from on-chain reserves — no
//       third-party bytes), its instruction allowlist (assertBurnTx) and its post-state check (checkBurnSimulation:
//       the wallet spends ≤ what it asked + fees + ATA rent and receives ≥ the quoted minimum). A funded wallet stands
//       in for the burn wallet; nothing is signed (sigVerify off). Run for a curve coin AND a graduated coin.
//   [2] burnChecked (Token-2022) of a real holder's whole ROOT balance (sigVerify off)
// Usage: node scripts/dryrun-burn.mjs [graduatedRootMint] [curveRootMint] [funded-wallet]
import { dryEnv } from './_env.mjs'
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { createBurnCheckedInstruction, getAssociatedTokenAddressSync, getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'

const gradRoot = process.argv[2] || 'SYLxv8TvHf5uAzAFhnTvyoYyxAuGYpjN3qYVWE6pump'
const curveRoot = process.argv[3] || 'GtJrSFQP4ooq58dBbJBB8qQ1soxqzp1UuJGPTvvYpump'
const payer = process.argv[4] || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
await dryEnv()
const sol = await import('../solana.js')
const rounds = await import('../rounds.js')
const burner = await import('../burner.js')
const M = await import('../math.js')
const conn = sol.getConnection()
await sol.loadRent()
let ok = true
const programOf = async m => ((await conn.getAccountInfo(new PublicKey(m))).owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID)

// [1] the burner's own buy, for a graduated and a curve ROOT
for (const [label, root] of [['graduated ROOT (PumpSwap)', gradRoot], ['curve ROOT (pump curve)', curveRoot]]) {
  try {
    const spend = 20_000_000n
    const balance = await sol.balanceOf(payer)
    const built = await burner.buildRootBuy({ owner: payer, mint: root, lamports: spend, signers: [] })
    const progs = [...new Set(built.tx.message.compiledInstructions.map(ix => built.tx.message.staticAccountKeys[ix.programIdIndex].toBase58()))]
    const { gained } = await burner.checkBurnSimulation(built, { owner: payer, mint: root, program: await programOf(root), lamports: spend, balance })
    console.log(`[1] ${label} ${root}: route ${built.quote.route} · quoted ${built.quote.outAmount} (min ${built.quote.minOut}) · ${built.tx.serialize().length} bytes · programs ${progs.map(p => p.slice(0, 6)).join(', ')} · SIMULATED OK, post-state check passed (ROOT gained ${gained})`)
  } catch (e) { ok = false; console.log(`[1] ${label} ${root}: FAILED ${e.message}`) }
}
// the allowlist refuses a drain (what a hostile third party could have returned)
{
  const { Keypair, SystemProgram } = await import('@solana/web3.js')
  const drain = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(payer), toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 })] }).compileToV0Message())
  let refused = false
  try { burner.assertBurnTx(drain, payer) } catch { refused = true }
  console.log(`[1] a drain tx (transfer to a stranger) → ${refused ? 'refused by assertBurnTx' : 'ACCEPTED (bug)'}`)
  ok = ok && refused
}
// [2] burnChecked of a holder's whole balance
const root = gradRoot
const program = await programOf(root)
const mint = await getMint(conn, new PublicKey(root), 'confirmed', program)
const snap = await rounds.snapshotHolders(root)
const holder = [...snap].filter(([o]) => !M.isReservedKey(o)).sort((a, b) => (b[1] > a[1] ? 1 : -1))[0]
const owner = new PublicKey(holder[0])
const ata = getAssociatedTokenAddressSync(new PublicKey(root), owner, false, program)
const bal = BigInt((await conn.getTokenAccountBalance(ata)).value.amount)
const { blockhash } = await conn.getLatestBlockhash('confirmed')
const burnTx = new VersionedTransaction(new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [...sol.budgetIxs(100_000), createBurnCheckedInstruction(ata, new PublicKey(root), owner, bal, mint.decimals, [], program)] }).compileToV0Message())
const r2 = await conn.simulateTransaction(burnTx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
console.log(`[2] burnChecked of ${Number(bal) / 10 ** mint.decimals} ROOT (${program.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : 'SPL'}) from a holder's ATA: ${r2.value.err ? 'FAILED ' + JSON.stringify(r2.value.err) : 'SIMULATED OK'} · ${r2.value.unitsConsumed} CU · ${burnTx.serialize().length} bytes`)
ok = ok && !r2.value.err
console.log(ok ? '\nBURN DRY RUN OK — nothing was sent.' : '\nBURN DRY RUN FAILED — read above.')
process.exit(ok ? 0 : 1)
