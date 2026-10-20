// Gachapad engine (pump.fun build): Express API, SSE feed, micro-cache, rate limits, admin, and the loops.
//
// Every coin is a launchpad: a child launched under a parent is a normal pump.fun coin whose creator fees are split
// by pump.fun's own one-shot fee sharing, locked at birth: 40% launcher / 40% the PARENT's holder pool / 10% burn
// wallet ($TICKER buyback + burn) / 10% protocol. Here: build + finish launches, lock the split, crank pump's
// distribution, run holder rounds per parent pool, burn ROOT. Boots fine with NO keys (read-only: the site works,
// nothing moves). Every money loop honors the kill switch at SEND time; every send is journaled before its first broadcast.
import express from 'express'
import cors from 'cors'
import { existsSync, createReadStream, readFileSync } from 'fs'
import { createHash, timingSafeEqual } from 'crypto'
import { join } from 'path'
import { hostname } from 'os'
import { config, assertConfig, BASE58_RE, HERE } from './config.js'
import { parseSecret, engineAddress, protocolAddress, burnAddress, getEngine, balanceOf, sol, isPubkey, loadRent, rentLoaded, CHAIN_ID } from './solana.js'
import {
  setWriteGuard, loadAllStores, readState, launchesStore, preparedStore, eventsStore, earnedStore, poolLedger, mintLedger, readPendingIntents, readQuarantine, burnsStore, ledgerStore, flushDirty,
  holdersPaidCount, earnedLamports,
} from './store.js'
import { acquireLock, checkIdentity, takeToken, takeTokens, pruneBuckets, retryAfter, ttlCache } from './guard.js'
import { solUsd, solUsdCached } from './price.js'
import { coins, coinRec, allRecs, isVisible, kidsOf, parentsChain, view, treeNode, rootMint, rootPinProblem, refreshCoins, refreshStatus, setHidden, liveOf, noteHolders, neverPay } from './registry.js'
import { prepareLaunch, submitLaunch, getLaunch, advanceLaunches, launchBlocker, launchMeta, preparedCount, adoptRoot, resetRoot, adoptOrphan, canaryStatus, replanShares, lockFailing, publicFileAccess } from './launch.js'
import { http, errorHandler } from './httperr.js'
import { distributeDue, distributeStatus, checkShareholderWallets, indexDistributions, indexStatus } from './distribute.js'
import { keyConflicts } from './math.js'
import { metadataHostProblem, metaBase } from './ipfs.js'
import { roundsTick, roundStep, rounds, roundById, roundView, roundDetail, snapshotHolders, holderTop } from './rounds.js'
import { resolvePendingIntents } from './paysol.js'
import { packsTick, rips as packRips, ripById, publicRip, coinPacks, packTotals, liveOdds, liveEntries, readDrawEntries, resolvePack, run as packsRun } from './packs.js'
import { machinePulls, machines as ccMachines, machineEv } from './cc.js'
import { preparePull, submitPull, pullsTick, pullById, pulls as burnPulls, publicPull, pullFigures, pullTotals, resolvePull, pullBlocker, stockAverageUsd, pullPriceUsd, run as pullsRun } from './pulls.js'
import { stockOf } from './packs.js'
import { pumpGacha } from './gacha.js'
import { crankBurner, burnerStatus, burnerBalanceSol } from './burner.js'
import { quote, buildSwap, relay, txStatus, trackRelays } from './trades.js'
import { runCanary } from './canary.js'
import { readLogo, cacheLogo, logoUrlFor } from './images.js'
import { isKilled, kill, unkill } from './kill.js'
import { bus } from './bus.js'

/* ---------------- boot guards ---------------- */

assertConfig()
// A key that is SET but does not parse must never boot quietly: the engine would look healthy and never pay or crank.
for (const [name, raw] of [['ENGINE_PRIVATE_KEY', config.enginePrivateKey], ['BURN_PRIVATE_KEY', config.burnPrivateKey]]) {
  if (raw && !parseSecret(raw)) { console.error(`[boot] FATAL — ${name} is set but is not a valid Solana secret key (base58 or JSON byte array)`); process.exit(1) }
}
if (config.protocolWallet && !isPubkey(config.protocolWallet)) { console.error('[boot] FATAL — PROTOCOL_WALLET is not a valid Solana address'); process.exit(1) }
// Every lock writes the burn + protocol addresses FOREVER: a key mix-up must stop the engine, not quietly lock it in.
for (const p of keyConflicts({ engine: engineAddress(), burn: burnAddress(), protocol: protocolAddress() })) { console.error(`[boot] FATAL — ${p}`); process.exit(1) }

// Exactly one engine per data dir: a second payer would pay the same round twice.
const LOCK_FILE = join(config.dataDir, 'engine.lock')
const LOCK = acquireLock(LOCK_FILE, { host: hostname() })
if (!LOCK.ok) { console.error(`[boot] FATAL — another engine holds ${LOCK_FILE} (pid ${LOCK.holder?.pid} on ${LOCK.holder?.host}); refusing to start a second payer`); process.exit(1) }
let fenced = false
const fence = () => {
  if (!fenced) { fenced = true; console.error('[boot] FATAL — lost the engine lock (another engine took over); exiting without writing'); setImmediate(() => process.exit(1)) }
  throw new Error('engine lock lost')
}
setWriteGuard(() => { if (fenced || !LOCK.held()) fence() })
setInterval(() => { if (!fenced && !LOCK.beat()) { try { fence() } catch {} } }, 15_000).unref()
process.on('exit', () => LOCK.release())
process.on('unhandledRejection', e => console.error('[process] unhandledRejection:', e?.stack || e?.message || e))
// An unexpected throw leaves the process in an unknown state: exit, pm2 restarts it, the journals make the restart safe.
process.on('uncaughtException', e => { console.error('[process] uncaughtException — exiting:', e?.stack || e); process.exit(1) })
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { console.log(`[boot] ${s}: flushing stores and exiting`); try { flushDirty() } catch {} process.exit(0) })

// Parse every store once; a corrupt money store refuses to start (fail closed).
try { loadAllStores() } catch (e) { console.error(`[boot] FATAL — ${e.message}`); process.exit(1) }
// The data dir is bound to this chain + engine key: every coin key and pool derives from that key.
// (tagged with the engine flavour: the retired Meteora engine used the same key + chain)
try { checkIdentity(join(config.dataDir, 'identity.json'), { chainId: CHAIN_ID, treasury: engineAddress() || null, factories: [], engine: 'pump.fun' }) } catch (e) { console.error(`[boot] FATAL — ${e.message}`); process.exit(1) }
// ROOT_MINT must be the ROOT this data dir registered: a wrong pin would buy + burn the wrong token forever
{ const rp = rootPinProblem(); if (rp) { console.error(`[boot] FATAL — ${rp}`); process.exit(1) } }
// the dev seed (fake ROOT + coins in the money stores) only ever runs offline; seedDev refuses otherwise too
if (config.devSeed && config.offline) { const { seedDev } = await import('./seed.js'); seedDev() }
else if (config.devSeed) console.error('[boot] DEV_SEED is set without DEV_OFFLINE: ignored (the seed never touches a live engine\'s data)')

/* ---------------- app ---------------- */

