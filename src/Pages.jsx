// App pages: Explore, Coin (+ TradeBox), Launch, Tree, Token, Me, Admin. Everything reads the engine (api.js).
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { BRAND, MOCK, SPLIT, ROOT_SPLIT, MAX_WALLET_PCT, SETUP_SOL, PUMP, splitOf, rootSplitOf, maxDepthOf } from './config'
import { api, post, bust, useApi, useTree, useCoin, useCoins, useLaunchMeta, useMachines } from './api'
import { signTx, walletSaidNo } from './wallet'
import { swap, getQuote, toRaw, fromRaw, routeLabel } from './trade'
import { Icon, Logo, Num, Sm, Ring, Bar, Skel, Empty, ErrLine, Dot, TxLink, AddrLink, Copy, Addr, Bg, Seg, Field, SortTh, CountRing, Modal, toast, useDebounced, useMedia, useNow, imageToDataUrl, fmtUsd, fmtSmall, fmtNum, fmtInt, fmtPct, fmtBps, fmtSol, timeAgo, short, isSig, safeHttp, xHandle } from './ui'
import Tree from './Tree'
import { PackMachine, Slab, PullCard } from './Packs'
import { useWallet, go } from './App'
import { hasBg } from './bg'
import { shareIntent, pumpUrlOf, PumpLink, FeedRow, CoinTr, Proof, roleOf, sharingNote, shareSource, STATUS_PILL } from './shared'

