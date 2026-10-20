// Collector Crypt gacha client. The same four calls their own site makes:
//
//   POST /api/generatePack  { playerAddress, turbo, packType, slug:'cc', token:'USDC' } → { memo, transaction }
//        `transaction` is a LEGACY tx, fee payer = their gacha wallet (already signed), that moves exactly the
//        pack price in USDC from the player's ATA to theirs, with the memo `<memo>:open`.
//   the player signs it → POST /api/submitTransaction { signedTransaction } (we also broadcast it ourselves)
//   POST /api/openPack { memo } → poll while code === 'WAITING_FOR_WEBHOOK' → { success, nftWon, rarity, ... }
//
// The treasury NEVER signs bytes it has not checked: assertPackTx() allows exactly ComputeBudget + Memo + one
// SPL-Token TransferChecked of exactly the price, from the treasury's own USDC account, with the treasury as the
// only other signer and never the fee payer. Anything else is refused before a signature exists.
import { Transaction, PublicKey } from '@solana/web3.js'
import bs58 from 'bs58'
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { config } from './config.js'

// The hard ceiling on one pack, in code. Config can only go lower.
export const PACK_USDC_CEILING = 1000
import { pk } from './solana.js'

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111'
export const MPL_CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'
const T = ms => AbortSignal.timeout(ms)
const sleep = ms => new Promise(r => setTimeout(r, ms))

export const usdcAta = owner => getAssociatedTokenAddressSync(pk(USDC_MINT), pk(owner), false, TOKEN_PROGRAM_ID)
export const usdcRaw = usd => BigInt(Math.round(Number(usd) * 1e6))

