// Trades for the site: quote, build (unsigned, the user's wallet is the ONLY signer), relay, status.
//   curve coins      → pump SDK buyInstructions / sellInstructions (pump.js curveTrade)
//   graduated coins  → pump-swap-sdk buyQuoteInput / sellBaseInput on the canonical pool (pump.js ammTrade)
//   anything else    → Jupiter lite-api (keyless)
// The engine builds, the wallet signs, the engine relays the exact bytes. It never signs a user tx, and /tx/send
// refuses any tx that asks for a signature from one of the engine's own keys.
import { createHash } from 'crypto'
import { VersionedTransaction, SendTransactionError } from '@solana/web3.js'
import { config, WSOL } from './config.js'
import { getConnection, buildTx, pk, isPubkey, sigOf, sigStatus, sigStatuses, engineAddress, burnAddress, coinKeyFor, poolKeyFor } from './solana.js'
import { curveTrade, ammTrade, quoteCurve } from './pump.js'
import { coins, coinRec, rootMint } from './registry.js'
import { relaysStore, launchesStore } from './store.js'
import { messageIsOurs } from './math.js'
import { emitEvent } from './bus.js'
import { http } from './httperr.js'

const T = ms => AbortSignal.timeout(ms)
export const normSide = m => (String(m || '').toUpperCase() === 'SOL' || m === WSOL ? 'SOL' : String(m || ''))

/* ---------------- Jupiter ---------------- */

export async function jupQuote({ input, output, amount, slippageBps = 100 }) {
  const mintOf = m => (m === 'SOL' ? WSOL : m)
  const q = new URLSearchParams({ inputMint: mintOf(input), outputMint: mintOf(output), amount: String(amount), slippageBps: String(slippageBps), swapMode: 'ExactIn', restrictIntermediateTokens: 'true' })
  const r = await fetch(`${config.jupiterBase}/quote?${q}`, { signal: T(12_000) })
  if (!r.ok) return null
  const j = await r.json()
  if (!j?.outAmount || BigInt(j.outAmount) <= 0n) return null
  return j
}
export async function jupSwapTx(quote, user) {
  const r = await fetch(`${config.jupiterBase}/swap`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteResponse: quote, userPublicKey: String(user), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 500_000, priorityLevel: 'medium' } } }), signal: T(20_000) })
  if (!r.ok) throw http(`jupiter swap build ${r.status}`, 502)
  const j = await r.json()
  return { tx: VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, 'base64')), lastValidBlockHeight: j.lastValidBlockHeight || 0 }
}
const jupView = q => ({ route: 'jupiter', outAmount: String(q.outAmount), minOut: String(q.otherAmountThreshold || q.outAmount), priceImpactPct: Number(q.priceImpactPct) || 0, feeBps: null })

/* ---------------- quote + build ---------------- */

function parseReq({ input, output, amount, slippageBps }) {
  const a = normSide(input), b = normSide(output)
  if (a === b) throw http('input and output are the same')
  if (a !== 'SOL' && !isPubkey(a)) throw http('input is not SOL or a mint')
  if (b !== 'SOL' && !isPubkey(b)) throw http('output is not SOL or a mint')
  let amt
  try { amt = BigInt(String(amount || '')) } catch { throw http('amount must be a raw integer amount') }
  if (amt <= 0n) throw http('amount must be positive')
  const slip = Math.min(5000, Math.max(1, Math.floor(Number(slippageBps) || 100)))
  const side = a === 'SOL' ? 'buy' : b === 'SOL' ? 'sell' : null
  return { a, b, amt, slip, side, mint: side === 'buy' ? b : side === 'sell' ? a : null }
}

/** Which venue a SOL↔mint pair trades on right now: 'curve' | 'amm' | null (not a pump coin). Shared for 2 s per coin. */
async function venueOf(mint) {
  const f = await quoteCurve(mint)
  if (!f) return null
  return f.graduated ? 'amm' : 'curve'
}

/**
 * API.md /quote → { route, outAmount, minOut, priceImpactPct, feeBps }. Only SOL ↔ a coin registered on Gachapad: the
 * engine is not an open quote proxy (every other pair would spend its RPC and its IP's keyless Jupiter quota).
 */
export async function quote(req, { user = null } = {}) {
  const { a, b, amt, slip, side, mint } = parseReq(req)
  if (!side) throw http('quote SOL against a coin (a coin-to-coin pair is not supported)')
  if (!coinRec(mint)) throw http(`not a coin on ${config.brand}`, 404)
  let venue = null, quoted = null
  try { venue = await venueOf(mint) } catch {}
  if (venue) {
    try {
      const q = venue === 'curve' ? await curveTrade({ mint, side, amount: amt, slippageBps: slip, user }) : await ammTrade({ mint, side, amount: amt, slippageBps: slip, user })
      return q
    } catch (e) {
      if (e.migrating) throw http(e.message, 503)
      if (e.quoted) quoted = e // priced in CARDS ($GACHA): only a Jupiter route (SOL → CARDS → coin) can serve it here
      if (e.graduated) { const q = await ammTrade({ mint, side, amount: amt, slippageBps: slip, user }).catch(x => { if (x.migrating) throw http(x.message, 503); throw x }); return q }
      console.warn(`[trades] ${venue} route for ${mint} failed, trying Jupiter: ${String(e.message).slice(0, 120)}`)
    }
  }
  const j = await jupQuote({ input: a, output: b, amount: amt.toString(), slippageBps: slip })
  if (!j) throw http(quoted ? quoted.message : 'no route for that pair right now', quoted ? 400 : 404)
  return { ...jupView(j), _jup: j }
}

