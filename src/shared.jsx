// Pieces used by more than one page: feed rows, the merged live feed, coin list rows, the fee table,
// the "what is enforced where" columns, the fee-sharing proof, share intents, shareholder roles.
import { useState, useMemo, useCallback } from 'react'
import { BRAND, SPLIT, MAX_DEPTH, SOLSCAN, PUMP, PUMP_URL } from './config'
import { useFeed, useLive, symbolOf } from './api'
import { Icon, Logo, Sm, Ring, TxLink, AddrLink, Copy, fmtUsd, fmtNum, fmtInt, fmtSol, timeAgo, short, isSig } from './ui'

export const isRootCoin = c => !!c && (c.level === 0 || (c.parent == null && c.level == null))
export const parentOf = c => c?.parent || null
export const pumpUrlOf = c => c?.pumpUrl || (c?.mint ? PUMP_URL(c.mint) : null)
export const coinUrl = mint => `${BRAND.siteUrl}/c/${mint}`
export const shareIntent = (c, parentSymbol) => {
  const under = parentSymbol ? ` under $${parentSymbol}` : ''
  const text = `$${c.symbol} just launched${under} on ${BRAND.name}${BRAND.handle ? ' ' + BRAND.handle : ''}: every coin gets a gacha machine.\n\n${coinUrl(c.mint)}`
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`
}
export const ageOf = c => Math.max(0, Date.now() - (c?.createdAt || 0))
/** "view on pump.fun" as a chip / button. */
export const PumpLink = ({ c, className = 'chip', children }) => {
  const u = pumpUrlOf(c)
  return u ? <a className={className} href={u} target="_blank" rel="noreferrer">{children || <>pump.fun {Icon.ext}</>}</a> : null
}

/* ---------------- feed ---------------- */

const sol = v => `${fmtSol(v)} SOL`
export function eventLine(e) {
  const sym = `$${e.symbol}`
  switch (e.type) {
    case 'launch': return { title: <><b>{sym}</b> launched{!e.parentMint ? <> · the platform coin</> : null}</>, amt: e.wallet ? short(e.wallet) : '', kind: 'launch' }
    case 'lock': return { title: <><b>{sym}</b> fee split locked on pump.fun</>, amt: '', kind: 'lock' }
    case 'distribute': return { title: <><b>{sym}</b> creator fees distributed</>, amt: e.amountSol ? sol(e.amountSol) : '', kind: 'distribute' }
    // 'round' is emitted when a round CLOSES (status paying | skipped; done only in old rows); the SOL moves in 'payout' events
    case 'round': {
      const n = e.extra?.wallets ? `${fmtInt(e.extra.wallets)} ` : ''
      const st = e.extra?.status
      if (st === 'skipped') return { title: <><b>{sym}</b> holder round skipped · the SOL stays in the pool</>, amt: '', kind: 'other' }
      if (st === 'done') return { title: <><b>{sol(e.amountSol)}</b> paid to {n}<b>{sym}</b> holders</>, amt: e.amountUsd ? fmtUsd(e.amountUsd) : '', kind: 'payout' }
      return { title: <><b>{sym}</b> holder round closed · <b>{sol(e.amountSol)}</b> to {n}holders</>, amt: e.amountUsd ? fmtUsd(e.amountUsd) : '', kind: 'payout' }
    }
    // one 'payout' event per batch transaction: extra.wallets holders paid in it (a single-wallet row carries e.wallet)
    case 'payout': return { title: <><b>{sol(e.amountSol)}</b> paid to {e.wallet ? 'a' : e.extra?.wallets ? fmtInt(e.extra.wallets) : ''} <b>{sym}</b> holder{e.wallet || e.extra?.wallets === 1 ? '' : 's'}</>, amt: e.wallet ? short(e.wallet) : '', kind: 'payout' }
    case 'burn': return { title: <><b>{fmtNum(e.amountUi)} ${BRAND.ticker}</b> bought and burned{e.amountSol ? <> for {sol(e.amountSol)}</> : null}</>, amt: e.amountUsd ? fmtUsd(e.amountUsd) : '', kind: 'burn' }
    case 'to-packs': return { title: <><b>{sym}</b> fees swapped into <b>{fmtUsd(e.extra?.usdc || 0)}</b> for packs</>, amt: e.amountSol ? sol(e.amountSol) : '', kind: 'distribute' }
    case 'rip': return { title: <><b>{sym}</b> bought pack <b>#{e.extra?.n}</b> · {e.extra?.pack}</>, amt: e.extra?.priceUsdc ? fmtUsd(e.extra.priceUsdc) : '', kind: 'launch' }
    case 'pull': return { title: <><b>{sym}</b> pulled <b>{e.extra?.card?.cardName || e.extra?.card?.name}</b>{e.extra?.card?.grade ? ` · ${e.extra.card.grader} ${e.extra.card.grade}` : ''}</>, amt: e.extra?.card?.valueUsd ? fmtUsd(e.extra.card.valueUsd) : '', kind: 'bond' }
    case 'freeze': return { title: <><b>{sym}</b> pack #{e.extra?.n}: {fmtInt(e.extra?.entrants)} holders frozen into the draw</>, amt: '', kind: 'other' }
    case 'draw': return { title: <><b>{sym}</b> pack #{e.extra?.n} won by <b>{short(e.wallet)}</b></>, amt: e.extra?.card?.valueUsd ? fmtUsd(e.extra.card.valueUsd) : '', kind: 'payout' }
    case 'delivered': return { title: <><b>{sym}</b> card delivered to <b>{short(e.wallet)}</b></>, amt: '', kind: 'payout' }
    case 'graduate': return { title: <><b>{sym}</b> graduated to PumpSwap</>, amt: e.amountUsd ? fmtUsd(e.amountUsd) : '', kind: 'bond' }
    case 'trade': return { title: <><b>{e.extra?.side === 'sell' ? 'sell' : 'buy'}</b> {e.amountUsd ? fmtUsd(e.amountUsd) : sol(e.amountSol)} of <b>{sym}</b></>, amt: e.wallet ? short(e.wallet) : '', kind: e.extra?.side === 'sell' ? 'sell' : 'buy' }
    default: return { title: <b>{sym}</b>, amt: '', kind: 'other' }
  }
}
export function FeedRow({ e, i }) {
  const l = eventLine(e)
  return (
    <div className={`frow ${l.kind}`} style={{ '--i': i }}>
      <i className="fdot" aria-hidden="true" />
      <a className="ftitle" href={e.extra?.ripId ? `#/pull/${e.extra.ripId}` : `#/coin/${e.mint}`}>{l.title}</a>
      <span className="famt tnum">{l.amt}</span>
      <span className="fwhen">{isSig(e.sig) ? <TxLink sig={e.sig}>{timeAgo(e.at)}</TxLink> : timeAgo(e.at)}</span>
    </div>
  )
}

