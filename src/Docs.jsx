// How it works (#/docs): the whole mechanic as plain prose with a sticky section nav.
import { useEffect, useState } from 'react'
import { BRAND, INTRO_LEDE, INTRO_SECOND, SETUP_SOL, PUMP, PULL_MARGIN_PCT, splitOf } from './config'
import { useApi } from './api'
import { AddrLink } from './ui'

const SECTIONS = [['pump', 'Built on pump.fun packs'], ['launching', 'Launching a coin'], ['machines', 'The machines'], ['split', 'The fee split'], ['packs', 'How a machine fills'], ['pulls', 'Pulling a card'], ['fairness', 'How the card is picked'], ['token', `$${BRAND.ticker}`], ['trust', 'What you are trusting'], ['risks', 'Risks'], ['addresses', 'Addresses']]

export function Docs({ stats }) {
  const root = stats?.root, wal = stats?.engine?.wallets
  const meta = useApi('/launch-meta')
  const split = splitOf(stats)
  const setup = meta.data?.setupSol || SETUP_SOL
  const [active, setActive] = useState(SECTIONS[0][0])
  useEffect(() => { const id = location.hash.split('#')[2]; if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60) }, [])
  useEffect(() => {
    if (!('IntersectionObserver' in window)) return
    const els = SECTIONS.map(([id]) => document.getElementById(id)).filter(Boolean)
    const io = new IntersectionObserver(entries => { for (const e of entries) if (e.isIntersecting) setActive(e.target.id) }, { rootMargin: '-20% 0px -70% 0px', threshold: 0 })
    els.forEach(el => io.observe(el))
    return () => io.disconnect()
  }, [])
  const jump = id => e => { e.preventDefault(); document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); history.replaceState(null, '', `#/docs#${id}`) }
  const T = BRAND.ticker
  return (
    <div className="wrap page docs">
      <nav className="toc" aria-label="Sections">
        {SECTIONS.map(([id, label]) => <a key={id} href={`#/docs#${id}`} onClick={jump(id)} className={active === id ? 'on' : ''}>{label}</a>)}
      </nav>
      <article className="prose">
        <h1>How it works</h1>
        <p className="lede">{INTRO_LEDE}</p>
        <p>{INTRO_SECOND}</p>

        <h2 id="pump">Built on pump.fun&apos;s packs update</h2>
        <div className="pump-hero">
          <img src="/gacha-hero.jpg?v=6" alt="" />
          <p>pump.fun now sells graded-card packs inside pump.fun itself. Its own backend lists every Collector Crypt gacha machine, builds the pack purchase, and publishes a live stock reading for each machine. {BRAND.name} is built on that update: every coin here gets one of those machines, and its trading keeps the machine stocked.</p>
        </div>
        <div className="pump-grid">
          <div><span>pump.fun provides</span><ul>
            <li><b>The machines.</b> The Collector Crypt machines pump.fun now sells: Pokémon at $25, $50 and $100, One Piece, sealed, anime, comics, sports and more.</li>
            <li><b>Live stock.</b> pump.fun&apos;s public stock feed (healthy, low or empty, and cards left per rarity tier). The launch form and every machine page show it, so you can see a machine is well stocked before you tie a coin to it.</li>
            <li><b>Locked fee sharing.</b> The {split.parentHolders}/{split.burn} split is written into pump.fun&apos;s own fee-sharing configuration at launch, with the admin key revoked.</li>
            <li><b>The coin.</b> A standard pump.fun coin on the bonding curve, then PumpSwap.</li>
          </ul></div>
          <div><span>{BRAND.name} adds</span><ul>
            <li><b>A machine per coin.</b> On pump.fun a pack is something you buy for yourself. Here, a coin&apos;s own trading buys packs for its machine, around the clock.</li>
            <li><b>Cards stay inside.</b> Nothing is airdropped or drawn to holders. Every card waits in the coin&apos;s machine, with its photo, grade and value on the page.</li>
            <li><b>The coin is the key.</b> The only way to take a card out is to burn the coin, so every pull takes supply off the market.</li>
            <li><b>Provable picks.</b> Each pull&apos;s card comes from a Solana block after the burn, with the list, hash and seed published.</li>
          </ul></div>
        </div>
        <p className="small muted">{BRAND.name} buys its packs directly from Collector Crypt, from the same machines at the same prices pump.fun shows; pump.fun&apos;s stock feed is shown for information and is never used to move money. {BRAND.name} is not affiliated with pump.fun or Collector Crypt.</p>

        <h2 id="launching">Launching a coin</h2>
        <p>You pick a pack machine, a name, a ticker and an image, and sign one transaction. It creates the coin on pump.fun and pays about {setup} SOL to set up its fee split. A few seconds later {BRAND.name} locks the split in pump.fun&apos;s fee-sharing configuration and revokes the admin key in the same transaction, so nobody (you, {BRAND.name}, anyone) can change it afterwards. The coin trades on pump.fun&apos;s bonding curve and graduates to PumpSwap at about {PUMP.gradSol} SOL, like any pump.fun coin.</p>

        <h2 id="machines">The machines</h2>
        <p>Every coin is tied to one machine for life: a Collector Crypt gacha machine, the same machines pump.fun now sells packs from (Pokémon at $25, $50 and $100, One Piece, sealed, anime, comics, Lorcana, Riftbound, Dragon Ball and sports). The launch form shows each machine&apos;s pack price, its average card value and its live stock as pump.fun reads it.</p>

        <h2 id="split">The fee split</h2>
        <p>pump.fun pays every coin&apos;s creator fee ({PUMP.curveCreatorFee} of volume on the curve today) to the shareholders {BRAND.name} locked at launch:</p>
        <ul>
          <li><b>{split.parentHolders}% to the coin&apos;s machine.</b> A pool wallet that only exists for that coin.</li>
          <li><b>{split.burn}% to buy and burn ${T}.</b></li>
        </ul>
        <p>There is no launcher cut and no platform cut on kid coins. ${T}&apos;s own creator fees go to the {BRAND.name} team, which runs the engine and pays the gas.</p>

        <h2 id="packs">How a machine fills</h2>
        <p>The engine collects each coin&apos;s machine pool and swaps it to USDC (through Jupiter, checked against the market price before it signs) into that coin&apos;s card vault. When the vault holds the machine&apos;s pack price, the engine buys one pack from Collector Crypt and opens it. The card that comes out stays in the vault: it is now inside the machine, and its photo, grade and insured value show on the coin&apos;s page. Nothing is drawn and nobody is paid at this step. One pack is in flight at a time across the whole pad; the fullest pot goes first.</p>

        <h2 id="pulls">Pulling a card</h2>
        <p>Anyone can pull a card out of a machine by burning that machine&apos;s coin. A pull costs the average insured value of the cards inside plus {PULL_MARGIN_PCT}%, priced in the coin at the <b>lower</b> of its spot price and its 10-minute average, so pumping the price never makes a pull cheaper. The quote reserves one card for two minutes.</p>
        <p>Your wallet signs a plain burn of the quoted amount with a memo naming the pull. {BRAND.name} never holds or moves your coins. Once the burn is final on Solana, the engine checks it (the right coin, the right amount, your wallet, the memo) and locks the machine for your pull. Your card is then sent to the wallet that burned.</p>
        <p><b>Burns are final.</b> There are no refunds. If a burn lands when every card is spoken for (for example a late burn after its quote ran out), it waits and takes the next card that comes in. A transaction edited to burn less than the quote gets nothing.</p>

        <h2 id="fairness">How the card is picked</h2>
        <p>When your burn is confirmed, the engine writes down the list of cards in the machine and its hash, and picks a Solana slot about 40 slots ahead. The card is picked from the first finalized block at or after that slot:</p>
        <p className="code">seed = sha256(blockhash | pull id | burn signature | list hash)<br />eligible = the locked list, minus cards that earlier pulls of this coin took<br />card = eligible[seed mod n]</p>
        <p>The list is fixed before the seed block exists, so nobody, {BRAND.name} included, can know or choose your card. Every pull&apos;s page shows the list, the hash, the block and the seed so anyone can recompute it.</p>

        <h2 id="token">${T}</h2>
        <p>{split.burn}% of every coin&apos;s creator fees buys ${T} and burns it, on the curve and after graduation. ${T} is a plain pump.fun coin: no mint authority, no freeze authority.</p>
        {root && <p>${T}: <AddrLink a={root.mint}>{root.mint}</AddrLink></p>}

        <h2 id="trust">What you are trusting</h2>
        <ul>
          <li><b>On-chain and locked:</b> every coin&apos;s fee split (pump.fun fee sharing, admin revoked). Anyone can read it.</li>
          <li><b>Held by {BRAND.name}&apos;s engine:</b> each coin&apos;s pool and card vault are wallets whose keys the engine derives from one secret. The engine is coded to sign only three kinds of transaction with them: a USDC swap into the vault, a Collector Crypt pack payment of exactly the pack price, and a card transfer to a wallet that burned for it. That is code you trust, not a contract.</li>
          <li><b>Collector Crypt:</b> the packs, the cards and their insured values are Collector Crypt&apos;s. Their API is not public and can change or close; a closed machine just stops filling.</li>
        </ul>

        <h2 id="risks">Risks</h2>
        <ul>
          <li>Coins launched here can lose most or all of their value. A machine full of cards does not hold up the coin&apos;s price.</li>
          <li>Pulls are random. Insured values are Collector Crypt&apos;s estimates, not prices anyone has to pay you; most cards resell below them.</li>
          <li>Burns cannot be undone. Read the quote before you sign.</li>
          <li>{BRAND.name} is not affiliated with pump.fun, Collector Crypt, Nintendo or The Pokémon Company.</li>
        </ul>

        <h2 id="addresses">Addresses</h2>
        <ul className="addrs">
          <li>pump.fun program: <AddrLink a={PUMP.program}>{PUMP.program}</AddrLink></li>
          <li>pump.fun fee sharing: <AddrLink a={PUMP.feesProgram}>{PUMP.feesProgram}</AddrLink></li>
          {wal?.engine && <li>engine (pays the cranks): <AddrLink a={wal.engine}>{wal.engine}</AddrLink></li>}
          {wal?.burn && <li>burn wallet (buys + burns ${T}): <AddrLink a={wal.burn}>{wal.burn}</AddrLink></li>}
          <li>each coin&apos;s pool and card vault: shown on its machine page</li>
        </ul>
      </article>
    </div>
  )
}
