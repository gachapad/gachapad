// THE TREE — a canvas constellation drawn on an instrument dial. ROOT at the centre (a glowing amber core
// with a breathing halo), level-1 coins orbit it, kids orbit their parent. Links are quadratic curves with
// dashes drifting TOWARD the parent (fees flow up). Glow = 1h volume. Whole thing drifts (1 rev / 6 min)
// and parallaxes with the mouse. Behind everything: faint concentric orbit rings + tick marks, so the
// composition never looks empty. Sparse trees (< 3 coins) fill the free orbit slots with ghost nodes
// ("your coin" · "a coin" · "a child") drawn as thin dashed circles.
// DPR aware (crisp on retina), eased hover, tooltip, click → coin page, reduced-motion = static, ≤ 400 nodes.
import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { BRAND, SPLIT, MAX_DEPTH } from './config'
import { Logo, Bg, MARK_SRC, fmtUsd, fmtInt, reduced, clamp } from './ui'
import { hasBg } from './bg'

const TAU = Math.PI * 2
const MAX_NODES = 400
const REV_MS = 6 * 60 * 1000

// the brand mark, drawn as the root node (loaded once, shared by every tree on the page)
let markImg = null
const mark = () => { if (!markImg && typeof Image !== 'undefined') { markImg = new Image(); markImg.decoding = 'async'; markImg.src = MARK_SRC } return markImg }