/** Every event type but 'trade': without trades the feed asks the engine for these, so a busy tape never empties it. */
export const NON_TRADE_TYPES = 'launch,lock,distribute,burn,graduate,to-packs,rip,pull,draw,delivered'

/** Feed = /feed poll merged with live SSE events (dedupe by id). */
export function useMergedFeed(limit = 40, { trades = false } = {}) {
  const { data, err, loading, reload } = useFeed(limit, trades ? '' : NON_TRADE_TYPES)
  const [live, setLive] = useState([])
  const mode = useLive(useCallback(e => setLive(l => (l.some(x => x.id === e.id) ? l : [e, ...l].slice(0, 60))), []))
  const rows = useMemo(() => {
    const seen = new Set(), out = []
    for (const e of [...live, ...(data || [])]) { if (!e?.id || seen.has(e.id)) continue; if (!trades && e.type === 'trade') continue; seen.add(e.id); out.push(e) }
    return out.sort((a, b) => b.at - a.at).slice(0, limit)
  }, [data, live, limit, trades])
  return { rows, err, loading: loading && !data, reload, mode }
}

/* ---------------- coin table rows ---------------- */

/** One row of a coin table. `cols` picks which cells render (see Explore). */
export function CoinTr({ c, i, cols = ['coin', 'parent', 'price', 'mcap', 'vol24', 'holders', 'kids', 'status', 'act'], rank, onOpen, maxDepth = MAX_DEPTH }) {
  const open = () => (onOpen ? onOpen(c) : (location.hash = `/coin/${c.mint}`))
  const cell = k => {
    switch (k) {
      case 'rank': return <td key={k} className="rank">{rank}</td>
      case 'coin': return <td key={k}><span className="tcoin"><Logo coin={c} size={28} /><b>${c.symbol}</b><span>{c.name}</span></span></td>
      case 'parent': return <td key={k} className="parent">{!c.parent ? (c.level > 0 ? `$${BRAND.ticker} (soon)` : 'root') : <a href={`#/coin/${c.parent}`} onClick={e => e.stopPropagation()}>${c.parentSymbol}</a>}</td>
      case 'price': return <td key={k} className="r num"><Sm s={fmtUsd(c.priceUsd)} /></td>
      case 'mcap': return <td key={k} className="r num">{fmtUsd(c.mcapUsd)}</td>
      case 'vol24': return <td key={k} className="r num dim">{fmtUsd(c.vol24hUsd)}</td>
      case 'vol1h': return <td key={k} className="r num dim">{fmtUsd(c.vol1hUsd)}</td>
      case 'holders': return <td key={k} className="r num dim">{fmtInt(c.holders)}</td>
      case 'kids': return <td key={k} className="r num">{fmtInt(c.kids)}</td>
      case 'pot': return <td key={k} className="r"><span className="pot-cell"><i style={{ width: `${Math.max(4, Math.min(100, (c.packs?.progress || 0) * 100))}%` }} /><b className="num">{fmtUsd(c.packs?.potUsd || 0)}</b></span></td>
      case 'pulled': return <td key={k} className="r num">{c.packs?.packs ? <>{fmtInt(c.packs.packs)} · {fmtUsd(c.packs.pulledUsd)}</> : <span className="dim">—</span>}</td>
      case 'age': return <td key={k} className="r num dim">{timeAgo(c.createdAt)}</td>
      case 'status': return <td key={k}><span className="status-cell">{c.curve?.graduated ? <span className="pill amber">{Icon.check} graduated</span> : <><Ring v={c.curve?.progress} size={22} stroke={2.5} /><span className="pct">{Math.round((c.curve?.progress || 0) * 100)}%</span></>}</span></td>
      case 'act': return <td key={k} className="act"><a href={`#/coin/${c.mint}`} onClick={e => e.stopPropagation()}>open</a></td>
      default: return null
    }
  }
  return <tr className="link" style={{ '--i': Math.min(i, 30) }} onClick={open}>{cols.map(cell)}</tr>
}

