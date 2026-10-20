// The coin registry: every coin launched on Gachapad (and ROOT), its keys, its lock, and its live figures read
// from the chain. coins.json is a MONEY store (it maps a coin to its coin key, pools and shareholders).
//
// Record: { mint, symbol, name, description, uri, image, socials, parent (mint|null = ROOT), level, root,
//           creator (the launcher wallet), creatorKey (coinKeyFor(mint); null for an external ROOT),
//           parentPool (poolKeyFor(parent)), holderPool (poolKeyFor(mint)), shares [{address, shareBps, role}],
//           createdAt, launchSig, launchId, hidden, external, sharing {address, tx, at, shareholders, slot?} | null,
//           setup (journaled lock/sweep tx) | null, swept, distributeBlocked {at, reason} | null, graduatedAt,
//           sharesProblem {at, reason} | null (a refused lock), lockProblem {since, at, reason} | null (a failing lock) }
import { config } from './config.js'
import { coinsStore, readState, patchState, mintLedger, poolLedger, burnsStore, ledgerStore } from './store.js'
import { engineAddress, protocolAddress, burnAddress, poolKeyFor, coinKeyFor, balancesOf, accountInfos, sol, pk, rent0, rentLoaded } from './solana.js'
import { readCurves, readAmmPools, readDistributable, feeSharingConfigPda, bondingCurvePda, canonicalPumpPoolPda, PUMP_SDK, TARGET_SOL } from './pump.js'
import { PROGRAMS } from './math.js'
import { solUsdCached, dexStatsMany, dexStatsCached } from './price.js'
import { logoUrlFor } from './images.js'
import { emitEvent } from './bus.js'

