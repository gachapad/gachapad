// What a pack pool may sign from Jupiter. Pure.
import { TOKEN_PROGRAM_ID, NATIVE_MINT, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { pk } from './solana.js'

export const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
const SYSTEM = '11111111111111111111111111111111'

/**
 * `owner` signs ONLY a swap shaped like Jupiter's SOL→token swaps: it is the sole signer and fee payer; top-level
 * programs ⊆ { ComputeBudget, System, Token, ATA, Jupiter v6 }; a System instruction is a transfer from the owner into
 * its OWN WSOL account; Token instructions are SyncNative / CloseAccount of that WSOL account back to the owner; ATA
 * creations are paid by the owner; exactly one Jupiter route. Accounts loaded from lookup tables resolve to undefined
 * here, so any System / Token / ATA instruction that uses one fails closed. Throws otherwise.
 */
export function assertSwapTx(tx, owner) {
  const me = pk(owner).toBase58()
  const msg = tx.message
  if (msg.header.numRequiredSignatures !== 1 || msg.staticAccountKeys[0].toBase58() !== me) throw new Error('swap tx: the pool must be the sole signer and fee payer')
  const keys = msg.staticAccountKeys.map(k => k.toBase58())
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, pk(me), false, TOKEN_PROGRAM_ID).toBase58()
  let jup = 0
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex]
    if (!prog) throw new Error('swap tx: a program id that is not a static key')
    const acc = i => keys[ix.accountKeyIndexes[i]], d = Buffer.from(ix.data)
    if (prog === COMPUTE_BUDGET) continue
    if (prog === JUPITER_V6) { jup++; continue }
    if (prog === SYSTEM) {
      if (!(d.length >= 12 && d.readUInt32LE(0) === 2 && acc(0) === me && acc(1) === wsol)) throw new Error('swap tx: a System instruction that is not a transfer into the pool\'s own WSOL account')
      continue
    }
    if (prog === TOKEN_PROGRAM_ID.toBase58()) {
      if (d[0] === 17 && acc(0) === wsol) continue // SyncNative
      if (d[0] === 9 && acc(0) === wsol && acc(1) === me && acc(2) === me) continue // close the pool's own WSOL → the pool
      throw new Error(`swap tx: token instruction ${d[0]} is not allowed`)
    }
    if (prog === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
      if ((d.length === 0 || d[0] === 0 || d[0] === 1) && acc(0) === me) continue
      throw new Error('swap tx: an ATA instruction not paid by the pool')
    }
    throw new Error(`swap tx: program ${prog} is not allowed at the top level`)
  }
  if (jup !== 1) throw new Error(`swap tx: ${jup} Jupiter instructions, expected 1`)
  return true
}