/* ---------------- shareholder roles + sharing status (API.md Coin.sharing) ---------------- */

export function roleOf(role, coin) {
  switch (role) {
    case 'creator': return { cls: 's-creator', label: 'the launcher', short: 'launcher' }
    case 'parentHolders': return { cls: 's-holders', label: `$${coin?.symbol || 'COIN'}'s pack pot`, short: 'pack pot' }
    case 'burn': return { cls: 's-burn', label: `buy and burn $${BRAND.ticker}`, short: 'burn wallet' }
    case 'protocol': return { cls: 's-protocol', label: `${BRAND.name} treasury`, short: 'treasury' }
    default: return { cls: 's-protocol', label: role || 'recipient', short: role || 'recipient' }
  }
}
export const STATUS_PILL = {
  locked: <span className="pill ok">{Icon.lock} locked</span>,
  pending: <span className="pill amber">{Icon.clock} locking</span>,
  mismatch: <span className="pill err">{Icon.warn} mismatch</span>,
  blocked: <span className="pill err">{Icon.warn} blocked</span>,
}
/** Honest copy for each sharing status. */
export function sharingNote(status) {
  switch (status) {
    case 'pending': return `The coin is live on pump.fun and its split is being locked. Until the lock lands, creator fees wait in pump.fun's creator vault for this coin; once it lands they are split by the same shares.`
    case 'mismatch': return `The recipients read back from chain differ from the ${BRAND.name} split. That can only happen if pump.fun's admin changed this coin's configuration. What is shown here is what the chain says.`
    case 'blocked': return `pump.fun's distribution fails for this coin because one recipient cannot receive fees, so ${BRAND.name} has stopped triggering it. Its creator fees stay in pump.fun's creator vault for this coin.`
    case 'locked': return `Admin rights are revoked. Neither the launcher nor ${BRAND.name} can change these recipients.`
    default: return ''
  }
}

