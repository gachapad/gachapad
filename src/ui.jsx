// Primitives: formatting, icons (one set, 1.5 px stroke), count-up numbers, rings, logos, skeletons, toasts,
// copy pills, address links, tooltips, background image slots, reveal, marquee, modal, form bits.
import { useState, useEffect, useRef, useCallback, createContext, useContext } from 'react'
import { createPortal } from 'react-dom'
import { SOLSCAN } from './config'
import { logoUrl } from './api'
import { bgSrc } from './bg'

/* ---------------- formatting ---------------- */

export const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
export const short = (a, n = 4) => (a ? `${String(a).slice(0, n)}…${String(a).slice(-n)}` : '')
export const isSig = t => typeof t === 'string' && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(t)
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = v => { const n = Number(v); return isFinite(n) ? n : 0 }

/** $1.2M · $45.3K · $980 · $12.40 · $0.0042 */
export function fmtUsd(v, { cents } = {}) {
  const n = num(v)
  if (n === 0) return '$0'
  const a = Math.abs(n), s = n < 0 ? '-' : ''
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`
  if (a >= 1e4) return `${s}$${(a / 1e3).toFixed(1)}K`
  if (a >= 100) return `${s}$${Math.round(a).toLocaleString()}`
  if (a >= 1 || cents) return `${s}$${a.toFixed(2)}`
  return `${s}$${fmtSmall(a)}`
}
/** tiny prices: 0.0000123 → 0.0₄123 */
export function fmtSmall(v) {
  const a = Math.abs(num(v)) // the engine sends null prices until a coin's curve is first read
  if (a === 0) return '0'
  if (a >= 0.01) return a.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
  const zeros = Math.floor(-Math.log10(a)) - 1
  const digits = Math.round(a * 10 ** (zeros + 4)).toString().slice(0, 3)
  return `0.0${'₀₁₂₃₄₅₆₇₈₉'[Math.min(9, zeros)]}${digits}`
}
export function fmtNum(v, dp) {
  const n = num(v), a = Math.abs(n)
  if (a >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`
  if (dp != null) return n.toFixed(dp)
  if (a >= 100) return Math.round(n).toLocaleString()
  if (a >= 1) return n.toFixed(2).replace(/\.?0+$/, '')
  return fmtSmall(a)
}
export const fmtInt = v => Math.round(num(v)).toLocaleString()
export const fmtPct = (v, dp = 0) => `${(num(v) * 100).toFixed(dp)}%`
export const fmtBps = bps => `${+(num(bps) / 100).toFixed(2)}%`
export const fmtSol = v => { const n = num(v), a = Math.abs(n); return a >= 100 ? n.toFixed(1) : a >= 1 ? n.toFixed(2) : a >= 0.001 || a === 0 ? n.toFixed(3) : a >= 0.00001 ? n.toFixed(5) : '<0.00001' }
export const timeAgo = ts => {
  if (!ts) return ''
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
export const safeHttp = u => (typeof u === 'string' && /^https?:\/\/[^\s<>"']+$/i.test(u) ? u : null)
export const xHandle = s => String(s || '').trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '')

/* ---------------- icons: one set, 24 box, 1.5 stroke ---------------- */

const I = p => ({ fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', viewBox: '0 0 24 24', 'aria-hidden': true, ...p })
export const Icon = {
  home: <svg {...I()}><path d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1h-5v-6.5h-5V21h-5a1 1 0 0 1-1-1z" /></svg>,
  explore: <svg {...I()}><circle cx="11" cy="11" r="7" /><path d="M20.5 20.5 16 16" /></svg>,
  tree: <svg {...I()}><circle cx="12" cy="18.5" r="2.5" /><circle cx="5.5" cy="6" r="2.5" /><circle cx="18.5" cy="6" r="2.5" /><path d="M12 16v-4.5M12 11.5c0-3-3.5-3.5-5-4M12 11.5c0-3 3.5-3.5 5-4" /></svg>,
  launch: <svg {...I()}><path d="M12 3c3 2 5 6 5 10l-2 2H9l-2-2c0-4 2-8 5-10z" /><path d="M9 15l-3 4M15 15l3 4M12 21v-3" /><circle cx="12" cy="10" r="1.5" /></svg>,
  token: <svg {...I()}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2" /></svg>,
  docs: <svg {...I()}><path d="M5 3.5h9l5 5V20a.5.5 0 0 1-.5.5h-13A.5.5 0 0 1 5 20z" /><path d="M14 3.5v5h5M8.5 13h7M8.5 16.5h7" /></svg>,
  me: <svg {...I()}><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" /></svg>,
  search: <svg {...I()}><circle cx="11" cy="11" r="7" /><path d="M20.5 20.5 16 16" /></svg>,
  copy: <svg {...I()}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg>,
  check: <svg {...I({ strokeWidth: 1.8 })}><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>,
  arrow: <svg {...I()}><path d="M5 12h14M13 6l6 6-6 6" /></svg>,
  up: <svg {...I()}><path d="M12 19V5M6 11l6-6 6 6" /></svg>,
  down: <svg {...I()}><path d="M12 5v14M6 13l6 6 6-6" /></svg>,
  chevron: <svg {...I()}><path d="M6 9l6 6 6-6" /></svg>,
  sort: <svg {...I({ strokeWidth: 1.8 })}><path d="M12 5v14M7 10l5-5 5 5" /></svg>,
  ext: <svg {...I()}><path d="M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></svg>,
  x: <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-7.2 8.3L23 22h-6.6l-5.2-6.8L5.3 22H2.2l7.7-8.8L1 2h6.8l4.7 6.2zm-1.1 18h1.7L7.3 3.9H5.4z" /></svg>,
  tg: <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.9 4.6L18.7 19.8c-.2 1-.9 1.3-1.8.8l-4.9-3.6-2.4 2.3c-.3.3-.5.5-1 .5l.4-5 9.1-8.2c.4-.4-.1-.5-.6-.2L6.1 13.6l-4.8-1.5c-1-.3-1-1 .2-1.5L20.5 3.1c.9-.3 1.6.2 1.4 1.5z" /></svg>,
  github: <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z" /></svg>,
  globe: <svg {...I()}><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c3 3.5 3 13.5 0 17M12 3.5c-3 3.5-3 13.5 0 17" /></svg>,
  close: <svg {...I({ strokeWidth: 1.8 })}><path d="M6 6l12 12M18 6L6 18" /></svg>,
  flame: <svg {...I()}><path d="M12 3c1 3 4.5 4.5 4.5 9.5a4.5 4.5 0 0 1-9 0c0-1.6.6-2.8 1.2-3.8.5 1.5 1.4 2.1 2.3 2.1C12 8.5 10.5 5.5 12 3z" /></svg>,
  wallet: <svg {...I()}><rect x="3" y="6" width="18" height="13" rx="3" /><path d="M3 10h18M16 14.5h2" /></svg>,
  gear: <svg {...I()}><circle cx="12" cy="12" r="3" /><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6" /></svg>,
  plus: <svg {...I({ strokeWidth: 1.8 })}><path d="M12 5v14M5 12h14" /></svg>,
  image: <svg {...I()}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.8" /><path d="M20.5 16l-5-5-8 8.5" /></svg>,
  refresh: <svg {...I()}><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" /></svg>,
  spark: <svg {...I()}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" /></svg>,
  lock: <svg {...I()}><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" /><circle cx="12" cy="15.5" r="1" /></svg>,
  shield: <svg {...I()}><path d="M12 3l7.5 3v6c0 4.5-3.2 7.7-7.5 9-4.3-1.3-7.5-4.5-7.5-9V6z" /><path d="M9 12l2 2 4-4" /></svg>,
  cpu: <svg {...I()}><rect x="6" y="6" width="12" height="12" rx="2" /><rect x="9.5" y="9.5" width="5" height="5" rx="1" /><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" /></svg>,
  info: <svg {...I()}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8v.5" /></svg>,
  warn: <svg {...I()}><path d="M12 4l8.5 15h-17z" /><path d="M12 10v4M12 17v.5" /></svg>,
  clock: <svg {...I()}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>,
  link: <svg {...I()}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>,
  layers: <svg {...I()}><path d="M12 4l8 4.5-8 4.5-8-4.5z" /><path d="M4 13l8 4.5 8-4.5M4 17.5l8 4.5 8-4.5" /></svg>,
  curve: <svg {...I()}><path d="M4 19c4 0 6-2 8-6s4-8 8-9" /><path d="M4 19h16" /></svg>,
  coins: <svg {...I()}><circle cx="9" cy="9" r="5.5" /><path d="M14.5 8.3a5.5 5.5 0 1 1-6.2 6.2" /></svg>,
  seed: <svg {...I()}><path d="M12 21c0-5 0-8 0-9" /><path d="M12 12c-4 0-6.5-2.5-7-7 4.5.5 7 3 7 7z" /><path d="M12 12c4 0 6.5-2.5 7-7-4.5.5-7 3-7 7z" /></svg>,
  admin: <svg {...I()}><path d="M4 7h16M4 12h16M4 17h16" /><circle cx="9" cy="7" r="1.5" fill="var(--bg)" /><circle cx="15" cy="12" r="1.5" fill="var(--bg)" /><circle cx="8" cy="17" r="1.5" fill="var(--bg)" /></svg>,
  sol: <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5.5 15.8h11.8c.2 0 .4.1.5.2l1.7 1.7c.3.3.1.8-.3.8H7.4c-.2 0-.4-.1-.5-.2l-1.7-1.7c-.3-.3-.1-.8.3-.8zM5.5 5.5h11.8c.2 0 .4.1.5.2l1.7 1.7c.3.3.1.8-.3.8H7.4c-.2 0-.4-.1-.5-.2L5.2 6.3c-.3-.3-.1-.8.3-.8zM18.5 10.6H6.7c-.2 0-.4.1-.5.2l-1.7 1.7c-.3.3-.1.8.3.8h11.8c.2 0 .4-.1.5-.2l1.7-1.7c.3-.3.1-.8-.3-.8z" /></svg>,
}

/* ---------------- brand mark ---------------- */

/** The brand mark: the Gachapad app icon (transparent PNG). */
export const MARK_SRC = '/mark-gacha.png?v=6'
export const Mark = ({ size = 28 }) => <img className="mark" src={MARK_SRC} width={size} height={size} alt="" aria-hidden="true" decoding="async" />
/** Whether a coin is the root (the mark stands in for its logo when none is set). */
const isRoot = c => !!c && c.level === 0

/* ---------------- numbers ---------------- */

/** Numbers glide to their new value instead of jumping (600 ms). */
export function useTween(v, ms = 600) {
  const target = num(v)
  const [d, setD] = useState(target)
  const cur = useRef(target)
  useEffect(() => {
    if (reduced()) { cur.current = target; setD(target); return }
    const from = cur.current, to = target
    if (from === to) return
    const t0 = performance.now()
    let raf
    const step = t => {
      const p = clamp((t - t0) / ms, 0, 1)
      const e = 1 - Math.pow(1 - p, 3)
      const val = from + (to - from) * e
      cur.current = val; setD(val)
      if (p < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return d
}
export const Num = ({ v, f = fmtInt, className = '' }) => <span className={`tnum ${className}`}>{f(useTween(v))}</span>

/* ---------------- logos ---------------- */

const hueTile = logo => {
  const hue = logo && logo.startsWith('mock://') ? Number(logo.slice(7)) : null
  return hue == null ? null : { background: `radial-gradient(120% 100% at 30% 20%, hsl(${hue} 70% 62% / .9), hsl(${(hue + 40) % 360} 60% 30%) 70%)`, color: '#fff' }
}
/** Coin logo. The ticker tile (initials on ember) is always underneath: it shows while the image loads,
 *  and stays if the image is missing or fails — never a blank square. All images object-fit: cover. */
export function Logo({ coin, size = 40, round = true, className = '' }) {
  const [ok, setOk] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const src = logoUrl(coin)
  useEffect(() => { setOk(true); setLoaded(false) }, [src])
  const style = { width: size, height: size, fontSize: Math.max(10, size * 0.34) }
  const tile = hueTile(src)
  const img = src && ok && !tile
  if (!img && !tile && isRoot(coin)) return <img className={`logo mark-logo ${className}`} src={MARK_SRC} alt="" width={size} height={size} style={style} decoding="async" />
  return (
    <span className={`logo ltile ${round ? '' : 'sq'} ${className}`} style={{ ...style, ...(tile || {}) }}>
      {(coin?.symbol || '?').slice(0, size >= 56 ? 4 : 2)}
      {img && <img className={`logo-img ${loaded ? 'in' : ''}`} src={src} alt="" width={size} height={size} loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={() => setLoaded(true)} onError={() => setOk(false)} />}
    </span>
  )
}

/** Renders a formatted number whose subscript zero-count (0.0₄400) becomes a real, legible <sub>. Pass a string from fmtUsd / fmtSmall / fmtNum. */
export function Sm({ s, className = '' }) {
  const str = String(s ?? '')
  const parts = str.split(/([₀-₉])/)
  if (parts.length === 1) return <span className={`tnum ${className}`}>{str}</span>
  return <span className={`tnum sm ${className}`}>{parts.map((p, i) => (i % 2 ? <sub key={i}>{'₀₁₂₃₄₅₆₇₈₉'.indexOf(p)}</sub> : p))}</span>
}

/* ---------------- progress ring ---------------- */

/** Bonding-curve progress. `bonded` = graduated to PumpSwap (the CSS class keeps its old name). */
export function Ring({ v = 0, size = 28, stroke = 3, bonded = false, label, showPct }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r
  const p = useTween(clamp(num(v), 0, 1), 900)
  const big = size >= 44
  return (
    <span className={`ring ${bonded ? 'bonded' : ''} ${big ? 'lg' : ''}`} style={{ width: size, height: size }} data-tip={label ?? (bonded ? 'graduated · trading on PumpSwap' : `${Math.round(num(v) * 100)}% of the bonding curve`)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity=".14" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - (bonded ? 1 : p))} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </svg>
      {(big || showPct) && <b className="tnum">{bonded ? '✓' : `${Math.round(p * 100)}`}</b>}
    </span>
  )
}
export const Bar = ({ v }) => <span className="bar"><span style={{ width: `${clamp(num(v) * 100, 1, 100)}%` }} /></span>

/** Small countdown ring for the quote refresh (seconds left of `total`). */
export function CountRing({ left, total, size = 14 }) {
  const r = (size - 2) / 2, c = 2 * Math.PI * r
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity=".2" strokeWidth="1.5" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - clamp(left / total, 0, 1))} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  )
}

/* ---------------- states ---------------- */

export const Skel = ({ n = 3, h = 44, className = '' }) => <div className={`skel-list ${className}`} aria-hidden="true">{Array.from({ length: n }, (_, i) => <div key={i} className="skel" style={{ height: h }} />)}</div>
export const Empty = ({ title, sub, cta, glyph, className = '' }) => (
  <div className={`empty ${className}`}>
    <i aria-hidden="true">{glyph || Icon.seed}</i>
    <h4>{title}</h4>
    {sub && <p>{sub}</p>}
    {cta}
  </div>
)
export const ErrLine = ({ msg, onRetry }) => (
  <div className="errline" role="alert">
    <span>{msg || 'Something went wrong.'}</span>
    {onRetry && <button className="btn ghost sm" onClick={onRetry}>{Icon.refresh} retry</button>}
  </div>
)
export const Dot = () => null

/* ---------------- links / copy ---------------- */

export const TxLink = ({ sig, children = 'tx', className = '' }) => (isSig(sig) ? <a className={`txlink ${className}`} href={SOLSCAN.tx(sig)} target="_blank" rel="noreferrer">{children}{Icon.ext}</a> : null)
export const AddrLink = ({ a, children, className = '' }) => (a ? <a className={`txlink mono ${className}`} href={SOLSCAN.account(a)} target="_blank" rel="noreferrer">{children || short(a)}</a> : null)

export function useCopy(ms = 1400) {
  const [copied, setCopied] = useState(false)
  const t = useRef(null)
  const copy = useCallback(async text => {
    try { await navigator.clipboard.writeText(text) } catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); try { document.execCommand('copy') } catch {} ta.remove()
    }
    setCopied(true); clearTimeout(t.current); t.current = setTimeout(() => setCopied(false), ms)
  }, [ms])
  return [copied, copy]
}
export function Copy({ text, label, className = '', mono = true, sm = false }) {
  const [copied, copy] = useCopy()
  return (
    <button type="button" className={`copy ${copied ? 'ok' : ''} ${mono ? 'mono' : ''} ${sm ? 'sm' : ''} ${className}`} onClick={() => copy(text)} data-tip={copied ? 'copied' : 'copy'}>
      <span>{copied ? 'copied' : label ?? short(text)}</span>{copied ? Icon.check : Icon.copy}
    </button>
  )
}
/** Copy pill + Solscan link, as one unit. */
export const Addr = ({ a, label, sm }) => (a ? (
  <span className="addr">
    <Copy text={a} label={label} sm={sm} />
    <a className="iconlink" href={SOLSCAN.account(a)} target="_blank" rel="noreferrer" data-tip="view on Solscan" aria-label="view on Solscan">{Icon.ext}</a>
  </span>
) : null)

/* ---------------- tooltip ---------------- */

export const Tip = ({ text, children, className = '', right }) => <span className={`${className} ${right ? 'tip-right' : ''}`} data-tip={text}>{children}</span>

/* ---------------- background image slot ---------------- */

/** Lazy background render with a dark veil; the CSS fallback shows until the file loads (or forever, if it never does). */
export function Bg({ name, className = '', eager = false }) {
  const { jpg, webp } = bgSrc(name)
  const [ok, setOk] = useState(false)
  const [dead, setDead] = useState(false)
  const has = !!(jpg || webp) && !dead
  return (
    <div className={`bg-slot bg-${name} ${className}`} aria-hidden="true">
      <div className="fallback" />
      {has && (
        <picture>
          {webp && <source srcSet={webp} type={webp.includes('.avif') ? 'image/avif' : 'image/webp'} />}
          <img src={jpg || webp} alt="" loading={eager ? 'eager' : 'lazy'} fetchPriority={eager ? 'high' : 'auto'} decoding="async" className={ok ? 'in' : ''} onLoad={() => setOk(true)} onError={() => setDead(true)} />
        </picture>
      )}
      <div className="veil" />
    </div>
  )
}

/* ---------------- reveal on scroll ---------------- */

export function useReveal() {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reduced() || !('IntersectionObserver' in window)) { el.classList.add('in'); return }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { el.classList.add('in'); io.disconnect() } }, { rootMargin: '0px 0px -6% 0px', threshold: 0 })
    io.observe(el)
    const safety = setTimeout(() => el.classList.add('in'), 1800)
    return () => { io.disconnect(); clearTimeout(safety) }
  }, [])
  return ref
}
export const Reveal = ({ as: Tag = 'section', className = '', children, ...rest }) => { const ref = useReveal(); return <Tag ref={ref} className={`reveal ${className}`} {...rest}>{children}</Tag> }

