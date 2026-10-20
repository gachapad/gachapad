// In-browser mock of EVERY endpoint in API.md (pump.fun build). Enabled by VITE_MOCK=1 (scripts/dev-mock.mjs).
// Deterministic (seeded PRNG) so the demo looks the same on every load, with a slow live drift so numbers move,
// events arrive, a curve can graduate and the tree grows a branch now and then.
// `?mock=preroot` in the page URL serves the pre-launch state (no ROOT, no coins) so #/admin can launch or adopt one.
import { BRAND, MAX_DEPTH, SETUP_SOL, PUMP_URL } from './config'

/* ---------------- deterministic randomness ---------------- */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20260924)
const R = (lo, hi) => lo + rnd() * (hi - lo)
const RI = (lo, hi) => Math.floor(R(lo, hi + 1))
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const b58 = (n, r = rnd) => { let s = ''; for (let i = 0; i < n; i++) s += B58[Math.floor(r() * B58.length)]; return s }
const addr = () => b58(44)
const sig = () => b58(88)
const NOW = Date.now()
const H = 3600_000, D = 24 * H
const hourFloor = t => Math.floor(t / H) * H
const LAST_ROUND = hourFloor(NOW) + 40_000 > NOW - 60_000 ? hourFloor(NOW) - H + 40_000 : hourFloor(NOW) + 40_000

const PRE = typeof location !== 'undefined' && new URLSearchParams(location.search).get('mock') === 'preroot'

export const DEMO_WALLET = addr()   // the "connected" wallet in mock mode (launched two coins, earned some rounds)
const ENGINE = addr(), PROTOCOL = addr(), BURN = addr()
const SOL_USD = 191.4
const MAX_WALLET_BPS = 500

/* ---------------- pump.fun curve math (Global: 30 SOL / 1.073B virtual, 793.1M real tokens, 1B supply) ---------------- */

const VS0 = 30, VT0 = 1_073_000_000, RT0 = 793_100_000, SUPPLY = 1e9, K = VS0 * VT0
const CURVE_FEE_BPS = 125   // protocol 95 + creator 30 on the curve
const curveAt = p => { const vT = VT0 - Math.min(1, Math.max(0, p)) * RT0; const vS = K / vT; return { vS, vT, realSol: vS - VS0, priceSol: vS / vT } }
const GRAD_MCAP_SOL = curveAt(1).priceSol * SUPPLY  // ≈ 410.9
/** pump.fun creator fee (bps): 30 on the curve and on PumpSwap below 420 SOL mcap, then 95 stepping down. */
const creatorBpsFor = (graduated, mcapSol) => (!graduated || mcapSol < 420 ? 30 : mcapSol < 1470 ? 95 : mcapSol < 2460 ? 90 : mcapSol < 3440 ? 85 : 80)

/* ---------------- the tree ---------------- */

const coins = []
const byMint = new Map()
let ROOT = null

const rootShares = () => [{ address: BURN, bps: 8000, role: 'burn' }, { address: PROTOCOL, bps: 2000, role: 'protocol' }]
const childShares = (creator, parent) => [{ address: creator, bps: 1000, role: 'creator' }, { address: parent.pool.address, bps: 4000, role: 'parentHolders' }, { address: BURN, bps: 4000, role: 'burn' }, { address: PROTOCOL, bps: 1000, role: 'protocol' }]
function lock(c) {
  const parent = c.parent ? byMint.get(c.parent) : null
  c.sharing = { config: addr(), locked: true, status: 'locked', shareholders: parent ? childShares(c.creator, parent) : rootShares(), readBack: true, adminRevoked: true }
}
const unlocked = () => ({ config: null, locked: false, status: 'pending', shareholders: [], readBack: false, adminRevoked: false })

function setPrice(c, priceSol) {
  c.priceSol = priceSol; c.priceUsd = priceSol * SOL_USD
  c.mcapSol = priceSol * SUPPLY; c.mcapUsd = c.mcapSol * SOL_USD
  c.fees.creatorFeeBps = creatorBpsFor(c.curve.graduated, c.mcapSol)
}
function setCurve(c, p) {
  const cv = curveAt(p)
  c.curve.progress = Math.min(1, p); c.curve.realSol = +cv.realSol.toFixed(3)
  setPrice(c, cv.priceSol)
}

