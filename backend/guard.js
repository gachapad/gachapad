// Process + HTTP guards, kept free of server state so they can be unit-tested:
// the single-instance lock, a token-bucket rate limiter, a TTL cache.
import { readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, writeSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'

/* ---------------- single-instance lock ---------------- */
// Two engines on one data dir would both pay the same queue. The lock file holds
// { pid, host, at } and the owner refreshes `at` every few seconds. A newcomer
// takes it only when it is stale, or held by a dead pid on this host; a live
// owner (fresh heartbeat, pid alive or on another host) makes the newcomer exit.
// The owner re-checks the file before every store write (lease): an engine that
// was frozen long enough to lose the lock fences itself instead of writing.

/** Pure: 'take' or 'refuse' for an existing lock record. */
export function lockDecision(existing, me, now, isAlive, staleMs = 120_000) {
  if (!existing || !existing.pid) return 'take'
  if (existing.pid === me.pid && existing.host === me.host) return 'take'
  if (!(now - (Number(existing.at) || 0) < staleMs)) return 'take'
  if (existing.host !== me.host) return 'refuse'
  return isAlive(existing.pid) ? 'refuse' : 'take'
}
export const pidAlive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }

function readLock(file) { try { return JSON.parse(readFileSync(file, 'utf-8')) } catch { return null } }
function writeLock(file, rec) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(rec))
  try { renameSync(tmp, file) } catch { try { unlinkSync(file) } catch {} renameSync(tmp, file) }
}

/**
 * Acquire the lock or return { ok: false, holder }. On success returns
 * { ok, held(), beat(), release() }: held() is true only while the file still
 * names this process; beat() refreshes the heartbeat (false if the lock was lost).
 */
export function acquireLock(file, { host, pid = process.pid, staleMs = 120_000, now = Date.now, isAlive = pidAlive } = {}) {
  if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
  const me = { pid, host }
  const startedAt = now()
  const rec = () => ({ pid, host, at: now(), startedAt })
  if (!existsSync(file)) {
    // exclusive create: of two engines starting at once, one wins here
    try { const fd = openSync(file, 'wx'); try { writeSync(fd, JSON.stringify(rec())) } finally { closeSync(fd) } } catch (e) { if (e.code !== 'EEXIST') throw e }
  }
  const cur = readLock(file)
  if (!(cur && cur.pid === pid && cur.host === host)) {
    if (lockDecision(cur, me, now(), isAlive, staleMs) === 'refuse') return { ok: false, holder: cur }
    writeLock(file, rec())
  }
  const held = () => { const c = readLock(file); return !!c && c.pid === pid && c.host === host }
  if (!held()) return { ok: false, holder: readLock(file) } // lost a takeover race
  return {
    ok: true,
    held,
    beat() { if (!held()) return false; writeLock(file, rec()); return true },
    release() { try { if (held()) unlinkSync(file) } catch {} },
  }
}

/* ---------------- data-dir identity ---------------- */
// A data dir belongs to ONE campaign: its dedupe stores and coin registry only
// mean something for the chain and engine key they were written for (every coin's
// keys are derived from that key).
// identity.json is written on the first boot; a later boot with a different
// chain or treasury refuses to start (a re-used dir from another campaign would
// re-pay or skip people); factories may only be added, never dropped.

/**
 * Pure: 'create' | 'ok' | 'update' (append new factories / a missing engine tag) | a refusal message.
 * `engine` tags the data dir with the engine FLAVOUR ('pump.fun'): the old Meteora engine used the same key and
 * chain, so chain + key alone cannot tell a DBC data dir from this one.
 */