// every swap we built (10 min): sha256(message) → info, and payer:blockhash → [info] so /tx/send can journal an expiry
// and a trade event even when the wallet added its own guard / compute-budget instructions before signing
const built = new Map(), byHash = new Map()
const msgKey = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex')
const hashKey = msg => `${msg.staticAccountKeys[0].toBase58()}:${msg.recentBlockhash}`
export const builtInfo = bytes => built.get(msgKey(bytes)) || null
export function rememberBuilt(tx, info) {
  const rec = { ...info, at: Date.now(), message: Buffer.from(tx.message.serialize()) }
  built.set(msgKey(rec.message), rec)
  const k = hashKey(tx.message)
  byHash.set(k, [...(byHash.get(k) || []), rec].slice(-5))
  if (built.size > 3000) for (const [key, v] of built) { if (Date.now() - v.at > 600_000) built.delete(key); if (built.size <= 2000) break }
  if (byHash.size > 3000) for (const [key, v] of byHash) { if (Date.now() - (v[v.length - 1]?.at || 0) > 600_000) byHash.delete(key); if (byHash.size <= 2000) break }
}
/**
 * The swap we built that a signed tx came from: the exact message, or — a wallet that added its own Lighthouse /
 * compute-budget instructions — one with the same payer + blockhash whose OUR instructions are unchanged
 * (messageIsOurs). `expiryOnly`: some build with the same payer + blockhash (the expiry belongs to the blockhash).
 */
export function builtFor(tx) {
  const exact = built.get(msgKey(tx.message.serialize()))
  if (exact) return { info: exact }
  const cands = byHash.get(hashKey(tx.message)) || []
  const signed = tx.message.serialize()
  for (const c of cands) if (messageIsOurs(c.message, signed)) return { info: c }
  return cands.length ? { expiryOnly: cands[cands.length - 1].lastValidBlockHeight } : {}
}

/** Never hand a user a tx that wants any signer but their own wallet (the engine signs nothing here). Pure. */
export function assertSoleSigner(tx, wallet) {
  if (tx.message.header.numRequiredSignatures !== 1 || !tx.message.staticAccountKeys[0].equals(pk(wallet))) throw http('built a transaction with unexpected signers', 502)
  return true
}

/** POST /tx/swap → { tx (base64, unsigned), route, quote }. */
export async function buildSwap({ wallet, input, output, amount, slippageBps }) {
  if (!isPubkey(wallet)) throw http('wallet is not a valid Solana address')
  const q = await quote({ input, output, amount, slippageBps }, { user: wallet })
  const { ixs, _jup, ...view } = q
  let tx, lastValidBlockHeight
  if (ixs) {
    const b = await buildTx({ payer: wallet, instructions: ixs, units: q.route === 'amm' ? 300_000 : 250_000 })
    tx = b.tx; lastValidBlockHeight = b.lastValidBlockHeight
    if (tx.serialize().length > 1232) throw http('the trade does not fit one transaction', 400)
  } else {
    ({ tx, lastValidBlockHeight } = await jupSwapTx(_jup, wallet))
  }
  assertSoleSigner(tx, wallet)
  const { mint, side } = parseReq({ input, output, amount, slippageBps })
  rememberBuilt(tx, { lastValidBlockHeight, mint, side, route: view.route, amount: String(amount), outAmount: view.outAmount, wallet })
  return { tx: Buffer.from(tx.serialize()).toString('base64'), route: view.route, quote: view }
}

/* ---------------- relay + status ---------------- */

/** Every key the engine can sign with (or derives): engine, burn, every coin key and holder pool it knows. */
export function engineKeys() {
  const s = new Set([engineAddress(), burnAddress()].filter(Boolean))
  for (const c of Object.values(coins())) for (const a of [c.creatorKey, c.holderPool, c.parentPool]) if (a) s.add(a)
  const r = rootMint()
  if (r) { const p = poolKeyFor(r); if (p) s.add(p.publicKey.toBase58()) }
  return s
}
/** Pure: the required signers of a tx that are engine keys (a relayed tx must have none). */
export function engineSigners(tx, keys = engineKeys()) {
  return tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map(k => k.toBase58()).filter(k => keys.has(k))
}

/**
 * Did the RPC node REFUSE this send before forwarding it? Only a JSON-RPC error answered by the node proves that:
 * preflight simulation failed, signature verification, a tx it cannot decode / sanitize, an unhealthy or lagging node.
 * A timeout, an abort, an HTTP 5xx or a dropped connection proves nothing (the node may already have forwarded the
 * tx), and "already processed" means it LANDED. Pure.
 */