const inFmt = ms => { if (ms == null) return ''; const s = Math.max(0, Math.round(ms / 1000)); if (s < 60) return `${s}s`; const m = Math.floor(s / 60); if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`; return `${Math.floor(m / 60)}h ${m % 60}m` }
const PHASE = { gradSol: PUMP.gradSol }

/* ======================================================================
   EXPLORE — dense, fast table
   ====================================================================== */

const FILTERS = [['all', 'all'], ['curve', 'on curve'], ['graduated', 'graduated']]
const SERVER_SORTS = new Set(['new', 'mcap', 'vol', 'kids', 'progress', 'pot', 'pulled'])
const KEY = { new: c => c.createdAt || 0, mcap: c => c.mcapUsd || 0, vol: c => c.vol24hUsd || 0, vol1h: c => c.vol1hUsd || 0, kids: c => c.kids || 0, pot: c => c.packs?.progress || 0, pulled: c => c.packs?.pulledUsd || 0, progress: c => (c.curve?.graduated ? 1.01 : c.curve?.progress || 0), price: c => c.priceUsd || 0, holders: c => c.holders || 0 }

export function Explore({ q, stats }) {
  const [filter, setFilter] = useState(q?.filter || 'all')
  const [sort, setSort] = useState({ k: q?.sort || 'mcap', d: 'desc' })
  const [search, setSearch] = useState(q?.q || '')
  const [limit, setLimit] = useState(50)
  const dq = useDebounced(search.trim(), 300)
  const depth = maxDepthOf(stats)
  useEffect(() => setLimit(50), [filter, dq])
  const serverSort = SERVER_SORTS.has(sort.k) ? sort.k : 'mcap'
  const { data, err, loading, reload } = useCoins({ sort: serverSort, filter, q: dq, limit }, 15_000)
  const items = useMemo(() => {
    const rows = [...(data?.items || [])]
    const f = KEY[sort.k] || KEY.mcap
    rows.sort((a, b) => (sort.d === 'desc' ? f(b) - f(a) : f(a) - f(b)))
    return rows
  }, [data, sort])
  const onSort = k => setSort(s => (s.k === k ? { k, d: s.d === 'desc' ? 'asc' : 'desc' } : { k, d: 'desc' }))
  const narrow = useMedia('(max-width: 760px)')
  return (
    <div className="wrap page">
      <div className="page-head">
        <div><h1>Explore</h1><p className="sub">Every coin on {BRAND.name}. Each one is a pump.fun coin whose creator fees fill its own pot; at {fmtUsd(stats?.pack?.priceUsdc || 50)} it opens a real graded Pokémon pack for its holders.</p></div>
        <a className="btn primary" href="#/launch">{Icon.plus} launch a coin</a>
      </div>
      <div className="toolbar">
        <label className="search-pill inline page-search">{Icon.search}<input value={search} onChange={e => setSearch(e.target.value)} placeholder="name, ticker or address" aria-label="search coins" /><kbd>/</kbd></label>
        <div className="chips-row">{FILTERS.map(([v, l]) => <button key={v} className={`chip-btn ${filter === v ? 'on' : ''}`} onClick={() => setFilter(v)}>{l}{filter === v && data ? <span className="n">{fmtInt(data.total)}</span> : null}</button>)}</div>
        <label className="sort">sort<select className="input" value={sort.k} onChange={e => setSort({ k: e.target.value, d: 'desc' })}>
          <option value="mcap">market cap</option><option value="pot">closest to a pack</option><option value="pulled">most pulled</option><option value="new">newest</option><option value="vol">24h volume</option><option value="progress">curve progress</option><option value="holders">holders</option><option value="price">price</option>
        </select></label>
      </div>
      <div className="card explore-tbl">
        {loading && !data ? <div style={{ padding: 16 }}><Skel n={10} h={44} /></div> : err && !data ? <div style={{ padding: 8 }}><ErrLine msg={err} onRetry={reload} /></div> : items.length === 0 ? (
          <Empty className="tall" title={dq ? <>Nothing matches <em>“{dq}”</em>.</> : filter === 'all' ? 'No coins yet.' : 'Nothing in this filter yet.'} sub={dq ? 'Try a ticker, a name or a full contract address.' : 'Launch the first one: its fees open real Pokémon packs for its holders.'} cta={<a className="btn primary sm" href="#/launch">launch a coin</a>} />
        ) : (
          <table className="tbl">
            <thead><tr>
              <th className="rank">#</th>
              <th>coin</th>
              {!narrow && <SortTh k="price" sort={sort} onSort={onSort} className="r">price</SortTh>}
              <SortTh k="mcap" sort={sort} onSort={onSort} className="r">mcap</SortTh>
              {!narrow && <SortTh k="vol" sort={sort} onSort={onSort} className="r">24h vol</SortTh>}
              {!narrow && <SortTh k="holders" sort={sort} onSort={onSort} className="r">holders</SortTh>}
              <SortTh k="pot" sort={sort} onSort={onSort} className="r">pack pot</SortTh>
              {!narrow && <SortTh k="pulled" sort={sort} onSort={onSort} className="r">pulled</SortTh>}
              <SortTh k="progress" sort={sort} onSort={onSort}>curve</SortTh>
              {!narrow && <SortTh k="new" sort={sort} onSort={onSort} className="r">age</SortTh>}
              {!narrow && <th className="act" />}
            </tr></thead>
            <tbody>{items.map((c, i) => <CoinTr key={c.mint} c={c} i={i} rank={i + 1} maxDepth={depth} cols={narrow ? ['rank', 'coin', 'mcap', 'pot', 'status'] : ['rank', 'coin', 'price', 'mcap', 'vol24', 'holders', 'pot', 'pulled', 'status', 'age', 'act']} />)}</tbody>
          </table>
        )}
        {data && items.length > 0 && <div className="tfoot"><span>{fmtInt(items.length)} of {fmtInt(data.total)} coins</span>{data.total > items.length && <button className="btn sm" onClick={() => setLimit(l => l + 50)}>show 50 more</button>}</div>}
      </div>
    </div>
  )
}

/* ======================================================================
   TRADE BOX (signing logic unchanged: quote → engine builds → wallet signs → engine relays → poll)
   SOL in / coin out, and back. The engine picks the route: pump.fun curve, PumpSwap, or Jupiter.
   ====================================================================== */

const SLIPS = [50, 100, 200, 500]
const QUOTE_MS = 8_000

export function TradeBox({ coin, solUsd, onDone }) {
  const w = useWallet()
  const [side, setSide] = useState('buy')
  const [amount, setAmount] = useState('')
  const [slip, setSlip] = useState(100)
  const [slipOpen, setSlipOpen] = useState(false)
  const [custom, setCustom] = useState('')
  const [quote, setQuote] = useState(null)
  const [qAt, setQAt] = useState(0)
  const [qerr, setQerr] = useState(null)
  const [quoting, setQuoting] = useState(false)
  const [stage, setStage] = useState(null)
  const input = side === 'buy' ? 'SOL' : coin.mint
  const output = side === 'buy' ? coin.mint : 'SOL'
  const raw = toRaw(amount, input)
  const dRaw = useDebounced(raw, 400)
  const now = useNow(1000)
  const abort = useRef(null)

  const fetchQuote = useCallback(async () => {
    if (!dRaw) { setQuote(null); setQerr(null); return }
    abort.current?.abort(); const ctl = new AbortController(); abort.current = ctl
    setQuoting(true)
    try { const qq = await getQuote({ input, output, amount: dRaw, slippageBps: slip, signal: ctl.signal }); if (!ctl.signal.aborted) { setQuote(qq); setQAt(Date.now()); setQerr(null) } }
    catch (e) { if (!ctl.signal.aborted) { setQuote(null); setQerr(e.shortMessage || e.message) } }
    finally { if (!ctl.signal.aborted) setQuoting(false) }
  }, [dRaw, input, output, slip])
  useEffect(() => { fetchQuote(); const id = setInterval(() => { if (!document.hidden && !stage) fetchQuote() }, QUOTE_MS); return () => { clearInterval(id); abort.current?.abort() } }, [fetchQuote, stage])

  const outUi = quote ? fromRaw(quote.outAmount, output) : 0
  const outUsd = side === 'buy' ? outUi * coin.priceUsd : outUi * solUsd
  const inUsd = raw ? fromRaw(raw, input) * (side === 'buy' ? solUsd : coin.priceUsd) : 0
  const impactHigh = quote && quote.priceImpactPct >= 5
  const left = quote ? Math.max(0, Math.ceil((QUOTE_MS - (now - qAt)) / 1000)) : 0

  async function trade() {
    if (!raw || stage) return
    let account = w.account
    try { if (!account) account = await w.connect() } catch { return }
    const id = toast({ kind: 'busy', title: side === 'buy' ? `Buying $${coin.symbol}` : `Selling $${coin.symbol}`, body: 'building the transaction…' })
    try {
      const r = await swap({ wallet: account, input, output, amount: raw, slippageBps: slip, onStage: s => { setStage(s); toast.update(id, { body: { building: 'building the transaction…', signing: 'approve in your wallet', sending: 'sending…', confirming: 'confirming on-chain…' }[s] }) } })
      toast.update(id, { kind: r.status === 'landed' ? 'ok' : 'info', title: r.status === 'landed' ? (side === 'buy' ? `Bought ${fmtNum(outUi)} $${coin.symbol}` : `Sold ${fmtNum(fromRaw(raw, input))} $${coin.symbol}`) : 'Sent — still confirming', body: r.status === 'landed' ? `via ${routeLabel(r.route || quote?.route)}` : 'It will show once finalized.', sig: r.sig, ms: 8000 })
      setAmount(''); setQuote(null); bust(); onDone?.()
    } catch (e) {
      toast.update(id, { kind: 'err', title: walletSaidNo(e) ? 'Cancelled in the wallet' : 'Trade failed', body: walletSaidNo(e) ? 'Nothing was sent.' : e.shortMessage || e.message, sig: e.sig, ms: 8000 })
    } finally { setStage(null) }
  }

  const presets = ['0.1', '0.5', '1', '2']
  return (
    <div className="tradebox card">
      <div className="trade-tabs" role="tablist">
        <button role="tab" aria-selected={side === 'buy'} className={side === 'buy' ? 'on buy' : ''} onClick={() => { setSide('buy'); setAmount('') }}>Buy</button>
        <button role="tab" aria-selected={side === 'sell'} className={side === 'sell' ? 'on sell' : ''} onClick={() => { setSide('sell'); setAmount('') }}>Sell</button>
        <button className="slip-btn" onClick={() => setSlipOpen(o => !o)} aria-expanded={slipOpen} data-tip="max slippage">{Icon.gear}<span>{fmtBps(slip)}</span></button>
      </div>
      {slipOpen && (
        <div className="slip">
          <span>max slippage</span>
          <div className="seg">{SLIPS.map(s => <button key={s} className={slip === s ? 'on' : ''} onClick={() => { setSlip(s); setCustom('') }}>{fmtBps(s)}</button>)}
            <label className="slip-custom"><input inputMode="decimal" placeholder="custom %" value={custom} onChange={e => { setCustom(e.target.value); const v = Number(e.target.value); if (v > 0 && v <= 50) setSlip(Math.round(v * 100)) }} /></label></div>
        </div>
      )}
      <div className="amt">
        <div className="amt-top"><span>{side === 'buy' ? 'you pay' : 'you sell'}</span><span className="sym">{side === 'buy' ? 'SOL' : `$${coin.symbol}`}</span></div>
        <input inputMode="decimal" placeholder="0.0" value={amount} onChange={e => setAmount(e.target.value.replace(/[^0-9.,]/g, ''))} aria-label="amount" />
        <div className="amt-foot"><span className="tnum">{inUsd ? `≈ ${fmtUsd(inUsd, { cents: true })}` : ''}</span>
          {side === 'buy' && <div className="presets">{presets.map(p => <button key={p} onClick={() => setAmount(p)}>{p}</button>)}</div>}
        </div>
      </div>
      <div className="amt out">
        <div className="amt-top"><span>you receive</span><span className="sym">{side === 'buy' ? `$${coin.symbol}` : 'SOL'}</span></div>
        <div className={`out-v tnum ${quote ? '' : 'muted'}`}>{quote ? fmtNum(outUi) : raw ? (qerr ? '—' : '…') : '0.0'}</div>
        <div className="amt-foot"><span className="tnum">{quote ? `≈ ${fmtUsd(outUsd, { cents: true })} · min ${fmtNum(fromRaw(quote.minOut, output))}` : ''}</span></div>
      </div>
      {quote && (
        <div className="quote-meta">
          <span>{routeLabel(quote.route)} · fee {fmtBps(quote.feeBps)} · impact {Number(quote.priceImpactPct || 0).toFixed(2)}%</span>
          <span className="qcount" data-tip={quoting ? 'refreshing' : `refreshes in ${left}s`}><CountRing left={quoting ? 0 : left} total={QUOTE_MS / 1000} /><span>{quoting ? '…' : `${left}s`}</span><button type="button" onClick={fetchQuote} aria-label="refresh quote">{Icon.refresh}</button></span>
        </div>
      )}
      {qerr && <p className="warn">{Icon.warn}<span>{qerr}</span></p>}
      {impactHigh && <p className="warn">{Icon.warn}<span>Price impact {quote.priceImpactPct.toFixed(1)}% — this trade moves the price a lot.</span></p>}
      <button className={`btn primary block lg ${side === 'sell' ? 'sell' : ''}`} disabled={!raw || !!stage || !!qerr} onClick={trade}>
        {stage ? { building: 'building…', signing: 'approve in wallet…', sending: 'sending…', confirming: 'confirming…' }[stage] : !w.account ? `connect & ${side}` : side === 'buy' ? `buy $${coin.symbol}` : `sell $${coin.symbol}`}
      </button>
      <p className="tiny muted">Built by the engine, signed in your wallet, relayed as signed. ${coin.symbol} trades in {coin.quoteSymbol || 'SOL'}{coin.quoteSymbol && coin.quoteSymbol !== 'SOL' ? ' (paying in SOL routes through Jupiter)' : ''} {coin.curve?.graduated ? 'on PumpSwap' : "on its pump.fun bonding curve"}, and anywhere else pump.fun coins trade. <PumpLink c={coin} className="link">pump.fun {Icon.ext}</PumpLink></p>
    </div>
  )
}

/* ======================================================================
   COIN PAGE
   ====================================================================== */

function Sparkline({ points }) {
  if (!points || points.length < 2) return <Empty glyph={Icon.curve} title="No chart yet." sub="Trades draw the first line." />
  const w = 600, h = 160, pad = 6
  const xs = points.map(p => p.at), ys = points.map(p => p.v)
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys)
  const X = t => pad + ((t - x0) / Math.max(1, x1 - x0)) * (w - pad * 2), Y = v => h - pad - ((v - y0) / Math.max(1e-12, y1 - y0)) * (h - pad * 2)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.at).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(' ')
  const up = ys[ys.length - 1] >= ys[0]
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="price">
      <defs><linearGradient id="sp-g" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor={up ? 'var(--up)' : 'var(--down)'} stopOpacity=".25" /><stop offset="1" stopColor={up ? 'var(--up)' : 'var(--down)'} stopOpacity="0" /></linearGradient></defs>
      <path d={`${d} L${X(x1).toFixed(1)} ${h} L${X(x0).toFixed(1)} ${h} Z`} fill="url(#sp-g)" />
      <path d={d} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}

/** The expected split, used only while a coin's shareholders have not been read back yet. */
const expectedShares = isRoot => (isRoot
  ? [{ role: 'burn', bps: ROOT_SPLIT.burn * 100 }, { role: 'protocol', bps: ROOT_SPLIT.protocol * 100 }]
  : [{ role: 'creator', bps: SPLIT.creator * 100 }, { role: 'parentHolders', bps: SPLIT.parentHolders * 100 }, { role: 'burn', bps: SPLIT.burn * 100 }, { role: 'protocol', bps: SPLIT.protocol * 100 }])
const creatorBpsOf = c => (c?.sharing?.shareholders || []).find(s => s.role === 'creator')?.bps ?? (c?.level === 0 ? 0 : SPLIT.creator * 100)
/** What pump.fun has paid this coin's launcher: the engine's MEASURED fees.toLauncherSol (API.md), else an estimate. */
const launcherSolOf = c => (typeof c?.fees?.toLauncherSol === 'number' ? c.fees.toLauncherSol : (c?.fees?.distributedSol || 0) * creatorBpsOf(c) / 10_000)

/** Where this coin's creator fees go: built from coin.sharing.shareholders, as read back from chain. */
function FeeSplit({ coin }) {
  const sh = coin.sharing || {}
  const status = sh.status || 'pending'
  const has = (sh.shareholders || []).length > 0
  const planned = shareSource(sh) === 'planned'
  const rows = has ? sh.shareholders : expectedShares(coin.level === 0)
  const P = coin.parentSymbol
  const how = role => ({
    creator: 'paid by pump.fun straight to the wallet',
    parentHolders: `pump.fun pays $${coin.symbol}'s machine pool; ${BRAND.name} turns it into graded-card packs that stock $${coin.symbol}'s machine`,
    burn: `pump.fun pays the burn wallet; ${BRAND.name} buys and burns $${BRAND.ticker}`,
    protocol: 'paid by pump.fun',
  })[role] || 'paid by pump.fun'
  const f = coin.fees || {}
  if (coin.level === 0 && !has) return (
    <div className="card pad feeflow">
      <div className="panel-head"><span>where ${coin.symbol} creator fees go</span></div>
      <p className="small muted" style={{ marginTop: 8 }}>${coin.symbol} is the platform coin. Its own creator fees go to the {BRAND.name} team, which keeps the machines running. {SPLIT.burn}% of the creator fees of every coin launched on {BRAND.name} buys ${coin.symbol} and burns it.</p>
      <p className="tiny muted"><PumpLink c={coin} className="link">see it on pump.fun</PumpLink></p>
    </div>
  )
  return (
    <div className="card pad feeflow">
      <div className="panel-head"><span>where ${coin.symbol} creator fees go</span>{STATUS_PILL[status]}</div>
      <div className="split-bar" aria-hidden="true">{rows.map(r => <i key={`${r.role}${r.address || ''}`} style={{ flex: r.bps }} className={roleOf(r.role, coin).cls} />)}</div>
      <ul className="split-list" style={{ marginTop: 12 }}>
        {rows.map(r => { const ro = roleOf(r.role, coin); return <li key={`${r.role}${r.address || ''}`}><i className={ro.cls} /><span>{fmtNum(r.bps / 100)}% {ro.label}</span><em>{has ? <>{planned ? 'planned · ' : ''}<AddrLink a={r.address} /> · </> : 'expected · '}{how(r.role)}</em></li> })}
      </ul>
      {status !== 'locked' && <p className={`notice ${status === 'pending' ? 'warn' : 'err'}`}>{sharingNote(status)}</p>}
      <div className="mini3">
        <div><span>generated</span><b className="tnum">{fmtSol(f.generatedSol)} SOL</b></div>
        <div><span>distributed</span><b className="tnum">{fmtSol(f.distributedSol)} SOL</b></div>
        <div><span>waiting</span><b className="tnum">{fmtSol(f.pendingSol)} SOL</b></div>
      </div>
      <p className="tiny muted">The split is of pump.fun&apos;s creator fee, now {fmtBps(f.creatorFeeBps)} of volume on this coin. pump.fun&apos;s own protocol fee is separate. <PumpLink c={coin} className="link">see it on pump.fun</PumpLink> · <a className="link" href="#/docs#trust">what is enforced where</a></p>
    </div>
  )
}

/** A round's lines (GET /round/:id) in a modal. */
function RoundModal({ id, onClose }) {
  const { data, err } = useApi(`/round/${encodeURIComponent(id)}`)
  return (
    <Modal title="Holder round" onClose={onClose} wide>
      {data ? (
        <>
          <p className="small muted">{data.parentSymbol ? `$${data.parentSymbol} holders · ` : ''}{data.closedAt ? `closed ${timeAgo(data.closedAt)} ago` : 'open'} · {fmtSol(data.paidSol)} SOL paid to {fmtInt(data.wallets)} wallets{data.reason ? ` · ${data.reason}` : ''}</p>
          {data.linesDropped ? <p className="small muted">An older round: only its totals are kept. Every payout is on-chain in the pool's history.</p> : null}
          <div className="tbl-wrap" style={{ maxHeight: 420, overflow: 'auto' }}>
            <table className="tbl plain"><thead><tr><th>wallet</th><th className="r hide-sm">counted</th><th className="r">paid</th><th className="r">tx</th></tr></thead>
              <tbody>{(data.lines || []).map((l, i) => <tr key={`${l.wallet}${i}`} style={{ '--i': Math.min(i, 20) }}><td><AddrLink a={l.wallet} /></td><td className="r num dim hide-sm">{fmtNum(l.weightUi)}</td><td className="r num amber">{fmtSol(Number(l.lamports || 0) / 1e9)} SOL</td><td className="r">{isSig(l.sig) ? <TxLink sig={l.sig} /> : <span className="muted small">{l.status}</span>}</td></tr>)}</tbody></table>
          </div>
        </>
      ) : err ? <ErrLine msg={err} /> : <Skel n={5} h={32} />}
    </Modal>
  )
}

const ROUND_PILL = { done: <span className="pill ok">paid</span>, open: <span className="pill amber">open</span>, paying: <span className="pill amber">paying</span>, skipped: <span className="pill">skipped</span> }

/** The rounds that paid this coin's holders from its own holder pool. */
export function RoundsTable({ rounds, solUsd }) {
  const [open, setOpen] = useState(null)
  if (!rounds?.length) return null
  return (
    <>
      <div className="tbl-wrap">
        <table className="tbl plain">
          <thead><tr><th>when</th><th>status</th><th className="r">paid</th><th className="r hide-sm">value</th><th className="r hide-sm">wallets</th><th className="r">tx</th></tr></thead>
          <tbody>{rounds.map((r, i) => (
            <tr key={r.id} className="link" style={{ '--i': i }} onClick={() => r.status !== 'open' && setOpen(r.id)}>
              <td className="num dim">{r.status === 'open' ? `opened ${timeAgo(r.openedAt)} ago` : `${timeAgo(r.closedAt || r.openedAt)} ago`}</td>
              <td><span data-tip={r.reason || undefined}>{ROUND_PILL[r.status] || <span className="pill">{r.status}</span>}</span></td>
              <td className="r num amber">{r.status === 'open' ? '—' : `${fmtSol(r.paidSol)} SOL`}</td>
              <td className="r num dim hide-sm">{r.status === 'open' ? '' : fmtUsd((r.paidSol || 0) * (solUsd || 0))}</td>
              <td className="r num hide-sm">{r.status === 'open' ? '—' : fmtInt(r.wallets)}</td>
              <td className="r">{r.sigs?.[0] ? <TxLink sig={r.sigs[0]}>{r.sigs.length > 1 ? `${r.sigs.length} txs` : 'tx'}</TxLink> : ''}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      {open && <RoundModal id={open} onClose={() => setOpen(null)} />}
    </>
  )
}

/** "This coin's holders earn from its children": its own holder pool + rounds. */
function HolderPool({ c, rounds, depth, solUsd, split }) {
  const now = useNow(1000)
  const pool = c.pool || {}
  const canKids = c.level < depth
  const next = pool.nextRoundAt ? pool.nextRoundAt - now : null
  return (
    <section className="card pad">
      <div className="sec-head sm"><h2>${c.symbol} holders earn from its children</h2></div>
      {canKids ? (
        <>
          <p className="muted small" style={{ marginBottom: 14 }}>{split.parentHolders}% of the creator fees of every coin launched under ${c.symbol} is paid by pump.fun into ${c.symbol}&apos;s holder pool. Every five minutes, {BRAND.name} pays the pool out to ${c.symbol} holders in SOL: each wallet counts the smaller of its balance at the round&apos;s open and at its close, capped at {MAX_WALLET_PCT}% of a round.</p>
          <div className="mini4">
            <div><span>in the pool</span><b className="tnum amber">{fmtSol(pool.balanceSol)} SOL</b><i>{fmtUsd((pool.balanceSol || 0) * solUsd)}</i></div>
            <div><span>paid to holders</span><b className="tnum">{fmtSol(pool.paidToHoldersSol)} SOL</b><i>{fmtUsd((pool.paidToHoldersSol || 0) * solUsd)}</i></div>
            <div><span>last round</span><b className="tnum">{pool.lastRoundAt ? `${timeAgo(pool.lastRoundAt)} ago` : '—'}</b><i>{pool.lastRoundAt ? 'published with signatures' : 'none yet'}</i></div>
            <div><span>next round</span><b className="tnum">{next != null ? (next > 0 ? `in ${inFmt(next)}` : 'closing…') : '—'}</b><i>{pool.address ? <AddrLink a={pool.address}>pool {short(pool.address)}</AddrLink> : ''}</i></div>
          </div>
          {rounds?.length ? <div style={{ marginTop: 12 }}><RoundsTable rounds={rounds} solUsd={solUsd} /></div> : <Empty title="No rounds yet." sub={`Once $${c.symbol}'s children trade, ${split.parentHolders}% of their creator fees reaches this pool and is paid to $${c.symbol} holders every five minutes.`} />}
        </>
      ) : (
        <Empty title="A leaf." sub={`Level ${depth} is as deep as the tree goes, so no coin can launch under $${c.symbol} and its holder pool receives nothing. Its own creator fees still pay $${c.parentSymbol} holders.`} cta={c.parent ? <a className="btn" href={`#/launch?under=${c.parent}`}>launch under ${c.parentSymbol}</a> : null} />
      )}
    </section>
  )
}

