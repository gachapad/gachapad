// Browser wallet (Solana): injected providers (Phantom / Solflare / Backpack) + Wallet Standard.
// Wallet connect + signing (proven in production). Only signing happens here; the engine builds
// and relays every transaction. @solana/web3.js is loaded on demand (sign only), so reads never download it.
import bs58 from 'bs58'
import { BRAND, MOCK } from './config'

const friendly = (message, extra) => Object.assign(new Error(message), { shortMessage: message }, extra)
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
export const isAddress = a => typeof a === 'string' && B58.test(a)

export const toB64 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }
export const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0))

/* ---------------- which wallet: injected providers first, Wallet Standard for the rest ---------------- */

const PICK_KEY = 'gachapad-wallet'
const standard = []
let active = null

function adaptStandard(w) {
  let acct = null
  const pick = accounts => (accounts || []).find(a => (a.chains || []).some(c => String(c).startsWith('solana:'))) || (accounts || [])[0] || null
  const pk = () => (acct ? { toString: () => acct.address } : null)
  return {
    isStandard: true,
    get publicKey() { return pk() },
    get isConnected() { return !!acct },
    async connect(opts) {
      const r = await w.features['standard:connect'].connect(opts?.onlyIfTrusted ? { silent: true } : undefined)
      acct = pick(r?.accounts?.length ? r.accounts : w.accounts)
      if (!acct) throw friendly('The wallet did not share an account.')
      return { publicKey: pk() }
    },
    async disconnect() { try { await w.features['standard:disconnect']?.disconnect() } catch {} acct = null },
    async signMessage(bytes) {
      const [r] = await w.features['solana:signMessage'].signMessage({ account: acct, message: bytes })
      return { signature: r.signature }
    },
    async signTransaction(tx) {
      const [r] = await w.features['solana:signTransaction'].signTransaction({ account: acct, transaction: tx.serialize(), chain: 'solana:mainnet' })
      return r.signedTransaction
    },
    on(ev, cb) {
      if (ev !== 'accountChanged' || !w.features['standard:events']) return () => {}
      return w.features['standard:events'].on('change', ({ accounts }) => { if (accounts) { acct = pick(accounts); cb(pk()) } })
    },
  }
}

if (typeof window !== 'undefined') {
  const register = (...wallets) => {
    for (const w of wallets) {
      const f = w?.features || {}
      if (!f['standard:connect'] || !f['solana:signTransaction'] || !f['solana:signMessage']) continue
      if (standard.some(x => x.info.name === w.name)) continue
      standard.push({ info: { id: `std:${w.name}`, name: w.name, icon: w.icon || '' }, provider: adaptStandard(w) })
    }
    return () => {}
  }
  try {
    window.addEventListener('wallet-standard:register-wallet', e => { try { e.detail?.({ register }) } catch {} })
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register } }))
  } catch {}
}

/** Wallets in this browser: [{ info: { id, name, icon }, provider }]. Injected providers win over their Standard twin. */
export function providers() {
  if (typeof window === 'undefined') return []
  const out = []
  const add = (id, name, p) => { if (p && typeof p.connect === 'function' && !out.some(x => x.provider === p)) out.push({ info: { id, name, icon: standard.find(s => s.info.name === name)?.info.icon || '' }, provider: p }) }
  add('phantom', 'Phantom', window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null))
  add('solflare', 'Solflare', window.solflare?.isSolflare ? window.solflare : null)
  add('backpack', 'Backpack', window.backpack?.solana || (window.backpack?.connect ? window.backpack : null))
  if (window.solana && !window.solana.isPhantom) add('injected', 'Browser wallet', window.solana)
  for (const s of standard) if (!out.some(x => x.info.name === s.info.name)) out.push(s)
  return out
}

export function hasWallet() { return providers().length > 0 }
export function isTouch() { return typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches }

