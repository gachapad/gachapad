// GACHAPAD pulls: burn a coin to pull one card from ITS machine.
//
// A coin's machine is the cards its own fees ripped (packs.js, rip status 'stock'). The only way a card leaves is a
// pull, and the only way to pay for a pull is to BURN that coin.
//
// ONE PULL IN FLIGHT PER MACHINE. A quote is refused while another pull of the same coin is quoted, sent, burned or
// waiting. That is what keeps the price honest: every quote is priced on the exact list of cards it can win (the
// stock at that moment, saved in the quote), and no other pull can change or reveal that list before this one is
// drawn. (With concurrent pulls, a second puller could wait for the first one's seed block, compute which card it
// takes, and burn only when the rest was worth more than the quote.)
//
//   quote     POST /burn/prepare {mint, wallet}: price = average insured value of the quoted list × (1 + PULL_MARGIN_BPS),
//             in tokens at the LOWEST of spot and every fresh on-chain reading of the last PULL_TWAP_MS. The engine
//             builds [budget] + burnChecked(wallet's ATA, mint, tokens) + memo "gachapad:pull:<id>" on a recent blockhash
//             it records. The WALLET signs; the engine never holds or moves the coin.
//   sent      the signed bytes (or the signature) come back; the engine relays them.
//   burned    the FINALIZED tx is read back and checked: no error, exactly one gachapad memo (ours), a top-level burn
//             of >= the quoted tokens of this mint by this wallet, the wallet's balance really fell, and the tx was
//             built on the quote's own blockhash (so it landed inside the quote's life: an old quote cannot be
//             replayed later at a stale price, and no durable nonce can stretch it).
//   frozen    the cards it can win (the quoted list still in stock) are written down with their hash and a seed slot
//             DRAW_DELAY_SLOTS ahead: nobody, us included, can know the seed block while the list can still change.
//   drawn     seed = sha256(first finalized blockhash >= seedSlot | pull id | burn sig | list hash); card = list[seed mod n].
//   delivered the vault sends that card to the wallet that burned (MPL Core / pNFT transfer built here).
//
// Burns are final: no refunds. A burn that is only found late (a lagging RPC) is re-checked for 30 minutes before it is
// called dead; one that lands when its quoted cards are gone WAITS and is drawn from the next stock instead.
import { createHash } from 'crypto'
import bs58 from 'bs58'
import { TransactionInstruction, VersionedTransaction } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, createBurnCheckedInstruction, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { config, WSOL } from './config.js'
import { moneyStore, newId } from './store.js'
import { getConnection, vaultKeyFor, buildTx, simulate, settleTx, sigOf, isWalletKey, pk } from './solana.js'
import { coinRec, liveOf, neverPay, isVisible } from './registry.js'
import { rips, stockOf, packCoins, ripsStore } from './packs.js'
import { readCard, cardTransfer } from './core.js'
import { machineEv } from './cc.js'
import { solUsd, solUsdCached } from './price.js'
import { isKilled } from './kill.js'
import { emitEvent } from './bus.js'
import { http } from './httperr.js'

export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'
export const MEMO_PREFIX = 'gachapad:pull:'
export const memoFor = id => `${MEMO_PREFIX}${id}`
const KEEP_FINISHED = 20_000          // finished records kept (delivered / void / invalid); active ones are never pruned
const DELIVERY_TRIES = 5
const UNSEEN_GIVE_UP_MS = 30 * 60_000 // a relayed burn not found on a finalized node for this long after its blockhash died
const LAPSE_COOLDOWN_MS = 10 * 60_000 // a wallet that lets a quote lapse unburned waits this long before quoting that coin again
const HEIGHT_MARGIN = 10              // blocks past lastValidBlockHeight before a blockhash is treated as dead
const FRESH_PRICE_MS = 90_000         // a price reading older than this is never sampled
const errText = e => String(e?.message || e).slice(0, 200)
export const run = { lastError: null, at: 0, busy: false }
const lapses = new Map() // `${wallet}:${mint}` → until

/* ---------------- store ---------------- */

