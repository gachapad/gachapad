// Durable JSON stores, held in memory. Each file is parsed ONCE and written through; no request parses a file.
//
// Two classes of store:
//   money   (coins, launches, prepared, state, ledger, rounds, intents, quarantine, burns): written synchronously
//           with fsync before the call returns, and the in-memory copy only changes after the write succeeded.
//           An unreadable money file refuses to load (fail closed) instead of reading as empty: an empty intent
//           journal or round store could re-pay people.
//   display (events, relays, earned): coalesced (at most every ~250 ms) and flushed on exit. An unreadable
//           display file is moved aside and starts empty.
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync } from 'fs'
import { dirname, join } from 'path'
import { randomBytes } from 'crypto'
import { config } from './config.js'

// index.js installs the single-instance lease check here: a fenced (second or resumed) engine must never write.
let writeGuard = null
export function setWriteGuard(fn) { writeGuard = fn }

export function ensureDir(d = config.dataDir) { if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 }) }
function fsyncDir(d) { try { const fd = openSync(d, 'r'); try { fsyncSync(fd) } finally { closeSync(fd) } } catch { /* not supported on Windows */ } }

// Atomic write: temp file then rename, so a crash never leaves half a JSON file. durable=true also fsyncs the
// file and its directory. Windows rename can refuse to overwrite: fall back to unlink+rename (local dev).
export function writeJsonAtomic(file, data, pretty = false, durable = false) {
  if (writeGuard) writeGuard(file)
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.tmp`
  const body = JSON.stringify(data, null, pretty ? 2 : undefined)
  if (durable) {
    const buf = Buffer.from(body)
    const fd = openSync(tmp, 'w', 0o600)
    try { let off = 0; while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off); fsyncSync(fd) } finally { closeSync(fd) }
  } else writeFileSync(tmp, body, { mode: 0o600 })
  try { renameSync(tmp, file) } catch { try { unlinkSync(file) } catch {} renameSync(tmp, file) }
  if (durable) fsyncDir(dirname(file))
}

function load(file, empty, money, valid) {
  if (!existsSync(file)) return empty()
  let data
  try { data = JSON.parse(readFileSync(file, 'utf-8')) } catch (e) { data = e }
  if (!(data instanceof Error) && valid(data)) return data
  const why = data instanceof Error ? data.message : 'unexpected shape'
  if (money) throw new Error(`${file} is unreadable (${why}). Refusing to run on a corrupt money store: restore it from backup (DEPLOY.md).`)
  const aside = `${file}.corrupt-${Date.now()}`
  try { renameSync(file, aside) } catch {}
  console.error(`[store] ${file} was unreadable (${why}); moved aside to ${aside}, starting it empty`)
  return empty()
}
export const isArr = Array.isArray
export const isObj = d => !!d && typeof d === 'object' && !Array.isArray(d)

const all = []
/**
 * A money store: get() is free; set(next) persists (fsync) THEN makes it current; update(fn) mutates a
 * structuredClone and sets it (a throw inside fn changes nothing).
 */
export function moneyStore(name, empty, valid = isObj) {
  const file = () => join(config.dataDir, `${name}.json`)
  let cache
  const s = {
    name, file,
    get() { if (cache === undefined) cache = load(file(), empty, true, valid); return cache },
    set(next) { writeJsonAtomic(file(), next, false, true); cache = next; return next },
    update(fn) { const next = structuredClone(s.get()); const r = fn(next); s.set(r === undefined ? next : r); return cache },
    reload() { cache = undefined; return s.get() },
    exists: () => existsSync(file()),
  }
  all.push(s)
  return s
}

/** A display store: coalesced writes, capped arrays. */
export function displayStore(name, empty, valid = () => true) {
  const file = () => join(config.dataDir, `${name}.json`)
  let cache
  const s = {
    name, file,
    get() { if (cache === undefined) cache = load(file(), empty, false, valid); return cache },
    touch() { markDirty(s) },
    set(v) { cache = v; markDirty(s); return v },
    reload() { cache = undefined; return s.get() },
    flush() { try { writeJsonAtomic(file(), s.get()) } catch (e) { console.error(`[store] ${name} write failed: ${e.message}`) } },
  }
  all.push(s)
  return s
}
const dirty = new Set()
let timer = null
function markDirty(s) {
  dirty.add(s)
  if (!timer) { timer = setTimeout(() => { timer = null; flushDirty() }, 250); timer.unref?.() }
}
export function flushDirty() { for (const s of [...dirty]) { dirty.delete(s); s.flush() } }
process.once('exit', () => { try { flushDirty() } catch {} })

/** Boot: parse every store once. Throws on a corrupt money store (fail closed). */
export function loadAllStores() { for (const s of all) s.get() }

export const newId = (n = 8) => randomBytes(n).toString('hex')

/* ---------------- the stores ---------------- */

export const stateStore = moneyStore('state', () => ({ rootMint: '', killed: false }))
export const coinsStore = moneyStore('coins', () => ({}))          // { [mint]: coin record } — the registry
export const launchesStore = moneyStore('launches', () => ({}))    // { [id]: launch journal }
export const preparedStore = moneyStore('prepared', () => ({}))    // { [id]: prepared record, NO secrets }
export const ledgerStore = moneyStore('ledger', () => ({ byPool: {}, byMint: {}, consumed: [], gasSpentLamports: '0' }))
export const roundsStore = moneyStore('rounds', () => ({ rounds: [] }))
export const intentsStore = moneyStore('pending-intents', () => [], isArr)
export const quarantineStore = moneyStore('quarantine', () => [], isArr)
export const burnsStore = moneyStore('burns', () => ({ pending: null, done: [], totalBurnedRaw: '0', totalSpentLamports: '0' }))
export const eventsStore = displayStore('events', () => [], isArr)
export const relaysStore = displayStore('relays', () => [], isArr)
export const earnedStore = displayStore('earned', () => ({}), isObj)   // { [wallet]: { lamports, rows: [...] } }

export function readState() { return stateStore.get() }
export function patchState(p) { return stateStore.update(s => ({ ...s, ...p, updatedAt: Date.now() })) }

/* ---------------- the payout ledger (money, monotonic) ---------------- */
// A pool IS its wallet's balance (chain truth): nothing is credited here. The ledger counts what LEFT each pool
// (per parent mint) and what reached each coin's shareholders (measured distribute deltas). `consumed` makes a
// booking idempotent per key (sig:wallet / dist:sig), so recovery can safely redo it.

const blankPool = () => ({ paidLamports: '0', paidCount: 0, quarantinedLamports: '0', quarantinedCount: 0, rounds: 0, lastRoundAt: 0 })
const blankMint = () => ({ distributedLamports: '0', toParentLamports: '0', toLauncherLamports: '0', toBurnLamports: '0', toProtocolLamports: '0', sweptLamports: '0', cranks: 0 })
const addStr = (a, b) => (BigInt(a || '0') + BigInt(b || 0)).toString()

export function poolLedger(parentMint) { return { ...blankPool(), ...(ledgerStore.get().byPool[String(parentMint)] || {}) } }
export function mintLedger(mint) { return { ...blankMint(), ...(ledgerStore.get().byMint[String(mint)] || {}) } }
export function isConsumed(key) { return ledgerStore.get().consumed.includes(key) }

/** Book one paid (or quarantined) holder payout. Idempotent per key. */
export function bookPayout(parentMint, lamports, key, opts = {}) {
  return bookPayouts(parentMint, [{ lamports, key }], opts) === 1
}
/**
 * Book every payee of ONE payout tx in ONE durable ledger write (a batch of 12 was 12 full rewrites). Idempotent per
 * key: an already-booked key (and a duplicate inside the batch) is skipped. Returns how many were booked.
 * `slot`: where a confirmed payout landed → the pool's `lastPaidSlot` (never lowered), so its next balance reads are
 * answered at or after it (paysol.lastPaidSlot).
 */
export function bookPayouts(parentMint, entries, { quarantined = false, slot = null } = {}) {
  if (!parentMint) return 0
  const seen = new Set(ledgerStore.get().consumed)
  const todo = []
  for (const e of entries || []) {
    const l = BigInt(e.lamports)
    if (l <= 0n || !e.key || seen.has(e.key)) continue
    seen.add(e.key); todo.push({ l, key: e.key })
  }
  if (!todo.length) return 0
  ledgerStore.update(s => {
    const p = (s.byPool[parentMint] = { ...blankPool(), ...(s.byPool[parentMint] || {}) })
    for (const { l, key } of todo) {
      if (quarantined) { p.quarantinedLamports = addStr(p.quarantinedLamports, l); p.quarantinedCount += 1 } else { p.paidLamports = addStr(p.paidLamports, l); p.paidCount += 1 }
      s.consumed.push(key)
    }
    if (!quarantined && Number(slot) > 0) p.lastPaidSlot = Math.max(Number(p.lastPaidSlot) || 0, Number(slot))
    if (s.consumed.length > 50_000) s.consumed.splice(0, s.consumed.length - 50_000)
  })
  return todo.length
}
/** Book a MEASURED distribution (per-role lamport deltas read from the confirmed tx). Idempotent per sig. */
export function bookDistribution(mint, sig, d) {
  const key = `dist:${sig}`
  if (!mint || !sig || isConsumed(key)) return false
  const total = ['toParent', 'toLauncher', 'toBurn', 'toProtocol'].reduce((a, k) => a + BigInt(d[k] || 0), 0n)
  if (total <= 0n) return false // nothing moved: nothing booked (never an estimate)
  ledgerStore.update(s => {
    const e = (s.byMint[mint] = { ...blankMint(), ...(s.byMint[mint] || {}) })
    e.distributedLamports = addStr(e.distributedLamports, total)
    e.toParentLamports = addStr(e.toParentLamports, d.toParent || 0)
    e.toLauncherLamports = addStr(e.toLauncherLamports, d.toLauncher || 0)
    e.toBurnLamports = addStr(e.toBurnLamports, d.toBurn || 0)
    e.toProtocolLamports = addStr(e.toProtocolLamports, d.toProtocol || 0)
    e.cranks += 1
    s.consumed.push(key)
  })
  return true
}
export function bookSweep(mint, lamports) {
  const l = BigInt(lamports)
  if (l <= 0n) return
  ledgerStore.update(s => { const e = (s.byMint[mint] = { ...blankMint(), ...(s.byMint[mint] || {}) }); e.sweptLamports = addStr(e.sweptLamports, l) })
}
export function noteRoundDone(parentMint, at) {
  ledgerStore.update(s => { const e = (s.byPool[parentMint] = { ...blankPool(), ...(s.byPool[parentMint] || {}) }); e.rounds += 1; e.lastRoundAt = at })
}
export function addGasSpent(lamports) { const l = BigInt(lamports); if (l > 0n) ledgerStore.update(s => { s.gasSpentLamports = addStr(s.gasSpentLamports, l) }) }

/* ---------------- quarantine: payouts whose on-chain fate is UNCERTAIN (money) ---------------- */

export function readQuarantine() { return quarantineStore.get() }
/** Append once per key (sig:wallet). */
export function appendQuarantine(entry) { return appendQuarantineMany([entry]) === 1 }
/** Append many entries (once per key) in ONE durable write. Returns how many were added. */
export function appendQuarantineMany(entries) {
  const have = new Set(quarantineStore.get().map(q => q.key).filter(Boolean))
  const add = []
  for (const e of entries || []) { if (e.key && have.has(e.key)) continue; if (e.key) have.add(e.key); add.push(e) }
  if (add.length) quarantineStore.update(list => { list.push(...add) })
  return add.length
}

/* ---------------- pre-send intent journal (money, NEVER capped) ---------------- */
// Written AFTER signing but BEFORE the first broadcast of every payout tx, so a tx that reaches the chain while
// the process dies is decided from the chain at boot instead of silently re-paying. Keyed by signature.

export function readPendingIntents(poolWallet = null) { const l = intentsStore.get(); return poolWallet ? l.filter(it => it.from === poolWallet) : [...l] }
export function appendPendingIntent(entry) { intentsStore.update(list => { list.push(entry) }) }
export function removePendingIntent(sig) {
  if (!intentsStore.get().some(it => it.sig === sig)) return
  intentsStore.set(intentsStore.get().filter(it => it.sig !== sig))
}

/* ---------------- events + earned (display) ---------------- */

const MAX_EVENTS = 5000
export function appendEvent(ev) {
  const rec = { id: ev.id || newId(6), at: ev.at || Date.now(), ...ev }
  const list = eventsStore.get()
  if (ev.id && list.some(e => e.id === ev.id)) return null
  list.push(rec)
  if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS)
  eventsStore.touch()
  return rec
}
/*
 * earned.json is BOUNDED (it is rewritten whole after every payout batch): per wallet the last MAX_EARNED_ROWS slim
 * rows (no repeated `key`: the wallet is the map key, the sig identifies the row) + lifetime totals per parent
 * (byParent); at most MAX_EARNED_WALLETS wallets, the least recently paid evicted first (the object's key order is
 * the recency order: a paid wallet is moved to the end). `_meta.evicted` counts evicted wallets for holders-paid.
 */
export const MAX_EARNED_ROWS = 20
export const MAX_EARNED_WALLETS = 5000
const EARNED_META = '_meta' // not base58: never a wallet
let earnedCount = { ref: null, n: 0 }
export function noteEarned(wallet, row) {
  const e = earnedStore.get()
  if (earnedCount.ref !== e) earnedCount = { ref: e, n: Object.keys(e).filter(k => k !== EARNED_META).length }
  let w = e[wallet]
  if (w && w.rows.some(r => (row.sig && r.sig === row.sig) || (row.key && r.key === row.key))) return // replayed booking
  const { key, ...slim } = row
  if (!w) { w = { lamports: '0', rows: [] }; earnedCount.n++ }
  if (!w.byParent) { w.byParent = {}; for (const r of w.rows) if (r.parentMint) w.byParent[r.parentMint] = addStr(w.byParent[r.parentMint], r.lamports || 0) } // older rows
  w.lamports = addStr(w.lamports, slim.lamports || 0)
  if (slim.parentMint) w.byParent[slim.parentMint] = addStr(w.byParent[slim.parentMint], slim.lamports || 0)
  w.rows = w.rows.map(({ key: _k, ...r }) => r)
  w.rows.push(slim); if (w.rows.length > MAX_EARNED_ROWS) w.rows.splice(0, w.rows.length - MAX_EARNED_ROWS)
  w.lastAt = slim.at || Date.now()
  delete e[wallet]; e[wallet] = w // most recently paid last
  for (const k in e) {
    if (earnedCount.n <= MAX_EARNED_WALLETS) break
    if (k === EARNED_META || k === wallet) continue
    delete e[k]; earnedCount.n--
    e[EARNED_META] = { ...(e[EARNED_META] || {}), evicted: (e[EARNED_META]?.evicted || 0) + 1 }
  }
  earnedStore.touch()
}
/** Wallets ever paid by a parent `isVisibleParent` accepts: the retained ones + every evicted one. */
export function holdersPaidCount(isVisibleParent) {
  const e = earnedStore.get()
  let n = 0
  for (const [k, w] of Object.entries(e)) {
    if (k === EARNED_META) continue
    if (Object.keys(w.byParent || {}).some(isVisibleParent) || (w.rows || []).some(r => isVisibleParent(r.parentMint))) n++
  }
  return n + (e[EARNED_META]?.evicted || 0)
}
/** A wallet's lifetime holder earnings from the parents `isVisibleParent` accepts (lamports, BigInt). */
export function earnedLamports(wallet, isVisibleParent) {
  const w = earnedStore.get()[wallet]
  if (!w) return 0n
  if (w.byParent) return Object.entries(w.byParent).filter(([m]) => isVisibleParent(m)).reduce((s, [, l]) => s + BigInt(l), 0n)
  return (w.rows || []).filter(r => isVisibleParent(r.parentMint)).reduce((s, r) => s + BigInt(r.lamports), 0n)
}
