// Holder rounds, one per PARENT pool. Each parent coin's holder pool (poolKeyFor(parent)) receives 40% of every
// child's creator fees from pump.fun directly; a round pays that SOL to the parent's holders.
//
//   open   : snapshot the parent's holders (gPA on Token-2022, memcmp mint @0, dataSlice {32,40}, NO dataSize —
//            pump ATAs are 170 bytes with ImmutableOwner)
//   close  : after ROUND_MS, snapshot again; weight = min(open, close) (a buy just before close earns nothing)
//   budget : pool balance − reserve (rent(0) + POOL_MARGIN_SOL) − the round's tx fees
//   split  : pro-rata, exact in BigInt, cap MAX_WALLET_SHARE_BPS (excess stays in the pool), ≥ MIN_PAYOUT_SOL to
//            existing accounts and ≥ rent(0) to missing ones (else skipped, stays in the pool), ≤ MAX_RECIPIENTS
//   pay    : paysol.payPoolShares in batches of 12 (intent journaled before broadcast, per-pool block)
// The close snapshot doubles as the next round's open snapshot: one getProgramAccounts per parent per window.
import { PublicKey } from '@solana/web3.js'
import { config } from './config.js'
import { roundsStore, newId, noteRoundDone, readPendingIntents } from './store.js'
import { getConnection, tokenProgramOf, balanceOf, walletKinds, sol, toLamports, rent0, rentLoaded, pk } from './solana.js'
import { foldHolders, minWeights, rankEligible, allocateRound, compactSnapshot, payableFloor } from './math.js'
import { coins, coinRec, liveOf, neverPay, noteHolders, noteRoundTimes } from './registry.js'
import { payPoolShares, resolvePendingIntents, roundFeeLamports, poolReserveLamports, lastPaidSlot } from './paysol.js'
import { isKilled } from './kill.js'
import { emitEvent } from './bus.js'

const errText = e => String(e?.message || e).slice(0, 200)
const MAX_DONE_ROUNDS = 3000
/** Only the newest KEEP_LINES settled rounds keep their payee lines; older ones keep their totals (rounds.json stays small). */
export const KEEP_LINES = 300
const DECIMALS = 6
const minTokensRaw = () => BigInt(Math.floor(config.holderMinTokens)) * 10n ** BigInt(DECIMALS)

/** Every token account of a mint → Map(owner → raw amount summed). One RPC call with a 40-byte slice per account. */
export async function snapshotHolders(mint, program = null) {
  const prog = program || await tokenProgramOf(mint)
  const accounts = await getConnection().getProgramAccounts(prog, {
    commitment: 'confirmed',
    filters: [{ memcmp: { offset: 0, bytes: String(mint) } }], // NO dataSize: Token-2022 ATAs are 170 bytes
    dataSlice: { offset: 32, length: 40 },
  })
  return foldHolders(accounts)
}

/* ---------------- round records ---------------- */

export const rounds = () => roundsStore.get().rounds
export const roundById = id => rounds().find(r => r.id === id) || null
const openRoundOf = parentMint => rounds().find(r => r.parentMint === parentMint && (r.status === 'open' || r.status === 'paying'))
/**
 * Keep rounds.json bounded (it is rewritten on every save): settled rounds beyond MAX_DONE_ROUNDS go, oldest first,
 * and only the newest KEEP_LINES settled rounds keep their payee lines — older ones keep paid totals. Open / paying
 * rounds are never touched. Mutates and returns `s`. Pure over its input.
 */