export const pullsStore = moneyStore('pulls', () => ({ seq: 0, pulls: [] }))
export const pulls = () => pullsStore.get().pulls
export const pullById = id => pulls().find(p => p.id === id) || null
export const FINISHED = ['delivered', 'void', 'invalid']
function savePull(rec) {
  pullsStore.update(s => {
    const i = s.pulls.findIndex(p => p.id === rec.id)
    if (i >= 0) s.pulls[i] = rec; else s.pulls.push(rec)
    // prune only FINISHED records, oldest first; anything in flight is never evicted
    const finished = s.pulls.filter(p => FINISHED.includes(p.status))
    if (finished.length > KEEP_FINISHED) {
      const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map(p => p.id))
      s.pulls = s.pulls.filter(p => !drop.has(p.id))
    }
  })
  return pullById(rec.id)
}
const patchPull = (id, fn) => { const p = structuredClone(pullById(id)); if (!p) return null; fn(p); return savePull(p) }
const dropPull = id => pullsStore.update(s => { s.pulls = s.pulls.filter(p => p.id !== id) })
const nextSeq = () => { let n = 0; pullsStore.update(s => { s.seq = (s.seq || 0) + 1; n = s.seq }); return n }

/** Pulls that hold a coin's machine: while one exists, nobody else can quote that coin. */
export const ACTIVE = ['quoted', 'sent', 'burned', 'waiting']
export const activeOf = mint => pulls().filter(p => p.mint === mint && ACTIVE.includes(p.status))

/* ---------------- pure pieces (unit-tested) ---------------- */

/** Average card value of a list of rips, USD. Cards with no recorded value count at `fallback`. Pure. */
export function stockAverageUsd(stock, fallback = null) {
  const vals = stock.map(r => Number(r.card?.valueUsd) || Number(fallback) || 0).filter(v => v > 0)
  return vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null
}
/** The price of one pull in USD (2 decimals, rounded up). Pure. */
export function pullPriceUsd(avgUsd, marginBps = config.pullMarginBps) {
  if (!(avgUsd > 0)) return null
  return Math.ceil(avgUsd * (10_000 + marginBps) / 100) / 100
}
/** Tokens (raw units) worth `usd` at `tokenUsd` per whole token, rounded UP. Pure. */
export function tokensFor(usd, tokenUsd, decimals = 6) {
  if (!(usd > 0) || !(tokenUsd > 0)) return null
  const raw = Math.ceil((usd / tokenUsd) * 10 ** decimals)
  return Number.isFinite(raw) && raw > 0 ? BigInt(raw) : null
}
/**
 * The price a pull is quoted at: the LOWEST of spot and every reading in the window (more tokens, never fewer), and only
 * once the readings cover most of the window (a fresh boot or a new coin waits). Pure.
 */
export function quotePriceSol(spot, samples, { now = Date.now(), windowMs = config.pullTwapMs, minSamples = config.pullMinSamples } = {}) {
  const recent = samples.filter(s => now - s.at <= windowMs && s.priceSol > 0)
  if (recent.length < minSamples || !(spot > 0)) return null
  if (now - Math.min(...recent.map(s => s.at)) < windowMs * 0.8) return null
  return Math.min(spot, ...recent.map(s => s.priceSol))
}
/** The frozen list: card rip ids, sorted by pack number, plus its hash. Pure. */
export function freezeList(stock) {
  const list = stock.map(r => (typeof r === 'string' ? r : r.id)).sort((a, b) => ripNum(a) - ripNum(b) || (a < b ? -1 : 1))
  return { list, hash: createHash('sha256').update(list.join(',')).digest('hex') }
}
const ripNum = id => Number(String(id).replace(/^\D+/, '')) || 0
export function pullSeed({ blockhash, pullId, sig, hash }) {
  return createHash('sha256').update(`${blockhash}|${pullId}|${sig}|${hash}`).digest('hex')
}
/** list[seed mod n]. Pure. */
export function pickCard(list, seedHex) {
  if (!list.length) return null
  const i = Number(BigInt(`0x${seedHex}`) % BigInt(list.length))
  return { ripId: list[i], index: i, n: list.length }
}

/** Every memo string in a parsed tx's top-level instructions. Pure. */
function memosOf(ixs) {
  return ixs.filter(ix => ix.program === 'spl-memo' || (ix.programId?.toString?.() || ix.programId) === MEMO_PROGRAM).map(ix => (typeof ix.parsed === 'string' ? ix.parsed.trim() : ''))
}

/**
 * Does a finalized, jsonParsed transaction burn at least `minRaw` of `mint` from `wallet`, carry exactly one
 * gachapad memo (= `memo`), and sit on `blockhash`? Top-level instructions only (a CPI burn is never counted).
 * Cross-checked with the wallet's token balance delta. Returns { ok, reason?, failed?, amountRaw }. Pure.
 */