/**
 * Where coin.sharing.shareholders came from (API.md): 'chain' = read back from the coin's fee-sharing config;
 * 'planned' = the split the lock will write (status pending, no config yet); 'recorded' = what the engine wrote at
 * the lock, not re-read yet.
 */
export const shareSource = sh => (sh?.readBack ? 'chain' : !sh?.config || sh?.status === 'pending' ? 'planned' : 'recorded')
export const SOURCE_LABEL = { chain: 'read back from chain', planned: 'planned · written when the lock lands', recorded: 'as written at the lock' }

/* ---------------- fee table (INTRO §3) ---------------- */

const OnPump = () => <span className="enf chain">{Icon.shield} pump.fun</span>
const Engine = () => <span className="enf engine">{Icon.cpu} {BRAND.name}&apos;s engine</span>

export function FeeTable({ compact = false, split = SPLIT }) {
  return (
    <div>
      <div className="fee-stack" aria-hidden="true">
        <i className="s-creator" style={{ flex: split.creator }} data-tip={`the launcher · ${split.creator}%`} />
        <i className="s-holders" style={{ flex: split.parentHolders }} data-tip={`parent holders · ${split.parentHolders}%`} />
        <i className="s-burn" style={{ flex: split.burn }} data-tip={`buy and burn · ${split.burn}%`} />
        <i className="s-protocol" style={{ flex: split.protocol }} data-tip={`treasury · ${split.protocol}%`} />
      </div>
      <div className="fee-legend">
        <span><i className="s-creator" />launcher</span>
        <span><i className="s-holders" />parent holders</span>
        <span><i className="s-burn" />burn ${BRAND.ticker}</span>
        <span><i className="s-protocol" />treasury</span>
      </div>
      <table className="fee-table" style={{ marginTop: 16 }}>
        <thead><tr><th>Share</th><th>Recipient</th><th>Paid</th><th>Enforced by</th></tr></thead>
        <tbody>
          <tr><td>{split.creator}%</td><td>The launcher of the coin</td><td>in SOL, to the launcher&apos;s wallet</td><td><OnPump /><small>paid directly by pump.fun&apos;s fee sharing</small></td></tr>
          <tr><td>{split.parentHolders}%</td><td>The holders of its parent coin</td><td>in SOL, in five-minute rounds</td><td><span className="enf-pair"><OnPump /><Engine /></span><small>pump.fun pays the parent&apos;s holder pool; the engine pays the pool out</small></td></tr>
          <tr><td>{split.burn}%</td><td>Buy and burn of ${BRAND.ticker}</td><td>SOL that buys ${BRAND.ticker}</td><td><span className="enf-pair"><OnPump /><Engine /></span><small>pump.fun pays the burn wallet; the engine buys and burns</small></td></tr>
          <tr><td>{split.protocol}%</td><td>{BRAND.name} protocol treasury</td><td>in SOL</td><td><OnPump /></td></tr>
        </tbody>
      </table>
      {!compact && (
        <div className="fee-notes">
          <p><b>This is a split of pump.fun&apos;s creator fee.</b> Today it is {PUMP.curveCreatorFee} of volume on the bonding curve and on PumpSwap for young pools, rising to {PUMP.bigPoolCreatorFee} once a pool passes 420 SOL in market cap and then stepping down as it grows. pump.fun&apos;s own protocol fee is separate and is not part of the split.</p>
          <p><b>pump.fun pays the four recipients directly</b> whenever its distribution is triggered. {BRAND.name} triggers it continuously. Anyone else can trigger it too. There is nothing to claim.</p>
        </div>
      )}
    </div>
  )
}

