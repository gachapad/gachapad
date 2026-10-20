// Coin logos: the engine proxies + caches every logo at GET /img/:mint (IPFS gateways flake and hot-link block).
// Bytes live under DATA_DIR/img/<mint>.<ext>. The source URL is only ever the one read from the coin's own
// metadata (or the launch form's upload), never a visitor-typed URL.
// A public GET can trigger an outbound download here (a coin whose logo is not on disk yet: an adopted ROOT / orphan),
// so every download is bounded: ONE in flight per mint (concurrent requests share it), at most MAX_FETCHES across all
// mints, never more than MAX_IMAGE bytes read (content-length checked first, then a byte counter that aborts), and an
// oversize source is remembered ON DISK (a restart must not reopen the download to the next burst of requests).
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'

const MAX_IMAGE = 4 * 1024 * 1024
const MAX_FETCHES = 2 // logo downloads in flight at once, across every mint
const OVERSIZE_TTL_MS = 7 * 86_400_000 // an oversize source is not retried for a week (persisted)
const EXTS = ['png', 'jpg', 'gif', 'webp']
const TYPES = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const dir = () => join(config.dataDir, 'img')
const failed = new Map() // mint → last failed fetch at (negative cache 10 min, memory: transient failures)
const inflight = new Map() // mint → the one download of that mint in flight
let active = 0

export const logoUrlFor = mint => `${(config.publicUrl || config.siteUrl).replace(/\/$/, '')}/img/${mint}`

/** { buf, type } of the cached logo, or null. */
export function readLogo(mint) {
  for (const ext of EXTS) { const p = join(dir(), `${mint}.${ext}`); if (existsSync(p)) return { buf: readFileSync(p), type: TYPES[ext] } }
  return null
}
export const hasLogo = mint => EXTS.some(e => existsSync(join(dir(), `${mint}.${e}`)))

const oversizeFile = mint => join(dir(), `${mint}.oversize`)
function oversizeKnown(mint) {
  try { return Date.now() - statSync(oversizeFile(mint)).mtimeMs < OVERSIZE_TTL_MS } catch { return false }
}
function noteOversize(mint) {
  try { mkdirSync(dir(), { recursive: true }); writeFileSync(oversizeFile(mint), String(Date.now())) } catch {}
}

/** Read a response body, never more than `max` bytes: { buf } or { oversize: true }. */
async function readCapped(r, max, abort) {
  const len = Number(r.headers.get('content-length'))
  if (Number.isFinite(len) && len > max) { abort(); return { oversize: true } }
  if (!r.body) return { buf: Buffer.alloc(0) }
  const chunks = []
  let n = 0
  for await (const ch of r.body) {
    n += ch.length
    if (n > max) { abort(); return { oversize: true } }
    chunks.push(Buffer.from(ch))
  }
  return { buf: Buffer.concat(chunks) }
}

async function fetchLogo(mint, url) {
  mkdirSync(dir(), { recursive: true })
  const cid = /\/ipfs\/([A-Za-z0-9]+)/.exec(url)?.[1]
  const urls = cid ? [`https://pump.mypinata.cloud/ipfs/${cid}`, url, `https://gateway.pinata.cloud/ipfs/${cid}`, `https://dweb.link/ipfs/${cid}`] : [url]
  for (const u of urls) {
    const ctl = new AbortController()
    try {
      const r = await fetch(u, { signal: AbortSignal.any([ctl.signal, AbortSignal.timeout(20_000)]), headers: { 'user-agent': `${config.brand.toLowerCase()}/1.0` } })
      const type = (r.headers.get('content-type') || '').split(';')[0].trim()
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[type]
      if (!r.ok || !ext) { ctl.abort(); continue }
      const got = await readCapped(r, MAX_IMAGE, () => ctl.abort())
      // the same content everywhere (one CID / one URL): too big at one gateway is too big at all of them
      if (got.oversize) { noteOversize(mint); break }
      if (!got.buf.length) continue
      writeFileSync(join(dir(), `${mint}.${ext}`), got.buf)
      failed.delete(mint)
      try { unlinkSync(oversizeFile(mint)) } catch {}
      return true
    } catch { ctl.abort() }
  }
  failed.set(mint, Date.now())
  if (failed.size > 5000) failed.delete(failed.keys().next().value)
  return false
}

/**
 * Fetch + cache a coin's logo once from its metadata image URL. Returns (a promise of) true when cached. Concurrent
 * calls for one mint share ONE download; beyond MAX_FETCHES downloads across mints a call answers false at once (the
 * caller serves a short-cached 404 and a later request tries again).
 */
export function cacheLogo(mint, url) {
  if (hasLogo(mint)) return Promise.resolve(true)
  const running = inflight.get(mint)
  if (running) return running
  if (!/^https?:\/\//.test(String(url || ''))) return Promise.resolve(false)
  const f = failed.get(mint)
  if (f && Date.now() - f < 600_000) return Promise.resolve(false)
  if (oversizeKnown(mint)) return Promise.resolve(false)
  if (active >= MAX_FETCHES) return Promise.resolve(false)
  active++
  const p = fetchLogo(mint, url).catch(() => false).finally(() => { active--; inflight.delete(mint) })
  inflight.set(mint, p)
  return p
}