export function verifyBurnTx(tx, { wallet, mint, minRaw, memo, blockhash = null }) {
  if (!tx) return { ok: false, reason: 'not found' }
  if (tx.meta?.err) return { ok: false, reason: `the transaction failed: ${JSON.stringify(tx.meta.err)}`, failed: true }
  const msg = tx.transaction?.message || {}
  const ixs = msg.instructions || []
  const keys = (msg.accountKeys || []).map(k => (typeof k === 'string' ? k : k.pubkey?.toString?.() || String(k.pubkey)))
  const signers = (msg.accountKeys || []).filter(k => k && typeof k === 'object' && k.signer).map(k => k.pubkey?.toString?.() || String(k.pubkey))
  if (!signers.includes(wallet) && keys[0] !== wallet) return { ok: false, reason: 'the wallet did not sign it' }
  if (blockhash && msg.recentBlockhash !== blockhash) return { ok: false, reason: 'the burn was not built on this quote (stale or replayed)' }
  const ours = memosOf(ixs).filter(m => m.startsWith(MEMO_PREFIX))
  if (ours.length !== 1 || ours[0] !== memo) return { ok: false, reason: ours.length > 1 ? 'one burn can pay for one pull only' : 'the memo does not match this pull' }
  let burned = 0n
  for (const ix of ixs) {
    if ((ix.program === 'spl-token' || ix.program === 'spl-token-2022') && ix.parsed && (ix.parsed.type === 'burnChecked' || ix.parsed.type === 'burn')) {
      const i = ix.parsed.info || {}
      if (i.mint !== mint || i.authority !== wallet) continue
      const amt = i.tokenAmount?.amount ?? i.amount
      try { burned += BigInt(String(amt)) } catch {}
    }
  }
  if (burned < BigInt(minRaw)) return { ok: false, reason: `burned ${burned}, the quote needs ${minRaw}`, amountRaw: burned.toString() }
  const bal = arr => (arr || []).filter(b => b.mint === mint && b.owner === wallet).reduce((a, b) => a + BigInt(b.uiTokenAmount?.amount || '0'), 0n)
  const drop = bal(tx.meta?.preTokenBalances) - bal(tx.meta?.postTokenBalances)
  if (drop < BigInt(minRaw)) return { ok: false, reason: `the wallet's balance fell by ${drop}, the quote needs ${minRaw}`, amountRaw: burned.toString() }
  return { ok: true, amountRaw: burned.toString() }
}

/* ---------------- token price readings (in memory: a restart waits a full window again) ---------------- */

const samples = new Map() // mint → [{ at, priceSol }]
export function samplePrices(now = Date.now()) {
  for (const c of packCoins()) {
    const l = liveOf(c.mint)
    const p = Number(l.priceSol)
    // only a FRESH on-chain read (curve or PumpSwap pool) of a SOL-paired coin; never a stale or third-party price
    if (!(p > 0) || !['curve', 'amm'].includes(l.priceSrc) || !(now - (l.refreshedAt || 0) < FRESH_PRICE_MS)) continue
    if (l.quoteMint && l.quoteMint !== WSOL) continue
    const arr = samples.get(c.mint) || []
    if (!arr.length || now - arr.at(-1).at >= 20_000) arr.push({ at: now, priceSol: p })
    while (arr.length && now - arr[0].at > config.pullTwapMs * 2) arr.shift()
    samples.set(c.mint, arr)
  }
}
export const samplesOf = mint => samples.get(mint) || []
/** Offline dev / tests only. */
export const setSamples = (mint, arr) => samples.set(mint, arr)

/* ---------------- figures ---------------- */

const programCache = new Map() // mint → token program id (string)
async function tokenProgramOf(mint) {
  if (programCache.has(mint)) return programCache.get(mint)
  const info = await getConnection().getAccountInfo(pk(mint), 'confirmed')
  if (!info) throw http('that mint does not exist', 404)
  const owner = info.owner.toBase58()
  if (owner !== TOKEN_PROGRAM_ID.toBase58() && owner !== TOKEN_2022_PROGRAM_ID.toBase58()) throw http('that mint is not a token', 400)
  programCache.set(mint, owner)
  return owner
}
const DECIMALS = 6 // every pump.fun coin