async function ccFetch(path, { method = 'GET', body = null, timeout = 20_000 } = {}) {
  const r = await fetch(`${config.ccBase}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: config.ccBase, Referer: `${config.ccBase}/` },
    body: body ? JSON.stringify(body) : undefined,
    signal: T(timeout),
  })
  let j = null
  try { j = await r.json() } catch {}
  return { ok: r.ok, status: r.status, data: j }
}

/* ---------------- machines ---------------- */

let machinesCache = { at: 0, list: [] }
/** Every machine with its price, buyback %, tier table and live open flag. Cached 2 min. */
export async function machines() {
  if (Date.now() - machinesCache.at < 120_000 && machinesCache.list.length) return machinesCache.list
  const [all, status] = await Promise.all([ccFetch('/api/gachas/all'), ccFetch('/api/status')])
  if (!all.ok || !Array.isArray(all.data)) throw new Error(`collector crypt machines: HTTP ${all.status}`)
  const open = new Map((status.data?.gachas || []).map(g => [g.code, !!g.isOpen]))
  const running = status.data?.machineStatus === 'running'
  const list = all.data.filter(g => g && g.code && !g.archived).map(g => ({
    code: g.code, name: String(g.name || g.code).normalize('NFC'), shortName: g.shortName || null, category: g.menuCategory || null,
    priceUsdc: Number(g.price?.amount) || 0, buybackPct: Number(g.instantBuyback?.percentageOfValue) || null,
    tiers: g.tierRanges || null, weights: g.weightMultipliers || null,
    image: g.imageNobgUrl || g.thumbnailUrl || null, video: g.videoNobgWebUrl || g.videoUrl || null,
    open: running && open.get(g.code) === true,
  }))
  machinesCache = { at: Date.now(), list }
  return list
}
export async function machine(code) {
  const m = (await machines()).find(x => x.code === code)
  if (!m) throw new Error(`no Collector Crypt machine "${code}"`)
  return m
}

const evCache = new Map()
/** Collector Crypt's own "weighted insured value" of a machine (the average card value, USD). Cached 10 min. */
export async function machineEv(code) {
  const hit = evCache.get(code)
  if (hit && Date.now() - hit.at < 600_000) return hit.v
  const r = await ccFetch(`/api/getWeightedInsuredValue?code=${encodeURIComponent(code)}`).catch(() => null)
  const v = Number(r?.data?.weightedInsuredValue) || null
  evCache.set(code, { at: Date.now(), v })
  return v
}

/* ---------------- the pack transaction ---------------- */

/**
 * Throws unless `tx` is exactly a pack payment the treasury may sign:
 *   - fee payer is NOT the treasury, and already signed; the treasury is the only other required signer
 *   - instructions ⊆ { ComputeBudget, Memo, SPL-Token }, exactly ONE token instruction: TransferChecked (12)
 *     of exactly `priceRaw` USDC (6 decimals) from the treasury's USDC ATA, authority = the treasury
 *   - exactly one memo, equal to `<memo>:open`
 *   - the treasury appears nowhere else as a writable account
 * Returns { destination, feePayer }. Pure.
 */
export function assertPackTx(tx, { treasury, priceRaw, memo, maxRaw = null }) {
  const me = pk(treasury).toBase58()
  const src = usdcAta(me).toBase58()
  const price = BigInt(priceRaw)
  const ceiling = maxRaw != null && BigInt(maxRaw) < usdcRaw(PACK_USDC_CEILING) ? BigInt(maxRaw) : usdcRaw(PACK_USDC_CEILING)
  if (!(price > 0n) || price > ceiling) throw new Error(`pack tx: price ${price} outside the ceiling ${ceiling}`)
  if (!tx.feePayer) throw new Error('pack tx: no fee payer')
  const feePayer = tx.feePayer.toBase58()
  if (feePayer === me) throw new Error('pack tx: the treasury must not be the fee payer')
  const sigs = tx.signatures.map(s => s.publicKey.toBase58())
  if (sigs.length !== 2 || sigs[0] !== feePayer || sigs[1] !== me) throw new Error(`pack tx: unexpected signers ${sigs.join(',')}`)
  if (!tx.signatures[0].signature) throw new Error('pack tx: the fee payer has not signed')
  if (tx.signatures[1].signature) throw new Error('pack tx: already carries a treasury signature')
  let transfers = 0, memos = 0, destination = null
  for (const ix of tx.instructions) {
    const prog = ix.programId.toBase58()
    const touchesMe = ix.keys.some(k => k.pubkey.toBase58() === me && k.isWritable)
    if (touchesMe) throw new Error('pack tx: an instruction writes to the treasury account')
    if (prog === COMPUTE_BUDGET) continue
    if (prog === MEMO_PROGRAM) {
      memos++
      if (Buffer.from(ix.data).toString('utf8') !== `${memo}:open`) throw new Error('pack tx: memo does not match')
      if (ix.keys.length) throw new Error('pack tx: the memo must not require signers')
      continue
    }
    if (prog === TOKEN_PROGRAM_ID.toBase58()) {
      const d = Buffer.from(ix.data)
      if (d.length !== 10 || d[0] !== 12) throw new Error(`pack tx: token instruction ${d[0]} is not a TransferChecked`)
      const amount = d.readBigUInt64LE(1), decimals = d[9]
      const k = ix.keys.map(x => x.pubkey.toBase58())
      // Collector Crypt's builder repeats the authority as a 5th (signer) account; anything else is refused
      if (!(ix.keys.length === 4 || (ix.keys.length === 5 && k[4] === me && ix.keys[4].isSigner))) throw new Error('pack tx: TransferChecked accounts are not [source, mint, destination, treasury(, treasury)]')
      if (k[0] !== src) throw new Error('pack tx: the payment is not from the treasury USDC account')
      if (k[1] !== USDC_MINT || decimals !== 6) throw new Error('pack tx: the payment is not USDC')
      if (k[3] !== me || !ix.keys[3].isSigner) throw new Error('pack tx: the authority is not the treasury')
      if (k[2] === src) throw new Error('pack tx: pays itself')
      if (amount !== price) throw new Error(`pack tx: amount ${amount} is not the pack price ${price}`)
      destination = k[2]
      transfers++
      continue
    }
    throw new Error(`pack tx: program ${prog} is not allowed`)
  }
  if (transfers !== 1) throw new Error(`pack tx: ${transfers} USDC transfers, expected exactly 1`)
  if (memos !== 1) throw new Error(`pack tx: ${memos} memos, expected exactly 1`)
  return { destination, feePayer }
}

/**
 * Ask for a pack. Returns { memo, tx (Transaction, NOT signed by us), sig (the tx id = the fee payer's signature),
 * blockhash, destination }. Throws with Collector Crypt's reason (machine empty, rebalancing, …).
 */
export async function generatePack({ treasury, code, priceUsdc, maxUsdc = null }) {
  const r = await ccFetch('/api/generatePack', { method: 'POST', body: { playerAddress: pk(treasury).toBase58(), turbo: false, packType: code, slug: 'cc', token: 'USDC' } })
  if (!r.ok || r.data?.success === false) throw new Error(`generatePack: ${r.data?.details || r.data?.error || `HTTP ${r.status}`}`)
  const { memo, transaction } = r.data || {}
  if (!/^cc-[0-9a-f-]{36}$/.test(String(memo || ''))) throw new Error('generatePack: no memo')
  const tx = Transaction.from(Buffer.from(String(transaction || ''), 'base64'))
  const { destination, feePayer } = assertPackTx(tx, { treasury, priceRaw: usdcRaw(priceUsdc), memo, maxRaw: maxUsdc != null ? usdcRaw(maxUsdc) : null })
  return { memo, tx, sig: bs58.encode(tx.signatures[0].signature), blockhash: tx.recentBlockhash, destination, feePayer }
}

/** Hand the signed tx to Collector Crypt (their site does this; we ALSO broadcast the same bytes ourselves). */
export async function submitPack(rawB64) {
  const r = await ccFetch('/api/submitTransaction', { method: 'POST', body: { signedTransaction: rawB64 }, timeout: 60_000 })
  return { ok: r.ok && r.data?.success !== false, status: r.status, signature: r.data?.signature || null, confirmation: r.data?.confirmationStatus || null, error: r.data?.error || null }
}

/**
 * Open a paid pack. Polls while Collector Crypt waits for its webhook, up to `maxMs`. Returns
 * { done: true, nft, rarity, prizeWallet, sendSig } or { done: false, reason }. Never throws on "not yet".
 */
export async function openPack(memo, { maxMs = 120_000 } = {}) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < maxMs) {
    const r = await ccFetch('/api/openPack', { method: 'POST', body: { memo }, timeout: 30_000 }).catch(e => ({ ok: false, status: 0, data: { error: e.message } }))
    last = r
    if (r.ok && r.data?.code === 'WAITING_FOR_WEBHOOK') { await sleep(1500); continue }
    if (r.ok && r.data?.success === true && r.data?.nftWon) {
      return { done: true, nft: shapeNft(r.data.nftWon), rarity: r.data.rarity || null, prizeWallet: r.data.prizeWallet || null, sendSig: r.data.transactionSignature || null }
    }
    if (!r.ok && r.status >= 500) { await sleep(3000); continue }
    return { done: false, reason: String(r.data?.error || r.data?.code || `HTTP ${r.status}`).slice(0, 160) }
  }
  return { done: false, reason: String(last?.data?.error || last?.data?.code || 'still waiting').slice(0, 160) }
}

/** The card as the site shows it, from Collector Crypt's DAS-shaped nftWon. Pure. */
export function shapeNft(n) {
  const attrs = Object.fromEntries((n?.content?.metadata?.attributes || []).map(a => [a.trait_type, a.value]))
  const files = n?.content?.files || []
  return {
    id: n?.id || null,
    name: n?.content?.metadata?.name || attrs['Card Name'] || 'Graded card',
    cardName: attrs['Card Name'] || null,
    set: attrs.Set || null, year: attrs.Year || null,
    grader: attrs['Grading Company'] || null, grade: attrs['The Grade'] || null,
    valueUsd: Number(attrs['Insured Value']) || null,
    ccId: attrs['Collector Crypt ID'] || null,
    image: n?.content?.links?.image || files[0]?.uri || null,
    back: files[1]?.uri || null,
    collection: (n?.grouping || []).find(g => g.group_key === 'collection')?.group_value || null,
  }
}

const pullsCache = new Map()
/** The machine's recent pulls, everyone on Collector Crypt (public). Cached 2 min. [{ card, tier, winner, at }] */
export async function machinePulls(code) {
  const hit = pullsCache.get(code)
  if (hit && Date.now() - hit.at < 120_000) return hit.v
  const r = await ccFetch(`/api/getRecentWinners?packType=${encodeURIComponent(code)}`).catch(() => null)
  const v = (r?.data?.data || []).slice(0, 24).map(w => ({ card: shapeNft(w.nft), tier: w.prize_tier ?? null, at: w.created_at || w.timestamp || null }))
  pullsCache.set(code, { at: Date.now(), v })
  return v
}

export const ccAssetUrl = id => `https://collectorcrypt.com/assets/solana/${id}`
export { PublicKey }