export function compactRounds(s) {
  let settled = s.rounds.filter(x => x.status === 'done' || x.status === 'skipped')
  if (settled.length > MAX_DONE_ROUNDS) { const drop = new Set(settled.slice(0, settled.length - MAX_DONE_ROUNDS).map(x => x.id)); s.rounds = s.rounds.filter(x => !drop.has(x.id)); settled = settled.filter(x => !drop.has(x.id)) }
  for (const r of settled.slice(0, Math.max(0, settled.length - KEEP_LINES))) {
    if (!r.lines?.length) continue
    const paid = r.lines.filter(l => l.status === 'paid')
    r.paidLamports = paid.reduce((a, l) => a + BigInt(l.lamports), 0n).toString()
    r.paidCount = paid.length
    r.lines = []
    r.linesDropped = true
  }
  return s
}
function saveRound(r) {
  roundsStore.update(s => {
    const i = s.rounds.findIndex(x => x.id === r.id)
    if (i >= 0) s.rounds[i] = r; else s.rounds.push(r)
    compactRounds(s)
  })
  return roundById(r.id)
}
/** API.md Round. */
export function roundView(r) {
  const p = coinRec(r.parentMint)
  const paid = (r.lines || []).filter(l => l.status === 'paid')
  const paidLamports = r.linesDropped ? BigInt(r.paidLamports || '0') : paid.reduce((a, l) => a + BigInt(l.lamports), 0n)
  return {
    id: r.id, parentMint: r.parentMint, parentSymbol: p?.symbol || r.parentSymbol || null, openedAt: r.openedAt, closedAt: r.closedAt || null,
    budgetSol: sol(BigInt(r.budgetLamports || '0')), paidSol: sol(paidLamports), wallets: r.linesDropped ? r.paidCount || 0 : paid.length,
    status: r.status, sigs: r.sigs || [], ...(r.reason ? { reason: r.reason } : {}),
  }
}
export function roundDetail(r) {
  return { ...roundView(r), lines: (r.lines || []).map(l => ({ wallet: l.wallet, weightUi: Number(BigInt(l.weight || '0')) / 10 ** DECIMALS, lamports: String(l.lamports), sig: l.sig || null, status: l.status })), ...(r.linesDropped ? { linesDropped: true } : {}) }
}

/* ---------------- one parent's round, one step ---------------- */

/**
 * The smallest budget that can pay anyone at all: each share is capped at MAX_WALLET_SHARE_BPS of the budget and must
 * reach MIN_PAYOUT_SOL, so below ceil(MIN_PAYOUT × 10000 / MAX_WALLET_SHARE_BPS) (0.02 SOL at the defaults) no holder
 * can ever be paid, however the parent is held.
 */
export const roundFloorLamports = () => payableFloor(toLamports(config.minPayoutSol), config.maxWalletShareBps)
/**
 * Is this parent worth a round? Only when its pool (as last refreshed) holds more than its reserve + a WHOLE round's
 * worst-case fees (MAX_RECIPIENTS payees — what planRound may set aside at close) + the payable floor: a pool that
 * cannot pay anyone never keeps a round open (a stored holder snapshot, two full rewrites of rounds.json and a public
 * 'round skipped' event per window, for nothing). With the same balance at close its budget is then ≥ the floor, so
 * the close pays someone or chains the next round — never open → skipped → reopen each window (one tx's fee here left
 * a band of pools that did exactly that). Fees arriving later open the next round then.
 */
export const roundOpenThreshold = () => poolReserveLamports() + roundFeeLamports(config.maxRecipients) + roundFloorLamports()
function roundWorthy(c) {
  try { return BigInt(liveOf(c.mint).poolLamports || '0') > roundOpenThreshold() } catch { return false }
}

/**
 * The accounts a round never pays, beyond the math.js rules (off-curve, reserved): engine, protocol, burn, every
 * coin's mint / coin key / pools / config / curve / AMM pool, ROOT's pool — and this pool itself.
 */
export function roundExclusions(poolWallet) { const s = neverPay(); s.add(poolWallet); return s }

/**
 * Close a round: compute the payable lines from (open, close) snapshots and the pool balance. Pure-ish over its
 * inputs (the caller reads the chain), so the whole allocation is unit-testable.
 */
export function planRound({ open, close, poolLamports, kinds, excluded, rent, minTokensRaw = BigInt(Math.floor(config.holderMinTokens)) * 10n ** BigInt(DECIMALS) }) {
  const weights = minWeights(open, close)
  const ranked = rankEligible(weights, { excluded, minTokensRaw })
  const reserve = BigInt(rent) + toLamports(config.poolMarginSol)
  const fees = roundFeeLamports(Math.min(ranked.length, config.maxRecipients))
  const budget = BigInt(poolLamports) - reserve - fees
  if (budget <= 0n || !ranked.length) return { budget: budget > 0n ? budget : 0n, items: [], leftover: budget > 0n ? budget : 0n, ranked, eligible: ranked.length }
  const alloc = allocateRound({ budget, candidates: ranked, kinds, maxShareBps: config.maxWalletShareBps, minPayout: toLamports(config.minPayoutSol), rent0: rent, maxRecipients: config.maxRecipients })
  return { budget, items: alloc.items, leftover: alloc.leftover, ranked, eligible: ranked.length }
}

