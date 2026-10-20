// The pack machine on the site. The slab (a graded card in its case), a coin's machine (pot → next pack,
// the round, your odds, its pulls), the all-pulls page and one pull with its draw, checkable by anyone.
import { useState, useEffect } from 'react'
import { BRAND, MIN_HOLD, MAX_WALLET_PCT, ROUND_MIN, SOLSCAN } from './config'
import { api, useApi } from './api'
import { Icon, Logo, Skel, Empty, ErrLine, TxLink, AddrLink, fmtUsd, fmtNum, fmtInt, fmtPct, timeAgo, short, useNow } from './ui'
import { useWallet } from './App'

/* ---------------- the slab ---------------- */

export function Slab({ card, n, label, holo = false, sealed = false, size = 'md', href, caption = true }) {
  const grade = card ? [card.grader, card.grade].filter(Boolean).join(' ') : ''
  const body = (
    <figure className={`slab slab-${size} ${holo ? 'holo' : ''} ${href ? 'clickable' : ''}`}>
      <div className="slab-label">
        <span className="slab-mark">{BRAND.name}</span>
        <span className="slab-name">{card ? (card.cardName || card.name) : (label || 'Sealed')}</span>
        {(size !== 'sm' || !card) && <span className="slab-grade">{card ? grade || 'graded' : n ? `#${n}` : ''}</span>}
      </div>
      <div className="slab-window">
        {card?.image ? <img src={card.image} alt={card.name || 'graded card'} loading="lazy" /> : <div className="slab-sealed"><span>{sealed ? 'next pack' : '?'}</span></div>}
        <i className="shine" />
      </div>
      {caption && card && <figcaption><span>{card.set || card.name}</span><b>{card.valueUsd ? fmtUsd(card.valueUsd) : ''}</b></figcaption>}
    </figure>
  )
  return href ? <a href={href} className="slab-link">{body}</a> : body
}

const STATUS = { signed: 'paying', paid: 'opening', ready: 'waiting for its round', frozen: 'drawing', drawn: 'sending the card', delivered: 'delivered', stuck: 'needs a hand', 'needs-attention': 'needs a hand', quarantined: 'checking the chain', 'written-off': 'closed' }
export const pullStatus = p => STATUS[p?.status] || p?.status || ''

/** One pull in a rail: the slab, then who won it. */
export function PullCard({ p, showCoin = true }) {
  return (
    <div className="pull-card">
      <Slab card={p.card} n={p.n} size="sm" href={`#/pull/${p.id}`} sealed={!p.card} />
      <p className="pull-under">
        {showCoin && <a href={`#/coin/${p.mint}`} className="mono">${p.symbol}</a>}
        {p.draw?.winner ? <> → <AddrLink a={p.draw.winner} /></> : <span className="muted"> {pullStatus(p)}</span>}
      </p>
    </div>
  )
}

/* ---------------- a coin's machine ---------------- */