/** The bonding-curve card: progress to graduation, or graduated. */
function CurveCard({ c }) {
  const cv = c.curve || {}
  return (
    <section className="card pad bond">
      <Ring v={cv.progress} bonded={cv.graduated} size={64} stroke={5} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <b>{cv.graduated ? 'Graduated to PumpSwap.' : `${fmtPct(cv.progress, 1)} of the bonding curve`}</b>
        <p className="muted">{cv.graduated
          ? <>pump.fun migrated ${c.symbol} when its curve completed and burned the liquidity tokens; nobody, including the launcher, pump.fun and {BRAND.name}, can withdraw that liquidity. The fee split followed it. {cv.ammPool && <AddrLink a={cv.ammPool}>PumpSwap pool {Icon.ext}</AddrLink>}</>
          : <><span className="tnum">{fmtSol(cv.realSol)}</span> of about <span className="tnum">{PHASE.gradSol}</span> SOL of real liquidity is in the curve. When it completes, pump.fun migrates ${c.symbol} to PumpSwap and burns the liquidity tokens. The fee split follows it.</>}</p>
        {!cv.graduated && <Bar v={cv.progress} />}
      </div>
    </section>
  )
}

export function CoinPage({ mint, stats }) {
  const { data, err, reload } = useCoin(mint)
  const w = useWallet()
  const c = data?.coin
  const [tab, setTab] = useState('trades')
  const depth = maxDepthOf(stats)
  const split = splitOf(stats)
  const solUsd = stats?.sol?.usd || 0
  useEffect(() => { if (c) document.title = `$${c.symbol} · ${c.name} — ${BRAND.name}`; return () => { document.title = `${BRAND.name} — ${BRAND.tagline}` } }, [c?.symbol]) // eslint-disable-line

  if (err && !data) return <div className="wrap page"><Empty className="tall" glyph={Icon.warn} title="No coin at that address." sub={err.includes('404') || /unknown|not found/i.test(err) ? `That address is not a coin on ${BRAND.name}.` : err} cta={<span className="cta-row"><button className="btn" onClick={reload}>{Icon.refresh} retry</button><a className="btn primary" href="#/coins">explore coins</a></span>} /></div>
  if (!c) return <div className="wrap page"><div className="coin-head skel-head"><div className="skel" style={{ width: 64, height: 64, borderRadius: 18 }} /><div className="skel" style={{ width: 260, height: 40 }} /></div><div className="tiles"><Skel n={6} h={88} /></div></div>

  const isRoot = c.level === 0
  const canKids = false // every coin sits directly under the ROOT coin
  const isCreator = w.account && w.account === c.creator
  const tradePts = (data.events || []).filter(e => e.type === 'trade' && e.extra?.priceUsd).map(e => ({ at: e.at, v: e.extra.priceUsd })).sort((a, b) => a.at - b.at)
  const pairAddr = c.curve?.graduated && c.curve?.ammPool ? c.curve.ammPool : c.mint
  const hasPair = !MOCK && (c.trades24h > 0 || c.curve?.graduated)
  const kidsNodes = [{ mint: c.mint, symbol: c.symbol, name: c.name, logo: c.logo, parent: null, level: 0, mcapUsd: c.mcapUsd, vol1hUsd: c.vol1hUsd, progress: c.curve?.progress, graduated: c.curve?.graduated, kids: c.kids }, ...(data.kids || []).map(k => ({ mint: k.mint, symbol: k.symbol, name: k.name, logo: k.logo, parent: c.mint, level: 1, mcapUsd: k.mcapUsd, vol1hUsd: k.vol1hUsd, progress: k.curve?.progress, graduated: k.curve?.graduated, kids: k.kids }))]
  const pool = c.pool || {}
  const fromKids = (pool.paidToHoldersSol || 0) + (pool.balanceSol || 0)
  const cBps = creatorBpsOf(c)
  const mine = { received: launcherSolOf(c), measured: typeof c.fees?.toLauncherSol === 'number', waiting: (c.fees?.pendingSol || 0) * cBps / 10_000 }

  return (
    <div className="wrap page coin">
      <div className="crumbs">
        <a href="#/coins">explore</a>
        {[...(data.parents || [])].reverse().map(p => <span key={p.mint}>{Icon.arrow}<a href={`#/coin/${p.mint}`}>${p.symbol}</a></span>)}
        <span>{Icon.arrow}<b>${c.symbol}</b></span>
      </div>
      <header className="coin-head">
        <Logo coin={c} size={72} round={false} />
        <div className="coin-title">
          <h1>{c.name} <span className={`sym ${isRoot ? 'amber' : ''}`}>${c.symbol}</span></h1>
          <div className="coin-meta">
            {isRoot ? <span className="chip mono">the platform coin</span> : <span className="chip mono">{SPLIT.parentHolders}% of fees → packs for holders</span>}
            <span className="chip" data-tip="set by pump.fun, not by the launcher">creator fee {fmtBps(c.fees?.creatorFeeBps)}</span>
            <Copy text={c.mint} label={`CA ${short(c.mint)}`} />
            <PumpLink c={c} className="chip">pump.fun {Icon.ext}</PumpLink>
            <span>by <AddrLink a={c.creator} /> · {timeAgo(c.createdAt)} ago</span>
            {c.socials?.twitter && safeHttp(c.socials.twitter) && <a className="iconlink" href={c.socials.twitter} target="_blank" rel="noreferrer" aria-label="X" data-tip="X">{Icon.x}</a>}
            {c.socials?.telegram && safeHttp(c.socials.telegram) && <a className="iconlink" href={c.socials.telegram} target="_blank" rel="noreferrer" aria-label="Telegram" data-tip="Telegram">{Icon.tg}</a>}
            {c.socials?.website && safeHttp(c.socials.website) && <a className="iconlink" href={c.socials.website} target="_blank" rel="noreferrer" aria-label="website" data-tip="website">{Icon.globe}</a>}
          </div>
          {c.description && <p className="desc">{c.description}</p>}
        </div>
        {canKids && <a className="btn primary head-cta" href={`#/launch?under=${c.mint}`}>{Icon.plus} launch under ${c.symbol}</a>}
      </header>

      <div className="tiles">
        <div className="tile"><span>price</span><b><Sm s={fmtUsd(c.priceUsd)} /></b><i className="price"><Sm s={fmtSmall(c.priceSol)} /> SOL</i></div>
        <div className="tile"><span>market cap</span><b className="tnum"><Num v={c.mcapUsd} f={fmtUsd} /></b><i>{fmtSol(c.mcapSol)} SOL</i></div>
        <div className="tile"><span>bonding curve</span><b className="tnum">{c.curve?.graduated ? 'graduated' : fmtPct(c.curve?.progress)}</b><i>{c.curve?.graduated ? 'trading on PumpSwap' : `${fmtSol(c.curve?.realSol)} of ~${PHASE.gradSol} SOL`}</i></div>
        <div className="tile"><span>24h volume</span><b className="tnum"><Num v={c.vol24hUsd} f={fmtUsd} /></b><i>{fmtInt(c.trades24h)} trades · {fmtUsd(c.vol1hUsd)} 1h</i></div>
        <div className="tile"><span>holders</span><b className="tnum"><Num v={c.holders} /></b><i>{isRoot ? 'the platform coin' : `${fmtInt(data.packs?.round?.entrants || 0)} in this round`}</i></div>
        {isRoot ? <div className="tile"><span>burned</span><b className="tnum"><Num v={c.burnedRootUi} f={fmtNum} /></b><i>by {SPLIT.burn}% of every coin</i></div> : <div className="tile"><span>pack pot</span><b className="tnum ember">{fmtUsd(data.packs?.potUsd || 0)}</b><i>{fmtPct(data.packs?.progress || 0)} of a {fmtUsd(data.packs?.priceUsdc || stats?.pack?.priceUsdc || 50)} pack · {fmtInt(data.packs?.packs || 0)} opened</i></div>}
      </div>

      <div className="coin-grid">
        <div className="coin-main">
          <CurveCard c={c} />

          <section className="card chart">
            {hasPair ? <iframe title="chart" src={`https://dexscreener.com/solana/${pairAddr}?embed=1&theme=dark&trades=0&info=0`} loading="lazy" allow="clipboard-write" /> : <div className="pad" style={{ padding: 20 }}><div className="panel-head"><span>price · last trades</span><span className="mono muted">{tradePts.length ? `${tradePts.length} samples` : ''}</span></div><Sparkline points={tradePts} /></div>}
          </section>

          {canKids && (
            <section className="card pad kids">
              <div className="sec-head sm"><h2>Children <span className="muted">{fmtInt(c.kids)}</span></h2><a className="ghost" href={`#/launch?under=${c.mint}`}>launch under ${c.symbol} {Icon.arrow}</a></div>
              <Tree nodes={kidsNodes} height={240} compact caption={false} maxDepth={depth} />
              {data.kids?.length ? (
                <div className="tbl-wrap" style={{ marginTop: 8 }}><table className="tbl plain"><thead><tr><th>coin</th><th className="r">mcap</th><th className="r hide-sm">24h vol</th><th className="r">children</th><th>curve</th></tr></thead><tbody>{data.kids.map((k, i) => <CoinTr key={k.mint} c={k} i={i} maxDepth={depth} cols={['coin', 'mcap', 'vol24', 'kids', 'status']} />)}</tbody></table></div>
              ) : (
                <Empty title={`No children under $${c.symbol} yet.`} sub={`Anyone can launch one. ${split.parentHolders}% of its creator fees will pay $${c.symbol} holders.`} cta={<a className="btn primary" href={`#/launch?under=${c.mint}`}>{Icon.plus} launch under ${c.symbol}</a>} />
              )}
              {data.kids?.length > 0 && <a className="btn primary block lg" href={`#/launch?under=${c.mint}`}>{Icon.plus} launch under ${c.symbol}</a>}
            </section>
          )}

          {!isRoot && <PackMachine coin={c} packs={data.packs} pulls={data.pulls} stats={stats} />}

          <Proof coin={c} />

          <section className="card pad activity">
            <div className="sec-head sm"><h2>Activity</h2><Seg value={tab} onChange={setTab} options={[{ value: 'trades', label: 'trades' }, { value: 'events', label: 'events' }, { value: 'holders', label: 'top holders' }]} /></div>
            {tab === 'holders' ? (data.holdersTop?.length ? (
              <table className="tbl plain"><thead><tr><th>#</th><th>wallet</th><th className="r">share</th><th className="r hide-sm">amount</th></tr></thead>
                <tbody>{data.holdersTop.map((h, i) => <tr key={h.wallet} style={{ '--i': i }}><td className="rank">{i + 1}</td><td><AddrLink a={h.wallet} /> {h.wallet === c.creator && <span className="pill">launcher</span>}{h.wallet === w.account && <span className="pill ok">you</span>}</td><td className="r num">{fmtPct(h.share, 2)}</td><td className="r num dim hide-sm">{fmtNum(h.amountUi)}</td></tr>)}</tbody></table>
            ) : <Empty title="No holders yet." sub="The first buyer appears here." />) : (
              (() => { const rows = (data.events || []).filter(e => (tab === 'trades' ? e.type === 'trade' && e.mint === c.mint : e.type !== 'trade')); return rows.length ? <div className="feed">{rows.slice(0, 30).map((e, i) => <FeedRow key={e.id} e={e} i={Math.min(i, 20)} />)}</div> : <Empty title={tab === 'trades' ? 'No trades yet.' : 'Nothing yet.'} sub={tab === 'trades' ? 'Be the first.' : 'Launches, split locks, distributions, rounds and burns for this coin land here.'} /> })()
            )}
          </section>
        </div>

        <aside className="coin-side">
          <TradeBox coin={c} solUsd={solUsd} onDone={reload} />
          {isCreator && !isRoot && cBps > 0 && (
            <div className="card pad creator">
              <div className="panel-head"><span>{Icon.spark} your {fmtNum(cBps / 100)}%</span><span className="pill ok">you launched this</span></div>
              <b className="big amber">{mine.measured ? '' : '≈ '}{fmtSol(mine.received)} <small>SOL received</small></b>
              <p className="muted small">≈ {fmtSol(mine.waiting)} SOL is waiting for the next distribution. pump.fun pays your share straight to your wallet whenever distribution runs; there is nothing to claim, and it never passes through {BRAND.name}.</p>
              <a className="btn block" href="#/me">my coins and earnings {Icon.arrow}</a>
            </div>
          )}
          <FeeSplit coin={c} />
          <div className="card pad addrs">
            <div className="panel-head"><span>addresses</span></div>
            <dl>
              <dt>mint</dt><dd><Addr a={c.mint} sm /></dd>
              <dt>fee sharing</dt><dd>{c.sharing?.config ? <Addr a={c.sharing.config} sm /> : <span className="muted">being locked</span>}</dd>
              {!isRoot && <><dt>pack pot</dt><dd><Addr a={data.packs?.pool} sm /></dd><dt>card vault</dt><dd><Addr a={data.packs?.vault} sm /></dd></>}
              {c.curve?.ammPool && <><dt>PumpSwap pool</dt><dd><Addr a={c.curve.ammPool} sm /></dd></>}
              <dt>launcher</dt><dd><Addr a={c.creator} sm /></dd>
              <dt>launch</dt><dd><TxLink sig={c.launchTx}>{short(c.launchTx)}</TxLink></dd>
            </dl>
            <div className="stack" style={{ gap: 8 }}>
              <PumpLink c={c} className="btn block sm">view on pump.fun {Icon.ext}</PumpLink>
              <a className="btn block sm" href={shareIntent(c, c.parentSymbol)} target="_blank" rel="noreferrer">{Icon.x} share ${c.symbol}</a>
            </div>
          </div>
        </aside>
      </div>
    </div>
  )
}