/* ---------------- what is enforced where (INTRO §7) ---------------- */

export function Enforced({ footnote = true }) {
  const chain = ['the four-way fee split and its recipients', `the payment of the launcher's ${SPLIT.creator}% and the treasury's ${SPLIT.protocol}%`, 'the bonding curve', 'graduation to PumpSwap', 'the burned liquidity', 'no mint authority and no freeze authority']
  const engine = [`the payout rounds from each parent's holder pool`, `the buy and burn of $${BRAND.ticker}`]
  return (
    <div className="enforce">
      <div className="enf-col chain">
        <header><i>{Icon.shield}</i><h3>Enforced by pump.fun&apos;s programs<small>and locked at launch</small></h3></header>
        <ul>{chain.map(t => <li key={t}>{Icon.check}<span>{t}</span></li>)}</ul>
      </div>
      <div className="enf-col engine">
        <header><i>{Icon.cpu}</i><h3>Enforced by {BRAND.name}&apos;s engine<small>whose wallets are published</small></h3></header>
        <ul>{engine.map(t => <li key={t}>{Icon.check}<span>{t}</span></li>)}</ul>
        <p className="tiny muted">{BRAND.name} holds the keys to the holder pools and the burn wallet, and says so. Every payout and every burn is published with its transaction signature.</p>
      </div>
      {footnote && <p className="enf-foot"><b>{BRAND.name} never holds user funds.</b> Launches and trades are built by the engine, signed in the user&apos;s own wallet, and relayed exactly as signed.</p>}
      {footnote && <p className="enf-foot"><b>What the lock does not cover.</b> pump.fun&apos;s programs are upgradeable by pump.fun, and pump.fun retains an administrative takeover right over coin fee configurations. The split is locked against the launcher and against {BRAND.name}; it is not locked against pump.fun itself.</p>}
    </div>
  )
}

/* ---------------- the proof: the split, read back from chain ---------------- */