/** What one pull of `mint` costs right now (no reservation). */
export async function pullFigures(mint, { fresh = true } = {}) {
  const c = coinRec(mint)
  if (!c || !c.packCode) throw http('that coin has no machine', 404)
  const stock = stockOf(mint)
  const busy = activeOf(mint).length > 0
  const ev = await machineEv(c.packCode).catch(() => null)
  const avgUsd = stockAverageUsd(stock, ev)
  const priceUsd = pullPriceUsd(avgUsd)
  const usd = fresh ? await solUsd().catch(() => solUsdCached()) : solUsdCached()
  const l = liveOf(mint)
  const pSol = l.quoteMint && l.quoteMint !== WSOL ? null : quotePriceSol(Number(l.priceSol), samplesOf(mint))
  const tokenUsd = pSol && usd > 0 ? pSol * usd : null
  const tokensRaw = priceUsd && tokenUsd ? tokensFor(priceUsd, tokenUsd, DECIMALS) : null
  return { stock: stock.length, available: busy ? 0 : stock.length, busy, avgUsd, priceUsd, tokenUsd, tokensRaw, decimals: DECIMALS, stockUsd: stock.reduce((a, r) => a + (Number(r.card?.valueUsd) || 0), 0) }
}

/* ---------------- prepare + submit ---------------- */

export function pullBlocker() {
  if (!config.pullsLive) return 'pulls are not open yet'
  if (isKilled()) return 'paused'
  return null
}

export async function preparePull(body) {
  const blocked = pullBlocker()
  if (blocked) throw http(blocked, 503)
  const b = body || {}
  const mint = String(b.mint || '').trim(), wallet = String(b.wallet || '').trim()
  if (!isWalletKey(wallet)) throw http('connect a Solana wallet first (an on-curve wallet address)')
  if (neverPay().has(wallet)) throw http('that wallet cannot pull here')
  const c = coinRec(mint)
  if (!c || !c.packCode || c.root || c.hidden || !isVisible(mint)) throw http('that coin has no machine here', 404)
  if (activeOf(mint).length) throw http('someone is pulling from this machine right now: try again in about a minute', 409)
  const lapse = lapses.get(`${wallet}:${mint}`)
  if (lapse && Date.now() < lapse) throw http('your last quote here lapsed without a burn: you can quote this machine again in a few minutes', 429)
  const f = await pullFigures(mint)
  if (f.stock < 1) throw http('this machine is empty: its next card arrives with its next pack', 409)
  if (!f.priceUsd) throw http('this machine has no priced cards yet', 409)
  if (f.priceUsd > config.pullMaxUsd) throw http(`a pull here would cost $${f.priceUsd}, above this pad's limit`, 409)
  if (!f.tokensRaw) throw http('the coin price is still settling (the price window needs a few minutes of readings): try again shortly', 503)
  const program = await tokenProgramOf(mint)
  const programId = pk(program)
  const ata = getAssociatedTokenAddressSync(pk(mint), pk(wallet), false, programId)
  const bal = await getConnection().getTokenAccountBalance(ata, 'confirmed').then(r => BigInt(r.value.amount)).catch(() => 0n)
  if (bal < f.tokensRaw) throw http(`a pull burns ${fmtTokens(f.tokensRaw)} $${c.symbol}: that wallet holds ${fmtTokens(bal)}`)
  const id = newId(8)
  const memo = memoFor(id)
  const ixs = [
    createBurnCheckedInstruction(ata, pk(mint), pk(wallet), f.tokensRaw, DECIMALS, [], programId),
    new TransactionInstruction({ programId: pk(MEMO_PROGRAM), keys: [], data: Buffer.from(memo, 'utf8') }),
  ]
  const built = await buildTx({ payer: wallet, instructions: ixs, units: 60_000 })
  try { await simulate(built.tx) } catch (e) { throw http(`the burn would fail: ${errText(e)}`) }
  // the machine lock + the quoted list are written in the SAME synchronous step as the re-check (no await in between)
  if (activeOf(mint).length) throw http('someone started pulling from this machine a moment ago: try again in about a minute', 409)
  const stockNow = stockOf(mint)
  if (!stockNow.length) throw http('this machine just emptied: try again after its next pack', 409)
  const quoted = freezeList(stockNow)
  // the price must be the price of THIS list (a card may have arrived during the awaits above)
  if (quoted.list.length !== f.stock) throw http('the machine changed while quoting: try again', 409)
  const now = Date.now()
  const rec = savePull({
    id, mint, symbol: c.symbol, wallet, status: 'quoted', createdAt: now, expiresAt: now + config.pullQuoteMs,
    tokensRaw: f.tokensRaw.toString(), priceUsd: f.priceUsd, avgUsd: f.avgUsd, tokenUsd: f.tokenUsd,
    quote: { list: quoted.list, hash: quoted.hash },
    memo, program, blockhash: built.tx.message.recentBlockhash, lastValidBlockHeight: built.lastValidBlockHeight,
  })
  return { id: rec.id, tx: Buffer.from(built.tx.serialize()).toString('base64'), tokens: rec.tokensRaw, decimals: DECIMALS, priceUsd: rec.priceUsd, expiresAt: rec.expiresAt, cards: quoted.list.length }
}