/* ======================================================================
   LAUNCH — prepare → sign → submit → poll /launch/:id (sent → created → live)
   ====================================================================== */

const PENDING_KEY = 'gachapad-launch-pending'
const readPending = () => { try { const p = JSON.parse(localStorage.getItem(PENDING_KEY) || 'null'); return p?.id && Date.now() - p.at < 3_600_000 ? p : null } catch { return null } }
const savePending = p => { try { localStorage.setItem(PENDING_KEY, JSON.stringify({ ...p, at: Date.now() })) } catch {} }
const clearPending = () => { try { localStorage.removeItem(PENDING_KEY) } catch {} }
const TICKER_RE = /^[A-Z][A-Z0-9]{1,9}$/
/** An engine message as a sentence: capital first letter, closing period. */
const sentence = s => { const t = String(s || '').trim(); return t ? t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.') : '' }
const bytes = s => new TextEncoder().encode(s).length

function launchErrorCopy(e, depth) {
  const raw = e?.shortMessage || e?.message || 'Launch failed.'
  const m = raw.toLowerCase()
  // every engine blocker comes back as a 503 (API.md: the same text as /launch-meta.blocker)
  if (e?.status === 503 || /disabled|paused|kill|blocker|canary/.test(m)) return `Launches are paused right now. Nothing was signed. ${sentence(raw)}`
  if (/depth/.test(m)) return `That coin is already ${depth} levels deep, the deepest the tree goes. Launch under its parent instead.`
  if (/ticker|symbol/.test(m)) return `${raw} Tickers are 2–10 letters or digits, start with a letter, and must be new on ${BRAND.name}.`
  if (/parent/.test(m)) return `That parent is not a coin on ${BRAND.name}. Pick one from the list.`
  if (/image|logo/.test(m)) return 'The image was rejected. Use a PNG, JPG, GIF or WEBP under 4 MB.'
  if (/balance|insufficient|funds/.test(m)) return 'Your wallet does not hold enough SOL for the setup, the network rent and the first buy. Lower the first buy, or add SOL.'
  if (/expired|blockhash|too old/.test(m)) return 'The prepared transaction expired before it was sent. Nothing was charged — try again.'
  if (/identical|mismatch|tamper|signature/.test(m)) return 'The signed transaction did not match what the engine built, so it refused to send it. Nothing was sent — try again.'
  if (e?.status === 429) return 'Too many launches from here in a short time. Wait a minute and try again.'
  return raw
}

function ParentPicker({ value, onChange, root, depth }) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const dq = useDebounced(q.trim(), 250)
  const { data } = useApi(open ? `/coins?q=${encodeURIComponent(dq)}&limit=12&sort=mcap` : null)
  const box = useRef(null)
  useEffect(() => { const f = e => { if (!box.current?.contains(e.target)) setOpen(false) }; document.addEventListener('mousedown', f); return () => document.removeEventListener('mousedown', f) }, [])
  const items = (data?.items || []).filter(c => c.level < depth)
  return (
    <div className="ppick" ref={box}>
      {value ? (
        <div className="ppick-val">
          <Logo coin={value} size={40} />
          <div><b>${value.symbol} <span className="muted">{value.name}</span></b><small className="muted">{value.level === 0 ? 'the root' : `level ${value.level} · child of $${value.parentSymbol}`} · {fmtUsd(value.mcapUsd)} mcap · <Sm s={fmtUsd(value.priceUsd)} /></small></div>
          <button type="button" className="btn sm" onClick={() => { onChange(null); setOpen(true) }}>change</button>
        </div>
      ) : (
        <label className="search-pill inline" style={{ flex: '1 1 100%' }}>{Icon.search}<input value={q} onChange={e => { setQ(e.target.value); setOpen(true) }} onFocus={() => setOpen(true)} placeholder={root ? `search a coin, or pick $${root.symbol}` : `search a coin on ${BRAND.name}`} autoFocus /></label>
      )}
      {open && !value && (
        <div className="search-pop static">
          {root && !dq && <button type="button" onClick={() => { onChange(root); setOpen(false) }}><Logo coin={root} size={26} /><b>${root.symbol}</b><span>{root.name} · the root</span><em>{fmtUsd(root.mcapUsd)}</em></button>}
          {items.filter(c => c.mint !== root?.mint).map(c => <button type="button" key={c.mint} onClick={() => { onChange(c); setOpen(false) }}><Logo coin={c} size={26} /><b>${c.symbol}</b><span>{c.name} · {c.level === 0 ? 'the root' : `child of $${c.parentSymbol}`}</span><em>{fmtUsd(c.mcapUsd)}</em></button>)}
          {data && !items.length && !root && <p className="muted">nothing matches</p>}
        </div>
      )}
    </div>
  )
}

const LAUNCH_STAGES = { connecting: 'Connecting your wallet', preparing: 'Building the launch', signing: 'Approve in your wallet', submitting: 'Sending', sent: 'Confirming on Solana', created: 'Live on pump.fun · locking the split', live: 'Split locked on pump.fun' }
const STAGE_ORDER = Object.keys(LAUNCH_STAGES)