function nextReading(round, now) {
  if (!round?.lastSampleAt) return null
  const ms = Math.max(0, round.lastSampleAt + ROUND_MIN * 60_000 - now)
  return `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
}

export function PackMachine({ coin, packs, pulls, stats }) {
  const w = useWallet()
  const now = useNow(1000)
  const pack = stats?.pack
  const price = packs?.priceUsdc || pack?.priceUsdc || 50
  const pot = packs?.potUsd || 0
  const r = packs?.round || {}
  const [odds, setOdds] = useState(null)
  useEffect(() => {
    if (!w.account || !coin?.mint) { setOdds(null); return }
    let alive = true
    api(`/odds/${coin.mint}/${w.account}`, { fresh: true }).then(o => alive && setOdds(o)).catch(() => {})
    return () => { alive = false }
  }, [w.account, coin?.mint, r.samples])
  const nr = nextReading(r, now)
  return (
    <section className="card pad machine">
      <div className="sec-head sm"><h2>${coin.symbol}&apos;s pack machine</h2>{pack?.name && <span className="pill">{pack.name}</span>}</div>
      <div className="pot-line">
        <b className="pot-have tnum">{fmtUsd(pot)}</b>
        <span className="pot-of">of {fmtUsd(price)}</span>
        <span className="pot-what">until ${coin.symbol}&apos;s next pack</span>
      </div>
      <div className="meter" aria-hidden="true"><i style={{ width: `${Math.max(1.5, Math.min(100, (packs?.progress || 0) * 100))}%` }} /></div>
      <p className="pot-meta">
        {pack?.evUsd ? <span>average card {fmtUsd(pack.evUsd)}</span> : null}
        {pack?.buybackPct ? <span>instant sell-back {pack.buybackPct}%</span> : null}
        <span>{fmtUsd(packs?.usdc || 0)} in the vault{packs?.poolSol ? ` + ${fmtNum(packs.poolSol, 3)} SOL converting` : ''}</span>
        {r.samples ? <span>{fmtInt(r.entrants)} holder{r.entrants === 1 ? '' : 's'} in this round · {r.samples} reading{r.samples === 1 ? '' : 's'}{nr ? ` · next in ${nr}` : ''}</span> : <span>readings start at 25% of a pack</span>}
      </p>
      {w.account && odds && (
        <p className="odds-line">
          {odds.entered
            ? <>You hold <b>{fmtNum(odds.averageTokens)} ${coin.symbol}</b> on average this round: a <b className="hl">{fmtPct(odds.chance, 2)}</b> chance at the next card.</>
            : odds.averageTokens > 0 ? <>You average <b>{fmtNum(odds.averageTokens)} ${coin.symbol}</b>. Hold {fmtNum(MIN_HOLD)} or more on average to enter.</>
              : <>Hold {fmtNum(MIN_HOLD)} ${coin.symbol} or more to enter the next draw.</>}
          {odds.won?.length ? <> You have won {odds.won.length} card{odds.won.length === 1 ? '' : 's'}.</> : null}
        </p>
      )}
      {pulls?.length ? (
        <div className="rail">{pulls.map(p => <PullCard key={p.id} p={p} showCoin={false} />)}</div>
      ) : (
        <Empty title="No pulls yet." sub={`When the pot reaches ${fmtUsd(price)}, ${BRAND.name} opens a real graded Pokémon pack for $${coin.symbol} holders. It shows up here, with its winner.`} />
      )}
      <p className="tiny muted rules">
        Your ticket is your average ${coin.symbol} holding across readings every {ROUND_MIN} minutes since the last card · at least {fmtNum(MIN_HOLD)} to enter · no wallet above {MAX_WALLET_PCT}% of a draw · pools and programs never enter · the winner comes from a Solana block made after the entries freeze. {packs?.vault && <>Vault <AddrLink a={packs.vault} />.</>}
      </p>
    </section>
  )
}

/* ---------------- all pulls ---------------- */

export function PullsPage({ stats }) {
  const { data, err } = useApi('/pulls?limit=120', { every: 15_000 })
  const theirs = useApi(data && !data.length ? '/machine-pulls' : null).data
  const t = stats?.totals?.packs
  return (
    <div className="wrap page packs-page">
      <div className="page-head"><div><span className="eyebrow ember">every pack, every winner</span><h1>The pulls</h1><p className="sub">Every graded card {BRAND.name} coins have opened, and the holder who won it. Tap one to check its draw.</p></div></div>
      {t && <div className="tiles"><div className="tile"><span>packs opened</span><b className="tnum">{fmtInt(t.packs)}</b></div><div className="tile"><span>cards pulled</span><b className="tnum">{fmtUsd(t.valueUsd)}</b></div><div className="tile"><span>sent to holders</span><b className="tnum">{fmtInt(t.delivered)}</b></div><div className="tile"><span>spent on packs</span><b className="tnum">{fmtUsd(t.spentUsdc)}</b></div></div>}
      {err && !data ? <ErrLine msg={err} /> : !data ? <Skel n={4} h={220} /> : data.length ? (
        <div className="pull-grid">{data.map(p => <PullCard key={p.id} p={p} />)}</div>
      ) : (
        <>
          <Empty title="No pulls yet." sub={`The first pack opens when a coin's pot reaches ${fmtUsd(stats?.pack?.priceUsdc || 50)}. Meanwhile, here is what the same Collector Crypt machine has been pulling for everyone.`} />
          <div className="pull-grid">{(theirs?.pulls || []).map((p, i) => <div className="pull-card" key={p.card?.id || i}><Slab card={p.card} size="sm" /><p className="pull-under muted">not ours · {p.card?.grader} {p.card?.grade}</p></div>)}</div>
        </>
      )}
    </div>
  )
}