/**
 * The wallet's signed burn (base64) or just its signature. Relays the bytes; the burn itself is judged later, on the
 * finalized chain (which also pins it to the quote's blockhash).
 */
export async function submitPull(id, { tx: txB64 = null, sig: sigIn = null } = {}) {
  const p = pullById(id)
  if (!p) throw http('no such quote (it lapsed): ask for a new one', 404)
  if (p.sig) return publicPull(p)
  if (p.status !== 'quoted') throw http(`this pull is ${p.status}`, 409)
  let sig = null, raw = null
  if (txB64) {
    let tx
    try { tx = VersionedTransaction.deserialize(Buffer.from(String(txB64), 'base64')) } catch { throw http('that is not a signed transaction') }
    if (tx.message.staticAccountKeys[0]?.toBase58() !== p.wallet) throw http('that transaction is not from the quoted wallet')
    if (tx.message.recentBlockhash !== p.blockhash) throw http('that transaction was not built for this quote')
    if (!tx.signatures[0] || tx.signatures[0].every(x => x === 0)) throw http('the transaction is not signed')
    sig = bs58.encode(tx.signatures[0])
    raw = Buffer.from(tx.serialize()).toString('base64')
  } else if (sigIn && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(String(sigIn))) {
    sig = String(sigIn)
  } else throw http('send the signed transaction (tx) or its signature (sig)')
  if (pulls().some(x => x.sig === sig && x.id !== id)) throw http('that signature belongs to another pull', 409)
  const rec = patchPull(id, x => { x.sig = sig; x.raw = raw; x.status = 'sent'; x.sentAt = Date.now() })
  if (raw) getConnection().sendRawTransaction(Buffer.from(raw, 'base64'), { skipPreflight: true, maxRetries: 2 }).catch(() => {})
  emitEvent({ id: `pullsent:${id}`, type: 'pull-sent', mint: p.mint, symbol: p.symbol, wallet: p.wallet, sig, extra: { pullId: id, tokens: p.tokensRaw } })
  return publicPull(rec)
}

/* ---------------- the loop ---------------- */

async function judgeBurn(p, tx) {
  const v = verifyBurnTx(tx, { wallet: p.wallet, mint: p.mint, minRaw: p.tokensRaw, memo: p.memo, blockhash: p.blockhash })
  if (!v.ok) {
    patchPull(p.id, x => { x.status = v.failed ? 'void' : 'invalid'; x.voidReason = v.reason; x.burnedRaw = v.amountRaw || null; x.burnSlot = tx.slot })
    emitEvent({ id: `pullbad:${p.id}`, type: 'pull-invalid', mint: p.mint, symbol: p.symbol, wallet: p.wallet, sig: p.sig, extra: { pullId: p.id, reason: v.reason } })
    return
  }
  patchPull(p.id, x => { x.status = 'burned'; x.burnedRaw = v.amountRaw; x.burnSlot = tx.slot; x.burnedAt = Date.now(); x.unseenSince = null })
  emitEvent({ id: `burn:${p.id}`, type: 'pull-burn', mint: p.mint, symbol: p.symbol, wallet: p.wallet, sig: p.sig, extra: { pullId: p.id, tokens: v.amountRaw } })
}

async function driveSent(p, height) {
  const conn = getConnection()
  const tx = await conn.getParsedTransaction(p.sig, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }).catch(() => undefined)
  if (tx === undefined) return // RPC hiccup
  if (tx) return judgeBurn(p, tx)
  // not finalized (yet): rebroadcast while the blockhash lives
  if (p.raw && height != null && height <= p.lastValidBlockHeight) conn.sendRawTransaction(Buffer.from(p.raw, 'base64'), { skipPreflight: true, maxRetries: 0 }).catch(() => {})
  const seen = await conn.getSignatureStatuses([p.sig], { searchTransactionHistory: true }).then(r => r.value[0]).catch(() => undefined)
  if (seen === undefined) return
  if (seen?.err) { patchPull(p.id, x => { x.status = 'void'; x.voidReason = `the burn failed on-chain: ${JSON.stringify(seen.err)} (nothing was burned)` }); return }
  if (seen) return // landed, finalizing
  // the blockhash died and no node shows the tx: it can no longer land, but a lagging node may still be hiding it —
  // 'unseen' releases the machine and is re-read for a while before it is called dead
  if (height != null && height > p.lastValidBlockHeight + HEIGHT_MARGIN) patchPull(p.id, x => { x.status = 'unseen'; x.unseenSince = Date.now() })
}

