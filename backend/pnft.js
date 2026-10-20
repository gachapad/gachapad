// Token Metadata programmable NFTs (pNFTs). Most Collector Crypt cards are Metaplex Core assets (core.js), but cards
// from their older collection (CCryptWBY…) are pNFTs: an SPL mint (supply 1) whose single token sits FROZEN in its
// owner's token account, moved only through Token Metadata's Transfer (it thaws, moves and re-freezes, and enforces
// the card's rule set). Two things the engine needs, hand-built like core.js: read a card (owner + the token account
// holding it + its rule set), and build Transfer V1.
import { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import bs58 from 'bs58'
import { getConnection, pk } from './solana.js'

export const TOKEN_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
export const AUTH_RULES_PROGRAM = 'auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg'
const TM = new PublicKey(TOKEN_METADATA_PROGRAM)
const PROGRAMMABLE_NON_FUNGIBLE = 4 // TokenStandard
const TRANSFER = 49 // Token Metadata instruction: Transfer (TransferArgs::V1)

const pda = seeds => PublicKey.findProgramAddressSync(seeds, TM)[0]
const M = Buffer.from('metadata')
export const metadataPda = mint => pda([M, TM.toBuffer(), pk(mint).toBuffer()])
export const editionPda = mint => pda([M, TM.toBuffer(), pk(mint).toBuffer(), Buffer.from('edition')])
export const tokenRecordPda = (mint, token) => pda([M, TM.toBuffer(), pk(mint).toBuffer(), Buffer.from('token_record'), pk(token).toBuffer()])

/**
 * Decode a MetadataV1 account as far as the programmable config: { mint, tokenStandard, collection, ruleSet } or
 * null when it is not one / is cut short. Pure.
 */
export function decodeMetadata(data) {
  const b = Buffer.from(data || [])
  let o = 0
  const need = n => { if (o + n > b.length) throw new Error('short') }
  const u8 = () => { need(1); return b[o++] }
  const skip = n => { need(n); o += n }
  const key32 = () => { need(32); const k = bs58.encode(b.subarray(o, o + 32)); o += 32; return k }
  const str = () => { need(4); const n = b.readUInt32LE(o); o += 4; skip(n) }
  try {
    if (u8() !== 4) return null // Key::MetadataV1
    skip(32) // update authority
    const mint = key32()
    str(); str(); str() // name, symbol, uri
    skip(2) // seller fee bps
    if (u8() === 1) { need(4); const n = b.readUInt32LE(o); o += 4; skip(n * 34) } // creators
    skip(2) // primary sale happened, is mutable
    if (u8() === 1) skip(1) // edition nonce
    let tokenStandard = null
    if (u8() === 1) tokenStandard = u8()
    let collection = null
    if (u8() === 1) { const verified = u8() === 1; collection = { verified, key: key32() } }
    if (u8() === 1) skip(17) // uses
    if (u8() === 1) skip(9) // collection details (V1 size / V2 padding)
    let ruleSet = null
    if (o < b.length && u8() === 1) { u8(); if (u8() === 1) ruleSet = key32() } // programmable config V1 { rule_set }
    return { mint, tokenStandard, collection, ruleSet }
  } catch { return null }
}

/**
 * Read a pNFT card: { standard:'pnft', owner, tokenAccount, collection, ruleSet } from chain, or null when `mint` is
 * not a programmable NFT (or nobody holds it).
 */
export async function readPnft(mint) {
  const conn = getConnection()
  const [mi, md] = await conn.getMultipleAccountsInfo([pk(mint), metadataPda(mint)], 'confirmed')
  if (!mi || !mi.owner.equals(TOKEN_PROGRAM_ID) || mi.data.length !== 82 || !md || !md.owner.equals(TM)) return null
  const meta = decodeMetadata(md.data)
  if (!meta || meta.mint !== String(mint) || meta.tokenStandard !== PROGRAMMABLE_NON_FUNGIBLE) return null
  const largest = await conn.getTokenLargestAccounts(pk(mint), 'confirmed')
  const hold = (largest?.value || []).find(a => String(a.amount) === '1')
  if (!hold) return null
  const ta = await conn.getAccountInfo(hold.address, 'confirmed')
  if (!ta || !ta.owner.equals(TOKEN_PROGRAM_ID) || ta.data.length < 72) return null
  return { standard: 'pnft', owner: bs58.encode(ta.data.subarray(32, 64)), tokenAccount: hold.address.toBase58(), collection: meta.collection?.verified ? meta.collection.key : null, ruleSet: meta.ruleSet }
}

/**
 * Token Metadata Transfer V1 of the pNFT `mint` (amount 1) from `owner`'s token account `tokenAccount` to `to`'s
 * associated token account (created by the program if missing). `owner` signs and pays. Absent optional accounts are
 * passed as the Token Metadata program id (Metaplex's convention).
 */
export function transferPnftIx({ mint, tokenAccount, owner, to, ruleSet = null }) {
  const m = pk(mint), from = pk(owner), dest = getAssociatedTokenAddressSync(m, pk(to), false, TOKEN_PROGRAM_ID)
  const ro = k => ({ pubkey: pk(k), isSigner: false, isWritable: false })
  const w = k => ({ pubkey: pk(k), isSigner: false, isWritable: true })
  const keys = [
    w(tokenAccount), ro(from), w(dest), ro(to), ro(m), w(metadataPda(m)), ro(editionPda(m)),
    w(tokenRecordPda(m, tokenAccount)), w(tokenRecordPda(m, dest)),
    { pubkey: from, isSigner: true, isWritable: false }, // authority
    { pubkey: from, isSigner: true, isWritable: true },  // payer
    ro(SystemProgram.programId), ro(SYSVAR_INSTRUCTIONS_PUBKEY), ro(TOKEN_PROGRAM_ID), ro(ASSOCIATED_TOKEN_PROGRAM_ID),
    ruleSet ? ro(AUTH_RULES_PROGRAM) : ro(TM), ruleSet ? ro(ruleSet) : ro(TM),
  ]
  const data = Buffer.alloc(11)
  data[0] = TRANSFER; data[1] = 0 // TransferArgs::V1
  data.writeBigUInt64LE(1n, 2)   // amount
  data[10] = 0                   // authorization data: None
  return new TransactionInstruction({ programId: TM, keys, data })
}
