// Launches: prepare → (the wallet signs) → submit → register → LOCK the fee split → sweep the coin key.
//
// Two transactions, forced by the 1232-byte limit (create + lock in one tx does not fit with a first buy):
//   1. (the launcher signs + pays) pump.fun create_v2 [+ first buy, pump ALT] + transfer(launcher → coin key,
//      SETUP_SOL + POOL_SEED_SOL). Default LAUNCH_PRESIGN=true: the MINT signs first (proven with Phantom on pump:
//      a wallet cannot inject into an already-signed tx). LAUNCH_PRESIGN=false: the wallet signs first and may add
//      Lighthouse / ComputeBudget instructions, accepted by messageIsOurs, then the engine adds the mint signature.
//   2. (the coin key signs + pays, atomic) seed the parent's holder pool if it is below rent(0)+margin +
//      createFeeSharingConfig + updateFeeShares([launcher 4000, pool(parent) 4000, burn 1000, protocol 1000]).
//      "Config exists" ⇔ all of it happened. Only the curve creator can create the config (6016 otherwise), so the
//      gap between 1 and 2 cannot be hijacked; fees earned in the gap stay in creator_vault[coin key] (swept by shares).
// Every step is journaled before it is sent and settled from the chain on boot. Prepared records are persisted
// WITHOUT the mint secret, and the parent is pinned into the metadata JSON, so a launch broadcast without submit
// (the tx already carries the mint signature) or across a restart is still adopted under the right parent.
import { Keypair, VersionedTransaction, PublicKey } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import { getTokenMetadata, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { config } from './config.js'
import { launchesStore, preparedStore, newId, bookSweep, readState, patchState, addGasSpent } from './store.js'
import {
  getConnection, getEngine, engineAddress, protocolAddress, burnAddress, coinKeyFor, poolKeyFor, serializeTx, buildTx, simulate,
  sendAndConfirm, settleTx, sigOf, balanceOf, balancesOf, accountInfos, sol, toLamports, isWalletKey, isPubkey, pk, transferIx, txFeeLamports, rent0, rentLoaded,
} from './solana.js'
import {
  readCurves, readVaults, collectIxs, readSharingConfig, sharingIxs, createIxs, feeSharingConfigPda, bondingCurvePda, decodeCurve, loadAlts, sharingConfigRent,
  vaultAccounts, coinKeyWsolAta, closeWsolIx, closesAccount, createsTokenAccount, tokenAccountRent, PUMP_PROGRAM_ID, PUMP_ALT_MAINNET,
} from './pump.js'
import { parseImage, pinMetadata, storeImage, discardPreparedFiles, fetchMetadata, metadataHostProblem, isEphemeralHost } from './ipfs.js'
import {
  shareholdersFor, rootShareholdersFor, sweepParts, validateTicker, validateName, normalizeSocials, depthOk, messageIsOurs, sameMessage,
  rootLaunchInFlight, launchesInFlight, keyConflicts, pruneIds, parentFromMetadata, lockSeedLamports,
} from './math.js'
import { coins, coinRec, patchCoin, putCoin, rootMint, setRootMint, attachPreRootKids, isVisible, neverPay, infraAddresses, keysMatch, warnEvery, view } from './registry.js'
import { isKilled } from './kill.js'
import { emitEvent } from './bus.js'
import { http, isHttp } from './httperr.js'
import { machine } from './cc.js'

export const PREPARE_TTL_MS = 100_000
const BLOCKHASH_MARGIN = 10 // blocks (~4 s): a submit this close to lastValidBlockHeight could not land any more
const MAX_PREPARED = 400
const MAX_LAUNCH_RECORDS = 5000
const NETWORK_SOL = 0.025 // pump.fun's own rent for mint + curve + metadata + ATAs, plus fees (≈, paid to the chain)
const errText = e => String(e?.message || e).slice(0, 240)
const secrets = new Map() // id → mintKp. MEMORY ONLY: the mint secret never touches disk.
export const _secrets = secrets // tests: simulate a restart (the secret is gone) or a live prepare

// A 'failing' canary verdict is persisted (state.json): a restart must never reopen launches a failing simulation
// paused, and an RPC error right after boot (runCanary keeps a prior 'failing') must not turn it into 'unknown'.
// Only a simulation that succeeds clears it.
let canary = null
function canaryNow() {
  if (!canary) {
    let st = null
    try { st = readState().canary } catch {}
    canary = st?.status === 'failing' ? { status: 'failing', at: Number(st.at) || 0, detail: `persisted from before a restart: ${String(st.detail || '').slice(0, 300)}` } : { status: 'unknown', at: 0, detail: null }
  }
  return canary
}
export const canaryStatus = () => canaryNow()
export function setCanary(c) {
  const prev = canaryNow().status
  canary = { ...canaryNow(), ...c, at: Date.now() }
  // persisted only on a change to / from 'failing' (rare): the in-memory verdict holds even if this write fails
  if (canary.status !== prev && (canary.status === 'failing' || prev === 'failing')) {
    try { patchState({ canary: { status: canary.status, at: canary.at, detail: String(canary.detail || '').slice(0, 400) } }) } catch (e) { console.error(`[canary] could not persist the verdict: ${errText(e)}`) }
  }
}
export const _forgetCanary = () => { canary = null } // tests: a restart re-reads the persisted verdict

export const reservedTickers = () => [...new Set([config.ticker, 'ROOT', 'SOL', 'WSOL', 'USDC', 'PUMP', ...config.reservedTickers])]
const fundLamports = () => toLamports(config.setupSol) + toLamports(config.poolSeedSol)

/* ---------------- blockers ---------------- */

/** Why the engine cannot LOCK a split right now (the split is forever: never on a half-configured engine), or null. */
export function lockBlocker() {
  if (!config.rpcUrl || !getEngine()) return 'the engine has no key or RPC yet'
  if (!isPubkey(protocolAddress())) return 'PROTOCOL_WALLET is missing or not a Solana address'
  if (protocolAddress() === engineAddress()) return 'PROTOCOL_WALLET must not be the engine wallet'
  if (config.burnPrivateKey && !burnAddress()) return 'BURN_PRIVATE_KEY is set but cannot be parsed'
  if (!burnAddress()) return 'BURN_PRIVATE_KEY is not set: refusing to lock a split without the burn wallet'
  // the split is written forever: the burn wallet must be neither the engine nor the protocol wallet
  const kc = keyConflicts({ engine: engineAddress(), burn: burnAddress(), protocol: protocolAddress() })
  if (kc.length) return kc[0]
  if (!rentLoaded()) return 'rent(0) not read from the chain yet'
  return null
}
/** Why launches cannot be served right now, or null. ROOT's own launch skips LAUNCH_ENABLED and the ROOT check. */
export function launchBlocker({ root = false } = {}) {
  if (config.offline) return 'launches are off in offline dev mode (no chain)'
  if (isKilled()) return 'the engine is paused'
  const lb = lockBlocker()
  if (lb) return lb
  // create_v2 metadata is immutable: never write a URI that dies with one box / IP
  const mb = metadataHostProblem()
  if (mb) return mb
  if (canaryNow().status === 'failing') return 'pump changed, launches paused (the canary simulation is failing)'
  if (root) return null
  if (!config.launchEnabled) return 'launching is paused'
  const r = rootMint()
  // before $TICKER exists coins launch PRE-ROOT: their split (own pack pool + burn) never depends on ROOT, and they
  // are attached under ROOT the moment it is adopted (registry.attachPreRootKids)
  if (!r) return null
  if (!coinRec(r)) return `ROOT_MINT pins ${r}, but it is not registered here yet: adopt it (POST /admin/root/adopt) before launches open`
  return null
}

/** The level-0 ancestor of a coin (itself for a level-0 coin), or null. */
function topOf(c) { let cur = c; for (let i = 0; cur?.parent && i < 8; i++) cur = coinRec(cur.parent); return cur && !cur.parent ? cur.mint : null }
/**
 * Why a launch may NOT (any longer) be built / relayed under its parent, or null: the parent must still be a live,
 * registered coin under the CURRENT ROOT (visible, for the public) — a ROOT launch needs ROOT to be unset.
 * Checked at prepare, again in the same synchronous step that stores the prepared record, and at submit.
 */
function parentProblem({ root, parent, admin, preRoot = false }) {
  if (root) return rootMint() ? 'ROOT is already set' : null
  if (preRoot && !parent) return null
  const p = coinRec(parent)
  if (!p || p.retiredAt) return `parent is not a coin on ${config.brand}`
  if (!admin && !isVisible(p.mint)) return `parent is not a coin on ${config.brand}`
  const r = rootMint()
  if (!r || topOf(p) !== r) return `$${p.symbol} is no longer under $${config.ticker} (ROOT changed): start again`
  return null
}

export function launchMeta() {
  const b = launchBlocker()
  return {
    enabled: config.launchEnabled && !b, blocker: b, setupSol: config.setupSol + config.poolSeedSol, maxDepth: config.maxDepth,
    tickers: { reserved: reservedTickers() }, firstBuyMaxSol: config.firstBuyMaxSol, presign: config.launchPresign,
    split: config.split, networkSol: NETWORK_SOL,
  }
}

/* ---------------- views ---------------- */

export function launchView(l) {
  if (!l) return null
  return { id: l.id, status: l.status, mint: l.mint, sig: l.sig || null, error: l.error || null, parent: l.parent || null, symbol: l.symbol, sharingSig: l.sharingSig || null }
}
// A caller-supplied id is looked up as an OWN key only: 'constructor', '__proto__', 'toString' … are inherited members
// of every plain-object store and must never read as a launch (a bogus 200, a flush of every public cache)
const own = (store, k) => (Object.hasOwn(store, k) ? store[k] : undefined)
export function getLaunch(id) {
  const k = String(id || '')
  const l = own(launchesStore.get(), k)
  if (l) return launchView(l)
  const p = own(preparedStore.get(), k)
  return p ? launchView({ ...p, status: p.adopted ? 'sent' : Date.now() > p.expiresAt ? 'expired' : 'prepared' }) : null
}
export const preparedCount = () => Object.keys(preparedStore.get()).length

/*
 * What may GET /m/<mint>.<ext> and /img/<mint> serve for a mint (the self-hosted metadata sits on the brand's own domain
 * through the site's rewrite, and its URI is PERMANENT on-chain):
 *   'public'  a registered, VISIBLE coin → CDN-cacheable
 *   'private' a live prepare or a launch journal not registered yet (pump.fun's indexer reads the JSON seconds after the
 *             create lands), a hidden ADMIN (test) launch, a coin under a hidden parent → /m served, never CDN-cached
 *             (its URI must resolve for pump.fun and wallets), /img 404 (the site never shows it)
 *   null      anything else: an unknown mint (a dead prepare's leftovers — an anonymous prepare can write files), or a
 *             PUBLIC launch the admin hid (moderation) → 404
 */
const mintIndex = new WeakMap() // store object → Map(mint → record); every write replaces the object
function byMint(storeObj) {
  let idx = mintIndex.get(storeObj)
  if (!idx) { idx = new Map(); for (const r of Object.values(storeObj)) if (r?.mint) idx.set(r.mint, r); mintIndex.set(storeObj, idx) }
  return idx
}
export const launchRecordOf = mint => byMint(preparedStore.get()).get(String(mint)) || byMint(launchesStore.get()).get(String(mint)) || null
export function publicFileAccess(mint) {
  const m = String(mint || '')
  const c = coinRec(m)
  if (c) {
    if (isVisible(m)) return 'public'
    if (c.hidden && !c.adminLaunch && !launchRecordOf(m)?.admin) return null // a public launch hidden by moderation
    return 'private'
  }
  return launchRecordOf(m) ? 'private' : null
}

/* ---------------- prepare ---------------- */

/**
 * Validate + build a launch. Returns { id, mint, tx (base64 v0; mint-signed unless LAUNCH_PRESIGN=false), expiresAt, costs }.
 * opts.root = the admin's ROOT launch; opts.admin = an admin test launch (hidden by default, may use hidden parents).
 * opts.gate(wallet) runs once EVERY cheap check (body, wallet, parent, balance) passed and before anything is written
 * or uploaded: the HTTP layer spends its per-wallet + global prepare budget there, so junk never drains it.
 */
export async function prepareLaunch(body, { root = false, admin = false, gate = null } = {}) {
  const blocked = launchBlocker({ root })
  if (blocked) throw http(blocked, 503)
  const b = body || {}
  const wallet = String(b.wallet || '').trim()
  if (!isWalletKey(wallet)) throw http('connect a Solana wallet first (an on-curve wallet address)')
  const banned = neverPay()
  if (banned.has(wallet)) throw http('that wallet cannot launch a coin here')
  const nm = validateName(b.name); if (!nm.ok) throw http(nm.error)
  const tk = validateTicker(b.symbol, root ? [] : reservedTickers()); if (!tk.ok) throw http(tk.error)
  const description = String(b.description || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ').trim().slice(0, 500)
  const socials = normalizeSocials(b.socials || {})
  let img
  try { img = parseImage(b.image) } catch (e) { throw http(e.message) }
  if (!img) throw http('image is required (png, jpg, gif or webp data URL, max 4 MB)')
  // hiding is an admin moderation tool: a public caller can never set it
  const hidden = admin ? (b.hidden === undefined ? true : !!b.hidden) : false
  // the parent
  let parent = null, level = 0, preRoot = false
  if (!root && !rootMint() && !b.parent) {
    level = 1; preRoot = true // PRE-ROOT kid: attached under $TICKER when it is adopted
  } else if (!root) {
    const p = coinRec(String(b.parent || ''))
    if (!p) throw http(`parent is not a coin on ${config.brand}`)
    const pp = parentProblem({ root: false, parent: p.mint, admin })
    if (pp) throw http(pp)
    if (!depthOk(p.level, config.maxDepth)) throw http(`$${p.symbol} is at the maximum depth (${config.maxDepth}): launch under a shallower coin`)
    parent = p.mint; level = p.level + 1
  } else {
    if (rootMint()) throw http('ROOT is already set', 409)
    // an earlier draft is never dropped here: it may already be signed and broadcast (sweepPrepared judges it)
    if (rootLaunchInFlight(Object.values(preparedStore.get()), launchesStore.get())) throw http('a ROOT launch is already prepared or in flight: let it land or expire first', 409)
  }
  // the coin's pack machine: fixed for life (pinned in its metadata, recorded on the coin)
  let packCode = null
  if (!root) {
    packCode = String(b.packCode || config.packCode).trim()
    if (!config.packCodes.includes(packCode)) throw http(`pick one of the offered pack machines (${config.packCodes.join(', ')})`)
    let m
    try { m = await machine(packCode) } catch (e) { throw http(`the pack machine list is not reachable right now: ${errText(e)}`, 503) }
    if (!m.open) throw http(`the ${m.name} machine is closed right now: pick another`)
    if (!(m.priceUsdc > 0) || m.priceUsdc > config.packMaxUsdc) throw http(`the ${m.name} pack costs ${m.priceUsdc} USDC, above this pad's limit (${config.packMaxUsdc})`)
  }
  const firstBuySol = Number(b.firstBuySol || 0)
  if (!Number.isFinite(firstBuySol) || firstBuySol < 0 || firstBuySol > config.firstBuyMaxSol) throw http(`first buy must be 0-${config.firstBuyMaxSol} SOL`)
  const buy = toLamports(firstBuySol)
  const dayAgo = Date.now() - 86_400_000
  if (Object.values(coins()).filter(c => c.createdAt > dayAgo).length >= config.maxLaunchesPerDay) throw http('daily launch limit reached, try again tomorrow', 429)
  if (preparedCount() >= MAX_PREPARED) throw http('too many launches are being prepared right now, try again in a minute', 429)
  // cheap balance check BEFORE anything is pinned: a wallet that cannot pay never costs us an upload
  const fund = fundLamports()
  const need = buy + fund + toLamports(NETWORK_SOL)
  const have = await balanceOf(wallet).catch(() => null)
  if (have != null && have < need) throw http(`that wallet needs about ${sol(need).toFixed(3)} SOL to launch (it holds ${sol(have).toFixed(3)})`)
  if (gate) gate(wallet) // throws (429) when this wallet / everyone is over budget; nothing is written before it

  const mintKp = Keypair.generate()
  const mint = mintKp.publicKey.toBase58()
  const coinKey = coinKeyFor(mint)
  const holderPool = poolKeyFor(mint).publicKey.toBase58()
  const parentPool = parent ? poolKeyFor(parent).publicKey.toBase58() : null
  const site = config.siteUrl.replace(/\/$/, '')
  const logo = storeImage(mint, img)
  let meta, built
  try {
    meta = await pinMetadata({ name: nm.name, symbol: tk.symbol, description, twitter: socials.twitter, telegram: socials.telegram, website: socials.website || `${site}/#/coin/${mint}`, mint, img, parent, level, launcher: wallet, machine: packCode })
    if (Buffer.byteLength(meta.uri) > 200) throw http('the metadata link is too long (over 200 bytes): set a shorter SITE_URL / META_BASE_URL', 500)
    // a Pinata failure falls back to self-hosting: never let that write a URI bound to one box / IP (it is permanent)
    if (!/\/ipfs\//.test(meta.uri) && isEphemeralHost(meta.uri)) throw http(`the metadata could only be hosted on ${new URL(meta.uri).host}, which dies with this box: launches wait for IPFS or an owned domain`, 503)
    const { ixs, alts, units } = await createIxs({ mint: mintKp.publicKey, name: nm.name, symbol: tk.symbol, uri: meta.uri, creator: coinKey.publicKey, user: pk(wallet), devBuyLamports: buy })
    built = await buildTx({ payer: wallet, instructions: [...ixs, transferIx(wallet, coinKey.publicKey, fund)], alts, units })
    built.alts = alts
    if (built.tx.serialize().length > 1232) throw new Error('overrun')
  } catch (e) {
    discardPreparedFiles(mint)
    // only OUR errors pass through as they are: an RPC error / timeout also carries an integer `code` (-32005, 23)
    if (isHttp(e)) throw e
    if (/overrun|too large|exceed/i.test(errText(e))) throw http('name or links too long for one transaction: shorten them')
    throw http(`could not build the launch: ${errText(e)}`, 502)
  }
  try { await simulate(built.tx) } catch (e) {
    discardPreparedFiles(mint)
    const m = errText(e)
    if (/insufficient|0x1\b|AccountNotFound/i.test(m)) throw http(`that wallet needs about ${sol(need).toFixed(3)} SOL to launch`)
    throw http(`the launch would fail on-chain: ${m}`)
  }
  // The parent (or ROOT's absence) may have changed while this prepare built: re-check in the SAME synchronous step
  // that stores the record (no await from here to the write), so a reset / adopt of ROOT cannot slip in between.
  const moved = parentProblem({ root, parent, admin, preRoot })
  if (moved) { discardPreparedFiles(mint); throw http(moved, 409) }
  if (root && rootLaunchInFlight(Object.values(preparedStore.get()), launchesStore.get())) { discardPreparedFiles(mint); throw http('a ROOT launch is already prepared or in flight: let it land or expire first', 409) }
  if (config.launchPresign) built.tx.sign([mintKp]) // the mint signs FIRST (see the header)
  const id = newId(12)
  const expiresAt = Date.now() + PREPARE_TTL_MS
  const rec = {
    id, status: 'prepared', mint, wallet, parent, level, root, ...(preRoot ? { preRoot: true } : {}), admin: !!admin, hidden, expiresAt, createdAt: Date.now(),
    symbol: tk.symbol, name: nm.name, description, uri: meta.uri, image: meta.image || logo || '', socials, packCode,
    buyLamports: buy.toString(), fundLamports: fund.toString(), creatorKey: coinKey.publicKey.toBase58(), holderPool, parentPool,
    // not secret: lets a presigned launch be submitted, verified and relayed even after an engine restart
    message: Buffer.from(built.tx.message.serialize()).toString('base64'), lastValidBlockHeight: built.lastValidBlockHeight, builtSlot: built.builtSlot ?? null,
    alts: (built.alts || []).map(a => a.key.toBase58()), presign: config.launchPresign,
  }
  preparedStore.update(all => { all[id] = rec })
  secrets.set(id, mintKp)
  return {
    id, mint, tx: Buffer.from(built.tx.serialize()).toString('base64'), expiresAt,
    costs: { setupSol: sol(fund), firstBuySol, networkSol: NETWORK_SOL },
    presign: config.launchPresign,
  }
}

/** Only sweepPrepared calls this, on chain PROOF that the prepared tx can never land (preparedTxDead). */
function dropPrepared(id, discard = true) {
  const p = preparedStore.get()[id]
  if (!p) return
  preparedStore.update(all => { delete all[id] })
  secrets.delete(id)
  if (discard && !coinRec(p.mint)) discardPreparedFiles(p.mint)
}

/* ---------------- submit ---------------- */

/**
 * Verify + journal + relay a signed launch. Returns { sig, mint, status }. A double submit answers with where it is.
 * `onJournaled` runs once a NEW launch was journaled (the HTTP layer flushes its public caches only then).
 */
export async function submitLaunch(id, signedTxB64, { onJournaled = null } = {}) {
  const k = String(id || '')
  const done = own(launchesStore.get(), k)
  if (done) return { sig: done.sig, mint: done.mint, status: done.status }
  const p = own(preparedStore.get(), k)
  if (!p || p.adopted) throw http('unknown or expired launch: start again', 404)
  if (isKilled()) throw http('the engine is paused', 503) // the kill switch stops relays too, not only prepares
  // a coin relayed now must be lockable: never relay one the engine could not lock (e.g. the burn key went missing)
  const lb = lockBlocker()
  if (lb) throw http(lb, 503)
  if (Date.now() > p.expiresAt) throw http('this launch expired before it was signed: start again', 410)
  // PREPARE_TTL outlives the blockhash: a tx whose blockhash is (about to be) dead can never land, and journaling it
  // would only create a failed launch to recheck. Refuse it before anything is written. An unreadable height proceeds.
  if (p.lastValidBlockHeight != null) {
    const h = await getConnection().getBlockHeight('confirmed').catch(() => null)
    if (h != null && Number(h) > Number(p.lastValidBlockHeight) - BLOCKHASH_MARGIN) throw http('this launch expired before it was signed: start again', 410)
  }
  // the parent may have been hidden / retired / ROOT may have changed since prepare: never relay a child whose
  // 40% would lock to a pool the product no longer stands behind
  const moved = parentProblem({ root: !!p.root, parent: p.parent, admin: !!p.admin, preRoot: !!p.preRoot })
  if (moved) throw http(moved, 409)
  let tx
  try { tx = VersionedTransaction.deserialize(Buffer.from(String(signedTxB64 || ''), 'base64')) } catch { throw http('not a transaction') }
  const built = Buffer.from(p.message, 'base64')
  const signedMessage = Buffer.from(tx.message.serialize())
  const alts = p.alts?.length ? await loadAlts().catch(() => []) : []
  // The mint key only ever signs OUR message: byte-identical, or (wallet-first) ours + the wallet's own guard /
  // compute-budget instructions. Fail closed on anything else.
  if (!messageIsOurs(built, signedMessage, { alts: alts.filter(a => p.alts.includes(a.key.toBase58())) })) throw http('the signed transaction is not the one that was prepared (your wallet may have changed it)')
  const keys = tx.message.staticAccountKeys
  if (keys[0].toBase58() !== p.wallet || !tx.signatures[0] || tx.signatures[0].every(x => x === 0)) throw http('the wallet signature is missing')
  let okSig = false
  try { okSig = ed25519.verify(tx.signatures[0], signedMessage, keys[0].toBytes(), { zip215: false }) } catch {}
  if (!okSig) throw http('the wallet signature is not valid')
  const signers = keys.slice(0, tx.message.header.numRequiredSignatures)
  const mi = signers.findIndex(x => x.toBase58() === p.mint)
  if (mi < 0) throw http('the mint is no longer a signer of this transaction')
  const mintKp = secrets.get(k)
  if (mintKp) tx.sign([mintKp])
  else {
    // after a restart the secret is gone: only a presigned, byte-identical tx can still go (its mint signature is ours)
    let okMint = false
    try { okMint = sameMessage(built, signedMessage) && ed25519.verify(tx.signatures[mi], signedMessage, pk(p.mint).toBytes(), { zip215: false }) } catch {}
    if (!okMint) throw http('the engine restarted since this launch was prepared: start again', 410)
  }
  const sig = sigOf(tx)
  // Journal (with the exact bytes) BEFORE the first broadcast. No await between here and the write.
  const { message, alts: _a, ...rest } = p
  launchesStore.update(all => { all[k] = { ...rest, status: 'sent', sig, raw: Buffer.from(tx.serialize()).toString('base64'), sentAt: Date.now() } })
  preparedStore.update(all => { delete all[k] })
  secrets.delete(k)
  advanceLaunch(k).catch(e => console.error(`[launch] ${k}: ${errText(e)}`))
  if (onJournaled) { try { onJournaled() } catch {} }
  return { sig, mint: p.mint, status: 'sent' }
}

/* ---------------- land → register → lock ---------------- */

const patchLaunch = (id, patch) => { launchesStore.update(all => { if (all[id]) all[id] = { ...all[id], ...patch, updatedAt: Date.now() } }); return launchesStore.get()[id] }

/** The shareholders a launch record locks. */
export function sharesFor(l) {
  const burn = burnAddress(), protocol = protocolAddress()
  if (l.root) return rootShareholdersFor(config.rootShares, { burn, protocol, holders: l.holderPool, creator: l.wallet })
  // GACHAPAD: the pool slot is the coin's OWN pack pool (its fees buy packs for its own holders)
  return shareholdersFor({ launcher: l.wallet, parentPool: l.holderPool, burn, protocol, split: config.split, infra: new Set([...infraAddresses(), l.holderPool, l.parentPool, l.creatorKey, l.mint]) })
}

/**
 * The split the engine would lock for a registered coin RIGHT NOW: its fixed fields (launcher, parent pool) + the
 * CURRENT burn / protocol wallets and split. { shares } or { error } (e.g. no burn wallet). ROOT-type = no parent.
 */
export function plannedShares(c) {
  try { return { shares: sharesFor({ root: c.root ?? !c.parent, wallet: c.creator, parentPool: c.parentPool, holderPool: c.holderPool, creatorKey: c.creatorKey, mint: c.mint }) } } catch (e) { return { error: errText(e) } }
}
export const sameShares = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((s, i) => s.address === b[i].address && s.shareBps === b[i].shareBps && s.role === b[i].role)
const fmtShares = s => (s || []).map(x => `${x.role} ${x.address.slice(0, 4)}… ${x.shareBps}`).join(' / ')

export function registerCoin(l) {
  const all = coins()
  if (all[l.mint]) {
    // idempotent: a crash (or a failed state write) between the coin write and the ROOT write below is repaired by
    // the next settle of the same journal, never left as a registered ROOT with ROOT unset
    const ex = all[l.mint]
    if (l.root && ex.root && !ex.retiredAt && !ex.strayRoot && !rootMint()) { setRootMint(l.mint); console.warn(`[launch] ROOT ${l.mint} was registered but not set as ROOT (interrupted): set now`) }
    return ex
  }
  // A ROOT launch that lands while ANOTHER ROOT is set (it cannot be refused: it is on-chain) is registered and
  // locked like any coin, but HIDDEN: never a second public level-0 coin the public can launch under.
  const strayRoot = !!l.root && !!rootMint() && rootMint() !== l.mint
  if (strayRoot) console.error(`[launch] a ROOT launch $${l.symbol} ${l.mint} landed while ROOT is ${rootMint()}: registered HIDDEN — decide its fate by hand`)
  // the split is planned from the CURRENT config; one that cannot be planned (no burn wallet) is never recorded with a
  // fallback: the journal stays 'sent' and registration retries (backoff) until the engine is configured
  let shares
  try { shares = sharesFor(l) } catch (e) { throw http(`$${l.symbol}: the fee split cannot be planned yet (${errText(e)}) — registration retries`, 503) }
  const rec = {
    mint: l.mint, symbol: l.symbol, name: l.name, description: l.description || '', uri: l.uri, image: l.image || '', socials: l.socials || {},
    parent: l.parent || (l.preRoot && rootMint() && coinRec(rootMint()) ? rootMint() : null), level: l.level, root: !!l.root, creator: l.wallet, creatorKey: l.creatorKey,
    parentPool: l.parentPool || (l.preRoot && rootMint() && coinRec(rootMint()) ? poolKeyFor(rootMint()).publicKey.toBase58() : null), holderPool: l.holderPool,
    ...(l.preRoot ? { preRoot: true } : {}), packCode: l.packCode || null,
    shares, createdAt: l.sentAt || Date.now(), launchSig: l.sig || null, launchId: l.id, hidden: !!l.hidden || strayRoot, external: false,
    sharing: null, setup: null, swept: false, distributeBlocked: null, ...(strayRoot ? { strayRoot: true } : {}),
    // an admin (test / ROOT) launch: its content is ours, so hiding it never withdraws its metadata (publicFileAccess)
    ...(l.admin ? { adminLaunch: true } : {}),
  }
  putCoin(rec)
  if (l.root && !rootMint()) { setRootMint(l.mint); attachPreRootKids() }
  console.log(`[launch] new coin $${rec.symbol} ${rec.mint} by ${rec.creator} under ${rec.parent || '(ROOT)'} (level ${rec.level})`)
  emitEvent({ id: `launch:${l.mint}`, type: 'launch', mint: l.mint, symbol: l.symbol, parentMint: l.parent || undefined, wallet: l.wallet, sig: l.sig || undefined, amountSol: sol(BigInt(l.buyLamports || 0)), extra: { level: l.level, parentSymbol: l.parent ? coinRec(l.parent)?.symbol : null, hidden: !!l.hidden } })
  return rec
}

/**
 * Did this launch's create land? The mint is unique to one launch: a bonding curve created under OUR coin key (or
 * already locked) proves it. TRI-STATE: true | false (a SUCCESSFUL read: no pump curve there) | null (unknown: the
 * read failed, or a pump account there does not decode). Callers never drop, fail or discard anything on null.
 */
async function createLanded(l) {
  let info
  try { [info] = await accountInfos([bondingCurvePda(pk(l.mint))]) } catch { return null }
  return curveLanded(info, l)
}
/** createLanded's verdict from an already-read bonding-curve account (batched reads). */
function curveLanded(info, l) {
  if (!info) return false
  if (!pk(info.owner).equals(PUMP_PROGRAM_ID)) return false // lamports someone parked at the PDA: not a curve
  const bc = decodeCurve(info)
  if (!bc) return null
  const creator = bc.creator.toBase58()
  return creator === l.creatorKey || creator === feeSharingConfigPda(pk(l.mint)).toBase58()
}

const advancing = new Set()
/** Idempotent: move one launch as far as the chain allows. Safe from a timer, a request and boot. */
export async function advanceLaunch(id) {
  if (advancing.has(id)) return getLaunch(id)
  advancing.add(id)
  try {
    let l = launchesStore.get()[id]
    if (!l) return null
    if (l.status === 'failed' && Date.now() - (l.sentAt || 0) < 86_400_000 && !coinRec(l.mint) && (await createLanded(l)) === true) {
      console.warn(`[launch] ${id} ($${l.symbol}) was marked failed but its coin EXISTS on-chain — recovering it`)
      l = patchLaunch(id, { status: 'sent', error: null, recovered: true })
    }
    if (l.status === 'sent') {
      const fresh = !!l.raw && Date.now() - (l.sentAt || 0) < 150_000
      const r = l.recovered || !l.sig ? { status: (await createLanded(l)) === true ? 'confirmed' : 'ambiguous' } : await settleTx({ raw: l.raw, sig: l.sig, lastValidBlockHeight: l.lastValidBlockHeight, builtSlot: l.builtSlot ?? null }, { broadcast: fresh, deadlineMs: fresh ? 150_000 : 20_000 })
      // our signature failed / expired — but the same mint may still have been created by another tx: ask the chain,
      // and on an unreadable answer keep the launch 'sent' (never mark it failed or delete its metadata on a guess)
      const landed = r.status === 'failed' || r.status === 'not-landed' ? await createLanded(l) : null
      if (r.status === 'confirmed' || landed === true) { registerCoin(l); l = patchLaunch(id, { status: 'created', raw: null }) }
      else if (landed === null && r.status !== 'ambiguous') return launchView(l) // unknown: settled on a later pass
      else if (r.status === 'failed') { l = patchLaunch(id, { status: 'failed', error: `the launch transaction failed on-chain (${r.err})`, raw: null }); discardPreparedFiles(l.mint) }
      else if (r.status === 'not-landed') { l = patchLaunch(id, { status: 'failed', error: 'the transaction expired before it landed: nothing was spent, try again', raw: null }); discardPreparedFiles(l.mint) }
      else return launchView(l) // ambiguous: stays 'sent', settled on a later pass
    }
    if (l.status === 'created') {
      const done = await finalizeCoin(l.mint)
      if (done?.sharing?.address) l = patchLaunch(id, { status: 'live', sharingSig: done.sharing.tx || null })
    }
    return launchView(l)
  } finally { advancing.delete(id) }
}

// Retries back off per launch/coin (20 s ticks would otherwise hammer the RPC for one that cannot finish yet).
const retryAt = new Map(), retryMs = new Map(), recheckN = new Map()
const due = k => Date.now() >= (retryAt.get(k) || 0)
const backoff = k => { const ms = Math.min(600_000, (retryMs.get(k) || 15_000) * 2); retryMs.set(k, ms); retryAt.set(k, Date.now() + ms) }
const clearBackoff = k => { retryAt.delete(k); retryMs.delete(k); recheckN.delete(k) }
// A failed launch is rechecked for 24 h (its verdict could be wrong), on a FIXED schedule and in batched reads —
// never on every 20 s tick: failed launches are free to create (a submit whose blockhash then dies).
const RECHECK_MS = [120_000, 900_000, 7_200_000, 21_600_000]
const scheduleRecheck = k => { const n = recheckN.get(k) || 0; recheckN.set(k, n + 1); retryMs.delete(k); retryAt.set(k, Date.now() + RECHECK_MS[Math.min(n, RECHECK_MS.length - 1)]) }
export const _clearBackoffs = () => { retryAt.clear(); retryMs.clear(); recheckN.clear() } // tests
export const _recheckScheduled = k => recheckN.has(k) // tests

/**
 * A prepared tx already carries the mint's signature (presign), so a wallet could broadcast it without ever
 * calling /launch/submit — and the record is on disk, so this also works across a restart. Before an expired
 * prepare is forgotten, ask the chain: a curve under our coin key means the launch happened → journal it (with
 * the PERSISTED parent) and finish it.
 * A record is forgotten (and its metadata files — with a self-hosted URI, the ONLY copy of its pinned parent — are
 * deleted) only on chain PROOF that its tx can never land, the way settleTx proves a dead signature (preparedTxDead).
 * The wall clock (10 min past expiry) is only a minimum: block height, not time, kills a blockhash, and a cluster halt
 * freezes it while a wallet can still rebroadcast the presigned tx after the restart.
 */
export async function sweepPrepared() {
  for (const [id, p] of Object.entries(preparedStore.get())) {
    if (p.adopted || Date.now() < p.expiresAt + 45_000 || launchesStore.get()[id]) continue
    if (!due(`p:${id}`)) continue
    let landed = await createLanded(p)
    if (landed === false && Date.now() > p.expiresAt + 600_000) {
      const proof = await preparedTxDead(p)
      if (proof === 'dead') { dropPrepared(id); clearBackoff(`p:${id}`); continue }
      if (proof === 'landed') landed = true
      else if (p.lastValidBlockHeight == null) warnEvery(`nolvbh:${id}`, 3_600_000, `[launch] prepared ${id} ($${p.symbol}) has no lastValidBlockHeight: it can never be proven expired — kept (inspect it in /admin/state)`)
    }
    if (landed === true) {
      console.warn(`[launch] ${id} ($${p.symbol}) was never submitted but its coin EXISTS on-chain — adopting it under ${p.parent || 'ROOT'}`)
      const { message, alts, ...rest } = p
      launchesStore.update(all => { all[id] = { ...rest, status: 'sent', recovered: true, sig: null, sentAt: Date.now() } })
      preparedStore.update(all => { delete all[id] })
      secrets.delete(id)
      clearBackoff(`p:${id}`)
      continue
    }
    backoff(`p:${id}`) // unknown (RPC error), inside the window, or not provably dead yet: ask again later, never forget it
  }
}

/**
 * Can a prepared tx never land any more? 'dead' only on PROOF: the FINALIZED block height is past the record's
 * lastValidBlockHeight (no block that could still include it will ever be produced) AND a read answered at or after
 * that finalized slot (minContextSlot: a lagging node errors instead of answering) shows no curve for the mint.
 * 'landed' when that read finds its curve; null otherwise (no proof yet, a read failed, no recorded height).
 */
async function preparedTxDead(p) {
  if (p.lastValidBlockHeight == null) return null
  try {
    const fin = await getConnection().getEpochInfo('finalized')
    if (!(Number(fin.blockHeight) > Number(p.lastValidBlockHeight)) || !(Number(fin.absoluteSlot) > 0)) return null
    const [info] = await accountInfos([bondingCurvePda(pk(p.mint))], { minContextSlot: Number(fin.absoluteSlot) })
    const v = curveLanded(info, p)
    return v === false ? 'dead' : v === true ? 'landed' : null
  } catch { return null }
}

/**
 * Admin: adopt an orphan coin by mint — one whose prepared record is gone. The curve must be ours (creator = our
 * coin key, or the config it locked to); the parent + launcher come from the pin in the coin's own metadata JSON.
 */
export async function adoptOrphan(mint) {
  if (!isPubkey(mint)) throw http('not a mint')
  if (coinRec(mint)) throw http('already registered', 409)
  const ck = coinKeyFor(mint)?.publicKey.toBase58()
  if (!ck) throw http('the engine has no key', 503)
  const f = (await readCurves([mint])).get(mint)
  if (!f) throw http('no pump.fun curve for that mint', 404)
  // EVERY fee-shared pump coin has the config PDA as its curve creator: that alone proves nothing. It is ours only when
  // the config's admin (kept after the revoke) is OUR coin key — as adoptRoot checks.
  let ours = f.creator === ck
  if (!ours && f.creator === feeSharingConfigPda(pk(mint)).toBase58()) {
    const sc = await readSharingConfig(mint).catch(() => { throw http('could not read the coin’s fee-sharing config', 502) })
    ours = sc?.config?.admin?.toBase58() === ck
  }
  if (!ours) throw http('that coin was not created under this engine’s coin key', 400)
  const md = await getTokenMetadata(getConnection(), pk(mint), 'confirmed', TOKEN_2022_PROGRAM_ID).catch(() => null)
  if (!md) throw http('could not read the coin’s on-chain metadata', 502)
  const json = await fetchMetadata(md.uri, mint)
  return adoptWithPin(mint, { name: md.name, symbol: md.symbol, uri: md.uri }, json)
}
/** Register an orphan from its pinned metadata (split out so the pin logic is unit-testable). */
export function adoptWithPin(mint, md, json) {
  const pin = parentFromMetadata(json)
  if (!pin) throw http('the metadata carries no parent pin', 400)
  const par = pin.level > 0 && pin.parent ? coinRec(pin.parent) : null
  if (pin.level > 0 && pin.parent && !par) throw http(`the pinned parent ${pin.parent} is not registered here`, 400)
  if (par?.retiredAt) throw http(`the pinned parent $${par.symbol} was retired as ROOT: adopting this coin under it would lock its 40% to that coin's holders forever — decide by hand`, 409)
  const launcher = String(json?.gachapad?.launcher || '')
  if (!isWalletKey(launcher)) throw http('the metadata carries no launcher wallet', 400)
  const l = {
    id: `adopt-${mint.slice(0, 8)}`, mint, wallet: launcher, parent: pin.parent, level: pin.level, root: pin.level === 0, ...(pin.preRoot ? { preRoot: true } : {}), packCode: pin.machine && config.packCodes.includes(pin.machine) ? pin.machine : null, hidden: pin.level === 0 || pin.preRoot ? false : !isVisible(pin.parent),
    symbol: String(md.symbol || '').slice(0, 10), name: String(md.name || '').slice(0, 32), description: String(json?.description || '').slice(0, 500), uri: md.uri, image: String(json?.image || ''), socials: normalizeSocials(json || {}),
    creatorKey: coinKeyFor(mint).publicKey.toBase58(), holderPool: poolKeyFor(mint).publicKey.toBase58(), parentPool: pin.parent ? poolKeyFor(pin.parent).publicKey.toBase58() : null,
    status: 'sent', recovered: true, sig: null, sentAt: Date.now(), buyLamports: '0',
  }
  if (l.root && rootMint()) throw http('ROOT is already set', 409)
  launchesStore.update(all => { all[l.id] = l })
  return registerCoin(l)
}

/** Boot + every chain tick: nothing journaled is ever left half-done. */
export async function advanceLaunches() {
  if (config.offline || !config.rpcUrl) return
  await sweepPrepared().catch(e => console.warn('[launch] prepared sweep:', errText(e)))
  const drop = pruneIds(launchesStore.get(), MAX_LAUNCH_RECORDS)
  if (drop.length) launchesStore.update(all => { for (const d of drop) delete all[d] })
  const seen = new Set(), rechecks = []
  for (const l of Object.values(launchesStore.get())) {
    const recheck = l.status === 'failed' && Date.now() - (l.sentAt || 0) < 86_400_000 && !coinRec(l.mint)
    if (!(l.status === 'sent' || l.status === 'created' || recheck) || !due(l.id)) continue
    seen.add(l.mint)
    if (recheck) { rechecks.push(l); continue }
    await advanceOne(l)
  }
  if (rechecks.length) await recheckFailed(rechecks)
  // a failed launch whose 24 h recheck window ended (or whose record was pruned) is never looked at again: forget its
  // schedule, so these maps stay bounded however many failed launches anyone creates
  for (const k of [...recheckN.keys()]) { const l = launchesStore.get()[k]; if (!l || (l.status === 'failed' && Date.now() - (l.sentAt || 0) >= 86_400_000)) clearBackoff(k) }
  await finishCoins(seen)
}
async function advanceOne(l) {
  try {
    const v = await advanceLaunch(l.id)
    if (v?.status === 'live') clearBackoff(l.id)
    else if (v?.status === 'failed') scheduleRecheck(l.id) // just failed (or still failed): the next look is minutes away
    else backoff(l.id)
  } catch (e) { backoff(l.id); console.warn(`[launch] ${l.id} ($${l.symbol}): ${errText(e)}`) }
}
/** Due failed launches: ONE getMultipleAccountsInfo per 100 curves; only a curve that is there is advanced (re-read). */
async function recheckFailed(list) {
  let infos
  try { infos = await accountInfos(list.map(l => bondingCurvePda(pk(l.mint)))) } catch (e) {
    for (const l of list) backoff(l.id)
    warnEvery('recheck', 600_000, `[launch] failed-launch recheck: ${errText(e)}`)
    return
  }
  for (let i = 0; i < list.length; i++) {
    if (curveLanded(infos[i], list[i]) === true) await advanceOne(list[i])
    else scheduleRecheck(list[i].id)
  }
}

/**
 * Every registered coin not finished yet: not locked (its launch record was lost), locked but not swept, or with a
 * journaled lock / sweep tx. There is NO time-based give-up: a coin is only marked swept by a sweep that read its key
 * and its old vault and emptied both (or found only dust). A stuck sweep retries with a capped backoff and shows in
 * /health ('sweep') and /admin/state; a kill or an outage never counts against it.
 */
export async function finishCoins(seen = new Set()) {
  for (const c of Object.values(coins())) {
    if (c.external || seen.has(c.mint) || !due(c.mint)) continue
    if (c.sharing?.address && c.swept && !c.setup?.pendingSig) continue
    try { await finalizeCoin(c.mint) } catch (e) { console.warn(`[launch] finalize $${c.symbol}: ${errText(e)}`) }
    const now = coins()[c.mint]
    if (now?.sharing?.address && now.swept) clearBackoff(c.mint); else backoff(c.mint)
  }
}

const LOCK_UNITS = 400_000
/** How long a coin's lock may keep failing before /health says so ('lock'). */
export const LOCK_FAILING_MS = 10 * 60_000
/** Record why a coin's lock cannot happen (kept from the FIRST failure: `since`); cleared by the lock. */
function noteLockProblem(mint, reason) {
  const c = coins()[mint]
  if (!c || c.sharing?.address) return
  const r = String(reason).slice(0, 300)
  if (c.lockProblem?.reason === r) return
  patchCoin(mint, { lockProblem: { since: c.lockProblem?.since || Date.now(), at: Date.now(), reason: r } })
}
/** An unlocked coin whose lock has kept failing (simulation / on-chain / an undecodable config) for LOCK_FAILING_MS. */
export const lockFailing = (c, now = Date.now()) => !!c && !c.external && !c.sharing?.address && !!c.lockProblem && now - (Number(c.lockProblem.since) || 0) >= LOCK_FAILING_MS

const busyCoins = new Set()
/**
 * The ONE fee-sharing setup of a coin, signed and paid by its coin key (step 1, atomic), then the sweep (step 2).
 * Re-entrant across restarts; nothing here can send twice (journal before broadcast, same-bytes re-broadcast only).
 */
export async function finalizeCoin(mint) {
  let c = coins()[mint]
  if (!c || c.external || busyCoins.has(mint)) return c || null
  const coinKey = coinKeyFor(mint)
  if (!coinKey || !keysMatch(c)) { warnEvery(`key:${mint}`, 3_600_000, `[launch] $${c.symbol}: derived keys ≠ recorded keys (wrong ENGINE_PRIVATE_KEY for this data dir?) — refusing to touch it`); return c }
  if (!c.shares?.length) { warnEvery(`noshares:${mint}`, 3_600_000, `[launch] $${c.symbol}: no shareholders recorded — refusing to lock`); return c }
  busyCoins.add(mint)
  try {
    const me = coinKey.publicKey.toBase58()
    if (c.setup?.pendingSig) {
      const r = await settleTx({ raw: c.setup.raw, sig: c.setup.pendingSig, lastValidBlockHeight: c.setup.lastValidBlockHeight, builtSlot: c.setup.builtSlot ?? null }, { broadcast: !!c.setup.raw, deadlineMs: 60_000 })
      if (r.status === 'ambiguous') return c
      // a confirmed sweep never marks the coin swept here: the sweepCoinKey pass below re-reads the key and the old
      // vault and marks it only when they hold dust (or sweeps what the landed tx left behind)
      if (r.status === 'confirmed' && c.setup.step === 2) { patchCoin(mint, { setup: null }); bookSweep(mint, BigInt(c.setup.claimable || 0)) }
      else if (r.status === 'confirmed' && c.setup.step === 1) {
        patchCoin(mint, { setup: null, lockProblem: null, sharing: { address: feeSharingConfigPda(pk(mint)).toBase58(), tx: c.setup.pendingSig, at: Date.now(), shareholders: c.shares, slot: r.slot ?? null } })
        emitEvent({ id: `lock:${mint}`, type: 'lock', mint, symbol: c.symbol, parentMint: c.parent || undefined, wallet: c.creator, sig: c.setup.pendingSig, extra: { shareholders: c.shares } })
      } else patchCoin(mint, { setup: null })
      c = coins()[mint]
    }
    // The fee lock is forever: never run it on a half-configured engine (e.g. a burn key that stopped parsing).
    const blocked = lockBlocker()
    if (blocked && !c.sharing?.address) { warnEvery(`blk:${mint}`, 600_000, `[launch] $${c.symbol}: fee lock postponed — ${blocked}`); return coins()[mint] }
    const shareholders = c.shares
    // A lock RECORDED here (its confirmed tx, or a config read back) can never be undone: the config is never read again
    // for it — a lagging node answering "no config" must never start a second lock (nor skip that pass's sweep).
    const locked = !!c.sharing?.address
    let sharing = null
    if (!locked) {
      try { sharing = await readSharingConfig(mint) } catch (e) {
        if (!e?.undecodable) throw e
        // a config EXISTS that this SDK cannot decode: never build a lock over it — flag it (/health 'lock')
        warnEvery(`undec:${mint}`, 600_000, `[launch] $${c.symbol}: fee lock NOT attempted — ${errText(e)}`)
        noteLockProblem(mint, errText(e))
        return coins()[mint]
      }
    }
    if (!locked && !sharing) {
      // The split is written FOREVER: send only the split this engine plans NOW (its burn / protocol wallets and
      // split). Shares recorded under another config — a burn key rotated during a kill, a registration before a
      // wallet change — are refused, flagged (/health 'shares') and wait for POST /admin/replan.
      const want = plannedShares(c)
      const problem = want.error ? `the split cannot be planned: ${want.error}` : !sameShares(want.shares, shareholders) ? `the recorded split (${fmtShares(shareholders)}) is not the one this engine plans now (${fmtShares(want.shares)}): re-plan it (POST /admin/replan) or fix the wallets` : null
      if (problem) {
        warnEvery(`plan:${mint}`, 600_000, `[launch] $${c.symbol}: fee lock REFUSED — ${problem}`)
        if (c.sharesProblem?.reason !== problem) patchCoin(mint, { sharesProblem: { at: Date.now(), reason: problem } })
        return coins()[mint]
      }
      if (c.sharesProblem) patchCoin(mint, { sharesProblem: null })
      const curve = (await readCurves([mint])).get(mint)
      if (!curve) return coins()[mint] // the create is not visible yet
      const ixs = []
      // make the pool shareholder exist (pump pays a missing account only above rent + rent*10000/bps) — seeded from
      // what the coin key HOLDS: it was funded at PREPARE under that moment's POOL_SEED_SOL, which may have been raised
      // since (a seed it cannot pay would fail this lock on every pass)
      const poolShare = shareholders.find(s => s.role === 'parentHolders')
      if (poolShare) {
        const bal = (await balancesOf([poolShare.address])).get(poolShare.address) || 0n
        if (bal < rent0() + toLamports(config.poolMarginSol)) {
          const seed = lockSeedLamports({ want: toLamports(config.poolSeedSol), keyLamports: await balanceOf(me), poolLamports: bal, configRent: sharingConfigRent(), lockFee: txFeeLamports(LOCK_UNITS), rent0: rent0() })
          if (seed > 0n) ixs.push(transferIx(me, poolShare.address, seed))
          else warnEvery(`noseed:${mint}`, 3_600_000, `[launch] $${c.symbol}: the coin key cannot also seed the parent pool — locking without the seed (distribution waits for pump's unfunded-shareholder minimum)`)
        }
      }
      ixs.push(...await sharingIxs({ creator: me, mint, graduated: !!curve.graduated, shareholders }))
      const built = await buildTx({ payer: me, instructions: ixs, signers: [coinKey], units: LOCK_UNITS })
      try { await simulate(built.tx) } catch (e) { noteLockProblem(mint, `the lock simulation fails: ${errText(e)}`); throw e }
      if (isKilled()) { console.warn(`[launch] $${c.symbol}: killed — lock not sent`); return coins()[mint] }
      const sig = sigOf(built.tx)
      patchCoin(mint, { setup: { step: 1, pendingSig: sig, raw: Buffer.from(built.tx.serialize()).toString('base64'), lastValidBlockHeight: built.lastValidBlockHeight, builtSlot: built.builtSlot, at: Date.now() } })
      let lockSlot = null
      try { ({ slot: lockSlot } = await serializeTx(me, () => sendAndConfirm(built.tx, built))) } catch (e) {
        if (/CONFIRM_UNKNOWN/.test(e.message)) { console.warn(`[launch] $${c.symbol} fee-lock tx unknown, settled next pass`); return coins()[mint] }
        patchCoin(mint, { setup: null })
        if (/TX_FAILED/.test(e.message)) noteLockProblem(mint, `the lock tx failed on-chain: ${errText(e)}`)
        throw e
      }
      const addr = feeSharingConfigPda(pk(mint)).toBase58()
      // `slot`: where the lock landed — the sweep reads + simulates at or after it (never a pre-lock state)
      patchCoin(mint, { sharing: { address: addr, tx: sig, at: Date.now(), shareholders, slot: lockSlot ?? null }, setup: null, lockProblem: null })
      console.log(`[launch] $${c.symbol}: fee sharing LOCKED on-chain (${sig}) → ${shareholders.map(s => `${s.role} ${s.shareBps}`).join(' / ')}`)
      emitEvent({ id: `lock:${mint}`, type: 'lock', mint, symbol: c.symbol, parentMint: c.parent || undefined, wallet: c.creator, sig, extra: { shareholders } })
    } else if (!locked) {
      const onChain = sharing.config.shareholders.map(x => ({ address: x.address.toBase58(), shareBps: Number(x.shareBps) }))
      const match = onChain.length === shareholders.length && shareholders.every((s, i) => onChain[i].address === s.address && onChain[i].shareBps === s.shareBps)
      if (!match) console.error(`[launch] $${c.symbol}: a sharing config exists with DIFFERENT shareholders than ours — recorded, shown as mismatch, never cranked`)
      patchCoin(mint, { lockProblem: null, sharing: { address: sharing.address.toBase58(), tx: null, at: Date.now(), shareholders, ...(match ? {} : { onChain }) }, ...(match ? {} : { distributeBlocked: { at: Date.now(), reason: 'on-chain shareholders differ from the expected split' } }) })
      if (match) emitEvent({ id: `lock:${mint}`, type: 'lock', mint, symbol: c.symbol, parentMint: c.parent || undefined, wallet: c.creator, extra: { shareholders, recovered: true } })
    }
    await sweepCoinKey(coins()[mint], coinKey)
    return coins()[mint]
  } catch (e) {
    console.error(`[launch] finalize $${c.symbol} failed: ${errText(e)}`)
    return coins()[mint]
  } finally { busyCoins.delete(mint) }
}

const SWEEP_DUST = 100_000n
/** Lamports the coin key holds after a simulated tx (its `accounts` post-state; a closed account is null = 0), or null
 *  when the RPC returned no post-state (nothing to check against: the landed tx is checked instead). */
const keyLeftAfter = sim => (Array.isArray(sim?.accounts) ? BigInt(sim.accounts[0]?.lamports ?? 0) : null)
/**
 * After a sweep landed: does the chain — read at or after the slot it landed in (minContextSlot) — show the coin key,
 * its own WSOL account and BOTH its old vaults (the curve vault and the old PumpSwap vault ATA, whatever any curve read
 * says: an ATA that holds WSOL is fees owed to the shares) all at dust? true | false | null (unreadable). Only true
 * marks a coin swept; anything else leaves it for the next pass, which sweeps what is left.
 */
async function sweepEmptied(me, { slot }) {
  try {
    const opts = { minContextSlot: slot || null }
    const { curveVault, ammVaultAta } = vaultAccounts(me)
    const key = await balanceOf(me, opts)
    const [wsol, vault, ata] = await accountInfos([coinKeyWsolAta(me), curveVault, ammVaultAta], opts)
    const r0 = rent0()
    const inVault = vault && BigInt(vault.lamports) > r0 ? BigInt(vault.lamports) - r0 : 0n
    const inAmm = ata && ata.data?.length >= 72 ? Buffer.from(ata.data).readBigUInt64LE(64) : 0n
    return key + BigInt(wsol?.lamports || 0) + inVault + inAmm <= SWEEP_DUST
  } catch { return null }
}
/**
 * The sweep's instructions, in order: [engine → key: the WSOL-account rent it fronts] + the collect (curve; AMM leg:
 * create the key's WSOL account → collect → close it into the key) + [key → engine: the same lamports back, right after
 * that close] + [close a WSOL account a third party collected into, if the collect did not] + the key's transfers by
 * shares. The fronted pair nets to zero for both sides: the pot and every part are unchanged. Exported for the dry run.
 */
export function sweepInstructions({ me, engine = null, collect = [], front = 0n, keyWsol, wsol = 0n, parts }) {
  const ixs = []
  if (front > 0n) ixs.push(transferIx(engine, me, front))
  ixs.push(...collect)
  if (front > 0n) ixs.push(transferIx(me, engine, front))
  if (wsol > 0n && !closesAccount(ixs, keyWsol)) ixs.push(closeWsolIx(me))
  ixs.push(...parts.map(p => transferIx(me, p.address, p.lamports)))
  return ixs
}
/**
 * What the engine must FRONT so the coin key can create its own temporary WSOL account inside the collect: the SDK
 * makes the key (creator = payer) pay that rent before the collect fills and the close refunds it, so a key holding
 * less than the rent at that point (after its own fee and the curve collect) would fail the whole sweep, on every pass.
 * 0n when the collect creates no such account or the key can pay. Pure.
 */
export function wsolRentToFront({ collect, keyWsol, keyAtCreate, rent }) {
  return createsTokenAccount(collect, keyWsol) && BigInt(keyAtCreate) < BigInt(rent) ? BigInt(rent) : 0n
}
/**
 * Step 2: collect what the coin key's own vault earned before the lock (the first buy's creator fee, early trades)
 * and sweep EVERYTHING the key holds by the same shares — the key may end at 0. A sub-rent part owed to an account
 * that does not exist yet is folded into the parent-pool part (math.js sweepParts). Never blocks a coin going live
 * (going live only needs the lock). The coin is marked swept ONLY when the chain shows the key (+ its own WSOL
 * account) and its old vault at dust: a pass whose reads found only dust, or a sweep that landed and was re-read at
 * or after its slot (sweepEmptied). The pot is what the reads saw, topped up ONCE by what the tx's simulated post-state
 * says it would still leave in the key (a lagging vault read, WSOL someone collected into the key, a rent change): a
 * sweep sent is meant to empty the key; whatever a landed one still left is swept by the next pass.
 * When the collect pass fails, a key-only pass runs ONLY if it finishes the
 * coin (the old vault holds dust): a key-only pass that emptied the key while the vault still held fees left a
 * 0-lamport fee payer that could never collect again. A key that cannot pay its own fee (drained by an older build)
 * while its old vault holds fees is collected with the ENGINE paying that one fee (pump's collect is permissionless;
 * the key still signs its own transfers). A key that cannot pay the rent of its temporary WSOL account (the AMM leg's
 * create, refunded by its close in the same tx) has the ENGINE front that rent and take it back in the same tx
 * (wsolRentToFront): e.g. WSOL donated into the old AMM vault right after an emptying sweep. The AMM leg follows the
 * ANCHORED vault read (the old AMM vault ATA exists and holds WSOL), never a curve read that may lag or not decode.
 * The engine's burn / protocol parts go to the CURRENT wallets.
 */
async function sweepCoinKey(c, coinKey) {
  const mint = c.mint, me = coinKey.publicKey.toBase58()
  if (!c.sharing?.address || c.swept) return
  // the pre-lock fees are in the engine's custody, not under the on-chain lock: never pay a burn / protocol wallet the
  // engine no longer uses (a rotated, leaked key); wait while the current one is missing
  const infraNow = { burn: burnAddress(), protocol: protocolAddress() }
  const isInfra = s => Object.hasOwn(infraNow, s.role)
  const missing = c.shares.find(s => isInfra(s) && !infraNow[s.role])
  if (missing) { warnEvery(`sweepinfra:${mint}`, 600_000, `[launch] $${c.symbol}: sweep postponed — the ${missing.role} wallet is not configured`); return }
  const shares = c.shares.map(s => (isInfra(s) ? { ...s, address: infraNow[s.role] } : s))
  const units = 250_000
  const keyWsol = coinKeyWsolAta(me).toBase58()
  // every read and simulation below is answered at or after the slot the lock landed in (when known): a node still
  // behind it would show the key before it paid the config rent, and the vault before its last pre-lock fees
  const anchor = Number(c.sharing?.slot) || null
  const at = { minContextSlot: anchor }
  const simSlot = built => Math.max(Number(built.builtSlot) || 0, anchor || 0) || null
  for (const withCollect of [true, false]) {
    try {
      // the AMM leg is decided by this ANCHORED read alone: the old PumpSwap vault ATA exists (the pool's coin creator
      // was this key before the lock — or someone parked WSOL there) and holds WSOL. Never an unanchored curve read: a
      // lagging node's "not graduated" (or an undecodable curve) would sweep the curve vault only, mark the coin swept
      // and strand every pre-lock PumpSwap fee. pump_amm's collect needs no pool, so it works for any coin.
      const v = (await readVaults([me], at)).get(me)
      const ammLeg = !!v?.ammAtaExists && (v?.amm || 0n) > 0n
      const inVault = v ? v.curve + (ammLeg ? v.amm : 0n) : 0n
      const final = withCollect || inVault <= SWEEP_DUST // does this pass leave the old vault empty?
      if (!final) return // never empty the key while the old vault holds fees: the next pass collects (the key pays that fee)
      // WSOL someone collected INTO the coin key (pump_amm's collect is permissionless): closing that account unwraps
      // all of it (WSOL + its rent) into the key, where the sweep splits it like any pre-lock fee
      const [wsolInfo] = await accountInfos([keyWsol], at)
      const wsol = wsolInfo && pk(wsolInfo.owner).equals(TOKEN_PROGRAM_ID) ? BigInt(wsolInfo.lamports) : 0n
      const fromVault = withCollect ? inVault : 0n
      const claimable = fromVault + wsol
      const bal = await balanceOf(me, at)
      const engine = getEngine()
      const keyFee = txFeeLamports(units)
      const collect = fromVault > 0n ? await collectIxs(me, ammLeg ? { graduated: true, ammAtaExists: true } : {}) : []
      // the engine pays the fee when the key cannot (below one fee), or when it must front the key's WSOL-account rent
      // (it signs that tx anyway); the fronted rent comes back to it in the same tx
      const keyCannotPay = withCollect && claimable > SWEEP_DUST && bal < keyFee
      const front = engine ? wsolRentToFront({ collect, keyWsol, keyAtCreate: (keyCannotPay ? bal : bal - keyFee) + (v?.curve || 0n), rent: tokenAccountRent() }) : 0n
      const enginePays = !!engine && (keyCannotPay || front > 0n)
      const fee = enginePays ? 0n : keyFee // what the KEY pays
      let pot = bal + claimable - fee
      if (pot <= SWEEP_DUST) { patchCoin(mint, { swept: true, sweptAt: Date.now() }); return }
      const lamportsOf = await balancesOf(shares.map(s => s.address))
      const build = async potNow => {
        const parts = sweepParts(potNow, shares, lamportsOf, rent0(), 'parentHolders')
        if (!parts.length) return null
        const ixs = sweepInstructions({ me, engine: engine?.publicKey || null, collect, front, keyWsol, wsol, parts })
        return buildTx({ payer: enginePays ? engine.publicKey : me, instructions: ixs, signers: enginePays ? [engine, coinKey] : [coinKey], units })
      }
      let built = await build(pot)
      if (!built) { patchCoin(mint, { swept: true, sweptAt: Date.now() }); return }
      // what would this tx REALLY leave in the key? (the reads may lag; the collect moves the whole vault, not what we
      // read) — the simulated post-state; anything above dust is added to the pot ONCE, so the sweep empties the key
      let extra = 0n
      const left = keyLeftAfter(await simulate(built.tx, { minContextSlot: simSlot(built), accounts: [me] }))
      if (left != null && left > SWEEP_DUST) {
        extra = left; pot += left
        built = await build(pot)
        const left2 = keyLeftAfter(await simulate(built.tx, { minContextSlot: simSlot(built), accounts: [me] }))
        if (left2 != null && left2 > SWEEP_DUST) throw new Error(`the sweep would still leave ${left2} lamports in the coin key (the chain moved between two simulations): retried next pass`)
      }
      if (isKilled()) return
      const sig = sigOf(built.tx)
      const booked = claimable + extra
      patchCoin(mint, { setup: { step: 2, pendingSig: sig, raw: Buffer.from(built.tx.serialize()).toString('base64'), lastValidBlockHeight: built.lastValidBlockHeight, builtSlot: built.builtSlot, at: Date.now(), claimable: booked.toString(), final, ...(enginePays ? { enginePays: true } : {}), ...(front > 0n ? { frontLamports: front.toString() } : {}) } })
      let landedSlot = null
      try { ({ slot: landedSlot } = await serializeTx(me, () => sendAndConfirm(built.tx, built))) } catch (e) {
        if (!/CONFIRM_UNKNOWN/.test(String(e.message))) patchCoin(mint, { setup: null }) // unknown: settled at the top of the next finalize pass
        throw e
      }
      patchCoin(mint, { setup: null })
      bookSweep(mint, booked)
      if (enginePays) addGasSpent(txFeeLamports(units, 2))
      // swept ONLY when the chain, read at or after the slot this sweep landed in, shows the key + old vault emptied
      const emptied = await sweepEmptied(me, { slot: landedSlot ?? simSlot(built) })
      if (emptied === true) patchCoin(mint, { swept: true, sweptAt: Date.now() })
      console.log(`[launch] $${c.symbol}: swept ${sol(pot).toFixed(5)} SOL from the coin key by its shares (${sig})${enginePays ? ` — the engine paid the fee${front > 0n ? ` and fronted the key's WSOL-account rent (${front} lamports, returned in the same tx)` : ' (the key held less than one)'}` : ''}${emptied === true ? '' : ` — NOT marked swept yet: ${emptied === false ? 'the key or its old vault still holds more than dust' : 'the key could not be re-read'}, the next pass sweeps the rest`}`)
      return
    } catch (e) {
      console.warn(`[launch] $${c.symbol} sweep${withCollect ? ' (with collect)' : ''}: ${errText(e)}`)
      if (/CONFIRM_UNKNOWN|TX_NOT_LANDED/.test(String(e.message))) return // never stack a second sweep on an unsettled one
    }
  }
}

/* ---------------- ROOT: adopt / reset ---------------- */

/**
 * Admin: set ROOT to an existing pump coin the user launched on pump.fun directly. Refuses if ROOT is set.
 * An external ROOT's own fees go wherever its creator routes them; its HOLDER POOL is still poolKeyFor(ROOT).
 */
export async function adoptRoot(mint) {
  // ROOT is free, or ROOT_MINT pins exactly this mint and it is not registered yet (adopting the pin)
  const rootFree = () => !rootMint() || (config.rootMint === mint && !readState().rootMint)
  // this mint is already registered as a ROOT whose ROOT write never happened (a crash / failed write between the two):
  // re-running the adopt only sets ROOT, it never rewrites the record (its lock / sweep state may have moved on)
  const unsetRoot = () => { const ex = coinRec(mint); return !!ex && !!ex.root && !ex.retiredAt && !ex.strayRoot && rootFree() }
  const blocker = () => {
    if (!rootFree()) return 'ROOT is already set'
    const ex = coinRec(mint)
    if (ex && !ex.retiredAt && !unsetRoot()) return 'that mint is already a registered coin'
    if (launchesInFlight(Object.values(preparedStore.get()), launchesStore.get(), l => !!l.root).length) return 'a ROOT launch is prepared or in flight: let it land or expire first'
    return null
  }
  if (!isPubkey(mint)) throw http('not a mint')
  const b0 = blocker()
  if (b0) throw http(b0, 409)
  if (unsetRoot()) {
    setRootMint(mint)
    attachPreRootKids()
    console.warn(`[launch] ROOT ${mint} was registered but not set as ROOT (interrupted): set now`)
    emitEvent({ id: `launch:${mint}`, type: 'launch', mint, symbol: coinRec(mint).symbol, wallet: coinRec(mint).creator || undefined, extra: { level: 0, adopted: true } })
    return coinRec(mint)
  }
  const f = (await readCurves([mint])).get(mint)
  if (!f) throw http('no pump.fun curve for that mint', 404)
  const md = await getTokenMetadata(getConnection(), pk(mint), 'confirmed', TOKEN_2022_PROGRAM_ID).catch(() => null)
  const json = md?.uri ? await fetchMetadata(md.uri, mint).catch(() => null) : null
  const ck = coinKeyFor(mint)?.publicKey.toBase58()
  const cfgPda = feeSharingConfigPda(pk(mint)).toBase58()
  // "ours" = created under OUR coin key (a ROOT launched through /admin/root/prepare whose records were lost): the
  // engine still owes it its lock (ROOT_SHARES). Anything else is an external ROOT: we never touch its fee sharing.
  const ours = f.creator === ck || (f.creator === cfgPda && (await readSharingConfig(mint).catch(() => { throw http('could not read the coin’s fee-sharing config', 502) }))?.config.admin.toBase58() === ck)
  const holderPool = poolKeyFor(mint).publicKey.toBase58()
  const launcher = isWalletKey(String(json?.gachapad?.launcher || '')) ? json.gachapad.launcher : null
  if (ours && config.rootShares.some(s => s.role === 'creator') && !launcher) throw http('ROOT_SHARES names a creator share but the launcher of this ROOT is unknown: adopt it by hand', 400)
  let shares = null
  if (ours) { try { shares = rootShareholdersFor(config.rootShares, { burn: burnAddress(), protocol: protocolAddress(), holders: holderPool, creator: launcher }) } catch (e) { throw http(`ROOT's fee split cannot be planned yet: ${errText(e)}`, 503) } }
  const rec = {
    mint, symbol: String(md?.symbol || config.ticker).slice(0, 10), name: String(md?.name || config.brand).slice(0, 32), description: String(json?.description || '').slice(0, 500), uri: md?.uri || '', image: String(json?.image || ''), socials: normalizeSocials(json || {}),
    parent: null, level: 0, root: true, creator: ours ? launcher : f.creator, creatorKey: ours ? ck : null, parentPool: null, holderPool,
    shares,
    createdAt: Date.now(), launchSig: null, launchId: null, hidden: false, external: !ours, adopted: true, sharing: null, setup: null, swept: !ours, distributeBlocked: null,
  }
  // the chain reads above awaited: ROOT, this mint's record or a ROOT launch may have changed meanwhile —
  // re-check in the same synchronous step as the write
  const b1 = blocker()
  if (b1) throw http(b1, 409)
  putCoin(rec)
  setRootMint(mint)
  attachPreRootKids()
  emitEvent({ id: `launch:${mint}`, type: 'launch', mint, symbol: rec.symbol, wallet: f.creator, extra: { level: 0, adopted: true } })
  return rec
}
/**
 * Admin: re-plan the split of a coin whose lock was REFUSED because its recorded split is not the one the engine plans
 * now (sharesProblem — e.g. registered while the burn key was being rotated). Only before any lock: never when the
 * coin is locked, its lock tx is journaled, or a sharing config already exists on-chain. Keeps the roles; takes the
 * current burn / protocol wallets and split. The next finalize pass locks it.
 */
export async function replanShares(mint) {
  const c = coinRec(mint)
  if (!c) throw http('unknown coin', 404)
  if (c.external) throw http('an external coin has no split of ours', 409)
  if (c.sharing?.address || c.setup?.pendingSig) throw http('this coin is already locked (or its lock is in flight): its split can never change', 409)
  const lb = lockBlocker()
  if (lb) throw http(lb, 503)
  const want = plannedShares(c)
  if (want.error) throw http(want.error, 409)
  let onChain
  try { onChain = await readSharingConfig(mint) } catch { throw http('could not read the coin’s fee-sharing config', 502) }
  if (onChain) throw http('a fee-sharing config already exists on-chain for this coin: the next finalize pass records it', 409)
  const before = c.shares
  patchCoin(mint, { shares: want.shares, sharesProblem: null })
  console.warn(`[launch] $${c.symbol}: split RE-PLANNED by the admin: ${fmtShares(before)} → ${fmtShares(want.shares)}`)
  clearBackoff(mint)
  return { mint, before, after: want.shares }
}

/** Admin: clear ROOT — only while ROOT has no children. The record stays (hidden) so its keys are never forgotten. */
export function resetRoot() {
  const r = rootMint()
  if (!r) throw http('ROOT is not set', 409)
  if (config.rootMint) throw http('ROOT is pinned by ROOT_MINT in the env: remove it there', 409)
  if (Object.values(coins()).some(c => c.parent === r)) throw http('ROOT has children: it can never be reset', 409)
  // a child still prepared (it may be signed and broadcast by its wallet) or journaled would land under the retired
  // ROOT and lock its 40% to that coin's holders forever: wait until every one of them landed or provably expired
  const flying = launchesInFlight(Object.values(preparedStore.get()), launchesStore.get(), l => l.parent === r || !!l.root, { registered: m => !!coinRec(m) })
  if (flying.length) throw http(`${flying.length} launch(es) under ROOT are prepared or in flight: wait until they land or provably expire (their blockhash dead on the finalized chain: ~12 minutes when blocks flow normally), then reset`, 409)
  if (coinRec(r)) patchCoin(r, { hidden: true, root: false, retiredAt: Date.now() })
  setRootMint('')
  return { ok: true, was: r }
}
export { view }