async function driveUnseen(p) {
  const tx = await getConnection().getParsedTransaction(p.sig, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }).catch(() => undefined)
  if (tx === undefined) return
  if (tx) { await judgeBurn(p, tx); const q = pullById(p.id); if (q?.status === 'burned') patchPull(p.id, x => { x.late = true }); return }
  if (Date.now() - (p.unseenSince || 0) > UNSEEN_GIVE_UP_MS) patchPull(p.id, x => { x.status = 'void'; x.voidReason = 'the burn never landed (checked for 30 minutes after its blockhash died): nothing was burned' })
}

/** Lock the cards this pull can win, and its seed slot. Late burns (another pull may have moved on) draw from the live stock. */
async function driveFreeze(p) {
  // one frozen-undrawn pull per machine at a time (late burns queue behind the live one)
  if (pulls().some(x => x.mint === p.mint && x.id !== p.id && x.freeze && !x.draw && ['burned', 'waiting'].includes(x.status))) return
  const stock = stockOf(p.mint)
  const inStock = new Set(stock.map(r => r.id))
  let list = (p.quote?.list || []).filter(id => inStock.has(id))
  if (!list.length || p.late) list = stock.map(r => r.id) // the quoted cards are gone: the next cards in
  if (!list.length) { if (p.status !== 'waiting') patchPull(p.id, x => { x.status = 'waiting' }); return }
  const slot = await getConnection().getSlot('confirmed')
  const f = freezeList(list)
  patchPull(p.id, x => { x.status = 'burned'; x.freeze = { ...f, seq: nextSeq(), slot, seedSlot: slot + config.drawDelaySlots, at: Date.now() } })
  emitEvent({ id: `pullfreeze:${p.id}`, type: 'pull-freeze', mint: p.mint, symbol: p.symbol, wallet: p.wallet, extra: { pullId: p.id, cards: f.list.length, hash: f.hash, seedSlot: slot + config.drawDelaySlots } })
}

async function driveDraw(p) {
  // a crash between the two writes below: the rip already names this pull — finish the assignment, never pick again
  const half = rips().find(r => r.pullId === p.id && r.status === 'pulled')
  if (half && !p.draw) { patchPull(p.id, x => { x.status = 'drawn'; x.ripId = half.id; x.card = half.card; x.draw = x.draw || { resumed: true, at: Date.now() } }); return }
  const conn = getConnection()
  const fin = await conn.getSlot('finalized')
  if (fin < p.freeze.seedSlot) return
  const blocks = await conn.getBlocks(p.freeze.seedSlot, Math.min(fin, p.freeze.seedSlot + 200), 'finalized')
  if (!blocks.length) return
  const blk = await conn.getBlock(blocks[0], { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 })
  if (!blk?.blockhash) return
  // the frozen list cannot shrink while this pull holds the machine (one in flight); if an admin action moved a card,
  // the pull re-freezes on what is left rather than ever picking a card that is gone
  const inStock = new Set(stockOf(p.mint).map(r => r.id))
  if (!p.freeze.list.every(id => inStock.has(id))) { patchPull(p.id, x => { x.freeze = null; x.refrozen = (x.refrozen || 0) + 1 }); return }
  const seed = pullSeed({ blockhash: blk.blockhash, pullId: p.id, sig: p.sig, hash: p.freeze.hash })
  const pick = pickCard(p.freeze.list, seed)
  const rip = rips().find(r => r.id === pick.ripId)
  if (!rip || rip.status !== 'stock') throw new Error(`pull ${p.id}: picked ${pick.ripId} is not in stock`)
  // the card leaves the machine (rip first: a crash here is resumed above, never re-picked)
  ripsStore.update(s => { const r = s.rips.find(x => x.id === pick.ripId); r.status = 'pulled'; r.pullId = p.id; r.pulledAt = Date.now() })
  patchPull(p.id, x => {
    x.status = 'drawn'; x.ripId = pick.ripId; x.card = rip.card
    x.draw = { blockSlot: blocks[0], blockhash: blk.blockhash, seed, index: pick.index, n: pick.n, at: Date.now() }
  })
  emitEvent({ id: `pulldraw:${p.id}`, type: 'pull-draw', mint: p.mint, symbol: p.symbol, wallet: p.wallet, extra: { pullId: p.id, card: rip.card, ripId: pick.ripId, of: pick.n } })
}