function mk({ name, symbol, parent = null, level, progress = 0, gradMcapSol, ageH, holders, creator, description, vol24hUsd, logoHue, pending = false, hidden = false, mint }) {
  mint = mint || addr()
  const parentCoin = parent ? byMint.get(parent) : null
  const graduated = !!gradMcapSol
  const c = {
    mint, symbol, name,
    description: description || `${name}. A child of $${parentCoin ? parentCoin.symbol : BRAND.ticker} on ${BRAND.name}.`,
    logo: null, logoHue, // logo null → ticker tile; a hue lets the mock draw a colour tile per coin
    socials: rnd() > 0.4 ? { twitter: `https://x.com/${symbol.toLowerCase()}`, ...(rnd() > 0.6 ? { website: `https://${symbol.toLowerCase()}.xyz` } : {}) } : {},
    parent: parentCoin ? parentCoin.mint : null, parentSymbol: parentCoin ? parentCoin.symbol : null, level, kids: 0,
    creator: creator || addr(), createdAt: NOW - ageH * H, launchTx: sig(), pumpUrl: PUMP_URL(mint),
    priceSol: 0, priceUsd: 0, mcapSol: 0, mcapUsd: 0,
    curve: { progress: graduated ? 1 : progress, graduated, realSol: graduated ? 85.005 : 0, ammPool: graduated ? addr() : null },
    vol24hUsd: 0, vol1hUsd: 0, trades24h: 0, holders: holders ?? (ageH < 1 ? RI(2, 12) : RI(20, 400)),
    sharing: unlocked(),
    fees: { generatedSol: 0, distributedSol: 0, pendingSol: 0, toParentHoldersSol: 0, toLauncherSol: 0, creatorFeeBps: 30 },
    pool: { address: addr(), balanceSol: 0, paidToHoldersSol: 0, lastRoundAt: null, nextRoundAt: null },
    burnedRootUi: 0,
    hidden,
  }
  if (graduated) setPrice(c, gradMcapSol / SUPPLY); else setCurve(c, progress)
  c.vol24hUsd = vol24hUsd ?? Math.round(c.mcapUsd * R(0.15, 0.9) * Math.min(1, Math.max(0.02, ageH / 24)))
  c.vol1hUsd = Math.round(c.vol24hUsd * R(0.02, 0.14))
  c.trades24h = Math.max(3, Math.round(c.vol24hUsd / R(40, 140)))
  coins.push(c); byMint.set(mint, c)
  if (parentCoin && !hidden) parentCoin.kids++
  if (!pending) lock(c)
  else c.sharing.shareholders = parentCoin ? childShares(c.creator, parentCoin) : rootShares() // like the engine: the PLANNED split, config still null
  return c
}

const L1 = [
  ['Mycelium', 'MYCO', 0, 520, 71, 33, 'A network under the forest floor. The first branch.'],
  ['Ember', 'EMBER', 0.71, 0, 52, 18],
  ['Lantern', 'LNTRN', 0.42, 0, 44, 268],
  ['Moth', 'MOTH', 0.33, 0, 31, 300],
  ['Dusk', 'DUSK', 0.22, 0, 26, 220],
  ['Spore', 'SPORE', 0.17, 0, 19, 120],
  ['Hollow', 'HOLW', 0.11, 0, 14, 24],
  ['Cinder', 'CNDR', 0.05, 0, 9, 12],
]
const L2 = [
  ['Hypha', 'HYPHA', 'MYCO', 0.34, 28, 140], ['Cap', 'CAP', 'MYCO', 0.16, 20, 60], ['Gill', 'GILL', 'MYCO', 0.05, 6, 200],
  ['Ash', 'ASH', 'EMBER', 0.2, 30, 0], ['Spark', 'SPARK', 'EMBER', 0.12, 18, 40],
  ['Wick', 'WICK', 'LNTRN', 0.14, 22, 48],
  ['Owl', 'OWL', 'DUSK', 0.11, 12, 250],
  ['Mold', 'MOLD', 'SPORE', 0.06, 8, 110],
]
const L3 = [
  ['Rhizome', 'RHIZO', 'HYPHA', 0.09, 14, 160], ['Knot', 'KNOT', 'HYPHA', 0.04, 5, 90],
  ['Soot', 'SOOT', 'ASH', 0.07, 10, 20],
  ['Frond', 'FROND', 'CAP', 0.05, 7, 130],
  ['Flare', 'FLARE', 'WICK', 0.02, 0.01, 30, true],  // launched seconds ago: its split is still being locked
]

if (!PRE) {
  ROOT = mk({ name: BRAND.name, symbol: BRAND.ticker, level: 0, gradMcapSol: 742, ageH: 96, holders: 1240, logoHue: 32, vol24hUsd: 38_400,
    description: `The root of the tree. A pump.fun coin with no parent: its holders are the parents of the first generation, and 10% of every coin's creator fees buys and burns it.` })
  const S = { [BRAND.ticker]: ROOT }
  L1.forEach(([name, symbol, progress, grad, ageH, hue, description], i) => { S[symbol] = mk({ name, symbol, parent: ROOT.mint, level: 1, progress, gradMcapSol: grad || undefined, ageH, logoHue: hue, description, creator: i === 1 ? DEMO_WALLET : undefined }) })
  L2.forEach(([name, symbol, ps, progress, ageH, hue], i) => { S[symbol] = mk({ name, symbol, parent: S[ps].mint, level: 2, progress, ageH, logoHue: hue, creator: i === 4 ? DEMO_WALLET : undefined }) })
  L3.forEach(([name, symbol, ps, progress, ageH, hue, pending]) => { S[symbol] = mk({ name, symbol, parent: S[ps].mint, level: 3, progress, ageH, logoHue: hue, pending }) })
  mk({ name: 'Test launch', symbol: 'TSTX', parent: ROOT.mint, level: 1, progress: 0.01, ageH: 2, logoHue: 0, hidden: true })  // admin test launch: hidden everywhere
}

/* ---------------- lifetime money on every coin ---------------- */

