// The home page (#/): the machine window (real slabs from every machine, scrolling), how a machine works, the busiest
// machines, fresh pulls, the machines you can pick, and $Gachapad.
import { useMemo } from 'react'
import { BRAND, PULL_MARGIN_PCT, splitOf } from './config'
import { useCoins, useApi, useMachines, useBurnPulls } from './api'
import { Icon, Logo, Num, Skel, Copy, fmtUsd, fmtInt, fmtNum, short } from './ui'
import { Slab, MachineRow } from './Machines'

/** Three columns of real slabs drifting upward behind glass: the machine's window. */
function MachineWindow({ cards, label = 'inside the machines' }) {
  const cols = useMemo(() => {
    const src = cards.length ? cards : []
    const out = [[], [], []]
    for (let i = 0; i < Math.max(src.length, 9); i++) if (src.length) out[i % 3].push(src[i % src.length])
    return out
  }, [cards])
  return (
    <div className="window" aria-label="cards inside the machines right now">
      <div className="window-top"><span className="window-dot" /><span>{label}</span><span className="window-n tnum">{fmtInt(cards.length)} cards</span></div>
      <div className="window-glass">
        {cols.map((col, i) => (
          <div key={i} className={`wcol c${i}`}>
            <div className="wtrack">{[...col, ...col].map((c, j) => <Slab key={j} card={c} size="sm" caption={false} eager />)}</div>
          </div>
        ))}
        <i className="window-shade" aria-hidden="true" />
      </div>
      <div className="window-chute"><span /><small>burn to pull</small></div>
    </div>
  )
}

const STEP = ({ n, title, children, art }) => (
  <li className="how-step">
    <span className="how-n">{n}</span>
    <div className="how-art">{art}</div>
    <h3>{title}</h3>
    <p>{children}</p>
  </li>
)

