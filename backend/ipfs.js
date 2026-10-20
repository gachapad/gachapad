// Token metadata. The logo arrives as a data URL from the launch form (≤ 4 MB); the JSON carries the coin's
// PARENT pinned at prepare (`gachapad: { parent, level }`), so a launch broadcast without submit — or across a
// restart — is still adopted under the right parent (math.js parentFromMetadata).
// Image: Pinata (PINATA_JWT) → pump.fun's keyless uploader → self-hosted. JSON: Pinata → self-hosted at
// META_BASE_URL (default SITE_URL)/m/<mint>.json (pump.fun's uploader builds its own JSON and cannot carry the pin,
// so it is only used for the image). The URI must stay ≤ 200 bytes (create_v2 6045 UriTooLong).
// create_v2 metadata is IMMUTABLE: a self-hosted URI must name an origin you OWN (the site rewrites /m/* to the
// engine), never the engine's IP-encoded host — a box / IP move is then a DNS or rewrite change, not a dead URI.
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync } from 'fs'
import { join } from 'path'
import { config } from './config.js'

const PIN_FILE = 'https://api.pinata.cloud/pinning/pinFileToIPFS'
const PIN_JSON = 'https://api.pinata.cloud/pinning/pinJSONToIPFS'
const GATEWAY = 'https://ipfs.io/ipfs/'
export const MAX_IMAGE = 4 * 1024 * 1024
const T = ms => AbortSignal.timeout(ms)
const site = () => config.siteUrl.replace(/\/$/, '')
const base = () => (config.publicUrl || config.siteUrl).replace(/\/$/, '') // the engine's own origin (logos for the site)
/** Where self-hosted metadata (JSON + image) lives: META_BASE_URL, else SITE_URL (an owned domain), else PUBLIC_URL. */
export const metaBase = () => (config.metaBaseUrl || config.siteUrl || config.publicUrl).replace(/\/$/, '')
const pad = () => config.brand.toLowerCase()

const IP_DNS = /(^|\.)(sslip\.io|nip\.io|xip\.io|traefik\.me|localtest\.me)$/i
/** A host bound to one box / IP (sslip.io, nip.io, a raw IPv4/IPv6, localhost): never durable. Pure. */
export function isEphemeralHost(url) {
  let h
  try { h = new URL(String(url)).hostname } catch { return true }
  if (!h || h === 'localhost' || h.endsWith('.localhost')) return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || h.startsWith('[')) return true
  return IP_DNS.test(h)
}
/** Why a launch's PERMANENT metadata URI would not be durable (no IPFS pinning and an IP-bound metadata host), or null. */
export function metadataHostProblem() {
  if (config.pinataJwt) return null
  const b = metaBase()
  return isEphemeralHost(b) ? `launches are paused: coin metadata would be self-hosted on ${b}, a host bound to one box/IP, and the on-chain URI is permanent — set PINATA_JWT, or point SITE_URL (or META_BASE_URL) at a domain you own` : null
}

/** Parse a data URL from the browser into { buf, type, ext }. null when it is not an image data URL. Throws when too big. */
export function parseImage(dataUrl) {
  const m = /^data:(image\/(png|jpe?g|gif|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''))
  if (!m) return null
  const buf = Buffer.from(m[3].replace(/\s+/g, ''), 'base64')
  if (!buf.length || buf.length > MAX_IMAGE) throw new Error('image too large (max 4 MB)')
  const ext = m[2].replace('jpeg', 'jpg')
  // sniff the magic bytes: the declared type must be the real one
  const magic = { png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], gif: [0x47, 0x49, 0x46], webp: [0x52, 0x49, 0x46, 0x46] }[ext]
  if (!magic.every((b, i) => buf[i] === b)) throw new Error('the image bytes do not match its type')
  return { buf, type: m[1].replace('image/jpg', 'image/jpeg'), ext }
}

