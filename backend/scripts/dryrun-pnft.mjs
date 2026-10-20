// Mainnet SIMULATION of a card delivery: read card <id> (Core or pNFT) and simulate moving it from its current owner
// to <to>. Nothing is signed (sigVerify off) or sent.
//   node scripts/dryrun-pnft.mjs <cardId> <toWallet>
import { dryEnv } from './_env.mjs'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
process.env.RPC_URL = /^RPC_URL=(.*)$/m.exec(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env.prod'), 'utf-8'))[1]
await dryEnv()
const sol = await import('../solana.js')
const core = await import('../core.js')
const [id, to] = process.argv.slice(2)
const a = await core.readCard(id)
console.log('card', id, JSON.stringify(a))
if (!a) { console.log('not a Core asset nor a pNFT'); process.exit(1) }
const mv = core.cardTransfer({ id, a, owner: sol.pk(a.owner), to })
const built = await sol.buildTx({ payer: sol.pk(a.owner), instructions: [mv.ix], signers: [], units: mv.units })
const bal = await sol.getConnection().getBalance(sol.pk(a.owner), 'confirmed')
try {
  const v = await sol.simulate(built.tx, { accounts: [a.owner] })
  console.log(`SIMULATED OK · ${v.unitsConsumed} CU · owner spends ${(bal - v.accounts[0].lamports) / 1e9} SOL (balance ${bal / 1e9})`)
} catch (e) { console.log('SIMULATION FAILED', e.message.slice(0, 900)) }
process.exit(0)
