// Metaplex Core, the two things the engine needs: read an asset (owner + collection) straight from its account,
// and build TransferV1. Collector Crypt cards are Core assets in a collection, with a permanent freeze delegate
// (theirs) and an owner transfer delegate; an unfrozen card moves with the owner's signature alone.
import { TransactionInstruction, SystemProgram } from '@solana/web3.js'
import bs58 from 'bs58'
import { getConnection, pk } from './solana.js'

export const MPL_CORE_PROGRAM = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'
const TRANSFER_V1 = 14 // mpl-core instruction index

/**
 * Decode the head of an AssetV1 account: key (1) | owner (32) | update authority (0 None, 1 Address, 2 Collection + 32).
 * Returns { owner, collection|null, updateAuthority|null } or null when it is not a Core asset. Pure.
 */
export function decodeAssetHead(data) {
  const b = Buffer.from(data || [])
  if (b.length < 34 || b[0] !== 1) return null
  const owner = bs58.encode(b.subarray(1, 33))
  const ua = b[33]
  let collection = null, updateAuthority = null
  if (ua === 1 || ua === 2) {
    if (b.length < 66) return null
    const key = bs58.encode(b.subarray(34, 66))
    if (ua === 2) collection = key; else updateAuthority = key
  } else if (ua !== 0) return null
  return { owner, collection, updateAuthority }
}

/** Read a card: { owner, collection } from chain, or null (no such Core asset). */
export async function readAsset(assetId) {
  const info = await getConnection().getAccountInfo(pk(assetId), 'confirmed')
  if (!info || info.owner.toBase58() !== MPL_CORE_PROGRAM) return null
  return decodeAssetHead(info.data)
}

/**
 * TransferV1 of `asset` from `owner` (signs, pays) to `to`. `collection` is required when the asset is in one.
 * Optional accounts that are absent are passed as the program id (Metaplex's optional-account convention).
 */
export function transferIx({ asset, collection = null, owner, to }) {
  const prog = pk(MPL_CORE_PROGRAM)
  const keys = [
    { pubkey: pk(asset), isSigner: false, isWritable: true },
    collection ? { pubkey: pk(collection), isSigner: false, isWritable: false } : { pubkey: prog, isSigner: false, isWritable: false },
    { pubkey: pk(owner), isSigner: true, isWritable: true }, // payer
    { pubkey: pk(owner), isSigner: true, isWritable: false }, // authority
    { pubkey: pk(to), isSigner: false, isWritable: false },   // new owner
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: prog, isSigner: false, isWritable: false },     // log wrapper: none
  ]
  return new TransactionInstruction({ programId: prog, keys, data: Buffer.from([TRANSFER_V1, 0]) }) // compression proof: None
}

/* ---------------- any Collector Crypt card: a Core asset, or a pNFT (their older collection) ---------------- */
import { readPnft, transferPnftIx } from './pnft.js'
/** { standard:'core'|'pnft', owner, collection, … } or null. */
export async function readCard(id) {
  const a = await readAsset(id)
  if (a) return { ...a, standard: 'core' }
  return readPnft(id)
}
/** The one instruction moving card `id` (as read by readCard → `a`) from `owner` to `to`, plus the CU it needs. */
export function cardTransfer({ id, a, owner, to }) {
  if (a?.standard === 'pnft') return { ix: transferPnftIx({ mint: id, tokenAccount: a.tokenAccount, owner, to, ruleSet: a.ruleSet }), units: 300_000 }
  return { ix: transferIx({ asset: id, collection: a?.collection || null, owner, to }), units: 60_000 }
}
