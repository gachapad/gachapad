// The engine is the ONLY data source (API.md). This is the fetch wrapper, a micro-cache, the polling
// hooks every page uses, and the live event channel (SSE with a polling fallback).
import { useState, useEffect, useRef, useCallback } from 'react'
import { API_URL, MOCK } from './config'

const friendly = (message, extra) => Object.assign(new Error(message), { shortMessage: message }, extra)
const cache = new Map() // GET micro-cache: path → { at, data }
const inflight = new Map()
const TTL = 2_000

let mock = null
const loadMock = async () => mock || (mock = await import('./mock.js'))

/** fetch wrapper. GETs are micro-cached 2 s and de-duplicated; errors carry .status and a human .shortMessage. */
export async function api(path, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase()
  if (MOCK) {
    const m = await loadMock()
    try { return await m.handle(method, path, opts.body ? JSON.parse(opts.body) : null, opts.headers || {}) } catch (e) { throw friendly(e.message, { status: e.status || 500 }) }
  }
  if (method === 'GET' && !opts.fresh) {
    const hit = cache.get(path)
    if (hit && Date.now() - hit.at < TTL) return hit.data
    if (inflight.has(path)) return inflight.get(path)
  }
  const run = (async () => {
    let r
    try {
      r = await fetch(`${API_URL}${path}`, {
        method,
        headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
        body: opts.body,
        cache: 'no-store',
        signal: opts.signal || (typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(opts.timeout || (method === 'GET' ? 12_000 : 90_000)) : undefined),
      })
    } catch (e) {
      throw friendly('Could not reach the engine. Check your connection and try again.', { network: true, cause: e })
    }
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw friendly(j.error || `Request failed (${r.status})`, { status: r.status, body: j })
    if (method === 'GET') cache.set(path, { at: Date.now(), data: j })
    return j
  })()
  if (method === 'GET') { inflight.set(path, run); run.finally(() => inflight.delete(path)).catch(() => {}) } // the derived promise must not surface as "Uncaught (in promise)"; callers still get the rejection from `run`
  return run
}
export const post = (path, body, headers) => api(path, { method: 'POST', body: JSON.stringify(body || {}), headers })
export const bust = () => cache.clear()

/** mint → symbol, learned from every coin the site has seen (feed rows only carry parentMint). */
export const symbolOf = new Map()
const learn = d => {
  if (!d || typeof d !== 'object') return
  const add = c => { if (c?.mint && c?.symbol) symbolOf.set(c.mint, c.symbol) }
  if (Array.isArray(d.nodes)) d.nodes.forEach(add)
  if (Array.isArray(d.items)) d.items.forEach(add)
  if (Array.isArray(d.launched)) d.launched.forEach(add)
  if (d.coin) { add(d.coin); (d.parents || []).forEach(add); (d.kids || []).forEach(add) }
  if (d.root) add(d.root)
}

/* ---------------- polling hook ---------------- */