for (const c of coins) {
  const lifetimeVolSol = c.vol24hUsd / SOL_USD * (c.level === 0 ? 4 : 2.2)
  const gen = lifetimeVolSol * c.fees.creatorFeeBps / 10_000
  const dist = c.sharing.locked ? gen * R(0.8, 0.92) : 0
  c.fees.generatedSol = +gen.toFixed(4); c.fees.distributedSol = +dist.toFixed(4); c.fees.pendingSol = +(gen - dist).toFixed(4)
  c.fees.toParentHoldersSol = c.level > 0 ? +(dist * 0.4).toFixed(4) : 0
  c.fees.toLauncherSol = c.level > 0 ? +(dist * 0.4).toFixed(4) : 0
}
const rootPriceSol = () => ROOT?.priceSol || 1e-6
for (const c of coins) {
  const kids = coins.filter(k => k.parent === c.mint)
  const inflow = kids.reduce((s, k) => s + k.fees.toParentHoldersSol, 0)
  c.pool.paidToHoldersSol = +(inflow * 0.8).toFixed(4)
  c.pool.balanceSol = +(inflow - c.pool.paidToHoldersSol).toFixed(4)
  if (inflow > 0) { c.pool.lastRoundAt = LAST_ROUND; c.pool.nextRoundAt = LAST_ROUND + H }
  c.burnedRootUi = Math.round(c.fees.distributedSol * (c.level === 0 ? 0.8 : 0.1) / rootPriceSol())
}
if (ROOT) ROOT.burnedRootUi = coins.reduce((s, c) => s + c.burnedRootUi, 0)

/* ---------------- events, rounds, burns ---------------- */

const events = []
let eid = 1
const ev = (type, c, at, extra = {}) => { const e = { id: `e${eid++}`, type, at, mint: c.mint, symbol: c.symbol, ...(c.parent ? { parentMint: c.parent } : {}), ...extra }; events.push(e); return e }
for (const c of coins) {
  ev('launch', c, c.createdAt, { wallet: c.creator, sig: c.launchTx, extra: { level: c.level, parentSymbol: c.parentSymbol } })
  if (c.sharing.locked) ev('lock', c, c.createdAt + 6_000, { sig: sig(), extra: { config: c.sharing.config } })
}
for (const c of coins.filter(x => x.curve.graduated && x.level > 0)) ev('graduate', c, c.createdAt + R(6, 30) * H, { sig: sig(), amountUsd: Math.round(GRAD_MCAP_SOL * SOL_USD) })
for (const c of coins.filter(x => x.fees.distributedSol > 0.004)) {
  const n = RI(1, 3)
  for (let i = 0; i < n; i++) ev('distribute', c, Math.max(c.createdAt + 60_000, NOW - R(0.2, 40) * H), { amountSol: +(c.fees.distributedSol / n).toFixed(4), sig: sig() })
}

const rounds = []
const roundLines = new Map()
let rid = 1
function makeRound(c, closedAt, paidSol, { wallets, demo = false, status = 'done', reason } = {}) {
  const id = `r${rid++}`
  const n = status === 'done' ? wallets || RI(12, Math.max(12, Math.min(c.holders, 90))) : 0
  const lines = []
  if (n) {
    let left = Math.round(paidSol * 1e9)
    const weights = Array.from({ length: n }, (_, i) => (i === 0 ? R(3, 6) : R(0.2, 2)))
    const wsum = weights.reduce((s, x) => s + x, 0)
    for (let i = 0; i < n; i++) {
      const lam = i === n - 1 ? left : Math.min(left, Math.round(paidSol * 1e9 * Math.min(weights[i] / wsum, MAX_WALLET_BPS / 10_000)))
      left -= lam
      lines.push({ wallet: i === 1 && demo ? DEMO_WALLET : addr(), weightUi: Math.round(weights[i] * 1e6), lamports: String(lam), sig: null, status: 'paid' }) // raw amounts are strings (API.md)
    }
  }
  const sigs = Array.from({ length: Math.ceil(n / 12) }, () => sig())
  lines.forEach((l, i) => { l.sig = sigs[Math.floor(i / 12)] })
  const r = { id, parentMint: c.mint, parentSymbol: c.symbol, openedAt: closedAt - H, closedAt, budgetSol: +(paidSol * (status === 'done' ? R(1.02, 1.12) : 1)).toFixed(4), paidSol: status === 'done' ? +paidSol.toFixed(4) : 0, wallets: n, status, sigs, ...(reason ? { reason } : {}) }
  rounds.push(r); roundLines.set(id, lines)
  if (status === 'done') {
    // like the engine: one 'round' event when the round closes, then one 'payout' event per batch tx (no single wallet)
    ev('round', c, closedAt, { amountSol: r.paidSol, extra: { roundId: id, status: 'paying', wallets: n, budgetSol: r.budgetSol } })
    sigs.forEach((s, b) => { const batch = lines.slice(b * 12, b * 12 + 12); ev('payout', c, closedAt + 5_000 + b, { amountSol: +(batch.reduce((a, l) => a + Number(l.lamports), 0) / 1e9).toFixed(6), sig: s, extra: { roundId: id, wallets: batch.length } }) })
  }
  return r
}
for (const c of coins.filter(x => x.pool.paidToHoldersSol > 0)) {
  const n = c.level === 0 ? 7 : RI(1, 4)
  const w = Array.from({ length: n }, () => R(0.6, 1.4)), ws = w.reduce((s, x) => s + x, 0)
  let t = LAST_ROUND
  for (let i = 0; i < n; i++) { makeRound(c, t, c.pool.paidToHoldersSol * w[i] / ws, { demo: c.level < 2 && i % 2 === 0 }); t -= H * RI(1, 3) }
  if (c.level === 1 && c.pool.balanceSol < 0.01) makeRound(c, t, 0, { status: 'skipped', reason: 'below the minimum payout; carried to the next round' })
  rounds.push({ id: `r${rid++}`, parentMint: c.mint, parentSymbol: c.symbol, openedAt: c.pool.nextRoundAt - H, closedAt: null, budgetSol: c.pool.balanceSol, paidSol: 0, wallets: 0, status: 'open', sigs: [] })
}