const app = express()
app.set('trust proxy', config.trustProxy) // 'true' = ONE hop (Caddy): req.ip is the real client, never a spoofed XFF entry
// exact paths only: '/LAUNCH/prepare' or '/launch/prepare/' must 404, never reach a handler around a limiter or a
// body-size rule that compares req.path exactly
app.set('case sensitive routing', true)
app.set('strict routing', true)
app.set('etag', false)
app.disable('x-powered-by')
app.use(cors(config.corsOrigins.includes('*') ? {} : { origin: config.corsOrigins }))
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)
const PRIVATE = 'private, no-store'

/*
 * rate limits: token buckets per IP, per launcher wallet, and one global bucket for prepare (every prepare pins
 * metadata). /quote and /tx/status have their own tight buckets (each costs RPC). The global prepare bucket and the
 * per-wallet one are spent ONLY by a prepare that passed every cheap check (prepareLaunch's gate): junk never drains them.
 */
const RL = { get: [600, 100], post: [30, 1], pull: [12, 12 / 60], prepare: [6, 6 / 60], prepareWallet: [5, 1 / 60], prepareAll: [120, 600 / 3600], swap: [30, 0.5], quote: [30, 2], status: [60, 2], holders: [10, 10 / 60] }
const buckets = Object.fromEntries(Object.keys(RL).map(k => [k, new Map()]))
const adminFails = new Map()
function allow(name, key, res, msg = 'too many requests, slow down') {
  const [cap, rate] = RL[name]
  if (takeToken(buckets[name], key, cap, rate)) return true
  res.status(429).set({ 'retry-after': String(retryAfter(buckets[name], key, rate)), 'cache-control': PRIVATE }).json({ error: msg })
  return false
}
setInterval(() => { for (const [n, [cap, rate]] of Object.entries(RL)) pruneBuckets(buckets[n], cap, rate); for (const [k, v] of adminFails) if (Date.now() - v.at > 60_000) adminFails.delete(k) }, 60_000).unref()
// the per-IP limiter runs BEFORE any body is read or parsed (a rate-limited client never makes us buffer a body).
// Exempt, for GET / HEAD / OPTIONS only (a POST there is limited like any path: it has no handler, but its body would
// still be read and parsed): /health (memoized), /events (own SSE caps), and the static /m/ + /c/ files — those are
// what the Vercel rewrite serves, where req.ip is Vercel's egress IP shared by EVERY visitor and metadata fetcher: a
// per-IP bucket there would let one flood 429 every coin's permanent metadata URI. They are O(1) disk reads.
const UNLIMITED = /^\/(m|c)\/[^/]+$/
app.use((req, res, next) => {
  const get = ['GET', 'HEAD', 'OPTIONS'].includes(req.method)
  if (get && (req.path === '/health' || req.path === '/events' || UNLIMITED.test(req.path))) return next()
  if (allow(get ? 'get' : 'post', req.ip, res)) next()
})
// bodies: POST only; up to 6 MB only on the three prepare routes (a launch image is a data URL ≤ 4 MB), 64 KB elsewhere
const BIG_BODY = new Set(['/launch/prepare', '/admin/prepare', '/admin/root/prepare'])
const bigJson = express.json({ limit: '6mb' }), smallJson = express.json({ limit: '64kb' })
app.use((req, res, next) => {
  if (req.method !== 'POST') return next()
  if (req.path === '/launch/prepare' && !allow('prepare', req.ip, res, 'too many launch attempts, wait a minute')) return // before the 6 MB body is read
  if (req.path === '/burn/prepare' && !allow('pull', req.ip, res, 'too many pulls at once, wait a minute')) return
  if (BIG_BODY.has(req.path) && req.path.startsWith('/admin/') && !admin(req, res)) return // admin auth before a 6 MB body is read
  return (BIG_BODY.has(req.path) ? bigJson : smallJson)(req, res, next)
})
app.use((req, res, next) => { if (!['GET', 'HEAD'].includes(req.method) || /^\/(admin|launch|tx|burn)(\/|$)/.test(req.path)) res.set('cache-control', PRIVATE); next() })

/* micro-cache: every public list GET is computed at most once per TTL and sent pre-serialized with an ETag */
const VIEW_TTL = 4000
const responses = ttlCache(500, { maxBytes: 24 * 1024 * 1024, weigh: e => e.str.length })
function sendCached(req, res, key, ttlMs, compute) {
  let hit = true
  const e = responses.get(key, ttlMs, () => { hit = false; const [status, body] = compute(); const str = JSON.stringify(body); return { status, str, etag: `W/"${createHash('sha1').update(str).digest('base64url').slice(0, 22)}"` } })
  const s = Math.max(1, Math.round(ttlMs / 1000))
  res.set({ 'content-type': 'application/json; charset=utf-8', etag: e.etag, 'x-cache': hit ? 'hit' : 'miss', 'cache-control': 'public, max-age=0, must-revalidate', 'cdn-cache-control': `public, s-maxage=${s}, stale-while-revalidate=30`, 'vercel-cdn-cache-control': `public, s-maxage=${s}, stale-while-revalidate=30`, vary: 'Accept-Encoding' })
  if (e.status === 200 && req.headers['if-none-match'] === e.etag) return res.status(304).end()
  res.status(e.status).send(e.str)
}
// hard = an admin write (hide, adopt, …): its effect must show at once; an event only marks the shared views stale
const invalidate = (hard = false) => { responses.clear(); if (hard) shared.views = null; else shared.stale = true }
const clampInt = (v, lo, hi, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d }
const mintParam = v => (BASE58_RE.test(String(v || '')) ? String(v) : '')

/* ---------------- public reads ---------------- */

const chain = { engineSol: null, at: 0 }
const dev = () => (config.offline ? readState().devWallets || {} : {})
const visibleEvent = e => !e.mint || !coinRec(e.mint) || isVisible(e.mint) || (e.type === 'burn' && e.mint === rootMint())

/*
 * Every visible coin's view, built at most once per VIEW_TTL whatever the query params (a random ?q= must never make
 * each request rebuild N views), plus one sorted copy per sort+filter. /coins then only filters and pages.
 */
const shared = { at: 0, views: null, sorted: new Map(), stale: false }
/** A coin's view + its pack machine in brief (pot toward the next pack, packs opened, value pulled). */
const packLite = c => {
  if (c.root || !c.packCode) return null
  const m = machineCache.list.find(x => x.code === c.packCode) || null
  const p = coinPacks(c.mint, m?.priceUsdc || null)
  const st = stockOf(c.mint)
  const avg = stockAverageUsd(st, m?.evUsd || null)
  return {
    code: c.packCode, machine: m ? { name: m.name, shortName: m.shortName, priceUsdc: m.priceUsdc, image: m.image, level: m.level } : null,
    potUsd: p.potUsd, progress: p.progress, packs: p.packs, pulledUsd: p.pulledUsd,
    stock: st.length, stockUsd: p.stockUsd, pullUsd: pullPriceUsd(avg),
    top: st.slice().sort((x, y) => (Number(y.card?.valueUsd) || 0) - (Number(x.card?.valueUsd) || 0)).slice(0, 3).map(r => ({ name: r.card.cardName || r.card.name, image: r.card.image, valueUsd: r.card.valueUsd, grade: [r.card.grader, r.card.grade].filter(Boolean).join(' ') })),
    lastCard: p.lastPull?.card ? { name: p.lastPull.card.cardName || p.lastPull.card.name, image: p.lastPull.card.image, valueUsd: p.lastPull.card.valueUsd } : null,
  }
}
const viewP = c => ({ ...view(c), packs: packLite(c) })
function allViews() {
  const age = Date.now() - shared.at
  // an event marks the views stale: rebuilt on the next read, but never more than once a second
  if (!shared.views || age > VIEW_TTL || (shared.stale && age > 1000)) { shared.views = allRecs().map(viewP); shared.at = Date.now(); shared.sorted.clear(); shared.stale = false }
  return shared.views
}
function sortedViews(sort, filter) {
  const views = allViews(), k = `${sort}:${filter}`
  let l = shared.sorted.get(k)
  if (!l) { l = views.filter(FILTERS[filter]).sort(SORTS[sort]); shared.sorted.set(k, l) }
  return l
}