export function Launch({ q, stats }) {
  const w = useWallet()
  const meta = useLaunchMeta()
  const m = meta.data
  const root = stats?.root || null
  const under = q?.under
  const preset = useApi(under ? `/coin/${encodeURIComponent(under)}` : null)
  const depth = maxDepthOf(stats, m)
  const split = splitOf(stats)
  const setup = m?.setupSol ?? SETUP_SOL
  const buyMax = Number(m?.firstBuyMaxSol) || 0
  const reserved = useMemo(() => new Set((m?.tickers?.reserved || []).map(s => String(s).toUpperCase())), [m])
  const [parent, setParent] = useState(null)
  const machinesQ = useMachines()
  const machineList = machinesQ.data?.machines || []
  const [code, setCode] = useState(q?.machine || '')
  useEffect(() => { if (!code && machinesQ.data?.default) setCode(machinesQ.data.default) }, [machinesQ.data]) // eslint-disable-line
  const picked = machineList.find(x => x.code === code) || null
  const [f, setF] = useState({ name: '', symbol: '', description: '', twitter: '', telegram: '', website: '', firstBuy: '' })
  const [image, setImage] = useState(null)
  const [imgBusy, setImgBusy] = useState(false)
  const [drag, setDrag] = useState(false)
  const [stage, setStage] = useState(null)
  const [msg, setMsg] = useState(null)
  const [result, setResult] = useState(null)
  const [costs, setCosts] = useState(null)
  const [pending, setPending] = useState(readPending)
  const busy = useRef(false)
  // every coin launches directly under the ROOT coin (the engine requires it)
  useEffect(() => { if (root && parent?.mint !== root.mint) setParent(root) }, [root]) // eslint-disable-line
  const set = k => e => setF(p => ({ ...p, [k]: k === 'symbol' ? e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) : e.target.value }))

  const killed = !!stats?.engine?.killed
  const blocker = m?.blocker || (killed ? 'The engine is paused (kill switch).' : null)
  const launchesOn = (m ? m.enabled !== false : stats?.engine?.live?.launch !== false) && !blocker
  const parentSym = parent ? parent.symbol : BRAND.ticker
  const buyN = f.firstBuy.trim() === '' ? 0 : Number(String(f.firstBuy).replace(',', '.'))
  const problems = [
    // before the ROOT coin exists a coin launches on its own and joins it when it is adopted (the engine allows it)
    !f.name.trim() && 'a name',
    bytes(f.name.trim()) > 32 && 'a name of 32 bytes or fewer',
    !TICKER_RE.test(f.symbol) && 'a ticker of 2–10 letters or digits, starting with a letter',
    reserved.has(f.symbol) && `a ticker other than $${f.symbol} (reserved)`,
    !image && 'an image',
    (!picked || !picked.open) && 'an open pack machine',
    f.description.length > 400 && 'a shorter description',
    !(buyN >= 0) && 'a valid first buy (0 is fine)',
    buyMax > 0 && buyN > buyMax && `a first buy of at most ${buyMax} SOL`,
    f.website && !safeHttp(f.website) && 'a valid website (https://…)',
    f.telegram && !/^(https?:\/\/)?(t\.me|telegram\.me)\//i.test(f.telegram.trim()) && 'a valid Telegram link',
  ].filter(Boolean)

  useEffect(() => {
    if (!pending?.id) return
    let alive = true
    setStage(s => (STAGE_ORDER.indexOf(s) > STAGE_ORDER.indexOf('submitting') ? s : 'sent'))
    const poll = async () => {
      const until = Date.now() + 240_000
      let last = null
      while (alive && Date.now() < until) {
        try {
          const s = await api(`/launch/${encodeURIComponent(pending.id)}`, { fresh: true })
          if (!alive) return
          last = s.status
          if (s.status === 'sent') setStage('sent')
          if (s.status === 'created') { setStage('created'); bust() }
          if (s.status === 'live') { clearPending(); setPending(null); setStage('live'); setResult({ mint: s.mint || pending.mint, sig: s.sig, symbol: pending.symbol, parentSymbol: pending.parentSymbol, level: pending.level }); bust(); return }
          if (s.status === 'failed') { clearPending(); setPending(null); setStage('failed'); setMsg(`The launch did not land: ${s.error || 'no reason given'}.${s.sig ? '' : ' Nothing was charged.'}`); return }
          if (s.status === 'expired') { clearPending(); setPending(null); setStage('failed'); setMsg('The prepared launch expired before it was sent. Nothing was charged — try again.'); return }
        } catch (e) { if (e.status === 404) { clearPending(); setPending(null); setStage('failed'); setMsg('The engine has no record of that launch. Nothing was charged — try again.'); return } }
        await new Promise(r => setTimeout(r, 2_000))
      }
      if (!alive) return
      if (last === 'created') setMsg(<>Your coin is live on pump.fun; the split lock has not landed yet. The engine keeps retrying, and the coin page shows the lock status. <a className="link" href={`#/coin/${pending.mint}`}>open ${pending.symbol}</a></>)
      else setMsg('Still confirming. Keep this page open, or come back — it picks the launch up where it left off.')
    }
    poll()
    return () => { alive = false }
  }, [pending?.id]) // eslint-disable-line

  async function onFile(file) {
    if (!file) return
    setImgBusy(true); setMsg(null)
    try { setImage(await imageToDataUrl(file)) } catch (e) { setMsg(e.message) } finally { setImgBusy(false) }
  }

  async function launch() {
    if (busy.current || problems.length || pending || !launchesOn) return
    busy.current = true; setMsg(null); setCosts(null)
    try {
      setStage('connecting')
      const account = w.account || await w.connect()
      setStage('preparing')
      const socials = {}
      const h = xHandle(f.twitter); if (h) socials.twitter = `https://x.com/${h}`
      if (f.telegram.trim()) socials.telegram = /^https?:\/\//i.test(f.telegram.trim()) ? f.telegram.trim() : `https://${f.telegram.trim()}`
      if (f.website.trim()) socials.website = f.website.trim()
      const prep = await post('/launch/prepare', { wallet: account, ...(parent ? { parent: parent.mint } : {}), packCode: code, name: f.name.trim(), symbol: f.symbol, description: f.description.trim() || undefined, image, socials, ...(buyN > 0 ? { firstBuySol: buyN } : {}) })
      if (!prep?.id || !prep?.tx || !prep?.mint) throw Object.assign(new Error('The engine sent back an incomplete launch. Nothing was signed.'), { shortMessage: 'The engine sent back an incomplete launch. Nothing was signed.' })
      setCosts(prep.costs || null)
      setStage('signing')
      const signedTx = await signTx(prep.tx, account, { label: 'launch' })
      setStage('submitting')
      const note = { id: prep.id, mint: prep.mint, symbol: f.symbol, parentSymbol: parent?.symbol || BRAND.ticker, level: (parent?.level || 0) + 1, account }
      savePending(note)
      try { await post('/launch/submit', { id: prep.id, signedTx }) } catch (e) {
        if (e.status >= 400 && e.status < 500) { clearPending(); throw e }
      }
      setPending(readPending() || note)
    } catch (e) {
      setStage(null)
      setMsg(walletSaidNo(e) ? 'Cancelled in the wallet. Nothing was sent.' : launchErrorCopy(e, depth))
    } finally { busy.current = false }
  }

  const reset = () => { setStage(null); setResult(null); setMsg(null); setCosts(null); setF(p => ({ ...p, name: '', symbol: '', description: '', firstBuy: '' })); setImage(null) }

  if (stage === 'live' && result) {
    const c = { mint: result.mint, symbol: result.symbol }
    return (
      <div className="wrap page launch-done">
        <div className="done card pad">
          <div className="done-mark"><Logo coin={{ symbol: result.symbol, logo: image }} size={88} round={false} /><i className="ripple" aria-hidden="true" /></div>
          <h1>${result.symbol} is live. Its machine is on.</h1>
          <p className="muted">It trades in SOL on pump.fun&apos;s bonding curve and graduates to PumpSwap at about {PUMP.gradSol} SOL. Its fee split is locked on pump.fun: {split.parentHolders}% of its creator fees rips {picked ? picked.name : 'pack'}s into ${result.symbol}&apos;s machine, and anyone can burn ${result.symbol} to pull a card out. {split.burn}% buys and burns ${BRAND.ticker}.</p>
          <div className="done-ca"><Copy text={result.mint} label={result.mint} /></div>
          <div className="cta-row">
            <a className="btn primary lg" href={`#/coin/${result.mint}`}>open ${result.symbol} {Icon.arrow}</a>
            <a className="btn lg" href={pumpUrlOf(c)} target="_blank" rel="noreferrer">view on pump.fun {Icon.ext}</a>
            <a className="btn lg" href={shareIntent(c, result.parentSymbol)} target="_blank" rel="noreferrer">{Icon.x} share on X</a>
          </div>
          {isSig(result.sig) && <p className="small"><TxLink sig={result.sig}>launch transaction</TxLink></p>}
        </div>
      </div>
    )
  }

  const stageIdx = STAGE_ORDER.indexOf(stage)
  const leafNext = parent && parent.level + 1 >= depth

  return (
    <div className="wrap page launch">
      <div className="page-head">
        <div><h1>Launch a coin</h1><p className="sub">A standard pump.fun coin with its own gacha machine. {split.parentHolders}% of its creator fees rips real graded cards into the machine, and burning the coin is how anyone pulls one out. {split.burn}% buys and burns ${BRAND.ticker}.</p></div>
      </div>
      {!launchesOn && (stats || m) && <div className="notice warn">Launches are paused right now.{blocker ? ` ${sentence(blocker)}` : ''} The form works; the engine will refuse to prepare until they resume.</div>}
      <div className="launch-grid">
        <form className="lform" onSubmit={e => { e.preventDefault(); launch() }}>
          <fieldset disabled={!!stage && stage !== 'failed'}>
            <div className="lblock">
              <span className="lstep">1 · Pick its machine</span>
              <p className="hint">Fixed for life. Your coin&apos;s fees buy this machine&apos;s packs (the Collector Crypt machines pump.fun sells), and the cards stay inside for people to pull.</p>
              <div className="mpick" role="radiogroup" aria-label="Pack machine">
                {!machineList.length && <div className="skel" style={{ height: 150, gridColumn: '1 / -1' }} />}
                {machineList.map(m => (
                  <button type="button" key={m.code} role="radio" aria-checked={code === m.code} disabled={!m.open} className={`mp ${code === m.code ? 'on' : ''}`} onClick={() => setCode(m.code)}>
                    <span className="mp-img">{m.image ? <img src={m.image} alt="" loading="lazy" /> : <span className="mp-ph">{m.shortName || m.name}</span>}</span>
                    <b>{m.name}</b>
                    <span className="mp-meta"><em className="tnum">{fmtUsd(m.priceUsdc)}</em> a pack{m.evUsd ? <> · avg <em className="tnum">{fmtUsd(m.evUsd)}</em></> : null}</span>
                    <i className={`lvl-${m.level || 'na'}`}>{m.open ? (m.level ? `stock ${m.level}` : 'open') : 'closed'}</i>
                  </button>
                ))}
              </div>
            </div>
            <div className="lblock">
              <span className="lstep">2 · The coin</span>
              <div className="row2">
                <Field label="Name" right={`${bytes(f.name)}/32`}><input className="input" maxLength={32} placeholder="e.g. Pika Club" value={f.name} onChange={set('name')} /></Field>
                <Field label="Ticker" right="2–10 A-Z 0-9"><span className="input tick"><i>$</i><input className="mono" placeholder="PIKA" maxLength={10} value={f.symbol} onChange={set('symbol')} /></span></Field>
              </div>
              <Field label="Description" right={`${f.description.length}/400`}><textarea className="input" rows={3} maxLength={400} placeholder="What is it? People will be burning it to pull cards." value={f.description} onChange={set('description')} /></Field>
              <div className="row2">
                <div className="field"><span className="flabel">Image <em>≤ 512 px, webp</em></span>
                  <label className={`drop ${image ? 'has' : ''} ${drag ? 'drag' : ''}`} onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)} onDrop={e => { e.preventDefault(); setDrag(false); onFile(e.dataTransfer.files?.[0]) }}>
                    <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" onChange={e => onFile(e.target.files?.[0])} />
                    {image ? <img src={image} alt="" /> : <span className="drop-ic">{Icon.image}</span>}
                    <span>{imgBusy ? 'processing…' : image ? 'change image' : 'drop an image, or click'}</span>
                  </label>
                </div>
                <div className="stack" style={{ gap: 10 }}>
                  <Field label="X" right="optional"><input className="input mono" placeholder="@handle" value={f.twitter} onChange={set('twitter')} /></Field>
                  <Field label="Telegram" right="optional"><input className="input mono" placeholder="t.me/yourgroup" value={f.telegram} onChange={set('telegram')} /></Field>
                  <Field label="Website" right="optional"><input className="input mono" placeholder="https://" value={f.website} onChange={set('website')} /></Field>
                </div>
              </div>
            </div>
            <div className="lblock">
              <span className="lstep">3 · First buy</span>
              <div className="row2">
                <Field label="First buy" right="optional" hint={`In SOL, bought on pump.fun's curve inside the launch transaction, so you hold the first tokens.${buyMax ? ` At most ${buyMax} SOL.` : ''}`}>
                  <span className="input tick"><input inputMode="decimal" placeholder="0" value={f.firstBuy} onChange={set('firstBuy')} /><i className="mono">SOL</i></span>
                </Field>
                <div className="field"><span className="flabel">Creator fee</span><p className="hint">Set by pump.fun, not by you: {PUMP.curveCreatorFee} of volume on the bonding curve today. {split.parentHolders}% of it stocks your coin&apos;s machine and {split.burn}% burns ${BRAND.ticker}. There is no launcher cut: the machine is the point.</p></div>
              </div>
            </div>
            <div className="lfoot">
              <div className="cost"><span>setup <b>≈ {setup} SOL</b></span><i>+</i><span>pump.fun network rent{m?.networkSol ? <> <b>≈ {m.networkSol} SOL</b></> : null}</span><i>·</i><span><b>no platform fee</b></span>{buyN > 0 ? <><i>·</i><span>first buy <b>{fmtNum(buyN)} SOL</b></span></> : null}</div>
              {problems.length > 0 && !stage && <p className="hint">Still needs: {problems.join(' · ')}.</p>}
              {msg && <p className={`notice ${stage === 'failed' ? 'err' : 'warn'}`}>{msg}</p>}
              {stage && stage !== 'failed' && (
                <ol className="stages">{STAGE_ORDER.map((k, i) => <li key={k} className={i < stageIdx ? 'done' : i === stageIdx ? 'now' : ''}><i />{LAUNCH_STAGES[k]}{k === 'signing' && costs ? <span className="muted mono small">&nbsp;· setup {costs.setupSol} SOL{costs.firstBuySol ? ` + first buy ${costs.firstBuySol} SOL` : ''}{costs.networkSol ? ` + network ≈ ${costs.networkSol} SOL` : ''}</span> : null}</li>)}</ol>
              )}
              <button type="submit" className="btn primary lg block" disabled={(!!stage && stage !== 'failed') || problems.length > 0 || !!pending || !launchesOn}>
                {stage && stage !== 'failed' ? `${LAUNCH_STAGES[stage]}…` : !w.account ? 'connect & launch' : `launch $${f.symbol || 'TICKER'}`}
              </button>
              {stage === 'failed' && <button type="button" className="btn block" onClick={() => { setStage(null); setMsg(null) }}>try again</button>}
            </div>
          </fieldset>
        </form>
        <aside className="lside">
          <div className="preview card">
            <div className="pv-img">{picked?.image ? <img className="pv-machine" src={picked.image} alt="" /> : null}{image || !picked?.image ? <span className="pv-logo"><Logo coin={{ symbol: f.symbol || '?', logo: image }} size={72} round={false} /></span> : null}</div>
            <div className="pv-body">
              <b>{f.name.trim() || 'Your coin'} <span className="mono">${f.symbol || 'TICKER'}</span></b>
              <small>on <em>{BRAND.name}</em> · {picked ? picked.name : 'pick a machine'}</small>
              <div className="pv-stats"><div><span>trades on</span><b>pump.fun</b></div><div><span>pack price</span><b className="tnum">{picked ? fmtUsd(picked.priceUsdc) : '—'}</b></div><div><span>to its machine</span><b>{split.parentHolders}%</b></div></div>
            </div>
          </div>
          <div className="card pad what">
            <div className="panel-head"><span>what happens</span></div>
            <ol>
              <li><b>One signature.</b> The engine builds one transaction that creates the coin on pump.fun and funds the setup of its fee split, about {setup} SOL. Your wallet signs it, and it is relayed exactly as signed. {BRAND.name} never holds your funds.</li>
              <li><b>Live on pump.fun at once.</b> A standard pump.fun coin on the bonding curve, bought and sold with SOL. No mint authority, no freeze authority.</li>
              <li><b>The split is locked seconds later.</b> {BRAND.name} writes {split.parentHolders}% machine / {split.burn}% ${BRAND.ticker} burn into pump.fun&apos;s fee-sharing configuration and revokes admin rights in the same transaction. Neither you nor {BRAND.name} can change it afterwards.</li>
              <li><b>Its fees rip packs.</b> pump.fun pays the machine&apos;s pool; {BRAND.name} swaps it to USDC and, at {picked ? fmtUsd(picked.priceUsdc) : 'the pack price'}, buys and opens a pack. The card goes into your coin&apos;s machine.</li>
              <li><b>Burn to pull.</b> Anyone can burn your coin to pull a random card out: price = the machine&apos;s average card + 10%, card picked by a Solana block after the burn. Every pull burns supply.</li>
            </ol>
          </div>
        </aside>
      </div>
    </div>
  )
}