const burns = []
if (ROOT) {
  let total = ROOT.burnedRootUi, left = total
  for (let i = 0; i < 14; i++) {
    const at = NOW - R(0.5, 70) * H
    const amountUi = i === 13 ? left : Math.round(total * R(0.03, 0.11))
    left -= amountUi
    const spentSol = +(amountUi * ROOT.priceSol).toFixed(4)
    const b = { at, amountUi, amountUsd: +(spentSol * SOL_USD).toFixed(2), spentSol, sig: sig(), swapSig: sig() }
    burns.push(b)
    ev('burn', ROOT, at, { amountUi, amountUsd: b.amountUsd, amountSol: spentSol, sig: b.sig, extra: { swapSig: b.swapSig } })
  }
}
for (let i = 0; i < (coins.length ? 90 : 0); i++) {
  const c = coins[RI(0, coins.length - 1)]
  if (c.hidden) continue
  const from = Math.max(c.createdAt + 10_000, NOW - D)
  const at = from + R(0.02, 1) * (NOW - from)
  const buy = rnd() > 0.42
  const amountUsd = +R(4, Math.max(20, c.vol24hUsd / 30)).toFixed(2)
  ev('trade', c, at, { wallet: addr(), amountUsd, amountSol: +(amountUsd / SOL_USD).toFixed(4), sig: sig(), extra: { side: buy ? 'buy' : 'sell', priceUsd: c.priceUsd * (1 + (buy ? 1 : -1) * R(0, 0.06)) } })
}
const sortAll = () => { events.sort((a, b) => b.at - a.at); rounds.sort((a, b) => (b.closedAt ?? Number.MAX_SAFE_INTEGER) - (a.closedAt ?? Number.MAX_SAFE_INTEGER)); burns.sort((a, b) => b.at - a.at) }
sortAll()

/* ---------------- live drift + subscribers ---------------- */

const subs = new Set()
export function subscribe(cb) { subs.add(cb); return () => subs.delete(cb) }
const emit = e => { for (const cb of subs) { try { cb(e) } catch {} } }
const push = e => { sortAll(); emit(e) }
let ticking = false
let killed = false
const drift = mulberry32(7)
const visible = () => coins.filter(c => !c.hidden)

function lockLater(c, ms = 5_000) {
  setTimeout(() => { if (c.sharing.locked) return; lock(c); push(ev('lock', c, Date.now(), { sig: sig(), extra: { config: c.sharing.config } })) }, ms)
}
function addFees(c, sol) {
  const f = sol * c.fees.creatorFeeBps / 10_000
  c.fees.generatedSol = +(c.fees.generatedSol + f).toFixed(6); c.fees.pendingSol = +(c.fees.pendingSol + f).toFixed(6)
}
function tick() {
  const list = visible()
  if (!list.length) return
  const c = list[Math.floor(drift() * list.length)]
  const roll = drift()
  const at = Date.now()
  if (roll < 0.6) {
    const buy = drift() > 0.45
    const sol = +(0.02 + drift() * Math.max(0.1, c.vol24hUsd / SOL_USD / 40)).toFixed(4)
    if (c.curve.graduated) setPrice(c, c.priceSol * (1 + (buy ? 1 : -1) * drift() * 0.02))
    else {
      const cv = curveAt(c.curve.progress)
      const vS = Math.max(VS0, cv.vS + (buy ? 1 : -1) * sol * (1 - CURVE_FEE_BPS / 10_000))
      const p = (VT0 - K / vS) / RT0
      if (p >= 1) {
        c.curve.graduated = true; c.curve.progress = 1; c.curve.realSol = 85.005; c.curve.ammPool = addr()
        setPrice(c, GRAD_MCAP_SOL / SUPPLY)
        push(ev('graduate', c, at, { sig: sig(), amountUsd: Math.round(GRAD_MCAP_SOL * SOL_USD) }))
      } else setCurve(c, p)
    }
    const amountUsd = +(sol * SOL_USD).toFixed(2)
    c.vol24hUsd += amountUsd; c.vol1hUsd += amountUsd; c.trades24h++
    addFees(c, sol)
    push(ev('trade', c, at, { wallet: addr(), amountUsd, amountSol: sol, sig: sig(), extra: { side: buy ? 'buy' : 'sell', priceUsd: c.priceUsd } }))
  } else if (roll < 0.72) {
    const d = list.filter(x => x.sharing.locked && x.fees.pendingSol > 0.001)
    const x = d[Math.floor(drift() * d.length)]
    if (!x) return
    const amt = x.fees.pendingSol
    x.fees.distributedSol = +(x.fees.distributedSol + amt).toFixed(6); x.fees.pendingSol = 0
    const p = x.parent ? byMint.get(x.parent) : null
    if (p) { x.fees.toParentHoldersSol = +(x.fees.toParentHoldersSol + amt * 0.4).toFixed(6); x.fees.toLauncherSol = +(x.fees.toLauncherSol + amt * 0.4).toFixed(6); p.pool.balanceSol = +(p.pool.balanceSol + amt * 0.4).toFixed(6); if (!p.pool.nextRoundAt) p.pool.nextRoundAt = hourFloor(at) + H }
    push(ev('distribute', x, at, { amountSol: +amt.toFixed(6), sig: sig() }))
  } else if (roll < 0.82) {
    const d = list.filter(x => x.pool.balanceSol > 0.005)
    const x = d[Math.floor(drift() * d.length)]
    if (!x) return
    const paid = +(x.pool.balanceSol * 0.85).toFixed(6)
    const open = rounds.find(r => r.parentMint === x.mint && r.status === 'open')
    if (open) rounds.splice(rounds.indexOf(open), 1)
    makeRound(x, at, paid, { wallets: 8 + Math.floor(drift() * 40) })
    x.pool.balanceSol = +(x.pool.balanceSol - paid).toFixed(6); x.pool.paidToHoldersSol = +(x.pool.paidToHoldersSol + paid).toFixed(6)
    x.pool.lastRoundAt = at; x.pool.nextRoundAt = at + H
    rounds.push({ id: `r${rid++}`, parentMint: x.mint, parentSymbol: x.symbol, openedAt: at, closedAt: null, budgetSol: x.pool.balanceSol, paidSol: 0, wallets: 0, status: 'open', sigs: [] })
    push(events.find(e => e.type === 'round' && e.mint === x.mint && e.at === at) || ev('round', x, at, {}))
  } else if (roll < 0.9 && ROOT) {
    const spentSol = +(0.005 + drift() * 0.08).toFixed(4)
    const amountUi = Math.round(spentSol / ROOT.priceSol)
    const b = { at, amountUi, amountUsd: +(spentSol * SOL_USD).toFixed(2), spentSol, sig: sig(), swapSig: sig() }
    burns.unshift(b); ROOT.burnedRootUi += amountUi
    push(ev('burn', ROOT, at, { amountUi, amountUsd: b.amountUsd, amountSol: spentSol, sig: b.sig, extra: { swapSig: b.swapSig } }))
  } else if (list.length < 40) {
    // a new branch grows: live on pump.fun at once, its split locked seconds later
    const parents = list.filter(x => x.level < MAX_DEPTH)
    const parent = parents[Math.floor(drift() * parents.length)]
    if (!parent) return
    const names = ['Fern', 'Lichen', 'Tinder', 'Nettle', 'Ivy', 'Thorn', 'Willow', 'Sable', 'Marrow', 'Quill', 'Rune', 'Kelp', 'Bramble', 'Tallow']
    const name = names[Math.floor(drift() * names.length)] + (coins.length > 26 ? coins.length : '')
    const symbol = name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
    if (coins.some(x => x.symbol === symbol)) return
    const k = mk({ name, symbol, parent: parent.mint, level: parent.level + 1, progress: 0.005 + drift() * 0.03, ageH: 0, logoHue: Math.floor(drift() * 360), pending: true })
    k.createdAt = at
    push(ev('launch', k, at, { wallet: k.creator, sig: k.launchTx, extra: { level: k.level, parentSymbol: k.parentSymbol } }))
    lockLater(k)
  }
}
function ensureTicking() {
  if (ticking || typeof window === 'undefined') return
  ticking = true
  setInterval(tick, 9_000)
  for (const c of coins) if (!c.sharing.locked && !c.hidden) lockLater(c, 6_000)
}