function stats() {
  const all = allRecs()
  const views = allViews()
  const usd = solUsdCached()
  const dayAgo = Date.now() - 86_400_000
  const root = coinRec(rootMint())
  const rootView = root && isVisible(root.mint) ? view(root) : null
  const paidLamports = all.reduce((s, c) => s + BigInt(poolLedger(c.mint).paidLamports || '0'), 0n)
  const visibleParents = new Set(all.map(c => c.mint))
  const holdersPaid = holdersPaidCount(m => visibleParents.has(m)) // bounded scan + the evicted wallets
  const burnedUi = burnerStatus().totalBurnedUi
  const rootPriceUsd = rootView?.priceUsd || 0
  const split = {}
  for (const s of config.rootShares || []) split[s.role] = s.bps
  return {
    brand: config.brand, ticker: config.ticker, root: rootView, sol: { usd },
    totals: {
      coins: all.length, launches24h: all.filter(c => (c.createdAt || 0) > dayAgo).length, vol24hUsd: views.reduce((s, c) => s + (c.vol24hUsd || 0), 0),
      creatorFeesSol: views.reduce((s, c) => s + (c.fees.generatedSol || 0), 0), paidToHoldersSol: sol(paidLamports), paidToHoldersUsd: sol(paidLamports) * usd,
      holdersPaid, burnedRootUi: burnedUi, burnedRootUsd: burnedUi * rootPriceUsd,
      packs: packTotals(), burnPulls: pullTotals(),
    },
    pack: packsRun.machine ? { code: packsRun.machine.code, name: packsRun.machine.name, priceUsdc: packsRun.machine.priceUsdc, open: packsRun.machine.open, buybackPct: packsRun.machine.buybackPct, evUsd: packsRun.evUsd || null, image: packsRun.machine.image } : null,
    engine: {
      live: { launch: config.launchEnabled, distribute: config.distributeLive, convert: config.convertLive, rip: config.ripLive, deliver: config.deliverLive, burn: config.burnLive }, killed: isKilled(), nextPack: packsRun.lastRipCheck,
      canary: canaryStatus().status, maxDepth: config.maxDepth, split: config.split, rootSplit: split, roundMs: config.roundMs,
      // offline dev: the seeded (fake) wallets, so the site has something to render
      wallets: { engine: engineAddress() || dev().engine || null, protocol: protocolAddress() || dev().protocol || null, burn: burnAddress() || dev().burn || null },
      balances: { engineSol: chain.engineSol ?? dev().engineSol ?? null, burnSol: burnerBalanceSol() ?? dev().burnSol ?? null },
      launchBlocker: launchBlocker(), presign: config.launchPresign,
    },
  }
}
app.get('/stats', (req, res) => sendCached(req, res, 'stats', VIEW_TTL, () => [200, stats()]))

const SORTS = {
  new: (a, b) => (b.createdAt || 0) - (a.createdAt || 0), mcap: (a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0), vol: (a, b) => (b.vol24hUsd || 0) - (a.vol24hUsd || 0),
  kids: (a, b) => (b.kids || 0) - (a.kids || 0) || (b.mcapUsd || 0) - (a.mcapUsd || 0), progress: (a, b) => progressKey(b) - progressKey(a),
  pot: (a, b) => (b.packs?.progress || 0) - (a.packs?.progress || 0) || (b.packs?.potUsd || 0) - (a.packs?.potUsd || 0), pulled: (a, b) => (b.packs?.pulledUsd || 0) - (a.packs?.pulledUsd || 0),
  cards: (a, b) => (b.packs?.stock || 0) - (a.packs?.stock || 0) || (b.packs?.stockUsd || 0) - (a.packs?.stockUsd || 0), value: (a, b) => (b.packs?.stockUsd || 0) - (a.packs?.stockUsd || 0), pull: (a, b) => (a.packs?.pullUsd || 1e9) - (b.packs?.pullUsd || 1e9),
}
// graduated sorts above every curve coin (it is past 100%), matching the site's own client-side sort
function progressKey(c) { return c.curve.graduated ? 1.01 : c.curve.progress || 0 }
const FILTERS = { all: () => true, curve: c => !c.curve.graduated, graduated: c => c.curve.graduated, level1: c => c.level === 1, level2: c => c.level === 2, level3: c => c.level === 3 }
app.get('/coins', (req, res) => {
  const sort = SORTS[req.query.sort] ? String(req.query.sort) : 'new'
  const filter = FILTERS[req.query.filter] ? String(req.query.filter) : 'all'
  const parent = mintParam(req.query.parent)
  const q = String(req.query.q || '').trim().slice(0, 44)
  const offset = clampInt(req.query.offset, 0, 100_000, 0), limit = clampInt(req.query.limit, 1, 100, 50)
  sendCached(req, res, `coins:${sort}:${filter}:${parent}:${BASE58_RE.test(q) ? q : q.toLowerCase()}:${offset}:${limit}`, VIEW_TTL, () => {
    const ql = q.toLowerCase().replace(/^\$/, '')
    // the shared, pre-sorted views: a cache miss (any ?q=) costs one O(N) filter, never N view builds + a sort
    let list = sortedViews(sort, filter)
    if (parent) list = list.filter(c => c.parent === parent)
    if (q) list = list.filter(c => c.mint === q || c.symbol.toLowerCase().includes(ql) || c.name.toLowerCase().includes(ql))
    return [200, { total: list.length, items: list.slice(offset, offset + limit) }]
  })
})