async function pinataFile(img, name) {
  const fd = new FormData()
  fd.append('file', new Blob([img.buf], { type: img.type }), `${name}.${img.ext}`)
  fd.append('pinataMetadata', JSON.stringify({ name: `${pad()}-${name}` }))
  const r = await fetch(PIN_FILE, { method: 'POST', headers: { Authorization: `Bearer ${config.pinataJwt}` }, body: fd, signal: T(60_000) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.IpfsHash) throw new Error(`pinata file ${r.status}`)
  return `${GATEWAY}${j.IpfsHash}`
}
async function pinataJson(json, name) {
  const r = await fetch(PIN_JSON, { method: 'POST', headers: { Authorization: `Bearer ${config.pinataJwt}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ pinataContent: json, pinataMetadata: { name: `${pad()}-${name}.json` } }), signal: T(30_000) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.IpfsHash) throw new Error(`pinata json ${r.status}`)
  return `${GATEWAY}${j.IpfsHash}`
}
/** pump.fun's own uploader (what its site uses): keyless, may be bot-gated from a server. Returns the image URL. */
async function pumpImage({ name, symbol, description, img }) {
  const fd = new FormData()
  fd.append('file', new Blob([img.buf], { type: img.type }), `logo.${img.ext}`)
  fd.append('name', name); fd.append('symbol', symbol); fd.append('description', description || ''); fd.append('showName', 'true')
  const r = await fetch('https://pump.fun/api/ipfs', { method: 'POST', body: fd, signal: T(60_000) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.metadata?.image) throw new Error(`pump.fun ipfs ${r.status}`)
  return j.metadata.image
}

/** The metadata JSON, with the parent pinned. Pure. */
export function metaJson({ name, symbol, description, twitter, website, telegram, mint, image, parent, level, launcher, machine = null }) {
  return {
    name, symbol, description: description || '', image: image || '', showName: true, createdOn: site(),
    twitter: twitter || undefined, website: website || undefined, telegram: telegram || undefined,
    ca: mint, launchpad: pad(), gachapad: { parent: parent || null, level, launcher: launcher || null, machine: machine || null },
  }
}
function selfHostImage(mint, img) {
  mkdirSync(join(config.dataDir, 'meta'), { recursive: true })
  writeFileSync(join(config.dataDir, 'meta', `${mint}.${img.ext}`), img.buf)
  return `${metaBase()}/m/${mint}.${img.ext}`
}
function selfHostJson(mint, json) {
  mkdirSync(join(config.dataDir, 'meta'), { recursive: true })
  writeFileSync(join(config.dataDir, 'meta', `${mint}.json`), JSON.stringify(json))
  return `${metaBase()}/m/${mint}.json`
}

/** Build + pin the metadata for a launch. Returns { uri, image }. `offline` never touches the network. */
export async function pinMetadata(p, { offline = config.metaSelfHost } = {}) {
  let image = ''
  if (p.img && !offline) {
    if (config.pinataJwt) { try { image = await pinataFile(p.img, p.symbol.toLowerCase()) } catch (e) { console.warn(`[ipfs] pinata image failed: ${e.message}`) } }
    if (!image) { try { image = await pumpImage(p) } catch (e) { console.warn(`[ipfs] pump.fun uploader failed: ${e.message}`) } }
  }
  if (!image && p.img) image = selfHostImage(p.mint, p.img)
  const json = metaJson({ ...p, image })
  if (config.pinataJwt && !offline) {
    try { return { uri: await pinataJson(json, `${p.symbol.toLowerCase()}-${String(p.mint).slice(0, 6)}`), image } } catch (e) { console.warn(`[ipfs] pinata json failed, self-hosting: ${e.message}`) }
  }
  return { uri: selfHostJson(p.mint, json), image }
}

/** Keep an uploaded logo's bytes under DATA_DIR/img right away (no network), so /img/<mint> works at once. */
export function storeImage(mint, img) {
  if (!img) return null
  mkdirSync(join(config.dataDir, 'img'), { recursive: true })
  writeFileSync(join(config.dataDir, 'img', `${mint}.${img.ext}`), img.buf)
  return `${base()}/img/${mint}`
}
/**
 * Remove what a prepare wrote to disk for a mint that never launched (image + self-hosted metadata): anonymous
 * prepare calls could otherwise fill the disk until journals cannot be written. Returns the number removed.
 */
export function discardPreparedFiles(mint) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(mint || ''))) return 0
  let n = 0
  for (const p of [...['png', 'jpg', 'gif', 'webp'].map(e => join(config.dataDir, 'img', `${mint}.${e}`)), ...['png', 'jpg', 'gif', 'webp', 'json'].map(e => join(config.dataDir, 'meta', `${mint}.${e}`))]) {
    try { if (existsSync(p)) { unlinkSync(p); n++ } } catch {}
  }
  return n
}

/** Fetch an off-chain metadata JSON (orphan adoption, ROOT adopt). Our own self-hosted file is read from disk. null on failure. */
export async function fetchMetadata(uri, mint = null) {
  const s = String(uri || '')
  if (!/^https?:\/\//.test(s)) return null
  // our own self-hosted JSON (path /m/<mint>.json) is read from disk WHATEVER host the permanent URI names: the box,
  // its IP or PUBLIC_URL may have moved since the launch, and the file on disk is ours for exactly this mint
  if (mint) { try { if (new URL(s).pathname === `/m/${mint}.json`) return JSON.parse(readFileSync(join(config.dataDir, 'meta', `${mint}.json`), 'utf-8')) } catch {} }
  const cid = /\/ipfs\/([A-Za-z0-9]+)/.exec(s)?.[1]
  const urls = cid ? [s, `https://pump.mypinata.cloud/ipfs/${cid}`, `https://gateway.pinata.cloud/ipfs/${cid}`, `https://dweb.link/ipfs/${cid}`] : [s]
  for (const u of urls) {
    try { const r = await fetch(u, { signal: T(10_000), headers: { 'user-agent': `${pad()}/1.0` } }); if (r.ok) return await r.json() } catch {}
  }
  return null
}