async function driveDelivery(p) {
  if (!config.deliverLive) return
  const vault = vaultKeyFor(p.mint)
  const d = p.delivery
  if (d?.sig) {
    const res = await settleTx({ raw: d.raw, sig: d.sig, lastValidBlockHeight: d.lastValidBlockHeight, builtSlot: d.builtSlot ?? null }, { deadlineMs: 20_000 })
    if (res.status === 'confirmed') return markDelivered(p, d.sig)
    if (res.status === 'ambiguous') return
    p = patchPull(p.id, x => { x.delivery = { attempts: (x.delivery?.attempts || 0) + 1, lastError: res.status === 'failed' ? res.err : 'expired' } })
  }
  if ((p.delivery?.attempts || 0) >= DELIVERY_TRIES) { patchPull(p.id, x => { x.status = 'stuck'; x.error = `the transfer failed ${DELIVERY_TRIES} times` }); return }
  const a = await readCard(p.card.id)
  if (a && a.owner === p.wallet) return markDelivered(p, null)
  if (!a || a.owner !== vault.publicKey.toBase58()) { patchPull(p.id, x => { x.status = 'stuck'; x.error = `the card is owned by ${a?.owner || 'nobody'}, not the vault` }); return }
  if (isKilled()) return
  const mv = cardTransfer({ id: p.card.id, a, owner: vault.publicKey, to: p.wallet })
  const built = await buildTx({ payer: vault.publicKey, instructions: [mv.ix], signers: [vault], units: mv.units })
  await simulate(built.tx, { minContextSlot: built.builtSlot })
  if (isKilled()) return
  const sig = sigOf(built.tx)
  // journal BEFORE broadcast: a crash after this resumes by settling these exact bytes
  patchPull(p.id, x => { x.delivery = { attempts: x.delivery?.attempts || 0, sig, raw: Buffer.from(built.tx.serialize()).toString('base64'), lastValidBlockHeight: built.lastValidBlockHeight, builtSlot: built.builtSlot ?? null, at: Date.now() } })
  const res = await settleTx({ raw: pullById(p.id).delivery.raw, sig, lastValidBlockHeight: built.lastValidBlockHeight, builtSlot: built.builtSlot ?? null }, { deadlineMs: 20_000 })
  if (res.status === 'confirmed') return markDelivered(pullById(p.id), sig)
  // failed / provably not landed: the next tick rebuilds (the card is still in the vault: checked above every time)
  if (res.status === 'failed' || res.status === 'not-landed') patchPull(p.id, x => { x.delivery = { attempts: (x.delivery?.attempts || 0) + 1, lastError: res.status } })
}
function markDelivered(p, sig) {
  patchPull(p.id, x => { x.status = 'delivered'; x.deliveredAt = Date.now(); x.delivery = { ...(x.delivery || {}), status: 'confirmed', sig: sig || x.delivery?.sig || null } })
  ripsStore.update(s => { const r = s.rips.find(x => x.id === p.ripId); if (r) { r.status = 'delivered'; r.deliveredAt = Date.now(); r.delivery = { status: 'confirmed', sig: sig || p.delivery?.sig || null, to: p.wallet } } })
  emitEvent({ id: `pulldeliver:${p.id}`, type: 'pull-delivered', mint: p.mint, symbol: p.symbol, wallet: p.wallet, sig: sig || p.delivery?.sig || undefined, extra: { pullId: p.id, card: p.card } })
}