/* ---------------- request handler ---------------- */

const logoOf = c => (c.logo && c.logo.startsWith('data:') ? c.logo : `mock://${c.logoHue}`)
const pub = c => { const { logoHue, hidden, ...rest } = c; return { ...rest, logo: logoOf(c), sharing: { ...c.sharing, shareholders: c.sharing.shareholders.map(s => ({ ...s })) }, fees: { ...c.fees }, pool: { ...c.pool }, curve: { ...c.curve } } }
const treeNode = c => ({ mint: c.mint, symbol: c.symbol, name: c.name, logo: logoOf(c), parent: c.parent, level: c.level, mcapUsd: c.mcapUsd, vol1hUsd: c.vol1hUsd, progress: c.curve.progress, graduated: c.curve.graduated, kids: c.kids })
const err = (status, error) => { const e = new Error(error); e.status = status; return e }
const delay = ms => new Promise(r => setTimeout(r, ms))
const launches = new Map()
const txs = new Map()
const fakeTx = () => btoa(String.fromCharCode(...Array.from({ length: 96 }, () => Math.floor(Math.random() * 256))))
const RESERVED = [BRAND.ticker, 'SOL', 'PUMP', 'USDC', 'USDT']
const byteLen = s => new TextEncoder().encode(String(s || '')).length
const liveCoin = m => { const c = byMint.get(m); return c && !c.hidden ? c : null }

function stats() {
  const list = visible()
  return {
    brand: BRAND.name, ticker: BRAND.ticker, root: ROOT && !ROOT.hidden ? pub(ROOT) : null, sol: { usd: SOL_USD },
    totals: {
      coins: list.length, launches24h: list.filter(c => c.createdAt > Date.now() - D).length,
      vol24hUsd: Math.round(list.reduce((s, c) => s + c.vol24hUsd, 0)),
      creatorFeesSol: +list.reduce((s, c) => s + c.fees.generatedSol, 0).toFixed(3),
      paidToHoldersSol: +list.reduce((s, c) => s + c.pool.paidToHoldersSol, 0).toFixed(3),
      paidToHoldersUsd: Math.round(list.reduce((s, c) => s + c.pool.paidToHoldersSol, 0) * SOL_USD),
      holdersPaid: rounds.reduce((s, r) => s + (r.wallets || 0), 0),
      burnedRootUi: ROOT?.burnedRootUi || 0, burnedRootUsd: Math.round((ROOT?.burnedRootUi || 0) * (ROOT?.priceUsd || 0)),
    },
    engine: {
      live: { launch: true, distribute: true, payouts: true, burn: true }, killed, canary: 'ok', maxDepth: MAX_DEPTH,
      split: { creator: 1000, parentHolders: 4000, burn: 4000, protocol: 1000 }, rootSplit: { burn: 8000, protocol: 2000 }, roundMs: H,
      wallets: { engine: ENGINE, protocol: PROTOCOL, burn: BURN }, balances: { engineSol: 2.417, burnSol: 0.084 },
    },
  }
}