/** The seal: a padlock inside a ticked ring. */
const Seal = () => (
  <svg viewBox="0 0 72 72" aria-hidden="true">
    <circle cx="36" cy="36" r="34" fill="none" stroke="currentColor" strokeOpacity=".32" strokeWidth="1" />
    <circle cx="36" cy="36" r="30.5" fill="none" stroke="currentColor" strokeOpacity=".55" strokeWidth="3" strokeDasharray="1 5.35" />
    <circle cx="36" cy="36" r="24" fill="none" stroke="currentColor" strokeOpacity=".14" strokeWidth="1" />
    <circle cx="36" cy="36" r="24" fill="currentColor" fillOpacity=".06" />
    <path d="M29.5 33v-4.5a6.5 6.5 0 0 1 13 0V33" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    <rect x="25.5" y="33" width="21" height="15.5" rx="3.5" fill="currentColor" fillOpacity=".16" stroke="currentColor" strokeWidth="1.6" />
    <circle cx="36" cy="39.5" r="1.9" fill="currentColor" />
    <path d="M36 41v3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)

const PROOF_H = {
  locked: <>The split is locked <em>on pump.fun.</em></>,
  pending: <>The split is <em>being locked.</em></>,
  mismatch: <>The split on chain <em>does not match.</em></>,
  blocked: <>Distribution is <em>blocked.</em></>,
}

/**
 * "The split is locked on pump.fun." With a coin: its fee-sharing config and shareholders as read back from
 * chain, plus Solscan + pump.fun links. Without one (the root has not launched): how it works and what to check.
 */
export function Proof({ coin }) {
  const sh = coin?.sharing
  const status = sh?.status || 'pending'
  const holders = sh?.shareholders || []
  const source = shareSource(sh)
  const explain = <>Every coin&apos;s creator fee is split by pump.fun&apos;s own fee-sharing program. The recipients are written into the coin&apos;s fee-sharing configuration, and admin rights over it are revoked in the same transaction, so neither the launcher nor {BRAND.name} can change them. pump.fun&apos;s coin page lists the same recipients and shows that permissions are revoked.</>
  if (!coin) {
    return (
      <div className="proof">
        <div className="proof-seal" aria-hidden="true"><Seal /></div>
        <div className="proof-body">
          <span className="eyebrow amber">{Icon.shield} pump.fun fee sharing · how to check it</span>
          <h3>The split is locked <em>on pump.fun.</em></h3>
          <p>{explain}</p>
          <p>When ${BRAND.ticker} launches, its own configuration appears here, read back from chain. Every coin page shows its own, with a link to the same coin on pump.fun.</p>
          <dl className="proof-read">
            <dt>what every coin&apos;s configuration holds</dt>
            <dd><span>the launcher</span><b>{SPLIT.creator}%</b></dd>
            <dd><span>the parent&apos;s holder pool</span><b>{SPLIT.parentHolders}%</b></dd>
            <dd><span>the burn wallet</span><b>{SPLIT.burn}%</b></dd>
            <dd><span>the treasury</span><b>{SPLIT.protocol}%</b></dd>
            <dd><span>admin</span><b>revoked</b></dd>
          </dl>
        </div>
      </div>
    )
  }
  return (
    <div className={`proof ${status !== 'locked' ? 'proof-open' : ''}`}>
      <div className="proof-seal" aria-hidden="true"><Seal /></div>
      <div className="proof-body">
        <div className="proof-top"><span className="eyebrow amber">{Icon.shield} ${coin.symbol} · pump.fun fee sharing</span>{STATUS_PILL[status]}</div>
        <h3>{PROOF_H[status] || PROOF_H.pending}</h3>
        <p>{explain}</p>
        {status !== 'locked' && <p className={`notice ${status === 'pending' ? 'warn' : 'err'}`}>{sharingNote(status)}</p>}
        <div className="proof-addr">
          <span className="proof-k">${coin.symbol} fee-sharing config</span>
          {sh?.config ? <Copy text={sh.config} label={sh.config} sm /> : <span className="muted">not created yet</span>}
          {sh?.config && <a className="btn sm proof-cta" href={SOLSCAN.account(sh.config)} target="_blank" rel="noreferrer">verify on Solscan {Icon.ext}</a>}
          <PumpLink c={coin} className="btn sm proof-cta">view on pump.fun {Icon.ext}</PumpLink>
        </div>
        <dl className="proof-read rows">
          <dt>{holders.length ? `${holders.length} recipient${holders.length === 1 ? '' : 's'} · ${SOURCE_LABEL[source]}` : 'recipients'}</dt>
          {holders.length ? holders.map(h => { const r = roleOf(h.role, coin); return <dd key={`${h.role}${h.address}`}><span>{r.label}</span><b>{fmtNum(h.bps / 100)}%</b><AddrLink a={h.address} /></dd> }) : <dd><span>not written yet</span><b>—</b></dd>}
          <dd><span>admin</span><b>{sh?.adminRevoked ? 'revoked' : 'not revoked yet'}</b></dd>
        </dl>
      </div>
    </div>
  )
}