export async function pullsTick() {
  if (run.busy || config.offline || !config.rpcUrl) return
  run.busy = true
  try {
    samplePrices()
    const height = await getConnection().getBlockHeight('finalized').catch(() => null)
    // quotes whose blockhash died without a burn: dropped (nothing happened), and the wallet cools down on that coin
    if (height != null) for (const p of pulls().filter(x => x.status === 'quoted' && height > x.lastValidBlockHeight + HEIGHT_MARGIN)) {
      lapses.set(`${p.wallet}:${p.mint}`, Date.now() + LAPSE_COOLDOWN_MS)
      dropPull(p.id)
    }
    if (lapses.size > 50_000) for (const [k, until] of lapses) if (until < Date.now()) lapses.delete(k)
    // money flows only with the flag on (a burn already sent is always followed through)
    if (!config.pullsLive && !pulls().some(p => ['sent', 'unseen', 'burned', 'waiting', 'drawn'].includes(p.status))) return
    for (const p of pulls().filter(x => x.status === 'sent')) { try { await driveSent(p, height) } catch (e) { run.lastError = `${p.id}: ${errText(e)}` } }
    for (const p of pulls().filter(x => x.status === 'unseen')) { try { await driveUnseen(p) } catch (e) { run.lastError = `${p.id}: ${errText(e)}` } }
    const toFreeze = pulls().filter(x => (x.status === 'burned' && !x.freeze) || x.status === 'waiting').sort((a, b) => (a.burnSlot || 0) - (b.burnSlot || 0) || (a.id < b.id ? -1 : 1))
    for (const p of toFreeze) { try { await driveFreeze(p) } catch (e) { run.lastError = `${p.id}: ${errText(e)}` } }
    const toDraw = pulls().filter(x => x.status === 'burned' && x.freeze && !x.draw).sort((a, b) => a.freeze.seq - b.freeze.seq)
    for (const p of toDraw) { try { await driveDraw(p) } catch (e) { run.lastError = `${p.id}: ${errText(e)}` } }
    for (const p of pulls().filter(x => x.status === 'drawn')) { try { await driveDelivery(p) } catch (e) { run.lastError = `${p.id}: ${errText(e)}` } }
    run.at = Date.now()
  } finally { run.busy = false }
}

/**
 * Admin, for a pull that needs a hand:
 *   retry   → stuck / needs-attention: try the delivery (or the burn read) again
 *   restock → stuck: the card is still in the vault: put it back in the machine and close the pull by hand (void)
 *   void    → waiting / unseen / needs-attention with no card assigned: close it (its burn is handled off-engine)
 */
export function resolvePull(id, action) {
  const p = pullById(id)
  if (!p) throw new Error('no such pull')
  if (action === 'retry' && ['stuck', 'needs-attention'].includes(p.status)) return patchPull(id, x => { x.status = x.card ? 'drawn' : 'sent'; x.delivery = null; x.error = null; x.sentAt = Date.now() })
  if (action === 'restock' && p.status === 'stuck' && p.ripId) {
    ripsStore.update(s => { const r = s.rips.find(x => x.id === p.ripId); if (r && r.status === 'pulled') { r.status = 'stock'; r.pullId = null } })
    return patchPull(id, x => { x.status = 'void'; x.voidReason = 'card put back in the machine by hand' })
  }
  if (action === 'void' && ['waiting', 'unseen', 'needs-attention'].includes(p.status) && !p.ripId) return patchPull(id, x => { x.status = 'void'; x.voidReason = 'closed by hand' })
  throw new Error(`cannot ${action} a ${p.status} pull`)
}

/* ---------------- public shapes ---------------- */

const fmtTokens = raw => { const n = Number(BigInt(raw)) / 10 ** DECIMALS; return n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0) }
export function publicPull(p) {
  if (!p) return null
  const list = p.freeze?.list || null
  return {
    id: p.id, mint: p.mint, symbol: p.symbol, wallet: p.wallet, status: p.status, createdAt: p.createdAt, expiresAt: p.expiresAt,
    tokens: p.tokensRaw, burned: p.burnedRaw || null, priceUsd: p.priceUsd, sig: p.sig || null, burnSlot: p.burnSlot || null,
    quote: p.quote ? { cards: p.quote.list.length, hash: p.quote.hash } : null,
    freeze: p.freeze ? { cards: list.length, list, hash: p.freeze.hash, slot: p.freeze.slot, seedSlot: p.freeze.seedSlot, seq: p.freeze.seq, at: p.freeze.at || null } : null,
    draw: p.draw ? { blockSlot: p.draw.blockSlot, blockhash: p.draw.blockhash, seed: p.draw.seed, eligible: list, index: p.draw.index, n: p.draw.n } : null,
    card: p.card || null, ripId: p.ripId || null, deliveredAt: p.deliveredAt || null, deliverySig: p.status === 'delivered' ? (p.delivery?.sig || null) : null,
    reason: ['void', 'invalid'].includes(p.status) ? p.voidReason || null : null, late: !!p.late,
  }
}
export function pullTotals() {
  const all = pulls()
  return { pulls: all.filter(p => p.burnedRaw && p.status !== 'invalid').length, delivered: all.filter(p => p.status === 'delivered').length, valueUsd: all.filter(p => p.card).reduce((a, p) => a + (Number(p.card.valueUsd) || 0), 0) }
}