const busy = new Set()
/** Advance the round of one parent as far as it can go right now. Safe to call from a timer and the admin. */
export async function roundStep(parentMint, { force = false, settle = {} } = {}) {
  if (busy.has(parentMint)) return { note: 'busy' }
  const c = coinRec(parentMint)
  if (!c || !c.holderPool) return { note: 'unknown parent' }
  busy.add(parentMint)
  try {
    const now = Date.now()
    let r = openRoundOf(parentMint)
    if (!r) {
      if (!force && !roundWorthy(c)) return { note: 'the pool holds nothing to pay yet' }
      const snap = await snapshotHolders(parentMint)
      noteHolders(parentMint, snap.size)
      // stored WITHOUT dust holders: lossless (weight = min(open, close) below the minimum is never paid)
      r = saveRound({ id: newId(8), parentMint, parentSymbol: c.symbol, pool: c.holderPool, openedAt: now, openSnapshot: compactSnapshot(snap, minTokensRaw()), status: 'open', lines: [], sigs: [] })
      noteRoundTimes(parentMint, { next: r.openedAt + config.roundMs })
      return { opened: r.id }
    }
    if (r.status === 'open') {
      if (!force && now < r.openedAt + config.roundMs) { noteRoundTimes(parentMint, { next: r.openedAt + config.roundMs }); return { note: 'window open' } }
      // a pool with an unresolved payout never starts a new split: its balance is not known yet
      if (readPendingIntents(c.holderPool).length && !(await resolvePendingIntents({ poolWallet: c.holderPool, settle }))) return { note: 'pool has an unresolved payout intent' }
      let close
      try { close = await snapshotHolders(parentMint) } catch (e) {
        if (now > r.openedAt + 2 * config.roundMs) { saveRound({ ...r, status: 'skipped', closedAt: now, reason: `holder snapshot unavailable (${errText(e)})`, openSnapshot: undefined }); return { skipped: r.id } }
        throw e
      }
      noteHolders(parentMint, close.size)
      // the budget is read at or after this pool's last landed payout: a load-balanced node still behind it would show
      // SOL the previous round already paid (an RPC error instead: the round waits for the next tick)
      const poolLamports = await balanceOf(c.holderPool, { minContextSlot: lastPaidSlot(parentMint) })
      const excluded = roundExclusions(c.holderPool)
      // account kinds for the candidates that can be paid (program-owned / executable → never; missing → rent rule)
      const pre = rankEligible(minWeights(r.openSnapshot, close), { excluded, minTokensRaw: minTokensRaw() })
      const window = pre.slice(0, config.maxRecipients + 100).map(x => x.owner)
      const kinds = window.length ? await walletKinds(window) : new Map()
      if ([...kinds.values()].some(k => k.kind == null)) throw new Error('account kinds unreadable: the round waits')
      const plan = planRound({ open: r.openSnapshot, close, poolLamports, kinds, excluded, rent: rent0() })
      const lines = plan.items.map(i => ({ wallet: i.wallet, weight: i.weight.toString(), lamports: i.lamports.toString(), sig: null, status: config.payoutsLive ? 'pending' : 'dry' }))
      let status = 'paying', reason
      if (!plan.items.length) { status = 'skipped'; reason = plan.budget <= 0n ? `pool below its reserve + fees (${sol(poolLamports).toFixed(6)} SOL)` : `no payable holder (${plan.eligible} eligible; every share below the minimum or the rent floor)` }
      else if (!config.payoutsLive) { status = 'skipped'; reason = 'PAYOUTS_LIVE is off: planned, nothing sent' }
      const closed = saveRound({ ...r, openSnapshot: undefined, closedAt: now, holdersOpen: Object.keys(r.openSnapshot || {}).length, holdersClose: close.size, eligible: plan.eligible, poolLamports: poolLamports.toString(), budgetLamports: plan.budget.toString(), leftoverLamports: plan.leftover.toString(), lines, status, reason })
      // the close snapshot is the next round's open snapshot — unless the pool could not pay anyone (its budget below
      // the payable floor): then no round stays open (and nothing is stored) until fees lift it past the floor and
      // roundWorthy opens a fresh one
      if (plan.items.length > 0 || plan.budget >= roundFloorLamports()) {
        const next = saveRound({ id: newId(8), parentMint, parentSymbol: c.symbol, pool: c.holderPool, openedAt: now, openSnapshot: compactSnapshot(close, minTokensRaw()), status: 'open', lines: [], sigs: [] })
        noteRoundTimes(parentMint, { last: now, next: next.openedAt + config.roundMs })
      } else noteRoundTimes(parentMint, { last: now, next: null })
      emitEvent({ id: `round:${closed.id}`, type: 'round', mint: parentMint, symbol: c.symbol, amountSol: sol(plan.items.reduce((a, i) => a + i.lamports, 0n)), extra: { roundId: closed.id, status, wallets: lines.length, budgetSol: sol(plan.budget), reason } })
      if (status === 'skipped') { noteRoundDone(parentMint, now); return { closed: closed.id, status, reason } }
      r = closed
    }
    if (r.status === 'paying') return await payRound(r, { settle })
    return { note: r.status }
  } catch (e) {
    console.warn(`[rounds] $${c.symbol}: ${errText(e)}`)
    return { error: errText(e) }
  } finally { busy.delete(parentMint) }
}