/** No wallet here: deep links that reopen this page inside a wallet app on phones, installs on desktop. */
export function walletLinks() {
  if (typeof window === 'undefined') return []
  const url = encodeURIComponent(window.location.href), ref = encodeURIComponent(window.location.origin)
  if (isTouch()) return [
    { name: 'Phantom', label: 'Open in Phantom', href: `https://phantom.app/ul/browse/${url}?ref=${ref}` },
    { name: 'Solflare', label: 'Open in Solflare', href: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` },
  ]
  return [
    { name: 'Phantom', label: 'Install Phantom', href: 'https://phantom.com/download', external: true },
    { name: 'Solflare', label: 'Install Solflare', href: 'https://solflare.com/download', external: true },
  ]
}

const noWallet = () => isTouch()
  ? `No wallet in this browser. Open ${BRAND.name} inside your wallet app (Phantom or Solflare).`
  : 'No Solana wallet found. Install Phantom, Solflare or Backpack.'

const remembered = () => { try { return localStorage.getItem(PICK_KEY) || '' } catch { return '' } }
const remember = id => { try { id ? localStorage.setItem(PICK_KEY, id) : localStorage.removeItem(PICK_KEY) } catch {} }

function quietProvider() {
  const list = providers()
  const hit = list.find(p => p.info.id === remembered())
  if (hit) return hit.provider
  return list.length === 1 ? list[0].provider : null
}
function provider() {
  const p = active || quietProvider()
  if (!p) throw friendly(providers().length > 1 ? 'Choose a wallet first.' : noWallet())
  return p
}
const keyOf = (p, r) => { const k = r?.publicKey || p.publicKey; return k ? k.toString() : '' }

/** Small modal list of the wallets found (styled by .wpick in index.css). Resolves the chosen one. */
function pickWallet(list) {
  return new Promise((resolve, reject) => {
    const dlg = document.createElement('dialog')
    if (typeof dlg.showModal !== 'function') return resolve(list[0])
    dlg.className = 'wpick'
    dlg.setAttribute('aria-labelledby', 'wpick-title')
    const panel = document.createElement('div')
    panel.className = 'wpick-panel'
    const title = document.createElement('h2')
    title.id = 'wpick-title'
    title.textContent = 'Choose a wallet'
    const note = document.createElement('p')
    note.textContent = `More than one wallet is installed. ${BRAND.name} remembers the one you pick.`
    const rows = document.createElement('div')
    rows.className = 'wpick-list'
    let chosen = null
    for (const w of list) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'wpick-opt'
      const icon = /^data:image\/(png|jpeg|gif|webp|svg\+xml)[;,]/i.test(w.info.icon || '')
        ? Object.assign(document.createElement('img'), { src: w.info.icon, alt: '' })
        : document.createElement('i')
      const name = document.createElement('span')
      name.textContent = w.info.name || w.info.id
      b.append(icon, name)
      b.addEventListener('click', () => { chosen = w; dlg.close() })
      rows.append(b)
    }
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'btn ghost'
    cancel.textContent = 'Cancel'
    cancel.addEventListener('click', () => dlg.close())
    panel.append(title, note, rows, cancel)
    dlg.append(panel)
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close() })
    dlg.addEventListener('close', () => { dlg.remove(); chosen ? resolve(chosen) : reject(friendly('No wallet chosen.')) })
    document.body.append(dlg)
    dlg.showModal()
  })
}

// Mock mode with no extension: a demo account so every flow is clickable.
let demoAccount = null
const demoAddr = async () => demoAccount || (demoAccount = (await import('./mock.js')).DEMO_WALLET)

/** Ask the wallet for an account; resolves its base58 public key. `pick: true` shows the wallet list even if one is remembered. */
export async function connect({ pick = false } = {}) {
  const list = providers()
  if (!list.length) {
    if (MOCK) { const a = await demoAddr(); remember('demo'); return a }
    throw friendly(noWallet())
  }
  let p = pick && list.length > 1 ? null : quietProvider()
  if (!p) {
    const w = list.length > 1 ? await pickWallet(list) : list[0]
    remember(w.info.id)
    p = w.provider
  } else {
    const hit = list.find(x => x.provider === p)
    if (hit) remember(hit.info.id)
  }
  active = p
  const addr = keyOf(p, await p.connect())
  if (!isAddress(addr)) throw friendly('The wallet did not share an account.')
  return addr
}

/** The account already shared with this site, or null. Never opens a wallet prompt. */
export async function currentAccount() {
  if (MOCK && remembered() === 'demo') return demoAddr()
  const p = active || quietProvider()
  if (!p) return null
  try {
    if (p.isConnected && p.publicKey) { active = p; return keyOf(p) || null }
    if (!remembered() || !(p.isPhantom || p.isBackpack || p.isStandard)) return null
    const a = keyOf(p, await p.connect({ onlyIfTrusted: true }))
    if (a) active = p
    return a || null
  } catch { return null }
}

/** Forget the pick and ask the provider to disconnect (best effort). */
export async function disconnect() {
  const p = active || (() => { try { return quietProvider() } catch { return null } })()
  remember('')
  active = null
  try { await p?.disconnect?.() } catch {}
}

/** Follow the account the wallet has selected. Returns the unsubscribe. */
export function watchAccounts(cb) {
  let p = null
  try { p = active || quietProvider() } catch {}
  if (!p || typeof p.on !== 'function') return () => {}
  const changed = k => cb(k ? k.toString() : null)
  const gone = () => cb(null)
  const offs = []
  try { const o = p.on('accountChanged', changed); if (typeof o === 'function') offs.push(o) } catch {}
  if (!p.isStandard) { try { p.on('disconnect', gone) } catch {} }
  return () => {
    offs.forEach(o => { try { o() } catch {} })
    for (const [ev, h] of [['accountChanged', changed], ['disconnect', gone]]) { try { (p.off || p.removeListener)?.call(p, ev, h) } catch {} }
  }
}

function sameAccount(p, account) {
  const now = keyOf(p)
  if (account && now && now !== account) throw friendly('Your wallet switched accounts. Connect again.')
}

/** Sign a plain message: ed25519 over its UTF-8 bytes, returned base58. Costs nothing, moves nothing. */
export async function signMessage(account, message) {
  const p = provider()
  sameAccount(p, account)
  const r = await p.signMessage(new TextEncoder().encode(message), 'utf8')
  const sig = r?.signature || r
  return bs58.encode(sig instanceof Uint8Array ? sig : Uint8Array.from(sig))
}

/**
 * Have the wallet sign an engine-built transaction (base64, v0 or legacy; may carry the mint's signature already).
 * Returns the signed transaction, base64. Sends nothing. Refuses a tx whose fee payer is not `account`.
 */
export async function signTx(txB64, account, { label = 'transaction' } = {}) {
  if (MOCK && !providers().length) return (await import('./mock.js')).mockSign(txB64)
  const p = provider()
  sameAccount(p, account)
  const { VersionedTransaction, Transaction } = await import('@solana/web3.js')
  let tx, payer
  const bytes = fromB64(txB64)
  try { tx = VersionedTransaction.deserialize(bytes); payer = tx.message.staticAccountKeys?.[0]?.toBase58?.() } catch {
    try { tx = Transaction.from(bytes); payer = tx.feePayer?.toBase58?.() } catch (e) { throw friendly(`The ${label} could not be read. Nothing was signed.`, { cause: e }) }
  }
  if (account && payer && payer !== account) throw friendly(`The ${label} was prepared for a different wallet. Nothing was signed.`)
  if (typeof p.signTransaction !== 'function') throw friendly('This wallet cannot sign a transaction without sending it. Use Phantom, Solflare or Backpack.')
  const signed = await p.signTransaction(tx)
  const out = signed instanceof Uint8Array ? signed : signed?.serialize ? signed.serialize() : null
  if (!out) throw friendly('The wallet did not return a signed transaction.')
  return toB64(out)
}

/** True when the error is the user pressing Reject / closing the wallet. */
export const walletSaidNo = e => /reject|denied|cancel|declin|closed|user/i.test(String(e?.message || e?.shortMessage || '')) && !/switched/i.test(String(e?.message || ''))