// top-20 holders: refreshed lazily in the background (one getProgramAccounts per viewed coin, at most every 2 min)
const holdersAt = new Map()
function refreshHoldersTop(m) {
  if (config.offline || !config.rpcUrl || !coinRec(m) || Date.now() - (holdersAt.get(m) || 0) < 120_000) return
  if (!takeToken(buckets.holders, 'all', ...RL.holders)) return // a global cap: walking every coin page never floods getProgramAccounts
  holdersAt.set(m, Date.now())
  if (holdersAt.size > 5000) holdersAt.delete(holdersAt.keys().next().value)
  snapshotHolders(m).then(snap => { noteHolders(m, snap.size, holderTop(snap, 10n ** 15n, neverPay())); responses.delete(`coin:${m}`) }).catch(() => {})
}
app.get('/coin/:mint', (req, res) => {
  const m = mintParam(req.params.mint)
  if (!m) return res.status(400).json({ error: 'bad mint' })
  if (!isVisible(m)) return res.status(404).json({ error: 'unknown coin' })
  refreshHoldersTop(m)
  sendCached(req, res, `coin:${m}`, VIEW_TTL, () => {
    const c = coinRec(m)
    const events = eventsStore.get().filter(e => (e.mint === m || e.parentMint === m) && visibleEvent(e)).slice(-50).reverse()
    const kids = kidsOf(m).map(view).sort(SORTS.mcap).slice(0, 50)
    const myRounds = rounds().filter(r => r.parentMint === m).slice(-20).reverse().map(roundView)
    const packs = coinPacks(m, packsRun.machine?.priceUsdc || null)
    const pulls = packRips().filter(r => r.mint === m && r.status !== 'void').slice(-50).reverse().map(r => publicRip(r))
    const machineRec = c.packCode ? (machineCache.list.find(x => x.code === c.packCode) || { code: c.packCode }) : null
    const burns = burnPulls().filter(p => p.mint === m && !['quoted', 'expired', 'void'].includes(p.status)).slice(-40).reverse().map(publicPull)
    return [200, { coin: viewP(c), parents: parentsChain(m).map(view), kids, events, holdersTop: liveOf(m).holdersTop || [], packs, pulls, machine: machineRec, burns }]
  })
})
/* ---------------- machines (Collector Crypt via pump.fun packs) + burn pulls ---------------- */
const machineCache = { at: 0, list: [] }
async function machineList() {
  if (Date.now() - machineCache.at < 60_000 && machineCache.list.length) return machineCache.list
  if (config.offline) { try { machineCache.list = JSON.parse(readFileSync(join(HERE, 'scripts', 'dev-machines.json'), 'utf8')); machineCache.at = Date.now() } catch {} return machineCache.list }
  const [all, stock] = await Promise.all([ccMachines(), pumpGacha().catch(() => new Map())])
  const list = []
  for (const code of config.packCodes) {
    const m = all.find(x => x.code === code)
    if (!m) continue
    const ev = await machineEv(code).catch(() => null)
    const s = stock.get(code) || null
    list.push({ code, name: m.name, shortName: m.shortName, category: m.category, priceUsdc: m.priceUsdc, buybackPct: m.buybackPct, image: m.image, video: m.video, open: m.open && m.priceUsdc <= config.packMaxUsdc, evUsd: ev, level: s?.level || null, stock: s?.stock || null })
  }
  machineCache.at = Date.now(); machineCache.list = list
  return list
}
app.get('/machines', wrap(async (req, res) => {
  const list = await machineList()
  res.set('cache-control', 'public, max-age=30').json({ machines: list, default: config.packCode, source: 'Collector Crypt machines · stock from pump.fun packs' })
}))
app.get('/machine/:mint', wrap(async (req, res) => {
  const m = mintParam(req.params.mint)
  if (!m || !isVisible(m)) return res.status(404).json({ error: 'unknown coin' })
  const c = coinRec(m)
  if (!c?.packCode) return res.status(404).json({ error: 'that coin has no machine' })
  await machineList().catch(() => {}) // cached 60 s; fills machineCache after a restart
  const f = await pullFigures(m, { fresh: false }).catch(e => ({ error: e.message }))
  const stock = stockOf(m).map(r => publicRip(r))
  res.set('cache-control', 'public, max-age=4').json({ mint: m, symbol: c.symbol, code: c.packCode, machine: machineCache.list.find(x => x.code === c.packCode) || null, figures: { ...f, tokensRaw: f.tokensRaw != null ? String(f.tokensRaw) : null }, stock, pullsOpen: !pullBlocker() })
}))
app.post('/burn/prepare', wrap(async (req, res) => { res.json(await preparePull(req.body)) }))
app.post('/burn/:id/submit', wrap(async (req, res) => { res.json(await submitPull(String(req.params.id || '').slice(0, 24), { tx: req.body?.tx || null, sig: req.body?.sig || null })) }))
app.get('/burn/:id', (req, res) => {
  const p = pullById(String(req.params.id || '').slice(0, 24))
  if (!p || !isVisible(p.mint)) return res.status(404).json({ error: 'unknown pull' })
  res.set('cache-control', PRIVATE).json({ pull: publicPull(p), coin: view(coinRec(p.mint)), rule: 'seed = sha256(blockhash|pullId|burnSig|listHash); eligible = frozen list minus cards earlier pulls took; card = eligible[seed mod n]' })
})
app.get('/burn-pulls', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 60), m = mintParam(req.query.mint), w = mintParam(req.query.wallet)
  sendCached(req, res, `burns:${m}:${w}:${limit}`, VIEW_TTL, () => [200, burnPulls().filter(p => isVisible(p.mint) && !['quoted', 'expired', 'void'].includes(p.status) && (!m || p.mint === m) && (!w || p.wallet === w)).slice(-limit).reverse().map(publicPull)])
})
/* ---------------- packs ---------------- */
app.get('/pulls', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 60), m = mintParam(req.query.mint)
  sendCached(req, res, `pulls:${m}:${limit}`, VIEW_TTL, () => [200, packRips().filter(r => r.status !== 'void' && isVisible(r.mint) && (!m || r.mint === m)).slice(-limit).reverse().map(r => publicRip(r))])
})
app.get('/pull/:id', (req, res) => {
  const r = ripById(String(req.params.id || '').slice(0, 20))
  if (!r || r.status === 'void' || !isVisible(r.mint)) return res.status(404).json({ error: 'unknown pack' })
  res.set('cache-control', 'public, max-age=5').json({ pull: publicRip(r, { full: true }), coin: view(coinRec(r.mint)) })
})
/** Everything needed to recompute a draw: the frozen entries (sorted by wallet), their hash, the seed block. */
app.get('/draw/:id', (req, res) => {
  const r = ripById(String(req.params.id || '').slice(0, 20))
  const f = r && isVisible(r.mint) ? readDrawEntries(r.id) : null
  if (!f) return res.status(404).json({ error: 'no frozen draw for that pack' })
  res.set('cache-control', 'public, max-age=30').json({ pull: publicRip(r, { full: true }), entries: f.entries, hash: f.hash, total: f.total, samples: f.samples, capBps: f.capBps, minHoldRaw: f.minHoldRaw, rule: 'seed = sha256(blockhash|id|hash); r = seed mod total; walk entries (sorted by wallet) until the running weight passes r' })
})
app.get('/odds/:mint/:wallet', (req, res) => {
  const m = mintParam(req.params.mint), w = mintParam(req.params.wallet)
  if (!m || !w || !isVisible(m)) return res.status(400).json({ error: 'bad coin or wallet' })
  res.set('cache-control', PRIVATE).json({ ...liveOdds(m, w), won: packRips().filter(r => r.draw?.winner === w && isVisible(r.mint)).reverse().map(r => publicRip(r)) })
})
app.get('/round/live/:mint', (req, res) => {
  const m = mintParam(req.params.mint)
  if (!m || !isVisible(m)) return res.status(404).json({ error: 'unknown coin' })
  sendCached(req, res, `live-round:${m}`, VIEW_TTL, () => {
    const entries = liveEntries(m)
    const total = entries.reduce((a, e) => a + e.weight, 0n)
    const top = entries.slice().sort((a, b) => (b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : 0)).slice(0, 25).map(e => ({ wallet: e.wallet, averageTokens: Number(e.weight) / 1e6, chance: total > 0n ? Number((e.weight * 1_000_000n) / total) / 1_000_000 : 0 }))
    return [200, { ...coinPacks(m, packsRun.machine?.priceUsdc || null).round, top }]
  })
})
app.get('/machine-pulls', wrap(async (req, res) => {
  // recent real pulls from the offered machines (Collector Crypt's public winners list): fills the site before any coin has cards
  const code = config.packCodes.includes(String(req.query.code || '')) ? String(req.query.code) : null
  const codes = code ? [code] : config.packCodes.slice(0, 4)
  const lists = config.offline ? [] : await Promise.all(codes.map(c => machinePulls(c).catch(() => [])))
  const pulls = lists.flatMap((l, i) => l.map(x => ({ ...x, code: codes[i] }))).filter(x => x.card?.image)
  res.set('cache-control', 'public, max-age=60').json({ codes, pulls })
}))