const QUOTE_SYMBOLS = { CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp: 'CARDS', EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC' }
const errText = e => String(e?.message || e).slice(0, 200)
const warned = new Map()
export const warnEvery = (k, ms, msg) => { if (Date.now() - (warned.get(k) || 0) > ms) { warned.set(k, Date.now()); console.warn(msg) } }

/* ---------------- records ---------------- */

export const coins = () => coinsStore.get()
// an OWN key only: 'constructor' / '__proto__' … are inherited members of the plain-object store, never a coin
export const coinRec = mint => { const all = coins(), k = String(mint || ''); return Object.hasOwn(all, k) ? all[k] || null : null }
export function patchCoin(mint, patch) {
  if (!coins()[mint]) return null
  coinsStore.update(all => { all[mint] = { ...all[mint], ...patch, updatedAt: Date.now() } })
  return coins()[mint]
}
export function putCoin(rec) { coinsStore.update(all => { all[rec.mint] = { ...rec, updatedAt: Date.now() } }); return coins()[rec.mint] }

/** $TICKER (ROOT): ROOT_MINT env pins it; otherwise the one the admin launched or adopted (state.json). */
export const rootMint = () => config.rootMint || readState().rootMint || ''
export const setRootMint = mint => patchState({ rootMint: mint || '' })
/**
 * Coins launched before $TICKER existed (preRoot, no parent) join ROOT once it is set and registered. Only the tree
 * changes (parent / parentPool): their locked split never involved ROOT. Idempotent; run on every ROOT write + refresh.
 */
export function attachPreRootKids() {
  const r = rootMint()
  if (!r || !coinRec(r)) return 0
  const pool = poolKeyFor(r)?.publicKey.toBase58() || null
  const kids = Object.values(coins()).filter(c => c.preRoot && !c.parent && c.mint !== r)
  for (const c of kids) patchCoin(c.mint, { parent: r, parentPool: pool })
  if (kids.length) console.log(`[registry] ${kids.length} pre-ROOT coin(s) attached under ROOT ${r}`)
  return kids.length
}
/**
 * Boot check: ROOT_MINT must name the ROOT this data dir registered (a wrong pin would make the burner buy and burn
 * the wrong token). A pin whose mint is not registered YET is allowed (it can be adopted; launches and burns wait).
 */
export function rootPinProblem() {
  const pin = config.rootMint, st = readState().rootMint || ''
  if (!pin) return null
  if (st && st !== pin) return `ROOT_MINT=${pin} but this data dir's ROOT is ${st}: fix ROOT_MINT (a wrong pin buys and burns the wrong token)`
  if (st && !coinRec(pin)) return `ROOT_MINT=${pin} is the registered ROOT but has no coin record: restore coins.json from backup`
  return null
}

/** Visible = not hidden and every ancestor visible (a hidden test coin hides its whole subtree). */
function visibleRaw(mint, all, seen = 0) {
  const c = all[mint]
  if (!c || c.hidden || seen > 8) return false
  return c.parent ? visibleRaw(c.parent, all, seen + 1) : true
}
// memoized per registry object (every write replaces it): visible set + kids index
let idx = { ref: null }
function index() {
  const all = coins()
  if (idx.ref === all) return idx
  const visible = new Set(), kids = new Map(), kidsAll = new Map()
  for (const c of Object.values(all)) if (visibleRaw(c.mint, all)) visible.add(c.mint)
  for (const c of Object.values(all)) {
    if (!c.parent) continue
    ;(kidsAll.get(c.parent) || kidsAll.set(c.parent, []).get(c.parent)).push(c)
    if (visible.has(c.mint)) (kids.get(c.parent) || kids.set(c.parent, []).get(c.parent)).push(c)
  }
  idx = { ref: all, visible, kids, kidsAll }
  return idx
}
export function isVisible(mint) { return index().visible.has(String(mint || '')) }
export function allRecs({ includeHidden = false } = {}) {
  const all = coins(), { visible } = index()
  return Object.values(all).filter(c => includeHidden || visible.has(c.mint))
}
export function kidsOf(mint, { includeHidden = false } = {}) { const i = index(); return [...((includeHidden ? i.kidsAll : i.kids).get(mint) || [])] }
export function parentsChain(mint) {
  const out = []
  let cur = coinRec(mint)
  for (let i = 0; cur?.parent && i < 8; i++) { const p = coinRec(cur.parent); if (!p) break; out.push(p); cur = p }
  return out
}
export function setHidden(mint, hidden) {
  if (!coinRec(mint)) return null
  return patchCoin(mint, { hidden: !!hidden })
}

/* ---------------- never-pay keys ---------------- */

/** Every address of every coin (mint, coin key, both pools, sharing config, curve, canonical AMM pool) + ROOT's pool. Memoized per registry object. */
let addrCache = { ref: null, set: new Set() }
const pdaCache = new Map()
export function coinAddresses() {
  const all = coins()
  if (addrCache.ref === all) return addrCache.set
  const out = new Set()
  for (const c of Object.values(all)) {
    for (const a of [c.mint, c.creatorKey, c.holderPool, c.parentPool, c.sharing?.address]) if (a) out.add(a)
    let pdas = pdaCache.get(c.mint)
    if (!pdas) { try { const m = pk(c.mint); pdas = [feeSharingConfigPda(m).toBase58(), bondingCurvePda(m).toBase58(), canonicalPumpPoolPda(m).toBase58()] } catch { pdas = [] } pdaCache.set(c.mint, pdas) }
    for (const a of pdas) out.add(a)
  }
  const r = rootMint()
  if (r) { out.add(r); const p = poolKeyFor(r); if (p) out.add(p.publicKey.toBase58()) }
  addrCache = { ref: all, set: out }
  return out
}
export function infraAddresses() {
  return new Set([engineAddress(), protocolAddress(), burnAddress(), ...PROGRAMS].filter(Boolean))
}
/** Never a holder payee, never a launcher: infra + every coin address. */
export const neverPay = () => new Set([...infraAddresses(), ...coinAddresses()])

/* ---------------- live figures (chain truth, refreshed by the chain loop) ---------------- */

const live = new Map() // mint → figures
let lastRefresh = 0, refreshOkAt = 0, refreshError = null
export const liveOf = mint => live.get(mint) || {}
export function setLive(mint, fig) { live.set(mint, { ...(live.get(mint) || {}), ...fig }) } // dev seed + tests
export const refreshStatus = () => ({ lastRefreshAt: lastRefresh || null, okAt: refreshOkAt || null, error: refreshError })

function sharingMatches(expected, onChain) {
  if (!expected?.length || !onChain?.length || expected.length !== onChain.length) return false
  return expected.every((s, i) => onChain[i]?.address === s.address && onChain[i]?.shareBps === s.shareBps)
}

/** Refresh every coin's curve / pool / sharing / vault / holder-pool figures. Cheap batched reads only. */
export async function refreshCoins({ force = false } = {}) {
  if (!force && Date.now() - lastRefresh < config.refreshMs) return
  lastRefresh = Date.now()
  try { attachPreRootKids() } catch (e) { console.warn('[registry] pre-ROOT attach:', e.message) } // ROOT pinned by ROOT_MINT at boot
  const all = Object.values(coins())
  if (!all.length || !config.rpcUrl || config.offline) { refreshOkAt = Date.now(); return }
  try {
    const mints = all.map(c => c.mint)
    const curves = await readCurves(mints)
    const grads = mints.filter(m => curves.get(m)?.graduated)
    const [pools, sharingInfos, distributable, poolBalances] = await Promise.all([
      readAmmPools(grads, new Map(grads.map(m => [m, curves.get(m)?.quoteMint]))),
      accountInfos(mints.map(m => feeSharingConfigPda(pk(m)))),
      rentLoaded() ? readDistributable(mints) : Promise.resolve(new Map()),
      balancesOf([...new Set(all.map(c => c.holderPool).filter(Boolean))]),
    ])
    const dex = await dexStatsMany(mints).catch(() => new Map())
    all.forEach((c, i) => {
      const f = curves.get(c.mint)
      const prev = live.get(c.mint) || {}
      const cfgPda = feeSharingConfigPda(pk(c.mint)).toBase58()
      let chainSharing = null
      try { if (sharingInfos[i]) { const s = PUMP_SDK.decodeSharingConfig(sharingInfos[i]); chainSharing = { adminRevoked: !!s.adminRevoked, admin: s.admin.toBase58(), shareholders: s.shareholders.map(x => ({ address: x.address.toBase58(), shareBps: Number(x.shareBps) })) } } } catch {}
      const amm = f?.graduated ? pools.get(c.mint) : null
      const v = distributable.get(c.mint)
      const graduated = f ? !!f.graduated : !!prev.graduated
      // fees reach the shareholders only while the curve's creator — and after graduation the pool's coin
      // creator — IS the sharing config, and the on-chain shareholders are the ones we locked
      let sharingOk = null
      if (c.sharing?.address && f) {
        sharingOk = f.creator === cfgPda && (!graduated || !amm || amm.coinCreator === cfgPda) && (!chainSharing || sharingMatches(c.sharing.shareholders, chainSharing.shareholders))
        if (!sharingOk) warnEvery(`share:${c.mint}`, 3_600_000, `[coins] $${c.symbol} ${c.mint}: recorded fee sharing but the chain disagrees (curve creator ${f.creator}${amm ? `, pool coin creator ${amm.coinCreator}` : ''}) — NOT cranked until this matches`)
      }
      const d = dex.get(c.mint)
      const priceSol = graduated ? (amm?.priceSol ?? d?.priceNative ?? prev.priceSol ?? null) : (f?.priceSol ?? prev.priceSol ?? null)
      // where this refresh's price came from: pulls (pulls.js) only price on a fresh on-chain read ('curve' / 'amm')
      const priceSrc = graduated ? (amm?.priceSol != null ? 'amm' : d?.priceNative != null ? 'dex' : 'prev') : (f?.priceSol != null ? 'curve' : 'prev')
      const fig = {
        // a migrated curve holds 0 SOL: show what it raised (≥ the completion target), not "0 / 85"
        graduated, progress: f ? f.progress : prev.progress ?? 0, realSol: graduated ? Math.max(f?.realSol || 0, TARGET_SOL) : f ? f.realSol : prev.realSol ?? 0,
        ammPool: amm?.pool || (graduated ? prev.ammPool || null : null),
        quoteMint: f?.quoteMint || prev.quoteMint || null, // SOL for the kids, CARDS for $GACHA (fixed at create)
        priceSol, priceSrc, mcapSol: priceSol != null ? priceSol * 1e9 : f?.mcapSol ?? prev.mcapSol ?? null,
        creatorFeeBps: (graduated ? amm?.creatorFeeBps : f?.creatorFeeBps) ?? prev.creatorFeeBps ?? 30,
        curveCreator: f?.creator || prev.curveCreator || null, poolCoinCreator: amm?.coinCreator || prev.poolCoinCreator || null,
        chainSharing: chainSharing || prev.chainSharing || null, sharingOk,
        vaultLamports: v ? v.vaultLamports.toString() : prev.vaultLamports || '0',
        // the curve's un-swept creator fee (pump.fun v3 trades) is pending too: the crank sweeps it into the vault
        curveFeeLamports: f?.curveFeeLamports ?? prev.curveFeeLamports ?? '0',
        pendingLamports: v ? (v.total + BigInt(f?.curveFeeLamports ?? prev.curveFeeLamports ?? '0')).toString() : prev.pendingLamports || '0',
        ammVaultLamports: v ? v.amm.toString() : prev.ammVaultLamports || '0', ammAtaExists: v ? v.ammAtaExists : !!prev.ammAtaExists,
        poolLamports: (poolBalances.get(c.holderPool) ?? BigInt(prev.poolLamports || 0)).toString(),
        vol24hUsd: d?.vol24hUsd ?? prev.vol24hUsd ?? 0, vol1hUsd: d?.vol1hUsd ?? prev.vol1hUsd ?? 0, trades24h: d?.trades24h ?? prev.trades24h ?? 0,
        refreshedAt: Date.now(),
      }
      if (graduated && !prev.graduated && prev.refreshedAt && !c.graduatedAt) {
        patchCoin(c.mint, { graduatedAt: Date.now() })
        emitEvent({ type: 'graduate', mint: c.mint, symbol: c.symbol, parentMint: c.parent || undefined, extra: { ammPool: fig.ammPool } })
      }
      live.set(c.mint, { ...prev, ...fig })
    })
    refreshOkAt = Date.now(); refreshError = null
  } catch (e) { refreshError = errText(e); console.warn('[coins] refresh failed:', refreshError) }
}
/** Holder counts come from our own snapshots (rounds + the lazy top-holders read). */
export function noteHolders(mint, count, top = null) { const l = live.get(mint) || {}; live.set(mint, { ...l, holders: count, ...(top ? { holdersTop: top, holdersAt: Date.now() } : {}) }) }

/* ---------------- views (API.md Coin) ---------------- */

export function sharingStatus(c, l = liveOf(c.mint)) {
  if (c.distributeBlocked) return 'blocked'
  if (!c.sharing?.address) return c.external && l.chainSharing ? 'locked' : 'pending'
  if (l.sharingOk === false) return 'mismatch'
  return 'locked'
}
const lam = s => BigInt(s || '0')
export function totalBurnedUi() {
  const b = burnsStore.get()
  return Number(BigInt(b.totalBurnedRaw || '0')) / 1e6
}
/**
 * ROOT burned from this coin's 10%: the burn total, attributed by each coin's measured inflow to the burn wallet.
 * The denominator is summed ONCE per ledger / registry version (every write replaces those objects), so a view pass
 * stays O(N) instead of O(N²).
 */
let burnSum = { led: null, reg: null, all: 0n }
function burnedFromCoin(mint) {
  const total = totalBurnedUi()
  if (!total) return 0
  const led = ledgerStore.get(), reg = coins()
  if (burnSum.led !== led || burnSum.reg !== reg) {
    let all = 0n
    for (const m of Object.keys(reg)) all += lam(led.byMint?.[m]?.toBurnLamports)
    burnSum = { led, reg, all }
  }
  if (burnSum.all <= 0n) return 0
  return total * (Number(lam(led.byMint?.[mint]?.toBurnLamports)) / Number(burnSum.all))
}
// generatedSol never goes DOWN in this process: a third-party crank drains `pending` a moment before the fee index
// books it as distributed (per-mint high-water mark, bounded by the registry)
const genHw = new Map()
export function nextRoundAtFor(mint) { return roundTimes.get(mint)?.next ?? null }
export function lastRoundAtFor(mint) { return roundTimes.get(mint)?.last ?? (poolLedger(mint).lastRoundAt || null) }
const roundTimes = new Map()
export function noteRoundTimes(mint, t) { roundTimes.set(mint, { ...(roundTimes.get(mint) || {}), ...t }) }

export function view(c) {
  if (!c) return null
  const l = liveOf(c.mint)
  const all = coins()
  const p = c.parent ? all[c.parent] : null
  const usd = solUsdCached()
  const led = mintLedger(c.mint), pl = poolLedger(c.mint)
  const pending = lam(l.pendingLamports)
  const status = sharingStatus(c, l)
  // the proof shows what the CHAIN says whenever the refresh loop has read the config (a mismatch must show the chain's
  // recipients, not ours); else what we recorded at the lock; else (pending) the planned split. readBack says which.
  const chainShares = l.chainSharing?.shareholders?.length ? l.chainSharing.shareholders : null
  const shareholders = (chainShares || c.sharing?.shareholders || c.shares || []).map(s => ({ address: s.address, bps: s.shareBps, role: s.role || roleOf(c, s.address) }))
  const priceSol = l.priceSol ?? null, mcapSol = l.mcapSol ?? null
  const genNow = lam(led.distributedLamports) + lam(led.sweptLamports) + pending
  const hw = genHw.get(c.mint) || 0n
  const generated = genNow > hw ? genNow : hw
  if (generated !== hw) genHw.set(c.mint, generated)
  return {
    mint: c.mint, symbol: c.symbol, name: c.name, description: c.description || '', logo: c.image || c.logo ? logoUrlFor(c.mint) : null, socials: c.socials || {},
    parent: c.parent || null, parentSymbol: p?.symbol || null, level: c.level, kids: kidsOf(c.mint).length,
    creator: c.creator || null, createdAt: c.createdAt, launchTx: c.launchSig || null,
    pumpUrl: `https://pump.fun/coin/${c.mint}`,
    priceSol, priceUsd: priceSol != null ? priceSol * usd : null, mcapSol, mcapUsd: mcapSol != null ? mcapSol * usd : null,
    curve: { progress: l.progress ?? 0, graduated: !!l.graduated, realSol: l.realSol ?? 0, ammPool: l.ammPool || null, targetSol: TARGET_SOL },
    quoteSymbol: QUOTE_SYMBOLS[l.quoteMint] || (l.quoteMint && l.quoteMint !== 'So11111111111111111111111111111111111111112' ? 'a token' : 'SOL'),
    vol24hUsd: l.vol24hUsd || 0, vol1hUsd: l.vol1hUsd || 0, trades24h: l.trades24h || 0, holders: l.holders || 0,
    sharing: {
      config: c.sharing?.address || (l.chainSharing ? feeSharingConfigPda(pk(c.mint)).toBase58() : null), locked: status === 'locked' || status === 'blocked',
      status, shareholders, readBack: !!chainShares, adminRevoked: !!l.chainSharing?.adminRevoked, tx: c.sharing?.tx || null,
      ...(c.distributeBlocked ? { blockedReason: c.distributeBlocked.reason } : {}),
    },
    fees: {
      generatedSol: sol(generated), distributedSol: sol(lam(led.distributedLamports)),
      pendingSol: sol(pending), toParentHoldersSol: sol(lam(led.toParentLamports)), toLauncherSol: sol(lam(led.toLauncherLamports)), creatorFeeBps: l.creatorFeeBps ?? 30,
    },
    pool: {
      address: c.holderPool, balanceSol: sol(lam(l.poolLamports)), paidToHoldersSol: sol(lam(pl.paidLamports)),
      lastRoundAt: lastRoundAtFor(c.mint), nextRoundAt: nextRoundAtFor(c.mint),
    },
    burnedRootUi: burnedFromCoin(c.mint),
  }
}
export function roleOf(c, address) {
  const s = (c.shares || []).find(x => x.address === address)
  return s?.role || null
}
export function treeNode(c) {
  const l = liveOf(c.mint)
  const usd = solUsdCached()
  return { mint: c.mint, symbol: c.symbol, name: c.name, logo: c.image || c.logo ? logoUrlFor(c.mint) : null, parent: c.parent || null, level: c.level, mcapUsd: l.mcapSol != null ? l.mcapSol * usd : 0, vol1hUsd: l.vol1hUsd || 0, progress: l.progress ?? 0, graduated: !!l.graduated, kids: kidsOf(c.mint).length }
}

/** Expected pool/coin keys of a record, re-derived (a wrong ENGINE_PRIVATE_KEY for this data dir shows here). */
export function keysMatch(c) {
  const ck = c.creatorKey ? coinKeyFor(c.mint)?.publicKey.toBase58() : null
  const hp = poolKeyFor(c.mint)?.publicKey.toBase58()
  const pp = c.parent ? poolKeyFor(c.parent)?.publicKey.toBase58() : null
  return (!c.creatorKey || ck === c.creatorKey) && hp === c.holderPool && (!c.parent || pp === c.parentPool)
}
export const rent0OrNull = () => (rentLoaded() ? rent0() : null)
export { dexStatsCached }