/** GET `path` now and every `every` ms while the tab is visible. `path` null → idle. */
export function useApi(path, { every = 0, keep = true } = {}) {
  const [state, set] = useState({ data: null, err: null, loading: !!path, path })
  const alive = useRef(true)
  const load = useCallback(async (fresh = false) => {
    if (!path) return
    try {
      const data = await api(path, { fresh })
      learn(data)
      if (alive.current) set(s => ({ data, err: null, loading: false, path }))
    } catch (e) {
      if (alive.current) set(s => ({ data: keep ? s.data : null, err: e.shortMessage || e.message, loading: false, path }))
    }
  }, [path, keep])
  useEffect(() => {
    alive.current = true
    if (!path) { set({ data: null, err: null, loading: false, path }); return }
    set(s => ({ ...s, loading: s.path !== path || s.data == null, err: null, path }))
    load()
    if (!every) return () => { alive.current = false }
    const id = setInterval(() => { if (!document.hidden) load(true) }, every)
    const onVis = () => { if (!document.hidden) load(true) }
    document.addEventListener('visibilitychange', onVis)
    return () => { alive.current = false; clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [path, every, load])
  const reload = useCallback(() => load(true), [load])
  return { data: state.path === path ? state.data : null, err: state.err, loading: state.loading, reload }
}

export const useStats = () => useApi('/stats', { every: 10_000 })
export const useTree = () => useApi('/tree', { every: 15_000 })
export const useFeed = (limit = 50, type = '') => useApi(`/feed?limit=${limit}${type ? `&type=${type}` : ''}`, { every: 6_000 })
export const useCoin = mint => useApi(mint ? `/coin/${encodeURIComponent(mint)}` : null, { every: 8_000 })
export const useHealth = () => useApi('/health', { every: 20_000 })
export const useLaunchMeta = () => useApi('/launch-meta', { every: 30_000 })
export function useCoins({ sort = 'new', filter = 'all', parent = '', q = '', offset = 0, limit = 50 } = {}, every = 15_000) {
  const qs = new URLSearchParams({ sort, filter, ...(parent ? { parent } : {}), ...(q ? { q } : {}), offset: String(offset), limit: String(limit) })
  return useApi(`/coins?${qs}`, { every })
}

/* ---------------- live events: SSE, else the 6 s /feed poll carries on ---------------- */

/** Subscribe to engine events. Returns 'live' | 'polling'. onEvent gets Event objects (API.md). */
export function useLive(onEvent) {
  const [mode, setMode] = useState('polling')
  const cb = useRef(onEvent); cb.current = onEvent
  useEffect(() => {
    let off = () => {}
    if (MOCK) {
      loadMock().then(m => { off = m.subscribe(e => cb.current?.(e)); setMode('live') })
      return () => off()
    }
    let es = null, errors = 0, retry = null, dead = false
    const close = () => { if (es) { es.close(); es = null } }
    const open = () => {
      if (dead || es || document.hidden) return
      errors = 0
      try { es = new EventSource(`${API_URL}/events`) } catch { setMode('polling'); return }
      es.onopen = () => { errors = 0; setMode('live') }
      es.onerror = () => { errors++; if (es && (es.readyState === EventSource.CLOSED || errors >= 3)) { close(); setMode('polling'); retry = setTimeout(open, 120_000) } }
      const on = ev => { let e; try { e = JSON.parse(ev.data) } catch { return } if (e && e.type) cb.current?.(e) }
      es.onmessage = on
      for (const t of ['launch', 'lock', 'distribute', 'round', 'payout', 'burn', 'graduate', 'trade', 'event', 'rip', 'stock', 'pull', 'pull-burn', 'pull-freeze', 'pull-draw', 'pull-delivered']) es.addEventListener(t, on)
    }
    const onVis = () => { if (document.hidden) close(); else open() }
    open()
    document.addEventListener('visibilitychange', onVis)
    return () => { dead = true; close(); clearTimeout(retry); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  return mode
}

/** Logo URL for a coin: the engine's cached proxy, the mock's colour tile, or nothing (ticker tile). */
export function logoUrl(c) {
  if (!c) return null
  if (c.logo && /^data:image\//.test(c.logo)) return c.logo
  if (c.logo && c.logo.startsWith('mock://')) return c.logo
  if (c.logo && c.mint) return `${API_URL}/img/${c.mint}`
  return c.logo || null
}

/* ---------------- machines + burn pulls ---------------- */
export const useMachines = () => useApi('/machines', { every: 60_000 })
export const useMachine = mint => useApi(mint ? `/machine/${encodeURIComponent(mint)}` : null, { every: 6_000 })
export const useBurnPulls = ({ mint = '', wallet = '', limit = 40 } = {}, every = 8_000) => {
  const qs = new URLSearchParams({ limit: String(limit), ...(mint ? { mint } : {}), ...(wallet ? { wallet } : {}) })
  return useApi(`/burn-pulls?${qs}`, { every })
}