/* ======================================================================
   TREE PAGE
   ====================================================================== */

export function TreePage({ stats }) {
  const { data, err, loading, reload } = useTree()
  const [hover, setHover] = useState(null)
  const [sel, setSel] = useState(null)
  const depth = maxDepthOf(stats)
  const split = splitOf(stats)
  const nodes = data?.nodes || []
  const byMint = useMemo(() => new Map(nodes.map(n => [n.mint, n])), [nodes])
  const focus = hover || sel || nodes.find(n => n.level === 0) || null
  const kids = focus ? nodes.filter(n => n.parent === focus.mint).sort((a, b) => b.mcapUsd - a.mcapUsd) : []
  const parent = focus && focus.parent ? byMint.get(focus.parent) : null
  const wide = useMedia('(min-width: 900px)')
  return (
    <div className="wrap page treepage">
      <div className="tree-stage card">
        <div className="panel-head"><span><Dot state="up" /> {fmtInt(nodes.length)} coins · {fmtInt(nodes.filter(n => n.level === 1).length)} under the root · {fmtInt(nodes.filter(n => n.level >= 2).length)} deeper</span><span className="muted small hide-sm">hover to inspect · click to open</span></div>
        <Tree nodes={nodes} full legend art maxDepth={depth} onHover={setHover} onSelect={n => { setSel(n); if (!wide) go(`/coin/${n.mint}`) }} selected={sel?.mint} />
        {err && !data && <ErrLine msg={err} onRetry={reload} />}
      </div>
      <aside className="tree-side card pad">
        {focus ? (
          <>
            <div className="ts-head">
              <Logo coin={focus} size={44} />
              <div><b>${focus.symbol} <span className="muted">{focus.name}</span></b><small className="muted">{focus.level === 0 ? 'the root' : `level ${focus.level} · child of $${parent?.symbol || '…'}`}</small></div>
            </div>
            <div className="ts-stats">
              <div><span>mcap</span><b className="tnum">{fmtUsd(focus.mcapUsd)}</b></div>
              <div><span>1h vol</span><b className="tnum">{fmtUsd(focus.vol1hUsd)}</b></div>
              <div><span>{focus.graduated ? 'status' : 'curve'}</span><b className="tnum">{focus.graduated ? 'graduated' : fmtPct(focus.progress)}</b></div>
              <div><span>children</span><b className="tnum">{fmtInt(focus.kids)}</b></div>
            </div>
            <div className="cta-row"><a className="btn primary sm" href={`#/coin/${focus.mint}`}>open {Icon.arrow}</a>{focus.level < depth && <a className="btn sm" href={`#/launch?under=${focus.mint}`}>launch under</a>}{parent && <a className="btn ghost sm" href={`#/coin/${parent.mint}`}>{Icon.up} ${parent.symbol}</a>}</div>
            <div className="ts-kids">
              <span className="eyebrow">{focus.level < depth ? `children of $${focus.symbol}` : 'a leaf'}</span>
              {kids.length ? kids.map(k => (
                <a key={k.mint} className="ts-kid" href={`#/coin/${k.mint}`} onMouseEnter={() => setHover(k)} onMouseLeave={() => setHover(null)}>
                  <Logo coin={k} size={26} /><b>${k.symbol}</b><span className="tnum">{fmtUsd(k.mcapUsd)}</span>{k.graduated ? <span className="pill amber">graduated</span> : <Ring v={k.progress} size={20} stroke={2.5} />}
                </a>
              )) : focus.level < depth ? <p className="muted small">none yet — <a className="link" href={`#/launch?under=${focus.mint}`}>be the first</a></p> : <p className="muted small">level {depth} is the deepest the tree goes.</p>}
            </div>
          </>
        ) : loading ? <Skel n={5} h={40} /> : (
          <div className="ts-pre">
            <Empty title={<>Root launches <em>soon.</em></>} sub={`The tree starts with $${BRAND.ticker}, a pump.fun coin. ${split.parentHolders}% of the creator fees of every coin launched under it pays $${BRAND.ticker} holders.`} cta={<span className="cta-row" style={{ justifyContent: 'center' }}><a className="btn primary sm" href={BRAND.xUrl} target="_blank" rel="noreferrer">{Icon.x} follow {BRAND.handle}</a><a className="btn sm" href="#/token">${BRAND.ticker} {Icon.arrow}</a></span>} />
            <dl className="spec sm">
              <div><dt>root</dt><dd>${BRAND.ticker} · a pump.fun coin</dd></div>
              <div><dt>depth</dt><dd>root → coin → child → grandchild</dd></div>
              <div><dt>every coin trades</dt><dd>on pump.fun, in SOL</dd></div>
              <div><dt>graduates</dt><dd>~{PUMP.gradSol} SOL → PumpSwap</dd></div>
              <div><dt>to parent holders</dt><dd>{split.parentHolders}% of creator fees</dd></div>
            </dl>
          </div>
        )}
      </aside>
    </div>
  )
}

/* ======================================================================
   TOKEN (ROOT)
   ====================================================================== */