export function sendRefused(e) {
  if (!(e instanceof SendTransactionError || e?.name === 'SendTransactionError')) return false
  const m = String(e.transactionMessage || e.message || '')
  if (/already (been )?processed/i.test(m)) return false
  return /simulation failed|signature verification|precompile|failed to deserialize|invalid transaction|sanitize|too large|node is (unhealthy|behind)|minimum context slot/i.test(m)
}

/**
 * POST /tx/send: relay a user-signed tx, exact bytes. Journals { sig, lvbh } first. → { sig } once the node took it,
 * or { sig, status: 'unknown' } when its fate is unknown (a timeout / 5xx after it may have been forwarded): the
 * caller polls the sig, never re-signs a second tx. Only a node's refusal (nothing forwarded) is an error (502), and
 * that journal entry is marked 'rejected' so it is never tracked as a pending swap.
 */
export async function relay(signedTxB64, { send = true } = {}) {
  let tx
  try { tx = VersionedTransaction.deserialize(Buffer.from(String(signedTxB64 || ''), 'base64')) } catch { throw http('not a transaction') }
  if (!tx.signatures[0] || tx.signatures[0].every(x => x === 0)) throw http('the transaction is not signed')
  const bad = engineSigners(tx)
  if (bad.length) throw http('this transaction asks an engine key to sign: refused', 403)
  const sig = sigOf(tx)
  const { info, expiryOnly } = builtFor(tx)
  const list = relaysStore.get()
  let entry = list.find(r => r.sig === sig), fresh = false
  if (!entry) {
    entry = { sig, at: Date.now(), lastValidBlockHeight: info?.lastValidBlockHeight || expiryOnly || null, kind: info ? 'swap' : 'foreign', mint: info?.mint || null, side: info?.side || null, wallet: info?.wallet || tx.message.staticAccountKeys[0].toBase58(), route: info?.route || null, outAmount: info?.outAmount || null, amount: info?.amount || null }
    list.push(entry); fresh = true
    if (list.length > 5000) list.splice(0, list.length - 5000)
    relaysStore.touch()
  }
  if (!send) return { sig }
  try { await getConnection().sendRawTransaction(Buffer.from(tx.serialize()), { skipPreflight: false, maxRetries: 3 }) } catch (e) {
    if (sendRefused(e)) {
      // nothing was forwarded. Only this call's own entry is marked: an earlier send of the same bytes may have gone out
      if (fresh && !entry.done) { entry.done = 'rejected'; relaysStore.touch() }
      throw http(`send failed: ${String(e.transactionMessage || e.message).slice(0, 200)}`, 502)
    }
    console.warn(`[trades] relay ${sig}: the send's fate is unknown (${String(e?.message || e).slice(0, 120)}) — the caller polls it`)
    return { sig, status: 'unknown' }
  }
  return { sig }
}

/** GET /tx/status/:sig → 'pending' | 'landed' | 'failed' | 'dead'. */
export async function txStatus(sig) {
  const known = relaysStore.get().find(r => r.sig === sig) || Object.values(launchesStore.get()).find(l => l.sig === sig)
  return sigStatus(sig, known?.lastValidBlockHeight || null)
}

/**
 * Emit a 'trade' event once for every relayed swap we built that landed (the site's live tape). Never overlaps itself.
 * EVERY pending swap is checked, newest first, in batched reads (one getSignatureStatuses per 256 + at most one
 * epoch read): no window a flood of junk relays could push a real trade out of, and O(1) RPC per 256 relays.
 */
let tracking = false
export async function trackRelays() {
  if (tracking) return // a slow RPC must never stack passes on top of each other (the money loops share it)
  tracking = true
  try {
    const list = relaysStore.get().filter(r => r.kind === 'swap' && !r.done && Date.now() - r.at < 10 * 60_000).reverse()
    for (let i = 0; i < list.length; i += 256) {
      const chunk = list.slice(i, i + 256)
      let v
      try { v = await sigStatuses(chunk.map(r => ({ sig: r.sig, lastValidBlockHeight: r.lastValidBlockHeight }))) } catch { break } // RPC trouble: the next pass
      for (const r of chunk) {
        const st = v.get(r.sig)
        if (!st || st === 'pending') continue
        r.done = st
        relaysStore.touch()
        if (st === 'landed' && r.mint) {
          try {
            const c = coins()[r.mint]
            if (c && !c.hidden) emitEvent({ id: `trade:${r.sig}`, type: 'trade', mint: r.mint, symbol: c.symbol, parentMint: c.parent || undefined, wallet: r.wallet, sig: r.sig, amountSol: r.side === 'buy' ? Number(r.amount) / 1e9 : Number(r.outAmount || 0) / 1e9, extra: { side: r.side, route: r.route } })
          } catch {}
        }
      }
    }
  } finally { tracking = false }
}
export { coinKeyFor }