function list(q) {
  const sort = q.get('sort') || 'new', filter = q.get('filter') || 'all', parent = q.get('parent'), s = (q.get('q') || '').trim().toLowerCase()
  const offset = +(q.get('offset') || 0), limit = Math.min(100, +(q.get('limit') || 50))
  let items = visible()
  if (parent) items = items.filter(c => c.parent === parent)
  if (filter === 'curve') items = items.filter(c => !c.curve.graduated)
  if (filter === 'graduated') items = items.filter(c => c.curve.graduated)
  if (/^level[123]$/.test(filter)) items = items.filter(c => c.level === +filter.slice(5))
  if (s) items = items.filter(c => c.symbol.toLowerCase().includes(s) || c.name.toLowerCase().includes(s) || c.mint.toLowerCase().startsWith(s))
  const key = { new: c => c.createdAt, mcap: c => c.mcapUsd, vol: c => c.vol24hUsd, kids: c => c.kids, progress: c => (c.curve.graduated ? 1.01 : c.curve.progress) }[sort] || (c => c.createdAt)
  items.sort((a, b) => key(b) - key(a))
  return { total: items.length, items: items.slice(offset, offset + limit).map(pub) }
}

function quote(q) {
  const input = q.get('input'), output = q.get('output'), amount = BigInt(q.get('amount') || '0'), slippageBps = +(q.get('slippageBps') || 100)
  if (amount <= 0n) throw err(400, 'amount must be > 0')
  if ((input === 'SOL') === (output === 'SOL')) throw err(400, 'quotes are SOL ↔ coin')
  const c = liveCoin(input === 'SOL' ? output : input)
  if (!c) throw err(404, 'unknown coin')
  const buy = input === 'SOL'
  const amt = Number(amount) / (buy ? 1e9 : 1e6)
  let out, spot, feeBps, route
  if (!c.curve.graduated) {
    const cv = curveAt(c.curve.progress)
    feeBps = CURVE_FEE_BPS; route = 'curve'; spot = cv.priceSol
    if (buy) { const net = amt * (1 - feeBps / 10_000); out = Math.min(cv.vT - K / (cv.vS + net), RT0 * (1 - c.curve.progress)) }
    else out = (cv.vS - K / (cv.vT + amt)) * (1 - feeBps / 10_000)
  } else {
    const solRes = Math.max(60, c.mcapSol * 0.2), tokRes = solRes / c.priceSol
    feeBps = c.mcapSol < 420 ? 125 : 25 + c.fees.creatorFeeBps; route = 'amm'; spot = c.priceSol
    if (buy) { const net = amt * (1 - feeBps / 10_000); out = tokRes - (solRes * tokRes) / (solRes + net) }
    else out = (solRes - (solRes * tokRes) / (tokRes + amt)) * (1 - feeBps / 10_000)
  }
  const eff = buy ? amt / Math.max(1e-12, out) : Math.max(1e-12, out) / amt
  const impact = Math.max(0, (buy ? (eff / spot - 1) * 100 : (1 - eff / spot) * 100) - feeBps / 100)
  const outRaw = Math.max(0, Math.floor(out * (buy ? 1e6 : 1e9)))
  return { route, outAmount: String(outRaw), minOut: String(Math.floor(outRaw * (1 - slippageBps / 10_000))), priceImpactPct: +Math.min(99, impact).toFixed(2), feeBps }
}

function advance(l) {
  const now = Date.now()
  if (l.status === 'prepared' && now > l.expiresAt) l.status = 'expired'
  if (l.status === 'sent' && now - l.submittedAt > 1_800) {
    l.status = 'created'
    const parent = l.parent ? byMint.get(l.parent) : null
    // first buy on the curve: tokens bought with firstBuySol → progress
    const tokens = l.firstBuySol ? VT0 - K / (VS0 + l.firstBuySol * (1 - CURVE_FEE_BPS / 10_000)) : 0
    const c = mk({ mint: l.mint, name: l.name, symbol: l.symbol, parent: parent?.mint || null, level: parent ? parent.level + 1 : 0, progress: tokens / RT0, ageH: 0, creator: l.wallet, description: l.description, logoHue: 24, pending: true, hidden: !!l.hidden, holders: 1, vol24hUsd: Math.round((l.firstBuySol || 0) * SOL_USD) })
    c.createdAt = now; c.socials = l.socials || {}; c.launchTx = l.sig
    if (l.image) c.logo = l.image
    if (l.isRoot) ROOT = c
    if (!c.hidden) push(ev('launch', c, now, { wallet: c.creator, sig: l.sig, extra: { level: c.level, parentSymbol: c.parentSymbol } }))
  }
  if (l.status === 'created' && now - l.submittedAt > 5_000) {
    l.status = 'live'
    const c = byMint.get(l.mint)
    if (c && !c.sharing.locked) { lock(c); if (!c.hidden) push(ev('lock', c, now, { sig: sig(), extra: { config: c.sharing.config } })) }
  }
  return { id: l.id, status: l.status, mint: l.mint, sig: l.sig || null, error: l.error || null, parent: l.parent }
}