export function Token({ stats }) {
  const root = stats?.root
  const burns = useApi(root ? '/burns?limit=30' : null, { every: 20_000 })
  const rounds = useApi(root ? `/rounds?mint=${encodeURIComponent(root.mint)}&limit=20` : null, { every: 20_000 })
  const t = stats?.totals
  const split = splitOf(stats), rootSplit = rootSplitOf(stats)
  const solUsd = stats?.sol?.usd || 0
  useEffect(() => { document.title = `$${root?.symbol || BRAND.ticker} — ${BRAND.name}`; return () => { document.title = `${BRAND.name} — ${BRAND.tagline}` } }, [root?.symbol])
  if (stats && !root) return (
    <div className="wrap page token pre">
      <div className={`token-hero ${hasBg('token') ? 'has-art' : ''}`}>
        <Bg name="token" eager />
        <div className="token-body">
          <div className="token-core" aria-hidden="true" />
          <span className="eyebrow amber">${BRAND.ticker} · the platform coin</span>
          <h1>${BRAND.ticker} launches soon.</h1>
          <p>${BRAND.ticker} is the platform coin of {BRAND.name}. {SPLIT.burn}% of the creator fees of every coin launched here buys ${BRAND.ticker} and burns it.</p>
          <div className="cta-row">{BRAND.xUrl ? <a className="btn primary" href={BRAND.xUrl} target="_blank" rel="noreferrer">{Icon.x} follow {BRAND.handle}</a> : null}<a className="btn" href="#/docs#token">read the docs {Icon.arrow}</a></div>
          <p className="token-spec">a pump.fun coin <i>·</i> no mint authority <i>·</i> {SPLIT.burn}% of every coin burns it <i>·</i> its own fees go to the team</p>
        </div>
      </div>
      <section className="section token-sec"><RootFlows sym={BRAND.ticker} split={split} rootSplit={rootSplit} /></section>
      <section className="section token-sec"><TokenWhat sym={BRAND.ticker} split={split} rootSplit={rootSplit} /></section>
      <section className="section token-sec"><Proof coin={null} /></section>
    </div>
  )
  if (!root) return <div className="wrap page"><Skel n={4} h={88} /></div>
  const pool = root.pool || {}
  return (
    <div className="wrap page token">
      <div className="token-hero live">
        <Bg name="token" className="compact" />
        <header className="coin-head token-head">
          <Logo coin={root} size={72} round={false} />
          <div className="coin-title">
            <span className="eyebrow amber">the platform coin</span>
            <h1>{root.name} <span className="sym amber">${root.symbol}</span></h1>
            <div className="coin-meta"><span className="chip mono">platform coin</span><span className="chip" data-tip="set by pump.fun">creator fee {fmtBps(root.fees?.creatorFeeBps)}</span><span className="chip">{SPLIT.burn}% of every machine&apos;s fees burns it</span><Addr a={root.mint} label={`CA ${short(root.mint)}`} /><PumpLink c={root} className="chip">pump.fun {Icon.ext}</PumpLink></div>
          </div>
          <a className="btn primary head-cta" href="#/launch">{Icon.plus} launch a coin</a>
        </header>
      </div>
      <div className="tiles" style={{ marginTop: 16 }}>
        <div className="tile"><span>price</span><b className="amber"><Sm s={fmtUsd(root.priceUsd)} /></b><i className="price"><Sm s={fmtSmall(root.priceSol)} /> SOL</i></div>
        <div className="tile"><span>market cap</span><b className="tnum amber"><Num v={root.mcapUsd} f={fmtUsd} /></b><i>{root.curve?.graduated ? 'graduated · PumpSwap' : `${fmtPct(root.curve?.progress)} of the curve`}</i></div>
        <div className="tile"><span>burned</span><b className="tnum amber"><Num v={t?.burnedRootUi} f={fmtNum} /></b><i>{fmtUsd(t?.burnedRootUsd)} · {fmtPct((t?.burnedRootUi || 0) / 1e9, 2)} of supply</i></div>
        <div className="tile"><span>holders</span><b className="tnum"><Num v={root.holders} /></b><i>of ${root.symbol}</i></div>
        <div className="tile"><span>24h volume</span><b className="tnum"><Num v={root.vol24hUsd} f={fmtUsd} /></b><i>{fmtInt(root.trades24h)} trades</i></div>
        <div className="tile"><span>coins launched</span><b className="tnum"><Num v={t?.coins ? t.coins - 1 : root.kids} /></b><i className="amber">{fmtInt(t?.packs?.packs || 0)} packs ripped · {fmtInt(t?.packs?.inMachines || 0)} cards in machines</i></div>
      </div>
      <div className="coin-grid">
        <div className="coin-main">
          {!root.curve?.graduated && <CurveCard c={root} />}
          <section className="card pad"><RootFlows sym={root.symbol} split={split} rootSplit={rootSplit} stack /></section>
          <section className="card pad">
            <div className="sec-head sm"><h2>Burn ledger</h2><span className="muted small">every buy and burn links to Solscan</span></div>
            {burns.data ? (burns.data.length ? (
              <div className="tbl-wrap"><table className="tbl plain"><thead><tr><th>when</th><th className="r">burned</th><th className="r hide-sm">spent</th><th className="r hide-sm">value</th><th className="r">tx</th></tr></thead>
                <tbody>{burns.data.map((b, i) => <tr key={b.sig || i} style={{ '--i': i }}><td className="num dim">{timeAgo(b.at)} ago</td><td className="r num amber">{fmtNum(b.amountUi)} ${root.symbol}</td><td className="r num hide-sm">{fmtSol(b.spentSol)} SOL</td><td className="r num hide-sm">{fmtUsd(b.amountUsd)}</td><td className="r"><span className="txpair">{isSig(b.swapSig) && <TxLink sig={b.swapSig}>buy</TxLink>}<TxLink sig={b.sig}>burn</TxLink></span></td></tr>)}</tbody></table></div>
            ) : <Empty glyph={Icon.flame} title="No burns yet." sub={`The first creator fees of any coin on ${BRAND.name} light it.`} />) : burns.err ? <ErrLine msg={burns.err} onRetry={burns.reload} /> : <Skel n={5} h={36} />}
          </section>
          <section className="card pad"><TokenWhat sym={root.symbol} quote={root.quoteSymbol} split={split} rootSplit={rootSplit} stack /></section>
          <section className="card pad">
            <div className="sec-head sm"><h2>Addresses</h2></div>
            <dl className="addrs-dl">
              <dt>mint</dt><dd><Addr a={root.mint} label={root.mint} sm /></dd>
              <dt>creator (fees to the team)</dt><dd>{root.creator ? <Addr a={root.creator} label={root.creator} sm /> : <span className="muted">—</span>}</dd>
              {root.curve?.ammPool && <><dt>PumpSwap pool</dt><dd><Addr a={root.curve.ammPool} label={root.curve.ammPool} sm /></dd></>}
              <dt>pump.fun program</dt><dd><Addr a={PUMP.program} label={PUMP.program} sm /></dd>
              <dt>pump.fun fee sharing</dt><dd><Addr a={PUMP.feesProgram} label={PUMP.feesProgram} sm /></dd>
              <dt>launch</dt><dd><TxLink sig={root.launchTx}>{short(root.launchTx, 8)}</TxLink></dd>
            </dl>
            <PumpLink c={root} className="btn sm">view ${root.symbol} on pump.fun {Icon.ext}</PumpLink>
          </section>
        </div>
        <aside className="coin-side">
          <TradeBox coin={root} solUsd={solUsd} />
          <FeeSplit coin={root} />
        </aside>
      </div>
    </div>
  )
}

/* ---------------- the two flows that support the root (INTRO §6): copy + one warm flow diagram ---------------- */

function RootFlows({ sym, split, rootSplit, stack = false }) {
  return (
    <div className={`rootflows ${stack ? 'stack' : ''}`}>
      <div className="rf-copy">
        <span className="eyebrow ember">what feeds it</span>
        <h2>Every coin burns <em>${sym}.</em></h2>
        <p><b>{split.burn}% of every coin&apos;s creator fees buys ${sym} and burns it.</b> Every coin launched on {BRAND.name}, on the curve and after graduation. The split is locked on pump.fun at each launch.</p>
        <p><b>The other {split.parentHolders}% stocks that coin&apos;s machine.</b> It rips real graded-card packs into the coin&apos;s own machine, and people burn the coin to pull cards out.</p>
        <p className="small muted">${sym}&apos;s own creator fees go to the {BRAND.name} team, which runs the engine, pays the gas and keeps the machines open.</p>
      </div>
    </div>
  )
}

/* ---------------- what the root is (INTRO §6) ---------------- */

function TokenWhat({ sym, quote, split, rootSplit, stack = false }) {
  return (
    <div className={`token-what ${stack ? 'stack' : ''}`}>
      <div className="tw-copy">
        <span className="eyebrow amber">what ${sym} is</span>
        <h2>The platform coin, <em>a pump.fun coin.</em></h2>
        <p>${sym} is a pump.fun coin like every coin on {BRAND.name}. Like every pump.fun coin it has no mint authority and no freeze authority, and when its curve completes pump.fun burns the liquidity tokens.</p>
      </div>
      <dl className="spec">
        <div><dt>trades on</dt><dd>pump.fun, in {quote || 'SOL'}</dd></div>
        <div><dt>its own creator fees</dt><dd>the {BRAND.name} team</dd></div>
        <div><dt>from every coin launched</dt><dd>{split.burn}% of creator fees → buy + burn</dd></div>
        <div><dt>mint / freeze authority</dt><dd>none</dd></div>
        <div><dt>liquidity at graduation</dt><dd className="amber">burned by pump.fun</dd></div>
      </dl>
    </div>
  )
}

/* ======================================================================
   ME — earned as holder (rounds), earned as creator, launched coins
   ====================================================================== */

export function Me({ stats }) {
  const w = useWallet()
  const { data, err, loading, reload } = useApi(w.account ? `/wallet/${w.account}` : null, { every: 20_000 })
  const solUsd = stats?.sol?.usd || 0
  const depth = maxDepthOf(stats)
  if (!w.account) return (
    <div className="wrap page"><div className="empty tall"><i>{Icon.wallet}</i><h4>Connect a wallet.</h4><p>See the cards you won and the coins you launched.</p><button className="btn primary" onClick={() => w.connect().catch(() => {})}>Connect</button></div></div>
  )
  const launched = data?.launched || []
  return (
    <div className="wrap page me">
      <div className="page-head"><div><span className="eyebrow">you</span><h1 className="mono">{short(w.account, 6)}</h1><p className="sub"><AddrLink a={w.account}>view on Solscan {Icon.ext}</AddrLink></p></div></div>
      <div className="tiles three">
        <div className="tile"><span>cards won</span><b className="tnum ember"><Num v={data?.won?.length || 0} /></b><i>{fmtUsd((data?.won || []).reduce((acc, p) => acc + (Number(p.card?.valueUsd) || 0), 0))} insured value</i></div>
        <div className="tile"><span>coins launched</span><b className="tnum"><Num v={launched.length} /></b><i>{stats?.root ? `on ${BRAND.name}` : ''}</i></div>
        <div className="tile"><span>packs they opened</span><b className="tnum"><Num v={launched.reduce((acc, c) => acc + (c.packs?.packs || 0), 0)} /></b><i>{fmtUsd(launched.reduce((acc, c) => acc + (c.packs?.pulledUsd || 0), 0))} pulled</i></div>
      </div>
      <section className="card pad">
        <div className="sec-head sm"><h2>Cards I won</h2><a className="ghost" href="#/pulls">all pulls {Icon.arrow}</a></div>
        {data ? (data.won?.length ? <div className="rail">{data.won.map(p => <PullCard key={p.id} p={p} />)}</div> : <Empty title="No cards yet." sub="Hold a coin whose pot is filling. Your chance at each card is your average holding since the last one." />) : loading ? <Skel n={2} h={200} /> : null}
        <p className="tiny muted" style={{ marginTop: 10 }}>A won card is a real graded slab in Collector Crypt&apos;s vault, held as an NFT in your wallet. On collectorcrypt.com you can keep it, have it shipped, or sell it back instantly.</p>
      </section>
      {err && !data && <ErrLine msg={err} onRetry={reload} />}
      <section className="card pad">
        <div className="sec-head sm"><h2>Coins I launched</h2><a className="ghost" href="#/launch">launch another {Icon.arrow}</a></div>
        {data ? (launched.length ? launched.map((c, i) => (
          <div key={c.mint} className="mycoin" style={{ '--i': i }}>
            <Logo coin={c} size={36} />
            <div><b><a href={`#/coin/${c.mint}`}>{c.name}</a> <span className="mono">${c.symbol}</span></b><small>{fmtUsd(c.mcapUsd)} mcap · {c.curve?.graduated ? 'graduated' : `${fmtPct(c.curve?.progress)} of the curve`} · pot {fmtUsd(c.packs?.potUsd || 0)} · {fmtInt(c.packs?.packs || 0)} packs</small></div>
            <div className="mycoin-claim"><span>{STATUS_PILL[c.sharing?.status || 'pending']}</span><b>{fmtUsd(c.packs?.pulledUsd || 0)}</b><span>pulled for its holders</span></div>
            <PumpLink c={c} className="btn sm">pump.fun {Icon.ext}</PumpLink>
          </div>
        )) : <Empty title="You have not launched anything yet." sub="Name it, add an image, one signature." cta={<a className="btn primary sm" href="#/launch">launch a coin</a>} />) : loading ? <Skel n={3} h={62} /> : null}
      </section>
      <p className="tiny muted" style={{ marginTop: 14 }}>Your cards and coins live in your wallet. <AddrLink a={w.account}>see them on Solscan</AddrLink>.</p>
    </div>
  )
}

/* ======================================================================
   ADMIN (plain, functional)
   ====================================================================== */