export function Home({ stats }) {
  const top = useCoins({ sort: 'cards', limit: 6 }, 20_000)
  const machines = useMachines()
  const burns = useBurnPulls({ limit: 24 }, 15_000)
  const cardsAll = useCoins({ sort: 'value', limit: 30 }, 30_000)
  const t = stats?.totals || {}
  const split = splitOf(stats)
  const root = stats?.root
  const ownCards = useMemo(() => (cardsAll.data?.items || []).flatMap(c => c.packs?.top || []).filter(c => c.image), [cardsAll.data])
  // before the machines hold enough cards: real recent pulls from the same Collector Crypt machines, labelled as such
  const recent = useApi(cardsAll.data && ownCards.length < 9 ? '/machine-pulls' : null, { every: 120_000 })
  const fallback = useMemo(() => (recent.data?.pulls || []).map(p => p.card).filter(c => c?.image).slice(0, 24), [recent.data])
  const windowCards = ownCards.length >= 9 ? ownCards : fallback.length ? fallback : ownCards
  const windowLabel = ownCards.length >= 9 ? 'inside the machines' : 'pulled from these machines today'
  const pulled = (burns.data || []).filter(p => p.card)
  const mlist = machines.data?.machines || []
  const topItems = (top.data?.items || []).filter(c => !c.root && c.packs)
  return (
    <div className="home">
      <section className="hero2">
        <div className="wrap hero2-grid">
          <div className="hero2-copy">
            <a className="hero-pill" href="#/docs#pump"><span className="live-dot" />Built on pump.fun packs<span className="hp-arrow">{Icon.arrow}</span></a>
            <h1>Every coin gets<br /><em>a gacha machine.</em></h1>
            <p className="lede">Launch a pump.fun coin and its fees rip real graded cards into its own machine. Burn the coin to pull one out.</p>
            <div className="cta-row">
              <a className="btn primary lg" href="#/launch">Launch a coin</a>
              <a className="btn lg" href="#/machines">Browse machines {Icon.arrow}</a>
            </div>
            <dl className="hero-stats">
              <div><dt>cards in machines</dt><dd><Num v={t.packs?.inMachines ?? null} /></dd></div>
              <div><dt>packs ripped</dt><dd><Num v={t.packs?.packs ?? null} /></dd></div>
              <div><dt>pulled by burning</dt><dd><Num v={t.packs?.valueUsd ?? null} f={fmtUsd} /></dd></div>
            </dl>
          </div>
          <MachineWindow cards={windowCards} label={windowLabel} />
        </div>
      </section>

      <section className="wrap how">
        <div className="sec-h"><h2>How a machine works</h2></div>
        <ol className="how-flow">
          <STEP n="1" title="Launch a coin, pick its machine" art={<div className="how-machines">{mlist.slice(0, 4).map(m => m.image ? <img key={m.code} src={m.image} alt="" /> : null)}</div>}>
            A standard pump.fun coin. You choose its pack machine (Pokémon, One Piece, sports, more) once, for life.
          </STEP>
          <STEP n="2" title="Its fees rip packs into it" art={<div className="how-split"><span style={{ width: `${split.parentHolders}%` }}>{split.parentHolders}% to its machine</span><span>{split.burn}%</span></div>}>
            {split.parentHolders}% of the coin&apos;s creator fees buys packs from the same Collector Crypt machines pump.fun sells. Every card stays inside. {split.burn}% buys and burns ${BRAND.ticker}.
          </STEP>
          <STEP n="3" title="Burn the coin to pull a card" art={<div className="how-burn">{pulled[0]?.card ? <Slab card={pulled[0].card} size="xs" caption={false} /> : null}<span className="how-arrow">{Icon.arrow}</span><span className="how-wallet">{Icon.wallet}</span></div>}>
            A pull costs the machine&apos;s average card value plus {PULL_MARGIN_PCT}%, paid in the coin and burned. A Solana block picks your card and it lands in your wallet.
          </STEP>
        </ol>
      </section>

      <section className="wrap home-sec">
        <div className="sec-h"><h2>Busiest machines</h2><a className="ghost" href="#/machines">all machines {Icon.arrow}</a></div>
        {!top.data ? <Skel n={4} h={84} /> : topItems.length ? <div className="mlist">{topItems.map(c => <MachineRow key={c.mint} c={c} />)}</div> : <p className="muted">No machines yet. <a className="link" href="#/launch">Launch the first.</a></p>}
      </section>

      {pulled.length > 0 && (
        <section className="home-sec fresh">
          <div className="wrap sec-h"><h2>Fresh pulls</h2><a className="ghost" href="#/pulls">every pull {Icon.arrow}</a></div>
          <div className="fresh-rail">
            <div className="fresh-track">{[...pulled, ...pulled].map((p, i) => (
              <a key={i} className="fresh-item" href={`#/burn/${p.id}`}>
                <Slab card={p.card} size="sm" caption={false} eager />
                <span><b>{p.card.cardName || p.card.name}</b><i><em className="mono">${p.symbol}</em> · {p.card.valueUsd ? fmtUsd(p.card.valueUsd) : ''}</i></span>
              </a>
            ))}</div>
          </div>
        </section>
      )}

      {mlist.length > 0 && (
        <section className="wrap home-sec">
          <div className="sec-h"><h2>Machines you can pick</h2><span className="muted small">live stock from pump.fun&apos;s packs</span></div>
          <div className="pick-rail">{mlist.map(m => (
            <a key={m.code} className={`pick ${m.open ? '' : 'closed'}`} href={`#/launch?machine=${m.code}`}>
              <div className="pick-img">{m.image ? <img src={m.image} alt="" loading="lazy" /> : <span className="pick-ph">{m.shortName || m.name}</span>}</div>
              <b>{m.name}</b>
              <span><em className="tnum">{fmtUsd(m.priceUsdc)}</em> a pack{m.evUsd ? <> · avg card <em className="tnum">{fmtUsd(m.evUsd)}</em></> : null}</span>
              <i className={`lvl-${m.level || 'na'}`}>{m.open ? (m.level ? `stock ${m.level}` : 'open') : 'closed'}</i>
            </a>
          ))}</div>
        </section>
      )}

      <section className="wrap home-sec token-band">
        <div className="tb-copy">
          <h2>${BRAND.ticker}</h2>
          <p>{split.burn}% of every machine&apos;s fees buys ${BRAND.ticker} and burns it. More machines, more volume, less ${BRAND.ticker}.</p>
          {root ? <div className="row"><Copy text={root.mint} label={short(root.mint, 6)} sm /><a className="btn sm" href={`#/coin/${root.mint}`}>Trade ${root.symbol}</a></div> : <p className="muted small">${BRAND.ticker} launches soon.</p>}
        </div>
        <img className="tb-art" src="/gacha-coin.png?v=6" alt="" loading="lazy" />
        <dl className="tb-stats">
          <div><dt>${BRAND.ticker} burned</dt><dd><Num v={t.burnedRootUi ?? null} f={fmtNum} /></dd></div>
          <div><dt>worth</dt><dd><Num v={t.burnedRootUsd ?? null} f={fmtUsd} /></dd></div>
          <div><dt>coins launched</dt><dd><Num v={t.coins != null ? Math.max(0, t.coins - (root ? 1 : 0)) : null} /></dd></div>
        </dl>
      </section>
    </div>
  )
}