/* ---------------- marquee ---------------- */

export function Marquee({ children, speed = 60, className = '' }) {
  const items = Array.isArray(children) ? children : [children]
  if (reduced()) return <div className={`mq-static ${className}`}>{items}</div>
  return (
    <div className={`marquee ${className}`}>
      <div className="mq-track" style={{ animationDuration: `${speed}s` }}>
        {items}
        {items.map((c, i) => <span key={`d${i}`} aria-hidden="true" className="mq-dup">{c}</span>)}
      </div>
    </div>
  )
}

/* ---------------- toasts ---------------- */

const ToastCtx = createContext(() => {})
let toastFn = () => {}
/** toast({ title, body?, sig?, kind: 'ok'|'err'|'info'|'busy', ms? }) from anywhere. Returns an id; toast.update(id, patch) / toast.dismiss(id). */
export const toast = Object.assign((t) => toastFn({ ...t }), { update: (id, patch) => toastFn({ id, ...patch }), dismiss: id => toastFn({ id, dismiss: true }) })

export function ToastHost({ children }) {
  const [list, setList] = useState([])
  const store = useRef(new Map())
  const push = useCallback(t => {
    const id = t.id || `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const prev = store.current.get(id)
    if (prev?.timer) clearTimeout(prev.timer)
    if (t.dismiss) { store.current.delete(id); setList(l => l.filter(x => x.id !== id)); return id }
    const next = { ...(prev || { kind: 'info', at: Date.now() }), ...t, id, timer: null }
    const ms = t.ms ?? (next.kind === 'busy' ? 0 : next.kind === 'err' ? 8000 : 5000)
    if (ms) next.timer = setTimeout(() => { store.current.delete(id); setList(l => l.filter(x => x.id !== id)) }, ms)
    store.current.set(id, next)
    setList(l => (l.some(x => x.id === id) ? l.map(x => (x.id === id ? next : x)) : [...l, next]).slice(-4))
    return id
  }, [])
  useEffect(() => { toastFn = push; return () => { toastFn = () => {} } }, [push])
  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="toasts" aria-live="polite">
          {list.map(t => (
            <div key={t.id} className={`toast ${t.kind || 'info'}`}>
              <i className="tdot" aria-hidden="true" />
              <div>
                <b>{t.title}</b>
                {t.body && <p>{t.body}</p>}
                {t.sig && <TxLink sig={t.sig}>view on Solscan</TxLink>}
              </div>
              <button className="tclose" onClick={() => setList(l => l.filter(x => x.id !== t.id))} aria-label="dismiss">{Icon.close}</button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  )
}
export const useToast = () => useContext(ToastCtx)

/* ---------------- modal ---------------- */

export function Modal({ title, onClose, children, wide }) {
  const closeRef = useRef(onClose); closeRef.current = onClose
  useEffect(() => {
    const k = e => { if (e.key === 'Escape') closeRef.current?.() }
    document.addEventListener('keydown', k)
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', k); document.body.style.overflow = prev }
  }, [])
  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}>
        <div className="modal-head"><h3>{title}</h3><button className="iconbtn" onClick={onClose} aria-label="Close">{Icon.close}</button></div>
        {children}
      </div>
    </div>,
    document.body,
  )
}

/* ---------------- form + table bits ---------------- */

export const Seg = ({ value, onChange, options, className = '' }) => (
  <div className={`seg ${className}`} role="tablist">
    {options.map(o => <button key={o.value} type="button" role="tab" aria-selected={o.value === value} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)} disabled={o.disabled}>{o.label}</button>)}
  </div>
)
export const Field = ({ label, hint, right, children, className = '' }) => (
  <label className={`field ${className}`}>
    <span className="flabel">{label}{right && <em>{right}</em>}</span>
    {children}
    {hint && <small>{hint}</small>}
  </label>
)
/** Sortable table header cell. */
export const SortTh = ({ k, sort, onSort, children, className = '' }) => {
  const on = sort?.k === k
  return (
    <th className={className}>
      <button type="button" className={`th-sort ${on ? 'on' : ''} ${on && sort.d === 'desc' ? 'desc' : ''}`} onClick={() => onSort(k)} aria-sort={on ? (sort.d === 'asc' ? 'ascending' : 'descending') : 'none'}>
        {children}{Icon.sort}
      </button>
    </th>
  )
}

/* ---------------- media ---------------- */

export function useMedia(query) {
  const [on, setOn] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    const m = matchMedia(query), f = e => setOn(e.matches)
    setOn(m.matches)
    m.addEventListener('change', f)
    return () => m.removeEventListener('change', f)
  }, [query])
  return on
}

/** Debounced value. */
export function useDebounced(v, ms = 300) {
  const [d, setD] = useState(v)
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t) }, [v, ms])
  return d
}

/** Ticks every second; returns Date.now(). */
export function useNow(ms = 1000) {
  const [t, setT] = useState(Date.now())
  useEffect(() => { const id = setInterval(() => setT(Date.now()), ms); return () => clearInterval(id) }, [ms])
  return t
}

/** Client-side image → ≤512 px webp data URL (GIFs pass through untouched). */
export async function imageToDataUrl(file, { max = 512, quality = 0.88 } = {}) {
  if (!file) return null
  if (!/^image\/(png|jpe?g|gif|webp|avif)$/i.test(file.type)) throw new Error('Use a PNG, JPG, GIF or WEBP image.')
  const read = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f) })
  if (file.type === 'image/gif') { if (file.size > 1.5 * 1024 * 1024) throw new Error('GIFs must be under 1.5 MB (they are not recompressed).'); return read(file) }
  const bmp = await createImageBitmap(file)
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height))
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s))
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height)
  const blob = await new Promise(r => c.toBlob(r, 'image/webp', quality))
  if (!blob) throw new Error('Could not process that image.')
  return read(blob)
}
