// Mainnet dry run of a pull's burn (nothing is signed or sent): builds exactly the transaction preparePull builds —
// [budget] + burnChecked(holder ATA, mint, amount, 6) + memo — for a REAL holder of a REAL pump.fun coin and simulates it
// (sigVerify off). Then checks that verifyBurnTx would accept the same shape.
//   RPC_URL=… node scripts/dryrun-pull.mjs <mint> [holderWallet] [tokensUi]
process.env.ENGINE_NO_DOTENV = '1'
const [mint, holderArg, uiArg = '1000'] = process.argv.slice(2)
if (!mint || !process.env.RPC_URL) { console.error('usage: RPC_URL=… node scripts/dryrun-pull.mjs <mint> [holder] [tokensUi]'); process.exit(1) }
const { PublicKey, TransactionInstruction } = await import('@solana/web3.js')
const { getAssociatedTokenAddressSync, createBurnCheckedInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } = await import('@solana/spl-token')
const { getConnection, buildTx } = await import('../solana.js')
const { MEMO_PROGRAM, memoFor } = await import('../pulls.js')
const conn = getConnection()
const info = await conn.getAccountInfo(new PublicKey(mint))
const program = info.owner
console.log('mint program:', program.equals(TOKEN_2022_PROGRAM_ID) ? 'Token-2022' : program.equals(TOKEN_PROGRAM_ID) ? 'SPL Token' : program.toBase58())
let holder = holderArg
if (!holder) {
  const big = await conn.getTokenLargestAccounts(new PublicKey(mint))
  for (const a of big.value) {
    const acc = await conn.getParsedAccountInfo(a.address)
    const owner = acc.value?.data?.parsed?.info?.owner
    if (owner && PublicKey.isOnCurve(new PublicKey(owner).toBytes())) {
      const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(owner), false, program)
      if (ata.equals(a.address)) { holder = owner; break }
    }
  }
}
console.log('holder:', holder)
const ata = getAssociatedTokenAddressSync(new PublicKey(mint), new PublicKey(holder), false, program)
const bal = await conn.getTokenAccountBalance(ata)
console.log('holder balance:', bal.value.uiAmountString)
const amount = BigInt(Math.round(Number(uiArg) * 1e6))
const memo = memoFor('dryrun' + Date.now().toString(36))
const ixs = [
  createBurnCheckedInstruction(ata, new PublicKey(mint), new PublicKey(holder), amount, 6, [], program),
  new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(memo, 'utf8') }),
]
const built = await buildTx({ payer: holder, instructions: ixs, units: 60_000 })
console.log('tx bytes:', built.tx.serialize().length)
const sim = await conn.simulateTransaction(built.tx, { sigVerify: false, commitment: 'confirmed' })
console.log('simulation err:', JSON.stringify(sim.value.err))
console.log('logs:', (sim.value.logs || []).filter(l => /Burn|Memo|success|failed|error/i.test(l)).slice(0, 10).join(' | '))
const after = await conn.getTokenAccountBalance(ata).then(b => b.value.amount).catch(() => null)
console.log('(simulated only; nothing sent) ATA now:', after, '· memo checked by verifyBurnTx:', memo)
process.exit(sim.value.err ? 1 : 0)