function prepare(p, b, headers) {
  const admin = p.startsWith('/admin/')
  if (admin && headers['x-admin-secret'] !== 'demo') throw err(401, 'bad admin secret (mock: use "demo")')
  if (killed) throw err(503, 'launches are paused (kill switch)')
  const isRoot = p === '/admin/root/prepare'
  if (isRoot && ROOT) throw err(409, `ROOT is already set: $${ROOT.symbol}`)
  if (!b.wallet) throw err(400, 'wallet required')
  if (!/^[A-Z][A-Z0-9]{1,9}$/.test(b.symbol || '')) throw err(400, 'ticker must be 2-10 A-Z 0-9, starting with a letter')
  if (!isRoot && RESERVED.includes(b.symbol)) throw err(409, `ticker $${b.symbol} is reserved`)
  if (!b.name || byteLen(b.name) > 32) throw err(400, 'name required (max 32 bytes)')
  if (!b.image || !/^data:image\//.test(b.image)) throw err(400, 'image required')
  if (b.image.length > 4 * 1024 * 1024) throw err(400, 'image too large')
  if (b.firstBuySol != null && !(b.firstBuySol >= 0 && b.firstBuySol <= 10)) throw err(400, 'firstBuySol must be between 0 and 10 SOL')
  let parent = null
  if (!isRoot) {
    parent = liveCoin(b.parent) || (admin ? byMint.get(b.parent) : null)
    if (!parent) throw err(400, 'parent unknown: pick a coin on the pad')
    if (parent.level >= MAX_DEPTH) throw err(400, `max depth: $${parent.symbol} is a level ${parent.level} coin; launch under $${parent.parentSymbol} instead`)
  }
  if (coins.some(c => c.symbol === b.symbol)) throw err(409, `ticker $${b.symbol} already exists on the pad`)
  const id = `L${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, mint = addr()
  const hidden = p === '/admin/prepare' ? b.hidden !== false : !!(isRoot && b.hidden)
  launches.set(id, { id, mint, status: 'prepared', wallet: b.wallet, parent: parent?.mint || null, name: b.name, symbol: b.symbol, description: b.description, image: b.image, socials: b.socials, firstBuySol: +b.firstBuySol || 0, hidden, isRoot, expiresAt: Date.now() + 90_000 })
  return { id, mint, tx: fakeTx(), expiresAt: Date.now() + 90_000, costs: { setupSol: SETUP_SOL, firstBuySol: +b.firstBuySol || 0, networkSol: 0.0226 } }
}

export async function handle(method, path, body, headers = {}) {
  ensureTicking()
  await delay(80 + Math.random() * 160)
  const url = new URL(path, 'http://mock')
  const p = url.pathname, q = url.searchParams
  const seg = p.split('/').filter(Boolean)

  if (method === 'GET') {
    if (p === '/stats') return stats()
    if (p === '/health') return { status: 'ok', uptime: 86_400 + Math.floor((Date.now() - NOW) / 1000), lastRefreshAt: Date.now() - 2000, coins: visible().length, rpcOk: true, queue: 0 }
    if (p === '/coins') return list(q)
    if (seg[0] === 'coin' && seg[1]) {
      const c = liveCoin(seg[1]); if (!c) throw err(404, 'unknown coin')
      const parents = []; let cur = c; while (cur && cur.parent) { cur = byMint.get(cur.parent); if (cur) parents.push(pub(cur)) }
      const kids = visible().filter(k => k.parent === c.mint).sort((a, b) => b.mcapUsd - a.mcapUsd).slice(0, 50).map(pub)
      const evs = events.filter(e => e.mint === c.mint || (e.type === 'launch' && e.parentMint === c.mint && liveCoin(e.mint))).slice(0, 50)
      const hr = mulberry32(c.mint.charCodeAt(5) * 31 + c.mint.charCodeAt(9))
      let left = 1
      const holdersTop = Array.from({ length: Math.min(20, c.holders) }, (_, i) => { const share = Math.min(left * 0.6, (i === 0 ? 0.12 : 0.05) * hr() + 0.004); left -= share; return { wallet: i === 2 && c.creator === DEMO_WALLET ? DEMO_WALLET : b58(44, hr), amountUi: Math.round(share * 1e9), share } })
      const own = rounds.filter(r => r.parentMint === c.mint).slice(0, 20)
      return { coin: pub(c), parents, kids, events: evs, holdersTop, rounds: own }
    }
    if (p === '/tree') return { nodes: visible().map(treeNode), updatedAt: Date.now() }
    if (p === '/feed') { const types = (q.get('type') || '').split(',').filter(Boolean); const limit = Math.min(200, +(q.get('limit') || 50)); return events.filter(e => liveCoin(e.mint) && (!types.length || types.includes(e.type))).slice(0, limit) }
    if (p === '/rounds') { const mint = q.get('mint'), limit = Math.min(200, +(q.get('limit') || 50)); return rounds.filter(r => (!mint || r.parentMint === mint) && liveCoin(r.parentMint)).slice(0, limit) }
    if (seg[0] === 'round' && seg[1]) { const r = rounds.find(x => x.id === seg[1]); if (!r) throw err(404, 'unknown round'); return { ...r, lines: roundLines.get(r.id) || [] } }
    if (p === '/burns') return burns.slice(0, Math.min(200, +(q.get('limit') || 50)))
    if (seg[0] === 'wallet' && seg[1]) {
      const w = seg[1]
      const launched = visible().filter(c => c.creator === w)
      const earned = []
      for (const r of rounds) for (const l of roundLines.get(r.id) || []) if (l.wallet === w) earned.push({ parentMint: r.parentMint, symbol: r.parentSymbol, amountSol: +(Number(l.lamports) / 1e9).toFixed(6), sig: l.sig, at: r.closedAt, roundId: r.id })
      earned.sort((a, b) => b.at - a.at)
      return {
        launched: launched.map(pub),
        earnedAsHolderSol: +earned.reduce((s, e) => s + e.amountSol, 0).toFixed(6), earned,
        earnedAsCreatorSol: +launched.reduce((s, c) => s + c.fees.toLauncherSol, 0).toFixed(6),
      }
    }
    if (p === '/quote') return quote(q)
    if (p === '/launch-meta') return { enabled: !killed, blocker: killed ? 'The kill switch is on.' : null, setupSol: SETUP_SOL, maxDepth: MAX_DEPTH, tickers: { reserved: RESERVED }, firstBuyMaxSol: 10, presign: true, split: { creator: 1000, parentHolders: 4000, burn: 4000, protocol: 1000 }, networkSol: 0.0226 }
    if (seg[0] === 'launch' && seg[1]) { const l = launches.get(seg[1]); if (!l) throw err(404, 'unknown launch'); return advance(l) }
    if (seg[0] === 'tx' && seg[1] === 'status' && seg[2]) { const t = txs.get(seg[2]); if (!t) return { status: 'pending' }; return { status: Date.now() - t.at > 2_200 ? 'landed' : 'pending' } }
    if (p === '/admin/state') {
      if (headers['x-admin-secret'] !== 'demo') throw err(401, 'bad admin secret')
      return {
        killed, canary: 'ok', root: ROOT?.mint || null,
        queues: { lock: coins.filter(c => !c.sharing.locked).length, distribute: coins.filter(c => c.fees.pendingSol > 0.001).length, burn: 0 },
        journals: { intents: 42, open: 0 },
        pendingIntentsByPool: Object.fromEntries(coins.filter(c => c.pool.balanceSol > 0).map(c => [c.symbol, 0])),
        balances: { engineSol: 2.417, burnSol: 0.084 },
        launches: [...launches.values()].map(({ image, ...l }) => l),
        hidden: coins.filter(c => c.hidden).map(c => ({ mint: c.mint, symbol: c.symbol })),
      }
    }
    throw err(404, `no route ${p}`)
  }

  if (method === 'POST') {
    const b = body || {}
    if (p === '/launch/prepare' || p === '/admin/root/prepare' || p === '/admin/prepare') return prepare(p, b, headers)
    if (p === '/launch/submit') {
      const l = launches.get(b.id); if (!l) throw err(404, 'unknown launch')
      if (!b.signedTx) throw err(400, 'signedTx required')
      if (l.status === 'expired' || Date.now() > l.expiresAt) { l.status = 'expired'; throw err(409, 'the prepared launch expired') }
      if (l.status === 'prepared') { l.status = 'sent'; l.submittedAt = Date.now(); l.sig = sig() }
      return { sig: l.sig, mint: l.mint, status: l.status }
    }
    if (p === '/tx/swap') {
      const qq = quote(new URLSearchParams({ input: b.input, output: b.output, amount: String(b.amount), slippageBps: String(b.slippageBps || 100) }))
      return { tx: fakeTx(), route: qq.route, quote: qq }
    }
    if (p === '/tx/send') { if (!b.signedTx) throw err(400, 'signedTx required'); const s = sig(); txs.set(s, { at: Date.now() }); return { sig: s } }
    if (seg[0] === 'admin') {
      if (headers['x-admin-secret'] !== 'demo') throw err(401, 'bad admin secret (mock: use "demo")')
      if (seg[1] === 'kill') { killed = true; return { ok: true, killed } }
      if (seg[1] === 'unkill') { killed = false; return { ok: true, killed } }
      if (seg[1] === 'hide') { const c = byMint.get(b.mint); if (!c) throw err(404, 'unknown coin'); if (c === ROOT && b.hidden) throw err(409, 'cannot hide ROOT'); if (c.hidden !== !!b.hidden && c.parent) byMint.get(c.parent).kids += b.hidden ? -1 : 1; c.hidden = !!b.hidden; return { ok: true, mint: c.mint, hidden: c.hidden } }
      if (seg[1] === 'round') { const c = byMint.get(b.parent); if (!c) throw err(404, 'unknown parent'); return { ok: true, parent: c.mint, queued: true } }
      if (seg[1] === 'root' && seg[2] === 'adopt') {
        if (ROOT) throw err(409, `ROOT is already set: $${ROOT.symbol}`)
        if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(b.mint || '')) throw err(400, 'mint required')
        ROOT = byMint.get(b.mint) || mk({ mint: b.mint, name: BRAND.name, symbol: BRAND.ticker, level: 0, progress: 0.08, ageH: 0.2, logoHue: 32, holders: 40 })
        push(ev('launch', ROOT, Date.now(), { wallet: ROOT.creator, sig: ROOT.launchTx, extra: { level: 0 } }))
        return { ok: true, root: ROOT.mint }
      }
      if (seg[1] === 'reset-root') {
        if (!ROOT) throw err(409, 'no ROOT set')
        if (coins.some(c => c.parent === ROOT.mint)) throw err(409, 'ROOT has children; it cannot be reset')
        coins.splice(coins.indexOf(ROOT), 1); byMint.delete(ROOT.mint); ROOT = null
        return { ok: true }
      }
      return { ok: true, action: seg[1] }
    }
    throw err(404, `no route ${p}`)
  }
  throw err(405, 'method')
}

// A tiny fake "sign": the browser never talks to a wallet in mock mode.
export async function mockSign(txB64) { await delay(900); return txB64 }
