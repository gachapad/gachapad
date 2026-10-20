// Shell: hash router, left rail (≥1100) / bottom tabs, sticky blurred topbar (search, SOL + ROOT chips, wallet), footer, toasts.
import { useState, useEffect, useRef, useMemo, useCallback, createContext, useContext, Component } from 'react'
import { BRAND, MOCK, SOLSCAN, PUMP, PUMP_URL } from './config'
import { api, useStats, useHealth } from './api'
import { connect, currentAccount, disconnect, watchAccounts, hasWallet, walletLinks, isTouch } from './wallet'
import { Icon, Mark, Logo, Sm, Dot, ToastHost, toast, useCopy, useDebounced, useMedia, short, fmtUsd, fmtSmall, useTween, Copy } from './ui'
import { Home } from './Landing'
import { Docs } from './Docs'
import { Launch, Token, Me, Admin } from './Pages'
import { MachinesPage, CoinMachinePage, PullsPage, BurnPullPage } from './Machines'

/* ---------------- routing ---------------- */

const safeDecode = s => { try { return decodeURIComponent(s) } catch { return s } }
export function parseHash() {
  const raw = (location.hash || '#/').replace(/^#\/?/, '')
  const [pathPart, query = ''] = raw.split('?')
  const [a, b] = pathPart.split('/')
  const q = Object.fromEntries(new URLSearchParams(query))
  if (a === 'coin' && b) return { page: 'coin', id: safeDecode(b), q, key: `coin/${b}` }
  if ((a === 'burn' || a === 'pull') && b) return { page: 'pull', id: safeDecode(b), q, key: `pull/${b}` }
  if (a === 'coins' || a === 'explore' || a === 'machines') return { page: 'explore', q, key: 'explore' }
  if (['launch', 'pulls', 'token', 'docs', 'me', 'admin'].includes(a)) return { page: a, q, key: a }
  return { page: 'home', q, key: 'home' }
}
export const go = to => { location.hash = to }
function useRoute() {
  const [r, setR] = useState(parseHash)
  useEffect(() => {
    const f = () => { setR(parseHash()); if (!/^#\/docs/.test(location.hash) || !location.hash.includes('#', 1)) window.scrollTo({ top: 0, behavior: 'instant' }) }
    addEventListener('hashchange', f)
    return () => removeEventListener('hashchange', f)
  }, [])
  return r
}

/* ---------------- wallet context ---------------- */

const WalletCtx = createContext({ account: null, connect: async () => null, disconnect: async () => {} })
export const useWallet = () => useContext(WalletCtx)

function useWalletState() {
  const [account, setAccount] = useState(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let off = () => {}
    currentAccount().then(a => { if (a) { setAccount(a); off = watchAccounts(k => setAccount(k)) } }).catch(() => {})
    return () => off()
  }, [])
  const doConnect = useCallback(async (opts) => {
    setBusy(true)
    try {
      const a = await connect(opts)
      setAccount(a)
      watchAccounts(k => setAccount(k))
      return a
    } catch (e) {
      if (!/No wallet chosen/.test(e?.message || '')) toast({ kind: 'err', title: 'Could not connect', body: e?.shortMessage || e?.message })
      throw e
    } finally { setBusy(false) }
  }, [])
  const doDisconnect = useCallback(async () => { await disconnect(); setAccount(null) }, [])
  return useMemo(() => ({ account, busy, connect: doConnect, disconnect: doDisconnect }), [account, busy, doConnect, doDisconnect])
}

/* ---------------- error boundary ---------------- */

class Boundary extends Component {
  state = { err: null }
  static getDerivedStateFromError(err) { return { err } }
  componentDidUpdate(p) { if (p.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null }) }
  render() {
    if (!this.state.err) return this.props.children
    return <div className="wrap page"><div className="empty tall"><i>{Icon.warn}</i><h4>This page hit a snag.</h4><p>{String(this.state.err?.message || this.state.err)}</p><a className="btn" href="#/">back home</a></div></div>
  }
}

/* ---------------- search ---------------- */

function Search({ compact }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState(null)
  const [hi, setHi] = useState(0)
  const dq = useDebounced(q.trim(), 250)
  const box = useRef(null)
  useEffect(() => {
    if (!dq) { setRows(null); return }
    let alive = true
    api(`/coins?q=${encodeURIComponent(dq)}&limit=8&sort=mcap`).then(r => { if (alive) { setRows(r.items || []); setHi(0) } }).catch(() => alive && setRows([]))
    return () => { alive = false }
  }, [dq])
  useEffect(() => {
    const f = e => { if (!box.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', f)
    return () => document.removeEventListener('mousedown', f)
  }, [])
  const pick = m => { setOpen(false); setQ(''); go(`/coin/${m}`) }
  const onKey = e => {
    if (e.key === 'Escape') { setOpen(false); e.target.blur() }
    if (e.key === 'ArrowDown' && rows?.length) { e.preventDefault(); setHi(h => (h + 1) % rows.length) }
    if (e.key === 'ArrowUp' && rows?.length) { e.preventDefault(); setHi(h => (h - 1 + rows.length) % rows.length) }
    if (e.key === 'Enter') { if (rows?.[hi]) pick(rows[hi].mint); else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q.trim())) pick(q.trim()) }
  }
  return (
    <div className={`search ${compact ? 'compact' : ''}`} ref={box}>
      <label className="search-pill">
        {Icon.search}
        <input value={q} onChange={e => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} onKeyDown={onKey} placeholder={compact ? 'search' : 'search coins, tickers, addresses'} aria-label="Search coins" spellCheck={false} />
        {!compact && <kbd>/</kbd>}
      </label>
      {open && dq && (
        <div className="search-pop" role="listbox">
          {rows == null ? <p className="muted">searching…</p> : rows.length === 0 ? <p className="muted">nothing matches “{dq}”</p> : rows.map((c, i) => (
            <button key={c.mint} className={i === hi ? 'hi' : ''} onMouseEnter={() => setHi(i)} onClick={() => pick(c.mint)} role="option" aria-selected={i === hi}>
              <Logo coin={c} size={26} />
              <b>${c.symbol}</b><span>{c.name}</span>
              <em>{c.parent ? `under $${c.parentSymbol}` : c.level > 0 ? `under $${BRAND.ticker}` : 'root'} · {fmtUsd(c.mcapUsd)}</em>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------------- wallet chip ---------------- */

function WalletChip() {
  const w = useWallet()
  const [open, setOpen] = useState(false)
  const [copied, copy] = useCopy()
  const box = useRef(null)
  useEffect(() => {
    if (!open) return
    const f = e => { if (!box.current?.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', f)
    return () => document.removeEventListener('mousedown', f)
  }, [open])
  if (!w.account) {
    const noExt = !hasWallet() && !MOCK
    return <button className="btn primary sm" onClick={() => (noExt ? toast({ kind: 'err', title: 'No Solana wallet found', body: isTouch() ? `Open ${BRAND.name} inside Phantom or Solflare.` : 'Install Phantom, Solflare or Backpack.' }) : w.connect())} disabled={w.busy}>{w.busy ? 'connecting…' : 'Connect'}</button>
  }
  return (
    <div className="wchip" ref={box}>
      <button className="wchip-btn" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-haspopup="menu">
        <i className="wav" aria-hidden="true">{Icon.wallet}</i>
        <span className="mono">{short(w.account)}</span>
      </button>
      {open && (
        <div className="wmenu" role="menu">
          <button onClick={() => copy(w.account)}>{copied ? Icon.check : Icon.copy}<span>{copied ? 'copied' : 'copy address'}</span></button>
          <a href={SOLSCAN.account(w.account)} target="_blank" rel="noreferrer">{Icon.ext}<span>view on Solscan</span></a>
          <a href="#/me" onClick={() => setOpen(false)}>{Icon.me}<span>my coins &amp; earnings</span></a>
          <button onClick={() => w.connect({ pick: true }).catch(() => {})}>{Icon.refresh}<span>switch wallet</span></button>
          <button className="danger" onClick={() => { setOpen(false); w.disconnect() }}>{Icon.close}<span>disconnect</span></button>
        </div>
      )}
    </div>
  )
}

/* ---------------- shell ---------------- */

const NAV = [
  ['/', 'Home', 'home', p => p === 'home'],
  ['/machines', 'Machines', 'layers', p => p === 'explore' || p === 'coin'],
  ['/pulls', 'Pulls', 'spark', p => p === 'pulls' || p === 'pull'],
  ['/launch', 'Launch', 'launch', p => p === 'launch'],
  ['/token', `$${BRAND.ticker}`, 'token', p => p === 'token'],
  ['/docs', 'How it works', 'docs', p => p === 'docs'],
]

function EngineDot({ stats, health, healthErr }) {
  const pending = !health && !stats && !healthErr
  const paused = stats?.engine?.killed || stats?.engine?.canary === 'failing'
  const st = pending ? 'warn' : health?.status === 'ok' && health?.rpcOk !== false ? (paused ? 'warn' : 'ok') : health ? 'warn' : 'down'
  const label = pending ? 'connecting…' : st === 'ok' ? 'engine live' : st === 'warn' ? (stats?.engine?.killed ? 'engine paused (kill switch)' : stats?.engine?.canary === 'failing' ? 'launches paused (pump.fun changed)' : 'engine degraded') : 'engine unreachable'
  return <span className="engine-dot" data-state={st} data-tip={label}><Dot state={st === 'ok' ? 'up' : st} /><span>{label}</span></span>
}

function PriceChips({ stats }) {
  const root = stats?.root
  const sol = useTween(stats?.sol?.usd || 0)
  const rp = useTween(root?.priceUsd || 0)
  return (
    <div className="chips">
      <span className="chip mono" data-tip="SOL price"><i className="sol" aria-hidden="true">{Icon.sol}</i>{stats?.sol?.usd ? `$${sol.toFixed(2)}` : '…'}</span>
      {root ? <a className="chip mono amber" href="#/token" data-tip={`$${root.symbol} price`}>${root.symbol} <b><Sm s={'$' + fmtSmall(rp)} /></b></a> : <a className="chip mono amber" href="#/token">${BRAND.ticker} <b>soon</b></a>}
    </div>
  )
}

function Footer({ stats, health, healthErr }) {
  return (
    <footer className="foot">
      <div className="wrap">
        <div className="foot-brand">
          <a className="brand-m" href="#/"><Mark size={26} />{BRAND.name}</a>
          <em>{BRAND.tagline}</em>
          <span>A launchpad for pump.fun coins. Every coin gets a gacha machine stocked with real graded cards by its own fees.</span>
          <EngineDot stats={stats} health={health} healthErr={healthErr} />
        </div>
        <div>
          <h4>Site</h4>
          <ul>
            <li><a href="#/machines">Machines</a></li>
            <li><a href="#/launch">Launch a coin</a></li>
            <li><a href="#/pulls">Pulls</a></li>
            <li><a href="#/token">${BRAND.ticker}</a></li>
            <li><a href="#/docs">How it works</a></li>
          </ul>
        </div>
        <div>
          <h4>Elsewhere</h4>
          <ul>
            <li><a href={`https://${BRAND.siteHost}`} target="_blank" rel="noreferrer">{BRAND.siteHost}</a></li>
            <li><a href={BRAND.githubUrl} target="_blank" rel="noreferrer">Source code on GitHub</a></li>
            {BRAND.xUrl && <li><a href={BRAND.xUrl} target="_blank" rel="noreferrer">{BRAND.handle} on X</a></li>}
            {stats?.root && <li><a href={stats.root.pumpUrl || PUMP_URL(stats.root.mint)} target="_blank" rel="noreferrer">${stats.root.symbol} on pump.fun</a></li>}
          </ul>
        </div>
      </div>
      <div className="foot-legal">
        <div className="wrap">
          <span>{BRAND.name} is software, not an investment product. Coins launched here can lose most or all of their value.</span>
          <span>{BRAND.name} does not run its own token contract: every coin is a pump.fun coin, and every fee split is a pump.fun fee-sharing configuration anyone can read. Packs and cards are Collector Crypt&apos;s, the same machines pump.fun sells. Each machine&apos;s cards sit in a vault wallet {BRAND.name}&apos;s engine holds the key to. Pulls are random and burns are final.</span>
          <span>{BRAND.name} is not affiliated with, endorsed or sponsored by Nintendo, Creatures, GAME FREAK, The Pokémon Company or Collector Crypt. Pokémon is a trademark of its owners.</span>
        </div>
      </div>
    </footer>
  )
}

function useTheme() {
  const read = () => 'dark'
  const [theme, setTheme] = useState(read)
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    if (next === 'dark') document.documentElement.setAttribute('data-theme', 'dark'); else document.documentElement.removeAttribute('data-theme')
    try { localStorage.setItem('gachapad-theme', next) } catch {}
    const meta = document.querySelector('meta[name="theme-color"]'); if (meta) meta.setAttribute('content', next === 'light' ? '#f3efe6' : '#12100d')
    setTheme(next)
  }
  return [theme, toggle]
}

function ThemeToggle({ theme, onToggle }) {
  const dark = theme === 'dark'
  return (
    <button type="button" className="theme-toggle" onClick={onToggle} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} title={dark ? 'Light theme' : 'Dark theme'}>
      {dark
        ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>
        : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>}
    </button>
  )
}

export default function App() {
  const [theme, toggleTheme] = useTheme()
  const route = useRoute()
  const wallet = useWalletState()
  const { data: stats } = useStats()
  const { data: health, err: healthErr } = useHealth()
  const wide = useMedia('(min-width: 1100px)')
  const [key, setKey] = useState(0)
  useEffect(() => setKey(k => k + 1), [route.key])
  // "/" focuses the nearest search box (page search on Explore, else the topbar)
  useEffect(() => {
    const f = e => { if (e.key === '/' && !/input|textarea|select/i.test(e.target.tagName)) { e.preventDefault(); (document.querySelector('.page-search input') || document.querySelector('.search input'))?.focus() } }
    addEventListener('keydown', f)
    return () => removeEventListener('keydown', f)
  }, [])
  useEffect(() => { if (route.page !== 'coin') document.title = `${BRAND.name} — ${BRAND.tagline}` }, [route.key])

  const page = (() => {
    switch (route.page) {
      case 'explore': return <MachinesPage q={route.q} stats={stats} />
      case 'coin': return <CoinMachinePage mint={route.id} stats={stats} />
      case 'launch': return <Launch q={route.q} stats={stats} />
      case 'pulls': return <PullsPage stats={stats} />
      case 'pull': return <BurnPullPage id={route.id} />
      case 'token': return <Token stats={stats} />
      case 'docs': return <Docs stats={stats} />
      case 'me': return <Me stats={stats} />
      case 'admin': return <Admin stats={stats} />
      default: return <Home stats={stats} />
    }
  })()

  return (
    <WalletCtx.Provider value={wallet}>
      <ToastHost>
        <div className="grain" aria-hidden="true" />
        {MOCK && <div className="demo-ribbon" role="status">preview · demo data · nothing here is on-chain</div>}
        <div className={`shell ${wide ? 'with-rail' : 'with-tabs'}`}>
          {wide && (
            <aside className="rail">
              <a className="brand" href="#/"><Mark size={32} /><b>{BRAND.name}</b><em>pump.fun packs launchpad</em></a>
              <nav aria-label="Primary">
                {NAV.map(([href, label, ic, on]) => <a key={href} href={`#${href}`} className={on(route.page) ? 'on' : ''}>{Icon[ic]}<span>{label}</span></a>)}
              </nav>
              <a className="btn primary block rail-launch" href="#/launch">{Icon.plus} launch a coin</a>
              <div className="rail-foot">
                <EngineDot stats={stats} health={health} healthErr={healthErr} />
                <span>{BRAND.xUrl ? <><a href={BRAND.xUrl} target="_blank" rel="noreferrer">{BRAND.handle}</a> · </> : null}<a href="#/docs">how it works</a> · <a href={BRAND.githubUrl} target="_blank" rel="noreferrer">GitHub</a></span>
              </div>
            </aside>
          )}
          <div className="main">
            <header className="topbar">
              <div className="wrap">
                {!wide && <a className="brand-m" href="#/" aria-label={BRAND.name}><Mark size={28} /></a>}
                <Search compact={!wide} />
                <div className="top-right">
                  {wide && <PriceChips stats={stats} />}
                  <a className="iconlink gh-link" href={BRAND.githubUrl} target="_blank" rel="noreferrer" aria-label="Open source on GitHub" data-tip="open source">{Icon.github}</a>
                  <WalletChip />
                </div>
              </div>
            </header>
            <main>
              <Boundary resetKey={route.key}>
                <div className="route" key={`${key}-${theme}`}>{page}</div>
              </Boundary>
            </main>
            <Footer stats={stats} health={health} healthErr={healthErr} />
          </div>
          {!wide && (
            <nav className="tabbar" aria-label="Primary">
              {NAV.slice(0, 2).map(([href, label, ic, on]) => <a key={href} href={`#${href}`} className={on(route.page) ? 'on' : ''}>{Icon[ic]}<span>{label}</span></a>)}
              <a href="#/launch" className="tab-launch" aria-label="Launch"><span>{Icon.plus}</span></a>
              <a href="#/pulls" className={route.page === 'pulls' || route.page === 'pull' ? 'on' : ''}>{Icon.spark}<span>Pulls</span></a>
              <a href="#/token" className={route.page === 'token' ? 'on' : ''}>{Icon.token}<span>Token</span></a>
            </nav>
          )}
        </div>
      </ToastHost>
    </WalletCtx.Provider>
  )
}