const tokens = () => {
  const cs = getComputedStyle(document.documentElement)
  const g = n => cs.getPropertyValue(n).trim()
  return { ember: g('--ember') || '#3ecf8e', ember2: g('--ember-2') || '#6ee7b7', amber: g('--amber') || '#9ff0c6', aura: g('--aura') || '#14b8a6', ink: g('--ink') || '#f4ebdf', ink3: g('--ink-3') || 'rgba(244,235,223,.44)', bg: g('--bg') || '#0d0a08', mono: g('--mono') || 'monospace', sans: g('--sans') || 'sans-serif' }
}
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})` }
const LINE = (a) => `rgba(${getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() || '245,245,245'},${a})`

/** Angles + radii only; screen positions are computed per frame (rotation + parallax). */
function layout(nodes, w, h, compact) {
  const all = nodes.length > MAX_NODES ? [...nodes].sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0)).slice(0, MAX_NODES) : nodes
  const root = all.find(n => n.level === 0) || null
  const l1 = all.filter(n => n.level === 1).sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0))
  const l2 = all.filter(n => n.level === 2)
  const l3 = all.filter(n => n.level === 3)
  const items = [], map = new Map()
  const pad = compact ? 84 : 116
  const rx = Math.max(70, w / 2 - pad), ry = Math.max(58, h / 2 - pad)
  const nodeR = n => clamp(5 + 3.2 * Math.log10(Math.max(n.mcapUsd || 0, 500) / 500), 5, compact ? 14 : 19)
  const rootR = compact ? 19 : 25
  // the root item always exists (drawn even before the root launches); n is null until then
  const rootItem = { n: root, level: 0, r: rootR, x: 0, y: 0, a: 0, h: 0 }
  items.push(rootItem); if (root) map.set(root.mint, rootItem)
  const N = l1.length
  const slots = N < 3 ? (compact ? 3 : 5) : N       // sparse trees keep 5 evenly spaced slots; free ones get ghosts
  l1.forEach((n, i) => {
    const a = -Math.PI / 2 + (i * TAU) / slots
    const it = { n, level: 1, r: nodeR(n) * (compact ? 0.85 : 1), a, parent: rootItem, vol: n.vol1hUsd || 0, h: 0 }
    items.push(it); map.set(n.mint, it)
  })
  const ghosts = []
  for (let i = N; i < slots; i++) {
    const g = { ghost: true, level: 1, r: compact ? 7 : 9, a: -Math.PI / 2 + (i * TAU) / slots, parent: rootItem, label: compact ? 'a child' : i === 0 ? 'your coin' : 'a coin', h: 0 }
    items.push(g); ghosts.push(g)
  }
  if (N === 0 && !compact && ghosts[0] && ry >= 120) items.push({ ghost: true, level: 2, r: 6, parent: ghosts[0], ta: 0, orbit: 9 + 36, label: 'a child', h: 0 })
  const kidsOf = new Map()
  for (const k of l2) { if (!kidsOf.has(k.parent)) kidsOf.set(k.parent, []); kidsOf.get(k.parent).push(k) }
  for (const [pm, ks] of kidsOf) {
    const p = map.get(pm); if (!p) continue
    ks.sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0))
    const spread = Math.min(Math.PI * 0.95, 0.5 * ks.length + 0.3)
    const orbit = p.r + (compact ? 22 : 30) + Math.min(ks.length, 6) * 2.5
    ks.forEach((k, j) => {
      const t = ks.length === 1 ? 0 : (j / (ks.length - 1) - 0.5) * spread
      const it = { n: k, level: 2, r: Math.max(3.5, nodeR(k) * 0.62), parent: p, ta: t, orbit, vol: k.vol1hUsd || 0, h: 0 }
      items.push(it); map.set(k.mint, it)
    })
  }
  // grandchildren (level 3) sit just outside their level-2 parent, fanned along the same outward direction
  const gOf = new Map()
  for (const k of l3) { if (!gOf.has(k.parent)) gOf.set(k.parent, []); gOf.get(k.parent).push(k) }
  for (const [pm, ks] of gOf) {
    const p = map.get(pm); if (!p || p.level !== 2) continue
    ks.sort((a, b) => (b.mcapUsd || 0) - (a.mcapUsd || 0))
    const spread = Math.min(Math.PI * 0.8, 0.55 * ks.length + 0.2)
    const orbit = p.r + (compact ? 12 : 16) + Math.min(ks.length, 6) * 1.5
    ks.forEach((k, j) => {
      const t = ks.length === 1 ? 0 : (j / (ks.length - 1) - 0.5) * spread
      const it = { n: k, level: 3, r: Math.max(2.8, nodeR(k) * 0.45), parent: p, ta: t, orbit, vol: k.vol1hUsd || 0, h: 0 }
      items.push(it); map.set(k.mint, it)
    })
  }
  const maxVol = Math.max(1, ...items.map(i => i.vol || 0))
  for (const it of items) it.glow = it.level ? Math.pow((it.vol || 0) / maxVol, 0.5) : 1
  return { items, map, rx, ry, root, rootItem, coins: N }
}

/** Point + outward normal on the orbit ellipse at parameter a. */
const onEllipse = (a, rx, ry) => { const x = Math.cos(a) * rx, y = Math.sin(a) * ry; const nx = Math.cos(a) / rx, ny = Math.sin(a) / ry; const l = Math.hypot(nx, ny) || 1; return { x, y, nx: nx / l, ny: ny / l } }

/** The dial: concentric orbit rings + tick marks, drawn once per size into an offscreen canvas. */
function drawDial(ctx, w, h, rx, ry, compact) {
  const outerK = Math.min(1.34, (w / 2 - 22) / rx, (h / 2 - 22) / ry)
  const innerK = compact ? 0.5 : 0.46
  const ring = (k, alpha, dash) => { ctx.beginPath(); ctx.ellipse(0, 0, rx * k, ry * k, 0, 0, TAU); ctx.setLineDash(dash || []); ctx.strokeStyle = LINE(alpha); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]) }
  ring(innerK, 0.07, [2, 7])
  ring(1, 0.11)
  ring(outerK, 0.13)
  if (outerK > 1.08) ring((1 + outerK) / 2, 0.05, [1, 9])
  // ticks on the outer ring, every 5°; every 6th is longer
  const n = compact ? 36 : 72
  ctx.lineCap = 'butt'
  for (let i = 0; i < n; i++) {
    const a = (i * TAU) / n
    const p = onEllipse(a, rx * outerK, ry * outerK)
    const len = i % 6 === 0 ? (compact ? 6 : 8) : 3.5
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.nx * len, p.y + p.ny * len)
    ctx.strokeStyle = LINE(i % 6 === 0 ? 0.3 : 0.16); ctx.lineWidth = 1; ctx.stroke()
  }
  // tiny cardinal marks on the orbit ring (a hairline crosshair, inward)
  for (let i = 0; i < 4; i++) {
    const p = onEllipse((i * TAU) / 4, rx, ry)
    ctx.beginPath(); ctx.moveTo(p.x - p.nx * 5, p.y - p.ny * 5); ctx.lineTo(p.x + p.nx * 5, p.y + p.ny * 5)
    ctx.strokeStyle = LINE(0.28); ctx.lineWidth = 1; ctx.stroke()
  }
}

const Legend = ({ inline = false }) => (
  <div className={`tree-legend ${inline ? 'inline' : ''}`} aria-hidden="true">
    <span><i className="lg-root" />root</span>
    <span><i className="lg-coin" />coin</span>
    <span><i className="lg-kid" />child</span>
    <span><i className="lg-bonded" />graduated</span>
    <span><i className="lg-flow" />fees flow up</span>
  </div>
)

export default function Tree({ nodes, height = 420, full = false, compact = false, selected = null, onHover, onSelect, caption = true, legend = false, art = false, className = '', maxDepth = MAX_DEPTH }) {
  const wrap = useRef(null), canvas = useRef(null)
  const [hover, setHover] = useState(null) // { item, x, y }
  const [size, setSize] = useState({ w: 0, h: 0 })
  const state = useRef({ theta: 0, px: 0, py: 0, tx: 0, ty: 0, ripples: [], known: null, last: 0, dash: 0, hover: null, L: null, dirty: true, easing: 0, cy: 0, dial: null, dialKey: '' })
  const still = reduced()
  const list = useMemo(() => Array.isArray(nodes) ? nodes : [], [nodes])
  const hasRoot = list.some(n => n.level === 0)
  const rootSym = list.find(n => n.level === 0)?.symbol || BRAND.ticker
  const coins = list.filter(n => n.level === 1).length
  const empty = coins === 0
  const showCaption = caption && empty
  // on short panels the composition sits a little above centre so the caption has room underneath
  const shift = showCaption ? clamp((520 - size.h) / 4, 0, 40) + (full ? 26 : 0) : 0

  // layout when data / size changes
  useEffect(() => {
    const s = state.current
    if (!size.w) return
    const prevH = new Map((s.L?.items || []).filter(i => i.n).map(i => [i.n.mint, i.h]))
    s.L = layout(list, size.w, size.h, compact)
    for (const it of s.L.items) if (it.n) it.h = prevH.get(it.n.mint) || 0
    if (s.known) for (const n of list) if (!s.known.has(n.mint)) s.ripples.push({ mint: n.mint, t0: performance.now() })
    s.known = new Set(list.map(n => n.mint))
    s.dirty = true
    s.kick?.()
  }, [list, size, compact])

  // size tracking
  useEffect(() => {
    const el = wrap.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => { const r = e.contentRect; setSize({ w: Math.round(r.width), h: Math.round(r.height) }) })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const positions = useCallback(() => {
    const s = state.current, L = s.L
    if (!L) return []
    const { rx, ry } = L
    const out = []
    for (const it of L.items) {
      if (it.level === 0) { it.x = 0; it.y = 0 }
      else if (it.level === 1) { const a = it.a + s.theta; it.x = Math.cos(a) * rx; it.y = Math.sin(a) * ry; it.sa = Math.atan2(it.y, it.x) }
      else { const p = it.parent; const a = (p.sa ?? p.a + s.theta) + it.ta; it.x = p.x + Math.cos(a) * it.orbit; it.y = p.y + Math.sin(a) * it.orbit; it.sa = a }
      out.push(it)
    }
    return out
  }, [])

  // draw
  useEffect(() => {
    const cv = canvas.current
    if (!cv || !size.w) return
    const ctx = cv.getContext('2d')
    const dpr = Math.min(3, window.devicePixelRatio || 1)
    cv.width = Math.round(size.w * dpr); cv.height = Math.round(size.h * dpr)   // CSS keeps it at 100% × 100%; never px, or a grid column would grow with it
    const T = tokens()
    const s = state.current
    let raf = 0, running = true
    const cx = size.w / 2, cy = size.h / 2 - shift
    s.cy = cy

    const dial = (L) => {
      const key = `${size.w}x${size.h}:${L.rx}:${L.ry}:${dpr}:${compact}`
      if (s.dialKey !== key || !s.dial) {
        const off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height
        const c = off.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.translate(cx, cy)
        drawDial(c, size.w, size.h, L.rx, L.ry, compact)
        s.dial = off; s.dialKey = key
      }
      return s.dial
    }

    const draw = (now, dt) => {
      const L = s.L
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, size.w, size.h)
      s.px += (s.tx - s.px) * 0.08; s.py += (s.ty - s.py) * 0.08
      if (L) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(dial(L), Math.round(s.px * dpr), Math.round(s.py * dpr)); ctx.restore() }
      ctx.translate(cx + s.px, cy + s.py)
      // the violet aura, breathing when the tree is sparse
      const breathe = still ? 1 : 1 + 0.05 * Math.sin(now / 1600)
      const auraR = (compact ? 96 : 150) * breathe
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, auraR)
      g.addColorStop(0, rgba(T.aura, 0.16)); g.addColorStop(0.55, rgba(T.aura, 0.04)); g.addColorStop(1, rgba(T.aura, 0))
      
      if (!L) return
      const items = positions()
      const hov = s.hover
      // hover easing (0..1 per item, ~180 ms)
      let easing = false
      for (const it of items) {
        const target = hov === it || (selected && it.n?.mint === selected) ? 1 : 0
        if (it.h !== target) { it.h += (target - it.h) * Math.min(1, dt / 90); if (Math.abs(it.h - target) < 0.02) it.h = target; else easing = true }
      }
      s.easing = easing
      // links (kid → parent, dashes drift toward the parent); ghosts get a plain hairline
      ctx.lineCap = 'round'
      for (const it of items) {
        if (!it.parent) continue
        const p = it.parent
        const mx = (it.x + p.x) / 2, my = (it.y + p.y) / 2
        const cxp = mx * 0.82, cyp = my * 0.82
        if (it.ghost) {
          ctx.beginPath(); ctx.moveTo(it.x, it.y); ctx.quadraticCurveTo(cxp, cyp, p.x, p.y)
          ctx.setLineDash([2, 6]); ctx.strokeStyle = LINE(0.16); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([])
          continue
        }
        const lit = Math.max(it.h, p.h, it.parent?.parent?.h || 0)
        ctx.beginPath(); ctx.moveTo(it.x, it.y); ctx.quadraticCurveTo(cxp, cyp, p.x, p.y)
        ctx.setLineDash([])
        ctx.strokeStyle = rgba(T.aura, (it.level >= 2 ? 0.2 : 0.3) + lit * 0.4); ctx.lineWidth = 0.75 + lit * 0.6; ctx.stroke()
        ctx.setLineDash(it.level === 3 ? [2, 8] : [2, 12]); ctx.lineDashOffset = -s.dash * (it.level >= 2 ? 0.7 : 1)
        ctx.strokeStyle = rgba(T.ember2, 0.42 + lit * 0.5); ctx.lineWidth = 1.1 + lit * 0.8; ctx.stroke()
      }
      ctx.setLineDash([])
      // ripples
      s.ripples = s.ripples.filter(r => now - r.t0 < 1600)
      for (const r of s.ripples) {
        const it = L.map.get(r.mint); if (!it) continue
        const k = (now - r.t0) / 1600
        ctx.beginPath(); ctx.arc(it.x, it.y, it.r + 4 + k * 46, 0, TAU)
        ctx.strokeStyle = rgba(T.ember, (1 - k) * 0.7); ctx.lineWidth = 1.5 * (1 - k) + 0.5; ctx.stroke()
      }
      // nodes
      for (const it of items) {
        if (it.ghost) {
          ctx.beginPath(); ctx.arc(it.x, it.y, it.r, 0, TAU)
          ctx.setLineDash([2.5, 3.5]); ctx.strokeStyle = LINE(0.34); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([])
          ctx.fillStyle = LINE(0.03); ctx.fill()
          continue
        }
        const fade = s.ripples.find(r => r.mint === it.n?.mint)
        ctx.globalAlpha = fade ? clamp((now - fade.t0) / 500, 0.15, 1) : 1
        if (it.level === 0) {
          const rr = it.r
          // halo: a warm breathing glow, wider than the core
          const hb = still ? 1 : 1 + 0.07 * Math.sin(now / 1500)
          const haloR = rr * 3.4 * hb
          const cg = ctx.createRadialGradient(0, 0, rr * 0.6, 0, 0, haloR)
          cg.addColorStop(0, rgba(T.amber, 0.42)); cg.addColorStop(0.3, rgba(T.ember, 0.16)); cg.addColorStop(1, rgba(T.ember, 0))
          
          // two hairline rings: a static one and a slowly turning open arc
          ctx.beginPath(); ctx.arc(0, 0, rr * 1.8, 0, TAU); ctx.strokeStyle = rgba(T.amber, 0.14); ctx.lineWidth = 1; ctx.stroke()
          const ang = still ? -Math.PI / 2 : (now / 9000) % TAU
          ctx.beginPath(); ctx.arc(0, 0, rr * 1.8, ang, ang + TAU * 0.62); ctx.strokeStyle = rgba(T.amber, 0.5); ctx.lineWidth = 1; ctx.stroke()
          // the node itself is the brand mark, glowing; a lit core stands in until the image has loaded
          const mi = mark()
          if (mi && mi.complete && mi.naturalWidth) {
            const ms = rr * 2.5
            ctx.save(); ctx.shadowColor = rgba(T.ember, 0.55); ctx.shadowBlur = 0
            ctx.drawImage(mi, -ms / 2, -ms / 2 + rr * 0.08, ms, ms)
            ctx.restore()
          } else {
            const core = ctx.createRadialGradient(-rr * 0.32, -rr * 0.34, rr * 0.05, 0, 0, rr)
            core.addColorStop(0, T.ember); core.addColorStop(1, T.ember)
            ctx.fillStyle = core; ctx.beginPath(); ctx.arc(0, 0, rr, 0, TAU); ctx.fill()
          }
          if (it.h > 0) { ctx.beginPath(); ctx.arc(0, 0, rr + 5 + it.h * 2, 0, TAU); ctx.strokeStyle = rgba(T.ink, 0.8 * it.h); ctx.lineWidth = 1.2; ctx.stroke() }
        } else {
          const gl = 0.1 + it.glow * 0.42 + it.h * 0.22
          const gr = it.r * (2 + it.glow * 1.5)
          const ng = ctx.createRadialGradient(it.x, it.y, 0, it.x, it.y, gr)
          ng.addColorStop(0, rgba(T.ember, gl)); ng.addColorStop(1, rgba(T.ember, 0))
          
          const rr = it.r * (1 + it.h * 0.14)
          const fill = ctx.createRadialGradient(it.x - rr * 0.35, it.y - rr * 0.35, 0, it.x, it.y, rr)
          fill.addColorStop(0, it.level === 1 ? T.ember : T.ember2); fill.addColorStop(0.5, it.level === 1 ? T.ember : T.ember2); fill.addColorStop(1, it.level === 1 ? T.ember : rgba(T.ember, 0.85))
          ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(it.x, it.y, rr, 0, TAU); ctx.fill()
          if (it.n.graduated) { ctx.beginPath(); ctx.arc(it.x, it.y, rr + 3, 0, TAU); ctx.strokeStyle = rgba(T.amber, 0.9); ctx.lineWidth = 1.1; ctx.stroke() }
          if (it.h > 0) { ctx.beginPath(); ctx.arc(it.x, it.y, rr + (it.n.graduated ? 6 : 4) + it.h * 1.5, 0, TAU); ctx.strokeStyle = rgba(T.ink, 0.85 * it.h); ctx.lineWidth = 1.2; ctx.stroke() }
        }
        ctx.globalAlpha = 1
      }
      // labels — with a soft dark halo so they stay readable over links
      ctx.textAlign = 'center'; ctx.lineJoin = 'round'
      for (const it of items) {
        if (it.ghost) {
          // ghost labels sit on the outward side of the node
          const out = it.level === 2 && it.parent ? Math.sin(it.parent.sa ?? 0) < 0 : false
          ctx.textBaseline = out ? 'bottom' : 'top'
          ctx.font = `400 11px ${T.sans}`
          ctx.lineWidth = 3; ctx.strokeStyle = T.bg
          const y = out ? it.y - it.r - 6 : it.y + it.r + 6
          ctx.strokeText(it.label, it.x, y)
          ctx.fillStyle = LINE(0.36); ctx.fillText(it.label, it.x, y)
          continue
        }
        const show = it.level === 0 || (it.level === 1 && (it.r >= (compact ? 8 : 9) || it.h > 0)) || it.h > 0
        if (!show) continue
        const sym = `$${it.n?.symbol || BRAND.ticker}`
        ctx.textBaseline = 'top'
        const y = it.y + it.r + (it.level === 0 ? 14 : 7)
        ctx.font = `500 ${it.level === 0 ? 12 : 11}px ${T.mono}`
        ctx.lineWidth = 3; ctx.strokeStyle = T.bg
        ctx.strokeText(sym, it.x, y)
        ctx.fillStyle = it.level === 0 ? T.amber : it.h > 0.5 ? T.ink : T.ink3
        ctx.fillText(sym, it.x, y)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    const loop = now => {
      if (!running) return
      const dt = s.last ? Math.min(64, now - s.last) : 16
      s.last = now
      if (!still) { s.theta += (TAU * dt) / REV_MS; s.dash += dt * 0.016 }
      const moving = !still || Math.abs(s.tx - s.px) > 0.05 || s.ripples.length || s.dirty || s.easing
      if (moving) { draw(now, dt); s.dirty = false }
      if (still && !moving) { raf = 0; return }
      raf = requestAnimationFrame(loop)
    }
    s.kick = () => { s.dirty = true; if (!raf && running) raf = requestAnimationFrame(loop) }
    const mi = mark()
    if (mi && !(mi.complete && mi.naturalWidth)) mi.addEventListener('load', () => s.kick?.(), { once: true })
    const onVis = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0 } else s.kick() }
    document.addEventListener('visibilitychange', onVis)
    s.kick()
    return () => { running = false; cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis) }
  }, [size, still, compact, selected, empty, hasRoot, positions, shift])

  // pointer: hover hit-test + parallax
  const hit = useCallback((mx, my) => {
    const s = state.current, L = s.L
    if (!L) return null
    const x = mx - size.w / 2 - s.px, y = my - s.cy - s.py
    let best = null, bd = Infinity
    for (const it of L.items) {
      if (it.x == null || !it.n) continue
      const d = Math.hypot(it.x - x, it.y - y)
      if (d <= it.r + 7 && d < bd) { best = it; bd = d }
    }
    return best
  }, [size])
  const onMove = e => {
    const r = wrap.current.getBoundingClientRect()
    const mx = e.clientX - r.left, my = e.clientY - r.top
    const s = state.current
    if (!still) { s.tx = ((mx / r.width) - 0.5) * 10; s.ty = ((my / r.height) - 0.5) * 10 }
    const it = hit(mx, my)
    if (it !== s.hover) {
      s.hover = it; s.kick?.()
      setHover(it ? { item: it, x: mx, y: my } : null)
      onHover?.(it?.n || null)
    } else if (it) setHover(h => (h ? { ...h, x: mx, y: my } : h))
  }
  const onLeave = () => { const s = state.current; s.tx = 0; s.ty = 0; s.kick?.(); if (s.hover) { s.hover = null; setHover(null); onHover?.(null) } }
  const onClick = e => {
    const r = wrap.current.getBoundingClientRect()
    const it = hit(e.clientX - r.left, e.clientY - r.top)
    if (!it?.n) return
    onSelect?.(it.n)
    if (!onSelect) location.hash = `/coin/${it.n.mint}`
  }
  const onKey = e => { if (e.key === 'Enter' && hover?.item?.n) onClick({ clientX: 0, clientY: 0 }) }

  const h = full ? '100%' : height
  const tip = hover?.item?.n
  const tipStyle = tip ? { left: clamp(hover.x + 14, 8, Math.max(8, size.w - 240)), top: clamp(hover.y + 14, 8, Math.max(8, size.h - 116)) } : null
  return (
    <div ref={wrap} className={`tree ${full ? 'full' : ''} ${showCaption ? 'sparse' : ''} ${className}`} style={{ height: h, '--tree-shift': `${shift}px` }} onMouseMove={onMove} onMouseLeave={onLeave} onClick={onClick} onKeyDown={onKey} tabIndex={0} role="img" aria-label={`The ${BRAND.name} tree: ${list.length} coins`}>
      {art && hasBg('token') && <Bg name="token" className="tree-art" />}
      <canvas ref={canvas} style={{ cursor: tip ? 'pointer' : 'default' }} />
      {showCaption && (
        <div className="tree-caption">
          <em>{hasRoot ? 'The first branch starts here.' : 'Root launches soon.'}</em>
          <p>{hasRoot
            ? <>Launch a coin under <b>${rootSym}</b>: {SPLIT.parentHolders}% of its creator fees pay ${rootSym} holders.</>
            : <>The tree starts with <b>${BRAND.ticker}</b>, a pump.fun coin. {SPLIT.parentHolders}% of the creator fees of every coin launched under it pays ${BRAND.ticker} holders.</>}</p>
          {hasRoot && <a className="btn primary sm" href="#/launch">launch under ${rootSym}</a>}
          {legend && <Legend inline />}
        </div>
      )}
      {legend && !showCaption && <Legend />}
      {tip && (
        <div className="tree-tip" style={tipStyle}>
          <Logo coin={tip} size={34} />
          <div>
            <b>${tip.symbol} <span>{tip.name}</span></b>
            <div className="tt-row"><span>mcap</span><em className="tnum">{fmtUsd(tip.mcapUsd)}</em></div>
            <div className="tt-row"><span>1h vol</span><em className="tnum">{fmtUsd(tip.vol1hUsd)}</em></div>
            <div className="tt-row"><span>{tip.graduated ? 'graduated' : 'bonding curve'}</span><em className="tnum">{tip.graduated ? 'PumpSwap' : `${Math.round((tip.progress || 0) * 100)}%`}</em></div>
            {tip.level < maxDepth && <div className="tt-row"><span>children</span><em className="tnum">{fmtInt(tip.kids)}</em></div>}
          </div>
        </div>
      )}
    </div>
  )
}