export function Admin({ stats }) {
  const w = useWallet()
  const [secret, setSecret] = useState(() => { try { return sessionStorage.getItem('gachapad-admin') || '' } catch { return '' } })
  const [f, setF] = useState({ name: BRAND.name, symbol: BRAND.ticker, description: '', twitter: '', website: '', telegram: '', firstBuySol: '', hidden: false })
  const [tl, setTl] = useState({ parent: '', name: '', symbol: '', description: '', firstBuySol: '', hidden: true })
  const [image, setImage] = useState(null)
  const [tlImage, setTlImage] = useState(null)
  const [adopt, setAdopt] = useState('')
  const [hideMint, setHideMint] = useState('')
  const [roundParent, setRoundParent] = useState('')
  const [log, setLog] = useState([])
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const hdr = { 'x-admin-secret': secret }
  useEffect(() => { try { sessionStorage.setItem('gachapad-admin', secret) } catch {} }, [secret])
  const say = (m, ok = true) => setLog(l => [{ at: Date.now(), m: typeof m === 'string' ? m : JSON.stringify(m, null, 2), ok }, ...l].slice(0, 40))
  const act = async (path, body) => { setBusy(true); try { const r = await post(path, body || {}, hdr); say(`${path} → ${JSON.stringify(r)}`); bust() } catch (e) { say(`${path} ✕ ${e.shortMessage || e.message}`, false) } finally { setBusy(false) } }
  const dump = async () => { setBusy(true); try { setState(await api('/admin/state', { headers: hdr, fresh: true })) } catch (e) { say(`/admin/state ✕ ${e.shortMessage || e.message}`, false) } finally { setBusy(false) } }
  const pollLaunch = async id => {
    let last = ''
    for (let i = 0; i < 120; i++) {
      await new Promise(r => setTimeout(r, 2000))
      let s
      try { s = await api(`/launch/${id}`, { fresh: true }) } catch (e) { say(`/launch/${id} ✕ ${e.shortMessage || e.message}`, false); continue }
      if (s.status !== last) { last = s.status; say(`${id}: ${s.status}${s.mint ? ` mint=${s.mint}` : ''}${s.sig ? ` sig=${s.sig}` : ''}${s.error ? ` error=${s.error}` : ''}`, s.status !== 'failed' && s.status !== 'expired') }
      if (['live', 'failed', 'expired'].includes(s.status)) { bust(); return }
    }
    say(`${id}: still ${last} after 4 min — check /admin/state`, false)
  }
  const signSubmit = async (prep, account, label) => {
    say(`prepared id=${prep.id} mint=${prep.mint || '?'}${prep.costs ? ` costs=${JSON.stringify(prep.costs)}` : ''}`)
    const signedTx = await signTx(prep.tx, account, { label })
    say('signed; submitting…')
    const sub = await post('/launch/submit', { id: prep.id, signedTx })
    say(`submitted sig=${sub.sig} mint=${sub.mint} status=${sub.status || '?'}`)
    await pollLaunch(prep.id)
  }
  const socialsOf = o => { const s = {}; if (o.twitter) s.twitter = o.twitter; if (o.website) s.website = o.website; if (o.telegram) s.telegram = o.telegram; return s }
  async function launchRoot() {
    if (busy) return
    setBusy(true)
    try {
      const account = w.account || await w.connect()
      say(`preparing root${f.hidden ? ' (hidden)' : ''}…`)
      const prep = await post('/admin/root/prepare', { wallet: account, name: f.name, symbol: f.symbol, description: f.description, image, socials: socialsOf(f), hidden: !!f.hidden, ...(Number(f.firstBuySol) > 0 ? { firstBuySol: Number(f.firstBuySol) } : {}) }, hdr)
      await signSubmit(prep, account, 'root launch')
    } catch (e) { say(`✕ ${e.shortMessage || e.message}`, false) } finally { setBusy(false) }
  }
  async function testLaunch() {
    if (busy) return
    setBusy(true)
    try {
      const account = w.account || await w.connect()
      say(`preparing test launch under ${tl.parent || 'ROOT'}${tl.hidden ? ' (hidden)' : ' (VISIBLE)'}…`)
      const prep = await post('/admin/prepare', { wallet: account, parent: tl.parent || stats?.root?.mint, name: tl.name, symbol: tl.symbol, description: tl.description || undefined, image: tlImage, socials: {}, hidden: !!tl.hidden, ...(Number(tl.firstBuySol) > 0 ? { firstBuySol: Number(tl.firstBuySol) } : {}) }, hdr)
      await signSubmit(prep, account, 'test launch')
    } catch (e) { say(`✕ ${e.shortMessage || e.message}`, false) } finally { setBusy(false) }
  }
  const off = busy || !secret
  const eng = stats?.engine
  return (
    <div className="wrap page admin">
      <div className="page-head"><div><span className="eyebrow">admin</span><h1>Engine controls</h1><p className="sub">Plain and functional. The secret stays in this tab&apos;s sessionStorage.{MOCK ? ' Mock: the secret is "demo".' : ''}</p></div></div>
      <div className="admin-grid">
        <div className="card pad">
          <Field label="admin secret"><input className="input mono" type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder="x-admin-secret" autoComplete="off" /></Field>
          <div className="cta-row">
            <button className="btn sm" disabled={off} onClick={dump}>GET /admin/state</button>
            <button className="btn sm" disabled={off} onClick={() => act('/admin/refresh')}>refresh</button>
            <button className="btn sm" disabled={off} onClick={() => act('/admin/distribute')}>distribute</button>
            <button className="btn sm" disabled={off} onClick={() => act('/admin/burn')}>burn</button>
            <button className="btn sm danger" disabled={off} onClick={() => confirm('Halt the engine (kill switch)?') && act('/admin/kill')}>KILL</button>
            <button className="btn sm" disabled={off} onClick={() => act('/admin/unkill')}>unkill</button>
          </div>
          <div className="row2">
            <Field label="holder round for parent (mint)"><input className="input mono" value={roundParent} onChange={e => setRoundParent(e.target.value.trim())} placeholder={stats?.root?.mint || 'parent mint'} /></Field>
            <div className="field"><span className="flabel">&nbsp;</span><button className="btn sm" disabled={off || !(roundParent || stats?.root?.mint)} onClick={() => act('/admin/round', { parent: roundParent || stats?.root?.mint })}>run round</button></div>
          </div>
          <div className="row2">
            <Field label="hide / unhide coin (mint)"><input className="input mono" value={hideMint} onChange={e => setHideMint(e.target.value.trim())} placeholder="mint" /></Field>
            <div className="field"><span className="flabel">&nbsp;</span><div className="cta-row" style={{ margin: 0 }}><button className="btn sm" disabled={off || !hideMint} onClick={() => act('/admin/hide', { mint: hideMint, hidden: true })}>hide</button><button className="btn sm" disabled={off || !hideMint} onClick={() => act('/admin/hide', { mint: hideMint, hidden: false })}>unhide</button></div></div>
          </div>
          <p className="small muted">engine: {eng?.killed ? 'KILLED' : 'running'} · canary: {eng?.canary || '…'} · live flags: {eng?.live ? Object.entries(eng.live).map(([k, v]) => `${k}=${v ? 'on' : 'off'}`).join(' ') : '…'} · engine SOL {eng?.balances?.engineSol ?? '…'} · burn SOL {eng?.balances?.burnSol ?? '…'}</p>
          {state && <pre className="dump">{JSON.stringify(state, null, 2)}</pre>}
        </div>
        <div className="card pad">
          <div className="sec-head sm"><h2>ROOT</h2>{stats?.root && <span className="pill ok">root is ${stats.root.symbol}</span>}</div>
          <div className="row2">
            <Field label="adopt an existing pump.fun coin as ROOT (mint)"><input className="input mono" value={adopt} onChange={e => setAdopt(e.target.value.trim())} placeholder="mint" /></Field>
            <div className="field"><span className="flabel">&nbsp;</span><div className="cta-row" style={{ margin: 0 }}><button className="btn sm" disabled={off || !adopt} onClick={() => confirm(`Adopt ${adopt} as ROOT?`) && act('/admin/root/adopt', { mint: adopt })}>adopt</button><button className="btn sm danger" disabled={off} onClick={() => confirm('Reset ROOT? (only works while ROOT has no children)') && act('/admin/reset-root')}>reset root</button></div></div>
          </div>
          <p className="small muted" style={{ margin: '4px 0 10px' }}>or launch it from here:</p>
          <div className="row2">
            <Field label="name"><input className="input" value={f.name} onChange={e => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="ticker"><input className="input mono" value={f.symbol} onChange={e => setF({ ...f, symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) })} /></Field>
          </div>
          <Field label="description"><textarea className="input" rows={3} value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></Field>
          <Field label="image"><input type="file" accept="image/*" onChange={async e => { try { setImage(await imageToDataUrl(e.target.files?.[0])) } catch (er) { say(er.message, false) } }} />{image && <img src={image} alt="" style={{ width: 64, height: 64, borderRadius: 12, objectFit: 'cover', marginTop: 8 }} />}</Field>
          <div className="row2">
            <Field label="X"><input className="input mono" value={f.twitter} onChange={e => setF({ ...f, twitter: e.target.value })} placeholder="https://x.com/…" /></Field>
            <Field label="website"><input className="input mono" value={f.website} onChange={e => setF({ ...f, website: e.target.value })} placeholder="https://" /></Field>
          </div>
          <div className="row2">
            <Field label="telegram"><input className="input mono" value={f.telegram} onChange={e => setF({ ...f, telegram: e.target.value })} placeholder="https://t.me/…" /></Field>
            <Field label="first buy (SOL, optional)"><input className="input mono" inputMode="decimal" value={f.firstBuySol} onChange={e => setF({ ...f, firstBuySol: e.target.value })} placeholder="0" /></Field>
          </div>
          <label className="check"><input type="checkbox" checked={!!f.hidden} onChange={e => setF({ ...f, hidden: e.target.checked })} /> hidden (a test root: excluded from every public list)</label>
          <button className="btn primary block" disabled={off || !image || !f.name || !f.symbol} onClick={launchRoot}>{busy ? 'working…' : `prepare + sign + submit ROOT (${w.account ? short(w.account) : 'connect'})`}</button>
        </div>
      </div>
      <div className="admin-grid">
        <div className="card pad">
          <div className="sec-head sm"><h2>Test launch</h2><span className={`pill ${tl.hidden ? '' : 'err'}`}>{tl.hidden ? 'hidden' : 'VISIBLE'}</span></div>
          <div className="row2">
            <Field label="parent (mint; empty = ROOT)"><input className="input mono" value={tl.parent} onChange={e => setTl({ ...tl, parent: e.target.value.trim() })} placeholder={stats?.root?.mint || 'ROOT'} /></Field>
            <Field label="first buy (SOL, optional)"><input className="input mono" inputMode="decimal" value={tl.firstBuySol} onChange={e => setTl({ ...tl, firstBuySol: e.target.value })} placeholder="0" /></Field>
          </div>
          <div className="row2">
            <Field label="name"><input className="input" value={tl.name} onChange={e => setTl({ ...tl, name: e.target.value })} /></Field>
            <Field label="ticker"><input className="input mono" value={tl.symbol} onChange={e => setTl({ ...tl, symbol: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) })} /></Field>
          </div>
          <Field label="image"><input type="file" accept="image/*" onChange={async e => { try { setTlImage(await imageToDataUrl(e.target.files?.[0])) } catch (er) { say(er.message, false) } }} /></Field>
          <label className="check"><input type="checkbox" checked={!!tl.hidden} onChange={e => setTl({ ...tl, hidden: e.target.checked })} /> hidden (default; its page 404s and it never appears in public lists)</label>
          <button className="btn block" disabled={off || !tlImage || !tl.name || !tl.symbol || !(tl.parent || stats?.root?.mint)} onClick={testLaunch}>{busy ? 'working…' : 'prepare + sign + submit test launch'}</button>
        </div>
        <div className="card pad"><div className="sec-head sm"><h2>Log</h2></div>{log.length ? <pre className="dump">{log.map(l => `${new Date(l.at).toLocaleTimeString()} ${l.ok ? '·' : '✕'} ${l.m}`).join('\n')}</pre> : <p className="muted small">nothing yet</p>}</div>
      </div>
    </div>
  )
}