export function identityDecision(existing, me) {
  if (!existing) return 'create'
  const low = a => String(a || '') // base58 is case-sensitive: compare exactly
  if (String(existing.chainId) !== String(me.chainId)) return `identity.json is for chain ${existing.chainId}, this engine runs on chain ${me.chainId}`
  if (existing.engine && me.engine && existing.engine !== me.engine) return `identity.json belongs to a ${existing.engine} engine, this is the ${me.engine} engine`
  if (existing.treasury && me.treasury && low(existing.treasury) !== low(me.treasury)) return `identity.json belongs to treasury ${existing.treasury}, this engine's key is ${me.treasury}`
  const had = (existing.factories || []).map(low), have = (me.factories || []).map(low)
  const missing = had.filter(f => !have.includes(f))
  if (missing.length) return `identity.json lists factories this config dropped: ${missing.join(', ')} (factories may only be appended)`
  const grew = have.some(f => !had.includes(f)) || (!existing.treasury && me.treasury) || (!existing.engine && me.engine)
  return grew ? 'update' : 'ok'
}
/** Enforce identityDecision on `file`. Throws with the refusal message. */
export function checkIdentity(file, me, { now = Date.now } = {}) {
  let existing = null
  if (existsSync(file)) {
    try { existing = JSON.parse(readFileSync(file, 'utf-8')) } catch (e) { throw new Error(`${file} is unreadable (${e.message}): restore it or move the data dir aside`) }
  }
  const d = identityDecision(existing, me)
  if (d === 'ok') return existing
  if (d !== 'create' && d !== 'update') throw new Error(`${d} — refusing to reuse ${dirname(file)}`)
  const rec = { chainId: me.chainId, treasury: me.treasury || existing?.treasury || null, factories: [...new Set([...(existing?.factories || []), ...(me.factories || [])])], ...(me.engine || existing?.engine ? { engine: me.engine || existing.engine } : {}), createdAt: existing?.createdAt || now(), updatedAt: now() }
  writeLock(file, rec) // atomic tmp+rename
  return rec
}

/* ---------------- token bucket ---------------- */

/** Pure-ish: take one token for `key` from `map` (capacity cap, refill per second). */
export function takeToken(map, key, cap, perSec, now = Date.now()) {
  let b = map.get(key)
  if (!b) { b = { t: cap, at: now }; map.set(key, b) } else { b.t = Math.min(cap, b.t + ((now - b.at) / 1000) * perSec); b.at = now }
  if (b.t < 1) return false
  b.t -= 1
  return true
}
/** Drop buckets that have refilled (idle keys), so the map can't grow forever. */
export function pruneBuckets(map, cap, perSec, now = Date.now()) {
  for (const [k, b] of map) if (b.t + ((now - b.at) / 1000) * perSec >= cap) map.delete(k)
}
/**
 * Take one token from each bucket IN ORDER, stopping at the first empty one (a refused step never spends the later
 * buckets: a wallet at its own limit cannot drain the global one). steps = [{ map, key, cap, rate, msg }].
 * Returns null, or { msg, retryAfter } for the bucket that refused.
 */
export function takeTokens(steps, now = Date.now()) {
  for (const s of steps) if (!takeToken(s.map, s.key, s.cap, s.rate, now)) return { msg: s.msg, retryAfter: retryAfter(s.map, s.key, s.rate) }
  return null
}
/** Seconds until `key` has a token again (for Retry-After). */
export function retryAfter(map, key, perSec) {
  const b = map.get(key)
  return b ? Math.max(1, Math.ceil((1 - b.t) / perSec)) : 1
}

/* ---------------- TTL cache ---------------- */
// Bounded by entries and (with `weigh`) by bytes: oldest entries go first.

export function ttlCache(max = 1000, { maxBytes = Infinity, weigh = () => 0 } = {}) {
  const m = new Map()
  let bytes = 0
  const drop = k => { const e = m.get(k); if (e) { bytes -= e.w; m.delete(k) } }
  return {
    get(key, ttlMs, compute, now = Date.now()) {
      const hit = m.get(key)
      if (hit && now - hit.at < ttlMs) return hit.v
      const v = compute()
      drop(key)
      const w = weigh(v) || 0
      m.set(key, { at: now, v, w })
      bytes += w
      while (m.size > 1 && (m.size > max || bytes > maxBytes)) drop(m.keys().next().value)
      return v
    },
    delete: drop,
    clear() { m.clear(); bytes = 0 },
    get size() { return m.size },
    get bytes() { return bytes },
  }
}