/* ---------------- one pull + its draw ---------------- */

export function PullPage({ id }) {
  const { data, err } = useApi(`/pull/${encodeURIComponent(id)}`, { every: 10_000 })
  const [entries, setEntries] = useState(null)
  const p = data?.pull, coin = data?.coin
  if (err && !data) return <div className="wrap page"><Empty className="tall" glyph={Icon.warn} title="No pull with that id." sub={err} cta={<a className="btn" href="#/pulls">all pulls</a>} /></div>
  if (!p) return <div className="wrap page"><Skel n={3} h={120} /></div>
  const d = p.draw
  return (
    <div className="wrap page pull-page">
      <div className="crumbs"><a href="#/pulls">pulls</a><span>{Icon.arrow}<a href={`#/coin/${p.mint}`}>${p.symbol}</a></span><span>{Icon.arrow}<b>#{p.n}</b></span></div>
      <div className="pull-grid-2">
        <Slab card={p.card} n={p.n} size="lg" sealed={!p.card} holo={p.status === 'drawn' || p.status === 'frozen'} />
        <div>
          <span className="eyebrow ember">pack #{p.n} · {p.pack} · {fmtUsd(p.priceUsdc)}</span>
          <h1 className="pull-title">{p.card ? (p.card.cardName || p.card.name) : 'Opening…'}</h1>
          {p.card && <p className="sub">{p.card.name}{p.card.valueUsd ? ` · insured at ${fmtUsd(p.card.valueUsd)}` : ''}</p>}
          <dl className="facts">
            <div><dt>coin</dt><dd>{coin ? <a href={`#/coin/${p.mint}`}><Logo coin={coin} size={20} /> ${p.symbol}</a> : `$${p.symbol}`}</dd></div>
            <div><dt>status</dt><dd>{pullStatus(p)}</dd></div>
            <div><dt>payment</dt><dd><TxLink sig={p.sig}>{short(p.sig)}</TxLink></dd></div>
            {p.cardUrl && <div><dt>card</dt><dd><a className="link" href={p.cardUrl} target="_blank" rel="noreferrer">on Collector Crypt {Icon.ext}</a></dd></div>}
            {d?.winner && <div><dt>winner</dt><dd><AddrLink a={d.winner} /> · {fmtPct(d.chance, 2)} chance</dd></div>}
            {p.deliverySig && <div><dt>delivered</dt><dd><TxLink sig={p.deliverySig}>{short(p.deliverySig)}</TxLink></dd></div>}
          </dl>
        </div>
      </div>
      {d && (
        <section className="card pad verify">
          <div className="sec-head sm"><h2>Check the draw yourself</h2></div>
          <ol className="steps">
            <li>The round froze with <b>{fmtInt(d.entrants)}</b> holders over {d.samples} readings. Their entries (wallet, average holding) hash to <code>{d.hash}</code>.</li>
            <li>The seed block had to be at or after slot <b>{fmtInt(d.seedSlot)}</b>{d.blockSlot ? <>: it was <a className="link" href={`https://solscan.io/block/${d.blockSlot}`} target="_blank" rel="noreferrer">{fmtInt(d.blockSlot)}</a>, hash <code>{d.blockhash}</code></> : ', which is not final yet'}.</li>
            {d.seed && <li>seed = sha256(<code>blockhash|{p.id}|entries hash</code>) = <code>{d.seed}</code>. r = seed mod {d.total} = <b>{d.r}</b>. Walk the entries in wallet order until the running total passes r: <b>{short(d.winner)}</b>.</li>}
          </ol>
          <button className="btn" onClick={() => api(`/draw/${encodeURIComponent(p.id)}`).then(setEntries).catch(() => {})}>show all {fmtInt(d.entrants)} entries</button>
          {entries && (
            <div className="entries">
              <p className="tiny muted mono">hash {entries.hash} · total {entries.total} · cap {entries.capBps / 100}%</p>
              <table className="tbl plain"><tbody>{entries.entries.map(([wa, wt]) => <tr key={wa} className={wa === d.winner ? 'win' : ''}><td className="mono small">{wa}</td><td className="r num">{fmtNum(Number(wt) / 1e6)}</td></tr>)}</tbody></table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
