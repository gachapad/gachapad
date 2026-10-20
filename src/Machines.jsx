// Gachapad: every coin's card machine on the site. The slab (a real graded card photo), a coin's machine (the cards
// inside, the next pack, burn-to-pull), the machines list, the pulls feed and one pull with its proof.
import { useState, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { BRAND, PUMP, PUMP_URL, SOLSCAN, splitOf, PULL_MARGIN_PCT } from './config'
import { api, post, bust, useCoin, useMachine, useCoins, useBurnPulls, useApi } from './api'
import { Icon, Logo, Skel, Empty, ErrLine, TxLink, AddrLink, Copy, fmtUsd, fmtNum, fmtInt, timeAgo, short, useNow, Ring, Sm, fmtSmall, toast, isSig } from './ui'
import { useWallet } from './App'
import { signTx, walletSaidNo } from './wallet'
import { TradeBox, Token } from './Pages'

const COIN_DEC = 6
const tokensUi = raw => Number(BigInt(raw || 0)) / 10 ** COIN_DEC
export const fmtTok = raw => { const n = tokensUi(raw); return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : fmtInt(n) }
const gradeOf = c => [c?.grader, c?.grade].filter(Boolean).join(' ')

/* ---------------- the slab: a real graded card, as photographed by Collector Crypt ---------------- */

export function Slab({ card, size = 'md', href, onClick, tag, caption = true, className = '', eager = false }) {
  const [ok, setOk] = useState(true)
  const body = (
    <figure className={`slab2 s-${size} ${className}`}>
      <div className="slab2-img">
        {card?.image && ok
          ? <img src={card.image} alt={card.name || 'graded card'} loading={eager ? 'eager' : 'lazy'} decoding="async" referrerPolicy="no-referrer" onError={() => setOk(false)} />
          : <span className="slab2-ph"><b>{card?.grader || 'Graded'}</b><i>{card?.cardName || 'card'}</i></span>}
        <i className="glare" aria-hidden="true" />
        {tag && <em className="slab2-tag">{tag}</em>}
      </div>
      {caption && card && size !== 'xs' && (
        <figcaption>
          <span className="sc-name">{card.cardName || card.name}</span>
          <span className="sc-meta"><i>{gradeOf(card) || card.set || ''}</i>{card.valueUsd ? <b className="tnum">{fmtUsd(card.valueUsd)}</b> : null}</span>
        </figcaption>
      )}
    </figure>
  )
  if (href) return <a className="slab2-link" href={href}>{body}</a>
  if (onClick) return <button type="button" className="slab2-link" onClick={onClick}>{body}</button>
  return body
}

/** Up to three slabs, fanned. */
export function Fan({ cards = [], size = 'xs' }) {
  const list = cards.slice(0, 3)
  if (!list.length) return <span className="fan empty" aria-hidden="true"><i /><i /><i /></span>
  return <span className={`fan n${list.length}`}>{list.map((c, i) => <Slab key={i} card={c} size={size} caption={false} />)}</span>
}

/** The capsule mark: a pixel capsule, closed or popped. */
const Capsule = ({ open = false }) => <img className={`capsule-ic ${open ? 'open' : ''}`} src="/mark-gacha.png?v=6" alt="" aria-hidden="true" />

/* ---------------- machines list ---------------- */

const SORTS = [['cards', 'most cards'], ['value', 'most value'], ['new', 'newest'], ['mcap', 'market cap'], ['pull', 'cheapest pull']]

export function MachineRow({ c }) {
  const p = c.packs || {}
  const m = p.machine
  return (
    <a className="mrow" href={`#/coin/${c.mint}`}>
      <span className="mrow-coin">
        <Logo coin={c} size={44} round={false} />
        <span className="mrow-id"><b>{c.name}</b><span><em className="mono">${c.symbol}</em>{m ? <i>{m.shortName || m.name}</i> : null}</span></span>
      </span>
      <span className="mrow-fan"><Fan cards={p.top || []} /></span>
      <span className="mrow-n"><b className="tnum">{fmtInt(p.stock || 0)}</b><small>cards inside</small></span>
      <span className="mrow-n"><b className="tnum">{fmtUsd(p.stockUsd || 0)}</b><small>value inside</small></span>
      <span className="mrow-n"><b className="tnum">{p.pullUsd ? fmtUsd(p.pullUsd, { cents: true }) : '—'}</b><small>per pull</small></span>
      <span className="mrow-n hide-md"><b className="tnum">{c.mcapUsd ? fmtUsd(c.mcapUsd) : '—'}</b><small>market cap</small></span>
      <span className="mrow-next hide-md">
        <span className="nextbar"><span style={{ width: `${Math.min(100, Math.max(2, (p.progress || 0) * 100))}%` }} /></span>
        <small>{m ? `${fmtUsd(p.potUsd || 0)} of ${fmtUsd(m.priceUsdc)} to the next pack` : 'next pack'}</small>
      </span>
      <span className="mrow-go" aria-hidden="true">{Icon.arrow}</span>
    </a>
  )
}

export function MachinesPage({ q, stats }) {
  const [sort, setSort] = useState(q?.sort && SORTS.some(s => s[0] === q.sort) ? q.sort : 'cards')
  const [query, setQuery] = useState('')
  const coins = useCoins({ sort, q: query.trim(), limit: 100 }, 12_000)
  const items = (coins.data?.items || []).filter(c => !c.root && c.packs)
  const t = stats?.totals?.packs || {}
  return (
    <div className="wrap page machines">
      <header className="ph">
        <div>
          <h1>Machines</h1>
          <p className="sub">Every coin here is a gacha machine. Its fees rip real graded cards into it, and burning the coin is the only way to pull one out.</p>
        </div>
        <dl className="ph-stats">
          <div><dt>cards in machines</dt><dd className="tnum">{fmtInt(t.inMachines || 0)}</dd></div>
          <div><dt>packs ripped</dt><dd className="tnum">{fmtInt(t.packs || 0)}</dd></div>
          <div><dt>card value pulled</dt><dd className="tnum">{fmtUsd(t.valueUsd || 0)}</dd></div>
        </dl>
      </header>
      <div className="toolbar">
        <div className="seg" role="tablist">{SORTS.map(([k, l]) => <button key={k} role="tab" aria-selected={sort === k} className={sort === k ? 'on' : ''} onClick={() => setSort(k)}>{l}</button>)}</div>
        <label className="input search-in">{Icon.search}<input placeholder="Search a coin or ticker" value={query} onChange={e => setQuery(e.target.value)} /></label>
      </div>
      {coins.err && !coins.data ? <ErrLine msg={coins.err} onRetry={coins.reload} />
        : !coins.data ? <Skel n={6} h={84} />
        : items.length ? <div className="mlist">{items.map(c => <MachineRow key={c.mint} c={c} />)}</div>
        : <Empty glyph={<Capsule />} title={query ? 'No machine by that name.' : 'No machines yet.'} sub="Launch a coin and it gets one." cta={<a className="btn primary" href="#/launch">Launch a coin</a>} />}
    </div>
  )
}

/* ---------------- one coin's machine ---------------- */

function MachineCase({ data, coin, highlight }) {
  const stock = data?.stock || []
  const m = data?.machine
  const potUsd = coin?.packs?.potUsd || 0
  const price = m?.priceUsdc || coin?.packs?.machine?.priceUsdc || 0
  const prog = price ? Math.min(1, potUsd / price) : 0
  const sorted = useMemo(() => stock.slice().sort((a, b) => (Number(b.card?.valueUsd) || 0) - (Number(a.card?.valueUsd) || 0)), [stock])
  return (
    <section className="case">
      <div className="case-head">
        <div className="case-title">
          {m?.image ? <img className="case-mimg" src={m.image} alt="" /> : <Capsule />}
          <div>
            <b>{m?.name || 'Pack machine'}</b>
            <span>{m ? <>{fmtUsd(m.priceUsdc)} packs · from Collector Crypt via pump.fun{m.level ? <> · <em className={`lvl-${m.level}`}>stock {m.level}</em></> : null}</> : 'loading…'}</span>
          </div>
        </div>
        <dl className="case-stats">
          <div><dt>cards inside</dt><dd className="tnum">{fmtInt(stock.length)}</dd></div>
          <div><dt>value inside</dt><dd className="tnum">{fmtUsd(data?.figures?.stockUsd || 0)}</dd></div>
          <div><dt>average card</dt><dd className="tnum">{data?.figures?.avgUsd ? fmtUsd(data.figures.avgUsd, { cents: true }) : '—'}</dd></div>
        </dl>
      </div>
      <div className="case-glass">
        {sorted.length ? (
          <div className="case-grid">{sorted.map(r => <Slab key={r.id} card={r.card} size="sm" className={highlight === r.id ? 'hl' : ''} />)}</div>
        ) : (
          <div className="case-empty"><Capsule /><b>No cards inside yet.</b><span>The first pack rips when ${coin?.symbol || ''}&apos;s fees reach {price ? fmtUsd(price) : 'a pack'}.</span></div>
        )}
        <i className="case-reflect" aria-hidden="true" />
      </div>
      <div className="case-foot">
        <span className="nextbar lg"><span style={{ width: `${Math.max(1.5, prog * 100)}%` }} /></span>
        <span className="case-next"><b className="tnum">{fmtUsd(potUsd, { cents: true })}</b> of {price ? fmtUsd(price) : '—'} toward the next pack <span className="muted">· fees convert to USDC as the coin trades</span></span>
      </div>
    </section>
  )
}

function PullPanel({ coin, data, onPull }) {
  const f = data?.figures || {}
  const open = data?.pullsOpen
  const can = open && f.available > 0 && f.tokensRaw && f.priceUsd
  return (
    <div className="pullp card">
      <div className="pullp-head"><Capsule /><div><b>Pull a card</b><span>Burn ${coin.symbol}, get a random card from this machine.</span></div></div>
      <div className="pullp-price">
        <div><span>one pull</span><b className="tnum">{f.priceUsd ? fmtUsd(f.priceUsd, { cents: true }) : '—'}</b></div>
        <div><span>you burn</span><b className="tnum">{f.tokensRaw ? `${fmtTok(f.tokensRaw)} $${coin.symbol}` : '—'}</b></div>
      </div>
      <button className="btn primary lg block" disabled={!can} onClick={onPull}>
        {!open ? 'Pulls open soon' : !f.stock ? 'Machine is empty' : f.busy ? 'Someone is pulling…' : !f.tokensRaw ? 'Price settling…' : `Burn & pull`}
      </button>
      <ul className="pullp-notes">
        <li><span>cards you can win</span><b className="tnum">{fmtInt(f.stock || 0)}</b></li>
        <li><span>price</span><b>average card + {PULL_MARGIN_PCT}%</b></li>
        <li><span>card chosen by</span><b>a Solana block after your burn</b></li>
      </ul>
      <p className="tiny muted">{f.busy ? 'One pull at a time per machine: the next one opens in about a minute. ' : ''}Burns are final. The coin is priced at its lowest reading of the last 10 minutes, so a pump never makes a pull cheaper.</p>
    </div>
  )
}

const STEPS = [['quote', 'Quote'], ['sign', 'Sign the burn'], ['sent', 'Burning'], ['burned', 'Machine locked'], ['drawn', 'Card picked'], ['delivered', 'In your wallet']]
const stepOf = (stage, p) => {
  if (p?.status === 'delivered') return 5
  if (p?.status === 'drawn') return 4
  if (p?.status === 'burned' || p?.status === 'waiting') return 3
  if (p?.status === 'sent' || p?.status === 'unseen') return 2
  if (stage === 'sign') return 1
  return 0
}

export function PullModal({ coin, data, onClose, onDone }) {
  const w = useWallet()
  const [stage, setStage] = useState('quote')
  const [err, setErr] = useState(null)
  const [quote, setQuote] = useState(null)
  const [pull, setPull] = useState(null)
  const [flipped, setFlipped] = useState(false)
  const busy = useRef(false)
  const f = data?.figures || {}
  const now = useNow(1000)

  useEffect(() => {
    if (!quote?.id) return
    let alive = true
    const tick = async () => {
      while (alive) {
        try {
          const r = await api(`/burn/${quote.id}`, { fresh: true })
          if (!alive) return
          setPull(r.pull)
          if (['drawn', 'delivered'].includes(r.pull.status) && !flipped) setTimeout(() => alive && setFlipped(true), 900)
          if (r.pull.status === 'delivered') { bust(); onDone?.(r.pull); return }
          if (['invalid', 'void'].includes(r.pull.status)) { setErr(r.pull.reason || 'The burn did not go through.'); return }
        } catch {}
        await new Promise(res => setTimeout(res, 2000))
      }
    }
    tick()
    return () => { alive = false }
  }, [quote?.id]) // eslint-disable-line

  async function go() {
    if (busy.current) return
    busy.current = true; setErr(null)
    try {
      const account = w.account || await w.connect()
      setStage('sign')
      const q = await post('/burn/prepare', { mint: coin.mint, wallet: account })
      setQuote(q)
      const signed = await signTx(q.tx, account, { label: 'burn' })
      setStage('sent')
      const s = await post(`/burn/${q.id}/submit`, { tx: signed })
      setPull(s)
    } catch (e) {
      setStage('quote'); setQuote(null)
      setErr(walletSaidNo(e) ? 'Cancelled in the wallet. Nothing was burned.' : e.shortMessage || e.message)
    } finally { busy.current = false }
  }

  const step = stepOf(stage, pull)
  const card = pull?.card
  const seedLeft = pull?.freeze?.at && !pull?.draw ? Math.max(0, Math.round((pull.freeze.seedSlot - pull.freeze.slot) * 0.4 - (now - pull.freeze.at) / 1000)) : null
  return createPortal(
    <div className="modal-back pullm-back" onMouseDown={e => { if (e.target === e.currentTarget && (step === 0 || step === 5 || err)) onClose() }}>
      <div className="pullm" role="dialog" aria-label="Pull a card">
        <button className="iconbtn pullm-x" onClick={onClose} aria-label="Close">{Icon.close}</button>
        <div className="pullm-stage">
          <div className={`reveal-card ${flipped && card ? 'flipped' : ''} ${step >= 2 && step < 4 ? 'shake' : ''}`}>
            <div className="rc-face rc-back"><img className="rc-art" src="/gacha-hero.jpg?v=6" alt="" /><span>{step < 2 ? `$${coin.symbol}` : step < 3 ? 'burning…' : step < 4 ? 'locked' : 'revealing…'}</span></div>
            <div className="rc-face rc-front">{card ? <Slab card={card} size="lg" caption={false} /> : null}</div>
          </div>
          {flipped && card && <div className="reveal-glow" aria-hidden="true" />}
        </div>
        <div className="pullm-body">
          {flipped && card ? (
            <>
              <span className="kicker">You pulled</span>
              <h3>{card.cardName || card.name}</h3>
              <p className="muted">{[gradeOf(card), card.set, card.year].filter(Boolean).join(' · ')}</p>
              <p className="pullm-val tnum">{card.valueUsd ? fmtUsd(card.valueUsd) : ''}<small> insured value</small></p>
            </>
          ) : (
            <>
              <span className="kicker">${coin.symbol} machine</span>
              <h3>{step === 0 ? 'Burn to pull a card' : step === 1 ? 'Sign in your wallet' : step === 2 ? 'Burning on-chain' : step === 3 ? 'The machine is locked' : 'Picking your card'}</h3>
              <p className="muted">
                {step === 0 && <>One pull burns <b className="tnum">{f.tokensRaw ? fmtTok(f.tokensRaw) : '…'} ${coin.symbol}</b> (about {f.priceUsd ? fmtUsd(f.priceUsd, { cents: true }) : '…'}). You get one of the {fmtInt(f.stock || 0)} cards inside, picked by a Solana block after your burn.</>}
                {step === 1 && <>Your wallet shows a burn of {quote ? fmtTok(quote.tokens) : '…'} ${coin.symbol} with a memo. Nothing else moves.</>}
                {step === 2 && <>Waiting for the burn to finalize on Solana (about 15 seconds).</>}
                {step === 3 && <>{pull?.freeze ? <>{fmtInt(pull.freeze.cards)} cards locked in. Your card comes from block {fmtInt(pull.freeze.seedSlot)}{seedLeft != null && seedLeft > 0 ? <>, in about {seedLeft}s</> : ''}.</> : pull?.status === 'waiting' ? 'Every card was spoken for: yours is the next card in.' : 'Burn confirmed. Locking the machine…'}</>}
                {step >= 4 && 'Sending the card to your wallet.'}
              </p>
            </>
          )}
          <ol className="steps">{STEPS.map(([k, l], i) => <li key={k} className={i < step ? 'done' : i === step ? 'now' : ''}><i />{l}</li>)}</ol>
          {err && <p className="notice err">{err}</p>}
          <div className="pullm-actions">
            {step === 0 && <button className="btn primary lg block" onClick={go} disabled={!f.tokensRaw || !f.available || f.busy}>{w.account ? `Burn ${f.tokensRaw ? fmtTok(f.tokensRaw) : ''} $${coin.symbol}` : 'Connect & burn'}</button>}
            {pull?.id && <a className="btn block" href={`#/burn/${pull.id}`} onClick={onClose}>View the proof {Icon.arrow}</a>}
            {step === 5 && <button className="btn primary block" onClick={onClose}>Done</button>}
          </div>
          {isSig(pull?.sig) && <p className="tiny muted center"><TxLink sig={pull.sig}>burn transaction</TxLink>{isSig(pull?.deliverySig) ? <> · <TxLink sig={pull.deliverySig}>card transfer</TxLink></> : null}</p>}
        </div>
      </div>
    </div>
 ,
    document.body,
  )
}

function BurnRow({ p, showCoin = false }) {
  return (
    <a className="brow" href={`#/burn/${p.id}`}>
      <span className="brow-card">{p.card ? <Slab card={p.card} size="xs" caption={false} /> : <Capsule open={false} />}</span>
      <span className="brow-main">
        <b>{p.card ? (p.card.cardName || p.card.name) : statusWord(p.status)}</b>
        <span><AddrLinkPlain a={p.wallet} /> burned <span className="tnum">{fmtTok(p.burned || p.tokens)}</span>{showCoin ? <> ${p.symbol}</> : null}</span>
      </span>
      <span className="brow-val tnum">{p.card?.valueUsd ? fmtUsd(p.card.valueUsd) : ''}</span>
      <span className="brow-t">{timeAgo(p.createdAt)}</span>
    </a>
  )
}
const AddrLinkPlain = ({ a }) => <span className="mono">{short(a)}</span>
const statusWord = s => ({ unseen: 'checking the chain…', sent: 'burning…', burned: 'locking the machine…', waiting: 'next card in', drawn: 'card picked', delivered: 'delivered', stuck: 'needs a hand', 'needs-attention': 'needs a hand' })[s] || s

export function CoinMachinePage({ mint, stats }) {
  const coin = useCoin(mint)
  const mach = useMachine(mint)
  const burns = useBurnPulls({ mint, limit: 30 })
  const [open, setOpen] = useState(false)
  const c = coin.data?.coin
  const split = splitOf(stats)
  if (coin.err && !coin.data) return <div className="wrap page"><ErrLine msg={coin.err} onRetry={coin.reload} /></div>
  if (!c) return <div className="wrap page"><Skel n={4} h={120} /></div>
  if (c.level === 0) return <Token stats={stats} />
  const rips = (coin.data?.pulls || []).filter(r => r.card)
  const curve = c.curve || {}
  return (
    <div className="wrap page cm">
      <header className="cm-head">
        <div className="cm-id">
          <Logo coin={c} size={64} round={false} />
          <div>
            <h1>{c.name} <span className="mono">${c.symbol}</span></h1>
            <div className="cm-meta">
              <Copy text={c.mint} label={short(c.mint, 5)} sm />
              <a className="chip" href={c.pumpUrl || PUMP_URL(c.mint)} target="_blank" rel="noreferrer">pump.fun {Icon.ext}</a>
              {c.socials?.twitter && <a className="chip" href={c.socials.twitter} target="_blank" rel="noreferrer">{Icon.x}</a>}
              {c.socials?.website && <a className="chip" href={c.socials.website} target="_blank" rel="noreferrer">{Icon.globe}</a>}
            </div>
          </div>
        </div>
        <dl className="cm-figs">
          <div><dt>market cap</dt><dd className="tnum">{c.mcapUsd ? fmtUsd(c.mcapUsd) : '—'}</dd></div>
          <div><dt>price</dt><dd><Sm s={c.priceUsd ? `$${fmtSmall(c.priceUsd)}` : '—'} /></dd></div>
          <div><dt>24h volume</dt><dd className="tnum">{fmtUsd(c.vol24hUsd || 0)}</dd></div>
          <div className="cm-curve"><Ring v={curve.graduated ? 1 : curve.progress || 0} size={34} bonded={!!curve.graduated} /><span><dt>{curve.graduated ? 'graduated' : 'bonding curve'}</dt><dd className="tnum">{curve.graduated ? 'PumpSwap' : `${Math.round((curve.progress || 0) * 100)}%`}</dd></span></div>
        </dl>
      </header>
      {c.description ? <p className="cm-desc">{c.description}</p> : null}
      <div className="cm-grid">
        <div className="cm-main">
          <MachineCase data={mach.data} coin={c} />
          <div className="pull-mobile"><PullPanel coin={c} data={mach.data} onPull={() => setOpen(true)} /></div>
          <section className="cm-sec">
            <div className="sec-h"><h2>Pulled from this machine</h2><span className="muted small">every burn, its card and its proof</span></div>
            {burns.data?.length ? <div className="blist">{burns.data.map(p => <BurnRow key={p.id} p={p} />)}</div>
              : <p className="muted small pad-y">No pulls yet. The first burn gets first pick of the odds.</p>}
          </section>
          <section className="cm-sec">
            <div className="sec-h"><h2>Packs ripped</h2><span className="muted small">what ${c.symbol}&apos;s fees put inside</span></div>
            {rips.length ? (
              <div className="rlist">{rips.map(r => (
                <div className="rrow" key={r.id}>
                  <Slab card={r.card} size="xs" caption={false} />
                  <span className="rrow-main"><b>{r.card.cardName || r.card.name}</b><span>{r.pack} · {fmtUsd(r.priceUsdc)} pack · {gradeOf(r.card)}</span></span>
                  <span className="tnum">{r.card.valueUsd ? fmtUsd(r.card.valueUsd) : ''}</span>
                  <span className={`rrow-st st-${r.status}`}>{r.status === 'stock' ? 'inside' : r.status === 'delivered' || r.status === 'pulled' ? 'pulled' : r.status}</span>
                  <span className="muted small">{timeAgo(r.at)}</span>
                  {isSig(r.sig) ? <TxLink sig={r.sig}>pack tx</TxLink> : <span />}
                </div>
              ))}</div>
            ) : <p className="muted small pad-y">No packs yet.</p>}
          </section>
        </div>
        <aside className="cm-side">
          <PullPanel coin={c} data={mach.data} onPull={() => setOpen(true)} />
          <div className="card trade-card"><TradeBox coin={c} solUsd={stats?.sol?.usd} onDone={() => { coin.reload(); mach.reload() }} /></div>
          <div className="card pad split-card">
            <div className="sec-h sm"><h3>Where ${c.symbol}&apos;s fees go</h3></div>
            <div className="splitbar"><span style={{ width: `${split.parentHolders}%` }}>{split.parentHolders}%</span><span>{split.burn}%</span></div>
            <ul className="split-legend">
              <li><i className="k1" />Stocks this machine with packs</li>
              <li><i className="k2" />Buys and burns ${BRAND.ticker}</li>
            </ul>
            <p className="tiny muted">Locked in pump.fun&apos;s fee sharing at launch, admin revoked. Nobody can change it.</p>
            {coin.data?.packs?.pool && <dl className="mini-addrs"><div><dt>machine pool</dt><dd><AddrLink a={coin.data.packs.pool} /></dd></div><div><dt>card vault</dt><dd><AddrLink a={coin.data.packs.vault} /></dd></div></dl>}
          </div>
        </aside>
      </div>
      {open && <PullModal coin={c} data={mach.data} onClose={() => { setOpen(false); mach.reload(); burns.reload() }} onDone={() => { mach.reload(); burns.reload() }} />}
    </div>
  )
}

/* ---------------- all pulls ---------------- */

export function PullsPage({ stats }) {
  const burns = useBurnPulls({ limit: 120 }, 8_000)
  const list = (burns.data || []).filter(p => p.card)
  const t = stats?.totals?.burnPulls || {}
  return (
    <div className="wrap page pulls2">
      <header className="ph">
        <div><h1>Pulls</h1><p className="sub">Every card pulled out of a {BRAND.name} machine, newest first. Each one was paid for with a burn and picked by a Solana block.</p></div>
        <dl className="ph-stats">
          <div><dt>pulls</dt><dd className="tnum">{fmtInt(t.pulls || 0)}</dd></div>
          <div><dt>delivered</dt><dd className="tnum">{fmtInt(t.delivered || 0)}</dd></div>
          <div><dt>card value</dt><dd className="tnum">{fmtUsd(t.valueUsd || 0)}</dd></div>
        </dl>
      </header>
      {burns.err && !burns.data ? <ErrLine msg={burns.err} onRetry={burns.reload} />
        : !burns.data ? <Skel n={2} h={260} />
        : list.length ? (
          <div className="pgrid">{list.map(p => (
            <a key={p.id} className="pcard" href={`#/burn/${p.id}`}>
              <Slab card={p.card} size="md" caption={false} />
              <div className="pcard-b">
                <b>{p.card.cardName || p.card.name}</b>
                <span><em className="mono">${p.symbol}</em> · <span className="mono">{short(p.wallet)}</span></span>
                <span className="pcard-v"><b className="tnum">{p.card.valueUsd ? fmtUsd(p.card.valueUsd) : ''}</b><small>{timeAgo(p.createdAt)}</small></span>
              </div>
            </a>
          ))}</div>
        ) : <Empty glyph={<Capsule />} title="No pulls yet." sub="Burn a coin on its machine page to pull the first card." cta={<a className="btn" href="#/machines">Browse machines</a>} />}
    </div>
  )
}

/* ---------------- one pull + its proof ---------------- */

export function BurnPullPage({ id }) {
  const r = useApi(`/burn/${encodeURIComponent(id)}`, { every: 5_000 })
  const p = r.data?.pull
  const c = r.data?.coin
  if (r.err && !r.data) return <div className="wrap page"><ErrLine msg={r.err} onRetry={r.reload} /></div>
  if (!p) return <div className="wrap page"><Skel n={3} h={120} /></div>
  return (
    <div className="wrap page proofp">
      <a className="ghost back" href={`#/coin/${p.mint}`}>{Icon.chevron} ${p.symbol} machine</a>
      <div className="proof-grid">
        <div className="proof-card">{p.card ? <Slab card={p.card} size="lg" /> : <div className="case-empty"><Capsule /><b>{statusWord(p.status)}</b></div>}</div>
        <div className="proof-body">
          <span className="kicker">pull {p.id}</span>
          <h1>{p.card ? (p.card.cardName || p.card.name) : statusWord(p.status)}</h1>
          <p className="muted">{p.card ? [gradeOf(p.card), p.card.set, p.card.valueUsd ? `${fmtUsd(p.card.valueUsd)} insured` : ''].filter(Boolean).join(' · ') : 'This pull is still in progress.'}</p>
          <dl className="kv">
            <div><dt>coin</dt><dd><a className="link" href={`#/coin/${p.mint}`}>{c?.name || ''} ${p.symbol}</a></dd></div>
            <div><dt>wallet</dt><dd><AddrLink a={p.wallet} /></dd></div>
            <div><dt>burned</dt><dd className="tnum">{fmtTok(p.burned || p.tokens)} ${p.symbol} {isSig(p.sig) ? <TxLink sig={p.sig}>burn tx</TxLink> : null}</dd></div>
            <div><dt>status</dt><dd>{statusWord(p.status)}{isSig(p.deliverySig) ? <> · <TxLink sig={p.deliverySig}>card transfer</TxLink></> : null}</dd></div>
            {p.freeze && <div><dt>machine locked</dt><dd>{fmtInt(p.freeze.cards)} cards at slot {fmtInt(p.freeze.slot)} · hash <span className="mono small">{short(p.freeze.hash, 8)}</span></dd></div>}
            {p.freeze && <div><dt>seed block</dt><dd>first finalized block at or after slot {fmtInt(p.freeze.seedSlot)}{p.draw ? <> → slot {fmtInt(p.draw.blockSlot)}</> : ' (pending)'}</dd></div>}
            {p.draw && <div><dt>blockhash</dt><dd className="mono small">{p.draw.blockhash}</dd></div>}
            {p.draw && <div><dt>seed</dt><dd className="mono small">{p.draw.seed}</dd></div>}
            {p.draw && <div><dt>pick</dt><dd>card {p.draw.index + 1} of {p.draw.n} eligible ({p.draw.eligible?.[p.draw.index]})</dd></div>}
          </dl>
          <div className="proof-rule">
            <b>Check it yourself</b>
            <p>seed = sha256(blockhash | pull id | burn signature | locked-list hash). Eligible = the locked list minus cards that earlier pulls of this coin took. Your card = eligible[seed mod n]. The list was locked {p.freeze ? `at slot ${fmtInt(p.freeze.slot)}, before block ${fmtInt(p.freeze.seedSlot)} existed` : 'before its seed block existed'}, so nobody, {BRAND.name} included, could know the card in advance.</p>
            {p.freeze?.list?.length ? <p className="mono tiny muted">locked list: {p.freeze.list.join(', ')}</p> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