app.get('/tree', (req, res) => sendCached(req, res, 'tree', VIEW_TTL, () => [200, { nodes: allRecs().map(treeNode), updatedAt: refreshStatus().lastRefreshAt || Date.now() }]))
app.get('/feed', (req, res) => {
  // type= one type or a comma-separated list (the site's feeds ask for every type but 'trade')
  const types = [...new Set(String(req.query.type || '').split(',').filter(t => /^[a-z-]{1,16}$/.test(t)))].sort().slice(0, 12)
  const limit = clampInt(req.query.limit, 1, 200, 50), want = types.length ? new Set(types) : null
  sendCached(req, res, `feed:${limit}:${types.join(',')}`, VIEW_TTL, () => [200, eventsStore.get().filter(e => (!want || want.has(e.type)) && visibleEvent(e)).slice(-limit).reverse()])
})
app.get('/rounds', (req, res) => {
  const m = mintParam(req.query.mint), limit = clampInt(req.query.limit, 1, 200, 50)
  sendCached(req, res, `rounds:${m}:${limit}`, VIEW_TTL, () => [200, rounds().filter(r => (!m || r.parentMint === m) && isVisible(r.parentMint)).slice(-limit).reverse().map(roundView)])
})
app.get('/round/:id', (req, res) => {
  const r = roundById(String(req.params.id || '').slice(0, 32))
  if (!r || !isVisible(r.parentMint)) return res.status(404).json({ error: 'unknown round' })
  res.set('cache-control', 'public, max-age=5').json(roundDetail(r))
})
app.get('/burns', (req, res) => {
  const limit = clampInt(req.query.limit, 1, 200, 50)
  sendCached(req, res, `burns:${limit}`, VIEW_TTL, () => {
    const root = coinRec(rootMint())
    const px = root ? view(root).priceUsd || 0 : 0
    return [200, burnsStore.get().done.slice(-limit).reverse().map(b => ({ at: b.at, amountUi: b.amountUi, amountUsd: b.amountUi * px, spentSol: b.spentSol, sig: b.sig, swapSig: b.swapSig || null }))]
  })
})
app.get('/wallet/:address', (req, res) => {
  const w = mintParam(req.params.address)
  if (!w) return res.status(400).json({ error: 'bad address' })
  sendCached(req, res, `wallet:${w}`, VIEW_TTL, () => {
    const launched = allRecs().filter(c => c.creator === w)
    const rows = (earnedStore.get()[w]?.rows || []).filter(r => isVisible(r.parentMint))
    const earned = rows.slice().reverse().map(r => ({ parentMint: r.parentMint, symbol: coinRec(r.parentMint)?.symbol || r.symbol || null, amountSol: sol(BigInt(r.lamports)), sig: r.sig, at: r.at, roundId: r.roundId }))
    const asCreator = launched.reduce((s, c) => s + BigInt(mintLedger(c.mint).toLauncherLamports || '0'), 0n)
    // lifetime per-parent totals (earned.json keeps only the latest rows per wallet)
    const won = packRips().filter(r => r.draw?.winner === w && isVisible(r.mint)).reverse().map(r => publicRip(r))
    return [200, { launched: launched.map(viewP), won, earnedAsHolderSol: sol(earnedLamports(w, isVisible)), earned, earnedAsCreatorSol: sol(asCreator) }]
  })
})
/** Offline dev only: a quote at the seeded coin's own price (SOL 9 dp, coins 6 dp), so the site's trade box adds up. */
function offlineQuote(q) {
  const a = Number(BigInt(String(q.amount || '0').replace(/\D/g, '') || '0'))
  const buy = String(q.input || '') === 'SOL', mint = mintParam(buy ? q.output : q.input)
  const c = mint && isVisible(mint) ? view(coinRec(mint)) : null
  const px = c?.priceSol || 3e-8, feeBps = 125, slip = clampInt(q.slippageBps, 0, 5000, 100)
  const out = Math.floor(buy ? (a / 1e9 / px) * (1 - feeBps / 10_000) * 1e6 : (a / 1e6) * px * (1 - feeBps / 10_000) * 1e9)
  return { route: c?.curve?.graduated ? 'amm' : 'curve', outAmount: String(out), minOut: String(Math.floor(out * (1 - slip / 10_000))), priceImpactPct: 0.4, feeBps }
}
app.get('/quote', wrap(async (req, res) => {
  if (!allow('quote', req.ip, res, 'too many quotes, slow down')) return
  if (config.offline) return res.json(offlineQuote(req.query))
  const { ixs, _jup, ...q } = await quote({ input: req.query.input, output: req.query.output, amount: String(req.query.amount || ''), slippageBps: req.query.slippageBps })
  res.set('cache-control', 'public, max-age=3').json(q)
}))
app.get('/launch-meta', (req, res) => { res.set('cache-control', 'public, max-age=10').json(launchMeta()) })
app.get('/launch/:id', (req, res) => { const l = getLaunch(String(req.params.id || '').slice(0, 40)); if (!l) return res.status(404).json({ error: 'unknown launch' }); res.json(l) })
app.get('/tx/status/:sig', wrap(async (req, res) => {
  const sig = String(req.params.sig || '')
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(sig)) return res.status(400).json({ error: 'bad signature' })
  if (!allow('status', req.ip, res)) return
  if (config.offline) return res.json({ status: 'landed' })
  res.json({ status: await txStatus(sig) })
}))
app.get('/c/:mint', (req, res) => {
  const m = mintParam(req.params.mint)
  const c = m && isVisible(m) ? view(coinRec(m)) : null
  const site = config.siteUrl.replace(/\/$/, '')
  const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
  const title = c ? `$${c.symbol} — ${c.name} on ${config.brand}` : config.brand
  const desc = c ? `${c.name} ($${c.symbol})${c.parentSymbol ? ` launched under $${c.parentSymbol}` : ''} on ${config.brand}. ${c.kids || 0} kids. Every coin is a launchpad.` : `${config.brand}: every coin is a launchpad.`
  const img = c?.logo || ''
  const to = c ? `${site}/#/coin/${m}` : site
  res.set({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=60', 'cdn-cache-control': 'public, s-maxage=60', 'vercel-cdn-cache-control': 'public, s-maxage=60' }).status(c ? 200 : 404).send(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">${img ? `<meta property="og:image" content="${esc(img)}"><meta name="twitter:card" content="summary">` : ''}<meta property="og:url" content="${esc(to)}"><meta http-equiv="refresh" content="0;url=${esc(to)}"></head><body><a href="${esc(to)}">${esc(title)}</a></body></html>`)
})
/*
 * /m/<mint>.<ext> (self-hosted token metadata: its on-chain URI) and /img/<mint> (the site's logo proxy) serve only what
 * this engine stands behind (launch.js publicFileAccess): a registered, VISIBLE coin → CDN-cacheable (metadata
 * immutable, logo a day); a live prepare, a launch journal not registered yet, a hidden admin test launch or a coin under
 * a hidden parent → /m served with no-store (its URI must resolve; pump.fun's indexer reads it seconds after the create)
 * and /img 404; anything else — a dead prepare's leftovers, a PUBLIC launch the admin hid (moderation) — 404, no-store,
 * so nothing is ever pinned at the CDN for a mint the engine does not stand behind. A CDN copy served BEFORE a hide is
 * not reached from here: POST /admin/hide answers with the paths to purge.
 */
const CDN_MISS = { 'cache-control': 'public, max-age=60', 'cdn-cache-control': 'public, s-maxage=60', 'vercel-cdn-cache-control': 'public, s-maxage=60' }
const NO_STORE = { 'cache-control': 'no-store', 'cdn-cache-control': 'no-store', 'vercel-cdn-cache-control': 'no-store' }
const META_EXTS = ['json', 'png', 'jpg', 'gif', 'webp']
app.get('/m/:file', (req, res) => {
  const f = String(req.params.file || '')
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}\.(json|png|jpg|gif|webp)$/.test(f)) return res.status(404).set(NO_STORE).end()
  const [m, ext] = f.split('.')
  const access = publicFileAccess(m)
  if (!access) return res.status(404).set(NO_STORE).end()
  const p = join(config.dataDir, 'meta', f)
  if (!existsSync(p)) return res.status(404).set(CDN_MISS).end() // a known mint without this file (e.g. its image is on IPFS)
  const type = { json: 'application/json; charset=utf-8', png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext]
  const cache = access === 'public' ? { 'cache-control': 'public, max-age=300', 'cdn-cache-control': 'public, s-maxage=31536000, immutable', 'vercel-cdn-cache-control': 'public, s-maxage=31536000, immutable' } : NO_STORE
  res.set({ 'content-type': type, ...cache, 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' })
  createReadStream(p).on('error', () => res.destroy()).pipe(res)
})
app.get('/img/:mint', wrap(async (req, res) => {
  const m = mintParam(req.params.mint)
  if (!m || publicFileAccess(m) !== 'public') return res.status(404).set(NO_STORE).end() // the site shows visible coins only
  let logo = readLogo(m)
  if (!logo) { const c = coinRec(m); if (c?.image && !config.offline && (await cacheLogo(m, c.image))) logo = readLogo(m) }
  if (!logo) return res.status(404).set(CDN_MISS).end()
  res.set({ 'content-type': logo.type, 'cache-control': 'public, max-age=86400', 'cdn-cache-control': 'public, s-maxage=86400', 'vercel-cdn-cache-control': 'public, s-maxage=86400', 'x-content-type-options': 'nosniff' }).send(logo.buf)
}))
/** The public URLs a CDN may still hold for a coin's files (served before a hide): the operator purges them. */
function cdnPaths(m) {
  const meta = metaBase()
  const files = META_EXTS.filter(e => existsSync(join(config.dataDir, 'meta', `${m}.${e}`))).map(e => `${meta}/m/${m}.${e}`)
  // the logo proxy, on the engine's public origin and on the brand domain (vercel.json rewrites /img/* there too)
  return [...new Set([...files, logoUrlFor(m), `${meta}/img/${m}`])]
}

/* ---------------- writes (engine builds, the wallet signs, the engine relays) ---------------- */

app.post('/launch/prepare', wrap(async (req, res) => {
  // (the per-IP 'prepare' bucket was taken before the body was read.) The per-wallet and global buckets are spent
  // inside prepareLaunch's gate: only once the body, wallet, parent AND the wallet's balance all checked out.
  const gate = wallet => {
    const no = takeTokens([
      { map: buckets.prepareWallet, key: wallet, cap: RL.prepareWallet[0], rate: RL.prepareWallet[1], msg: 'this wallet prepared several launches just now, wait a minute' },
      { map: buckets.prepareAll, key: 'all', cap: RL.prepareAll[0], rate: RL.prepareAll[1], msg: 'a lot of launches are being prepared right now, try again in a minute' },
    ])
    if (no) throw http(no.msg, 429, { retryAfter: no.retryAfter })
  }
  res.json(await prepareLaunch(req.body, { gate }))
}))
// the public caches are flushed only when a NEW launch was journaled (a double submit or an error changes nothing)
app.post('/launch/submit', wrap(async (req, res) => { res.json(await submitLaunch(req.body?.id, req.body?.signedTx, { onJournaled: () => invalidate(true) })) }))
app.post('/tx/swap', wrap(async (req, res) => {
  if (!allow('swap', req.ip, res)) return
  if (config.offline) throw http('swaps are off in offline dev mode', 503)
  const b = req.body || {}
  res.json(await buildSwap({ wallet: b.wallet, input: b.input, output: b.output, amount: String(b.amount || ''), slippageBps: b.slippageBps }))
}))
app.post('/tx/send', wrap(async (req, res) => {
  if (!allow('swap', req.ip, res)) return
  if (config.offline) throw http('relays are off in offline dev mode', 503)
  // 202 { sig, status: 'unknown' }: the RPC timed out / failed AFTER it may have forwarded the tx — poll the sig
  // (/tx/status), never rebuild and re-sign (a second, different tx could land too)
  const r = await relay(req.body?.signedTx)
  res.status(r.status === 'unknown' ? 202 : 200).json(r)
}))

/* ---------------- admin (x-admin-secret header, constant-time, 5 failures/min/IP) ---------------- */

const sha = s => createHash('sha256').update(String(s ?? '')).digest()
function admin(req, res) {
  const f = adminFails.get(req.ip)
  if (f && f.n >= 5 && Date.now() - f.at < 60_000) { res.status(429).set('retry-after', '60').json({ error: 'too many attempts' }); return false }
  const given = req.headers['x-admin-secret']
  const ok = !!config.adminSecret && typeof given === 'string' && timingSafeEqual(sha(given), sha(config.adminSecret))
  if (!ok) { const g = f && Date.now() - f.at < 60_000 ? f : { n: 0, at: Date.now() }; g.n++; adminFails.set(req.ip, g); res.status(401).json({ error: 'Unauthorized' }); return false }
  return true
}
const A = fn => wrap(async (req, res) => { if (!admin(req, res)) return; await fn(req, res); invalidate(true) })
app.post('/admin/kill', A(async (req, res) => { kill(String(req.body?.reason || 'admin').slice(0, 200)); res.json({ ok: true, killed: true }) }))
app.post('/admin/unkill', A(async (req, res) => { unkill(); res.json({ ok: true, killed: isKilled() }) }))
app.post('/admin/refresh', A(async (req, res) => { await refreshCoins({ force: true }); await advanceLaunches(); res.json({ ok: true, coins: Object.keys(coins()).length, status: refreshStatus() }) }))
app.post('/admin/distribute', A(async (req, res) => { await refreshCoins({ force: true }); const sent = await distributeDue({ force: true, only: mintParam(req.body?.mint) || null }); res.json({ ok: true, sent, status: distributeStatus() }) }))
app.post('/admin/packs', A(async (req, res) => { await packsTick(); res.json({ ok: true, next: packsRun.lastRipCheck, error: packsRun.lastError, convertError: packsRun.lastConvertError }) }))
app.post('/admin/pulls', A(async (req, res) => { await pullsTick(); res.json({ ok: true, error: pullsRun.lastError }) }))
app.post('/admin/burn-pull/:id/resolve', A(async (req, res) => { res.json({ ok: true, pull: publicPull(resolvePull(String(req.params.id), String(req.body?.action || ''))) }) }))
app.post('/admin/pack/:id/resolve', A(async (req, res) => { res.json({ ok: true, pull: publicRip(resolvePack(String(req.params.id), String(req.body?.action || ''))) }) }))
app.post('/admin/burn', A(async (req, res) => { const b = await crankBurner(); res.json({ ok: true, burned: b ? String(b.burned) : null, status: burnerStatus() }) }))
app.post('/admin/root/prepare', A(async (req, res) => { res.json(await prepareLaunch({ ...(req.body || {}), hidden: !!req.body?.hidden }, { root: true, admin: true })) }))
app.post('/admin/root/adopt', A(async (req, res) => { const r = await adoptRoot(String(req.body?.mint || '')); await refreshCoins({ force: true }); res.json({ ok: true, root: view(r) }) }))
app.post('/admin/prepare', A(async (req, res) => { res.json(await prepareLaunch({ ...(req.body || {}), hidden: req.body?.hidden === undefined ? true : !!req.body.hidden }, { admin: true })) }))
// hiding withdraws the coin's /m + /img at the engine at once (a public launch: 404; an admin test launch: /m no-store);
// a copy a CDN cached while it was visible is not reachable from here — `purge` lists those URLs (the operator purges
// them from Vercel's CDN cache by hand)
app.post('/admin/hide', A(async (req, res) => { const c = setHidden(mintParam(req.body?.mint), !!req.body?.hidden); if (!c) throw http('unknown coin', 404); res.json({ ok: true, mint: c.mint, hidden: !!c.hidden, ...(c.hidden ? { purge: cdnPaths(c.mint) } : {}) }) }))
app.post('/admin/reset-root', A(async (req, res) => { res.json(resetRoot()) }))
app.post('/admin/adopt', A(async (req, res) => { const c = await adoptOrphan(String(req.body?.mint || '')); res.json({ ok: true, coin: view(c) }) }))
app.post('/admin/replan', A(async (req, res) => { const m = mintParam(req.body?.mint); if (!m) throw http('bad mint'); res.json({ ok: true, ...(await replanShares(m)) }) }))
app.get('/admin/state', wrap(async (req, res) => {
  if (!admin(req, res)) return
  const intents = readPendingIntents()
  const perPool = {}
  for (const it of intents) (perPool[it.from] ||= []).push({ sig: it.sig, roundId: it.roundId, items: it.items.length, at: it.time })
  res.json({
    engine: stats().engine, rootMint: rootMint(), state: readState(), refresh: refreshStatus(), distribute: distributeStatus(), burner: burnerStatus(), canary: canaryStatus(),
    launches: Object.values(launchesStore.get()).slice(-50), prepared: Object.values(preparedStore.get()).map(({ message, ...p }) => p), preparedCount: preparedCount(),
    roundsOpen: rounds().filter(r => r.status === 'open' || r.status === 'paying').map(r => ({ ...roundView(r), pending: (r.lines || []).filter(l => l.status === 'pending').length })),
    pendingIntents: perPool, quarantine: readQuarantine().slice(-50), ledger: { gasSpentSol: sol(BigInt(ledgerStore.get().gasSpentLamports || '0')) },
    feeIndex: indexStatus(),
    coins: Object.values(coins()).map(c => ({ mint: c.mint, symbol: c.symbol, level: c.level, hidden: !!c.hidden, sharing: !!c.sharing?.address, swept: !!c.swept, unsweptSince: c.sharing?.address && !c.swept ? c.sharing.at || null : null, setup: c.setup ? { step: c.setup.step, sig: c.setup.pendingSig } : null, distributeBlocked: c.distributeBlocked || null, sharesProblem: !c.sharing?.address ? c.sharesProblem || null : null, lockProblem: !c.sharing?.address ? c.lockProblem || null : null, external: !!c.external })),
  })
}))

/* ---------------- SSE ---------------- */

const sse = new Set(), sseByIp = new Map()
app.get('/events', (req, res) => {
  const ip = req.ip
  if (sse.size >= config.maxSseClients || (sseByIp.get(ip) || 0) >= config.ssePerIp) return res.status(503).set('retry-after', '60').json({ error: 'live updates are at capacity; the page still refreshes' })
  res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  res.flushHeaders?.()
  res.write('retry: 10000\n: connected\n\n')
  const c = { res }
  sse.add(c); sseByIp.set(ip, (sseByIp.get(ip) || 0) + 1)
  res.on('close', () => { if (!sse.delete(c)) return; const n = (sseByIp.get(ip) || 1) - 1; if (n > 0) sseByIp.set(ip, n); else sseByIp.delete(ip) })
})
bus.on('event', ev => {
  invalidate()
  if (!visibleEvent(ev) || !sse.size) return
  const frame = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`
  for (const c of sse) { if (c.res.writableLength > 64 * 1024) { c.res.destroy(); continue } c.res.write(frame) }
})
setInterval(() => { for (const c of sse) c.res.write(': hb\n\n') }, 20_000).unref()

/* ---------------- health + errors ---------------- */

const loops = { startedAt: Date.now(), chainOkAt: 0, roundsAt: 0 }
function health() {
  const r = refreshStatus(), now = Date.now(), stale = []
  const ready = config.offline || loops.chainOkAt > 0
  if (!config.offline && config.rpcUrl) {
    if (ready && now - loops.chainOkAt > 10 * 60_000) stale.push('chain')
    if (r.error) stale.push('refresh')
    if (!rentLoaded()) stale.push('rent')
  }
  if (chain.engineSol != null && chain.engineSol < config.gasReserveSol) stale.push('gas')
  if (canaryStatus().status === 'failing') stale.push('canary')
  if (readPendingIntents().some(it => now - (it.time || 0) > 10 * 60_000)) stale.push('intents')
  if (readQuarantine().some(q => now - (q.time || 0) < 3_600_000)) stale.push('quarantine')
  if (Object.values(coins()).some(c => c.sharing?.address && liveOf(c.mint).sharingOk === false)) stale.push('sharing')
  // a locked coin whose coin key / pre-lock vault is still unswept an hour later (never given up on: it retries)
  if (Object.values(coins()).some(c => c.sharing?.address && !c.swept && !c.external && now - (c.sharing.at || 0) > 3_600_000)) stale.push('sweep')
  // a coin whose lock was REFUSED: its recorded split is not the one the engine plans now (POST /admin/replan)
  if (Object.values(coins()).some(c => !c.sharing?.address && c.sharesProblem)) stale.push('shares')
  // a coin whose fee lock has kept failing for 10+ minutes (its simulation / tx fails, or its config does not decode)
  if (Object.values(coins()).some(c => lockFailing(c, now))) stale.push('lock')
  if (packRips().some(r => ['needs-attention', 'stuck', 'quarantined'].includes(r.status) || (r.status === 'paid' && now - (r.paidAt || r.at) > 3_600_000))) stale.push('packs')
  if (burnPulls().some(p => ['stuck', 'needs-attention'].includes(p.status) || (p.status === 'drawn' && now - (p.draw?.at || 0) > 3_600_000))) stale.push('pulls')
  if (isKilled()) stale.push('killed')
  return {
    status: !ready ? 'starting' : stale.length ? 'degraded' : 'ok', ready, stale, rpcOk: config.offline ? null : !r.error && !!r.okAt,
    // coins = the VISIBLE count (= /stats.totals.coins): a public total never reveals a hidden (rehearsal) coin. The stale
    // flags above still watch EVERY coin: a hidden coin's lock / sweep is real money (money does not care about visibility)
    uptime: process.uptime(), coins: allRecs().length, engine: engineAddress() || null, live: { launch: config.launchEnabled, distribute: config.distributeLive, payouts: config.payoutsLive, burn: config.burnLive }, killed: isKilled(), offline: config.offline,
    canary: canaryStatus(), lastChainLoopAt: loops.chainOkAt || null, lastPacksAt: loops.roundsAt || null, packs: { next: packsRun.lastRipCheck, error: packsRun.lastError, convertError: packsRun.lastConvertError, stuck: packRips().filter(r => ['needs-attention', 'stuck', 'quarantined'].includes(r.status)).map(r => `${r.id}:${r.status}`) }, pulls: { live: config.pullsLive, error: pullsRun.lastError, lastAt: loops.pullsAt || null, stuck: burnPulls().filter(p => ['stuck', 'needs-attention'].includes(p.status)).map(p => `${p.id}:${p.status}`) }, pendingIntents: readPendingIntents().length, sse: sse.size, launchBlocker: launchBlocker(),
  }
}
// /health skips the per-IP limiter and walks every coin: computed at most once a second, whatever the request rate
let healthMemo = { at: 0, v: null }
app.get('/health', (req, res) => {
  if (!healthMemo.v || Date.now() - healthMemo.at >= 1000) healthMemo = { at: Date.now(), v: health() }
  const h = healthMemo.v
  res.set('cache-control', PRIVATE).status(h.ready ? 200 : 503).json(h) // degraded (e.g. low gas) is still reachable; the JSON says why
})
app.use((req, res) => res.status(404).json({ error: 'not found' }))
// only our own http() errors set the status; an RPC error / timeout carrying an integer `code` is a logged JSON 500
app.use(errorHandler({ bigBody: BIG_BODY }))

/* ---------------- loops ---------------- */

const guardLoop = (name, fn) => async () => { try { await fn() } catch (e) { console.error(`[${name}]`, e?.message || e) } }
let chainRunning = false
async function chainLoop() {
  if (chainRunning) return
  chainRunning = true
  try {
    solUsd().catch(() => {})
    if (!rentLoaded()) await loadRent()
    await advanceLaunches()   // finish every journaled launch (create landed → lock the split → sweep)
    await refreshCoins()
    await distributeDue()     // crank pump's distribution for locked coins whose vault reached the minimum
    await indexDistributions() // book every distribution from the chain (third-party cranks too), at most once a minute
    await crankBurner()
    const e = engineAddress(); if (e) chain.engineSol = sol(await balanceOf(e).catch(() => 0n))
    loops.chainOkAt = Date.now()
  } catch (e) { console.error('[chain]', e?.message || e) } finally { chainRunning = false }
}
async function boot() {
  console.log(`[boot] ${config.brand} ($${config.ticker}) engine (pump.fun) on http://${config.host}:${config.port} | data ${config.dataDir} | rpc ${config.rpcUrl ? 'set' : 'NOT SET'}${config.offline ? ' | OFFLINE dev' : ''}`)
  console.log(`[boot] engine ${engineAddress() || 'NO KEY (read-only)'} | protocol ${protocolAddress() || 'NOT SET'} | burn ${burnAddress() || 'NOT SET'} | ROOT ${rootMint() || 'not set'}`)
  console.log(`[boot] live: launch ${config.launchEnabled ? 'ON' : 'off'} | distribute ${config.distributeLive ? 'ON' : 'off'} | payouts ${config.payoutsLive ? 'ON' : 'off'} | burn ${config.burnLive ? 'ON' : 'off'} | presign ${config.launchPresign} | killed ${isKilled()} | depth ${config.maxDepth} | round ${config.roundMs / 60000} min`)
  if (config.rootMint && !coinRec(config.rootMint)) console.warn(`[boot] ROOT_MINT pins ${config.rootMint}, which is not registered yet: adopt it (POST /admin/root/adopt) — launches and burns wait until then`)
  if (config.canaryPayer && config.canaryPayer === engineAddress()) console.warn('[boot] CANARY_PAYER is the engine wallet: the crank spends it down and the canary then cannot simulate a create — leave CANARY_PAYER empty (a large public wallet is the default; nothing is ever signed)')
  { const mp = metadataHostProblem(); if (mp && !config.offline) console.warn(`[boot] ${mp}`) }
  if (config.offline || !config.rpcUrl) return
  try { console.log(`[boot] rent(0) = ${await loadRent()} lamports (read from the chain)`) } catch (e) { console.error(`[boot] could not read rent(0): ${e.message} — money loops wait for it`) }
  // the canary FIRST: prepares are served from listen on, so a pump change must pause them before the slow boot steps
  // (a 'failing' verdict from before the restart is persisted and holds until a simulation succeeds)
  await runCanary().catch(e => console.error(`[boot] canary: ${e?.message || e}`)) // never skips the boot steps below
  console.log(`[boot] canary:${canaryStatus().status}${canaryStatus().detail ? ` (${String(canaryStatus().detail).slice(0, 120)})` : ''}`)
  await solUsd().catch(() => {})
  await refreshCoins({ force: true })
  await advanceLaunches()
  if (getEngine()) {
    // reconcile every payout journal from the chain before any loop may send
    await resolvePendingIntents({ deadlineMs: 20_000 }).catch(() => {})
    checkShareholderWallets([protocolAddress(), burnAddress()])
  }
}
const server = app.listen(config.port, config.host, () => {
  boot().catch(e => console.error('[boot]', e?.stack || e)).finally(() => {
    if (config.offline || !config.rpcUrl) { loops.chainOkAt = Date.now(); return }
    setInterval(chainLoop, 20_000)
    setInterval(guardLoop('packs', async () => { await packsTick(); loops.roundsAt = Date.now() }), 45_000)
    setInterval(guardLoop('pulls', async () => { await pullsTick(); loops.pullsAt = Date.now() }), 8_000)
    setInterval(guardLoop('machines', async () => { await machineList() }), 60_000); machineList().catch(() => {})
    // hourly; every 5 min while not 'ok' (a top-up or a pump fix clears a stale verdict within minutes, not an hour)
    setInterval(guardLoop('canary', async () => { const c = canaryStatus(); if (c.status !== 'ok' || Date.now() - (c.at || 0) > 3_600_000 - 60_000) await runCanary() }), 300_000)
    setInterval(guardLoop('relays', trackRelays), 20_000)
    chainLoop()
  })
})
server.on('error', e => { console.error(`[boot] FATAL — listen on ${config.host}:${config.port} failed: ${e.message}`); process.exit(1) })
server.headersTimeout = 15_000
server.requestTimeout = 60_000