/** Pay a closed round's pending lines (continues after a restart, a kill/unkill or a failed batch). */
export async function payRound(r, { settle = {} } = {}) {
  const c = coinRec(r.parentMint)
  if (!config.payoutsLive) return { note: 'payouts off' }
  if (isKilled()) return { note: 'killed' }
  if (!(await resolvePendingIntents({ poolWallet: r.pool, settle }))) return { note: 'pool has an unresolved payout intent' }
  r = roundById(r.id)
  if (r.status !== 'paying') return { note: r.status }
  // a round that could not finish within two windows drops its remaining lines (the SOL stays in the pool)
  if (Date.now() > (r.closedAt || 0) + 2 * config.roundMs) {
    const lines = r.lines.map(l => (l.status === 'pending' ? { ...l, status: 'expired' } : l))
    saveRound({ ...r, lines, status: 'done', reason: 'stale: unpaid lines dropped, their SOL stays in the pool' })
    noteRoundDone(r.parentMint, Date.now())
    return { done: r.id, stale: true }
  }
  const pending = r.lines.filter(l => l.status === 'pending').map(l => ({ wallet: l.wallet, lamports: BigInt(l.lamports), weight: l.weight }))
  const res = pending.length ? await payPoolShares({ parentMint: r.parentMint, symbol: c?.symbol || r.parentSymbol, poolWallet: r.pool }, pending, { roundId: r.id, settle }) : { paid: [], halted: false }
  const now = roundById(r.id)
  if (!now.lines.some(l => l.status === 'pending')) {
    saveRound({ ...now, status: 'done' })
    noteRoundDone(r.parentMint, Date.now())
    return { done: r.id, paid: res.paid.length }
  }
  return { paying: r.id, paid: res.paid.length, halted: res.halted, reason: res.reason }
}

/** One pass over every parent (hidden ones too: money does not care about visibility). */
let ticking = false
export async function roundsTick({ settle = {} } = {}) {
  if (ticking || config.offline || !config.rpcUrl || !rentLoaded()) return
  ticking = true
  try {
    for (const c of Object.values(coins())) {
      if (isKilled()) break
      await roundStep(c.mint, { settle })
    }
  } finally { ticking = false }
}
export const holderTop = (snap, supplyRaw = 10n ** 15n, excluded = new Set()) => [...snap].filter(([o]) => !excluded.has(o)).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, 20).map(([wallet, amount]) => ({ wallet, amountUi: Number(amount) / 10 ** DECIMALS, share: Number(amount) / Number(supplyRaw) }))
export { PublicKey, pk }
