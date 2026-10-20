// Dev seed: ROOT + 12 coins over levels 1–3 (+ 1 hidden admin test coin) with realistic pump.fun numbers,
// locked sharing configs, measured distributions, holder rounds with lines, burns and events — so the site can be
// built with no chain at all (DEV_OFFLINE=true keeps every loop off). Every key is a real random Solana key
// (valid base58, wallets on-curve), every signature 64 random bytes in base58. Shapes are exactly API.md's.
import { Keypair } from '@solana/web3.js'
import { randomBytes } from 'crypto'
import bs58 from 'bs58'
import { config } from './config.js'
import { coinsStore, ledgerStore, roundsStore, burnsStore, eventsStore, earnedStore, patchState, newId } from './store.js'
import { setLive, noteHolders, noteRoundTimes } from './registry.js'
import { setSolUsd } from './price.js'
import { setRent0 } from './solana.js'
import { mergeShares } from './math.js'

const key = () => Keypair.generate().publicKey.toBase58()
const sig = () => bs58.encode(randomBytes(64))
const L = sol => BigInt(Math.round(sol * 1e9)).toString()
const ago = h => Math.round(Date.now() - h * 3_600_000)
let seedN = 7
const rnd = () => { seedN = (seedN * 16807) % 2147483647; return seedN / 2147483647 } // deterministic figures

/**
 * Seed the site-development data. OFFLINE ONLY (DEV_OFFLINE: no chain, no money loops): the seed is a fake ROOT and
 * fake coins with random pools and "locked" splits written into the money stores — on an engine with keys and an RPC it
 * would set a ROOT no one holds and open public launches under coins that do not exist. Returns false when refused.
 */
export function seedDev() {
  if (!config.offline) { console.error('[dev] DEV_SEED is ignored: the dev seed only runs with DEV_OFFLINE=true (no chain, no keys)'); return false }
  setSolUsd(190)
  setRent0(650_240)
  if (!Object.keys(coinsStore.get()).length) writeSeed()
  // live figures are in memory: re-applied from the records on every boot
  for (const c of Object.values(coinsStore.get())) if (c.devLive) { setLive(c.mint, c.devLive); noteHolders(c.mint, c.devLive.holders, c.devLive.holdersTop) }
  for (const r of roundsStore.get().rounds) if (r.status === 'open') noteRoundTimes(r.parentMint, { next: r.openedAt + config.roundMs })
  for (const c of Object.values(coinsStore.get())) { const done = roundsStore.get().rounds.filter(r => r.parentMint === c.mint && r.status === 'done').pop(); if (done) noteRoundTimes(c.mint, { last: done.closedAt }) }
  seedPacks()
  return true
}

/** GACHAPAD demo: pots on the way to a pack + a few delivered pulls (real Collector Crypt card images). Offline only. */
async function seedPacks() {
  const { ripsStore, setFigures, run } = await import('./packs.js')
  const { pullsStore, setSamples } = await import('./pulls.js')
  const { readFileSync } = await import('fs')
  const { join } = await import('path')
  const { HERE } = await import('./config.js')
  const real = JSON.parse(readFileSync(join(HERE, 'scripts', 'dev-cards.json'), 'utf8'))
  const coinsAll = Object.values(coinsStore.get()).filter(c => !c.root && !c.hidden && c.packCode)
  for (const c of coinsAll) setSamples(c.mint, Array.from({ length: 10 }, (_, i) => ({ at: Date.now() - (10 - i) * 58_000, priceSol: c.devLive.priceSol })))
  if (ripsStore.get().rips.length && ripsStore.get().rips.some(r => r.status === 'stock')) {
    coinsAll.forEach((c, i) => setFigures(c.mint, { usdcRaw: BigInt(Math.round([18.2, 31.5, 9.9, 42.4, 61.7, 23.1, 4.8, 12, 2, 0.4][i % 10] * 1e6)), poolLamports: BigInt(Math.round((0.02 + (i % 3) * 0.03) * 1e9)) }))
    return
  }
  const names = { pokemon_25: 'Starter Pokémon Gacha Pack', pokemon_50: 'Elite Pokémon Gacha Pack', pokemon_100: 'Bronze Pokémon Gacha Pack', onepiece_50: 'One Piece Ocean Blue Pack', basketball_50: 'Basketball Gacha Pack', sealed_80: 'Sealed Gacha Pack', dragonball_50: 'Dragonball 50', comic_25: 'Comic 25' }
  const price = { pokemon_25: 25, pokemon_50: 50, pokemon_100: 100, onepiece_50: 50, basketball_50: 50, sealed_80: 80, dragonball_50: 50, comic_25: 25 }
  const rips2 = [], pulls2 = []
  let n = 0, k = 0
  const stockPer = [9, 7, 6, 5, 4, 3, 2, 1, 0, 0]
  coinsAll.forEach((c, ci) => {
    const total = stockPer[ci] + (ci < 4 ? 3 : 0)
    for (let j = 0; j < total; j++) {
      const card = real[k++ % real.length]
      n++
      const pulled = ci < 4 && j >= stockPer[ci]
      rips2.push({ id: `p${n}`, n, mint: c.mint, symbol: c.symbol, at: ago(20 - n * 0.3), code: c.packCode, machineName: names[c.packCode], priceUsdc: price[c.packCode], status: pulled ? 'delivered' : 'stock', memo: 'cc-dev', sig: sig(), card, rarity: card.valueUsd > 60 ? 'rare' : 'common', stockedAt: ago(20 - n * 0.3), ...(pulled ? { pullId: `dev${n}`, deliveredAt: ago(1 + j * 0.2), delivery: { status: 'confirmed', sig: sig() } } : {}) })
      if (pulled) {
        const id = `dev${n}`
        pulls2.push({ id, mint: c.mint, symbol: c.symbol, wallet: key(), status: 'delivered', createdAt: ago(1.2 + j * 0.2), expiresAt: ago(1.1 + j * 0.2), tokensRaw: String(Math.round(1_000_000 * 1e6 * (1 + j))), burnedRaw: String(Math.round(1_000_000 * 1e6 * (1 + j))), priceUsd: card.valueUsd * 1.1, sig: sig(), burnSlot: 451_000_000 + n, ripId: `p${n}`, card, memo: `gachapad:pull:${id}`, freeze: { list: [`p${n}`], hash: randomBytes(32).toString('hex'), seq: n, slot: 451_000_000 + n, seedSlot: 451_000_040 + n }, draw: { blockSlot: 451_000_041 + n, blockhash: key(), seed: randomBytes(32).toString('hex'), eligible: [`p${n}`], index: 0, n: 1, at: ago(1 + j * 0.2) }, deliveredAt: ago(1 + j * 0.2), delivery: { status: 'confirmed', sig: sig() } })
      }
    }
  })
  ripsStore.set({ rips: rips2 })
  pullsStore.set({ seq: n, pulls: pulls2 })
  run.machine = { code: 'pokemon_25', name: names.pokemon_25, priceUsdc: 25, open: true, buybackPct: 85, image: null }
  run.evUsd = 27.4
  coinsAll.forEach((c, i) => setFigures(c.mint, { usdcRaw: BigInt(Math.round([18.2, 31.5, 9.9, 42.4, 61.7, 23.1, 4.8, 12, 2, 0.4][i % 10] * 1e6)), poolLamports: BigInt(Math.round((0.02 + (i % 3) * 0.03) * 1e9)) }))
  return
  // eslint-disable-next-line no-unreachable
  const { roundStore } = await import('./packs.js')
  run.machine = { code: 'pokemon_50', name: 'Elite Pokémon Gacha Pack', priceUsdc: 50, open: true, buybackPct: 85, image: null }
  run.evUsd = 55
  const coinsL = Object.values(coinsStore.get()).filter(c => !c.root && !c.hidden)
  coinsL.forEach((c, i) => {
    setFigures(c.mint, { usdcRaw: BigInt(Math.round([46.2, 31.5, 18.9, 12.4, 7.7, 3.1, 0.8][i % 7] * 1e6)), poolLamports: BigInt(Math.round((0.02 + (i % 3) * 0.03) * 1e9)) })
    const rs = roundStore(c.mint)
    if (!rs.get().samples) rs.set({ id: 1, startedAt: ago(1), samples: 4 + i, lastSampleAt: Date.now() - 120_000, sums: Object.fromEntries(Array.from({ length: 6 + i }, () => [key(), String(BigInt(Math.round((150_000 + rnd() * 5_000_000) * 1e6)) * BigInt(4 + i))])) })
  })
  if (ripsStore.get().rips.length) return
  const cards = [
    { id: '3JqZ2VyyiGcwcex8kPVEvGWPEb8ograHQDdJWEKfGKyj', name: '2025 #01 Captain Pikachu PSA 9', cardName: 'Captain Pikachu', set: 'Pokemon Simplified Chinese CBB1 C-Gem Pack Vol 1', grader: 'PSA', grade: 'MINT 9', valueUsd: 30, image: 'https://nft.collectorcrypt.com/front/202609028C241221' },
    { id: '6DETShpirxjapnqWwE5dAXvM2BMjy5uanZWSSbxfHoFb', name: '2025 #142 Zorua PSA 9', cardName: 'Zorua', set: 'Pokemon Wht EN-White Flare', grader: 'PSA', grade: 'MINT 9', valueUsd: 42, image: 'https://nft.collectorcrypt.com/front/202609042C245144' },
  ]
  const rips = coinsL.slice(0, 3).map((c, i) => ({ id: `p${i + 1}`, n: i + 1, mint: c.mint, symbol: c.symbol, at: ago(6 - i * 2), code: 'pokemon_50', machineName: 'Elite Pokémon Gacha Pack', priceUsdc: 50, status: i === 2 ? 'frozen' : 'delivered', memo: 'cc-dev', sig: sig(), card: i === 2 ? cards[0] : cards[i % 2], rarity: 'common', draw: { roundId: 1, samples: 6, entrants: 40 + i * 9, total: '1000000', hash: randomBytes(32).toString('hex'), frozenAt: ago(5 - i * 2), seedSlot: 451_000_000 + i, ...(i === 2 ? {} : { blockSlot: 451_000_000 + i, blockhash: key(), seed: randomBytes(32).toString('hex'), r: '4242', winner: key(), chance: 0.031 + i * 0.01, drawnAt: ago(5 - i * 2) }) }, delivery: i === 2 ? null : { status: 'confirmed', sig: sig() }, deliveredAt: i === 2 ? null : ago(5 - i * 2) }))
  ripsStore.set({ rips })
}

function writeSeed() {
  const burn = key(), protocol = key()
  // [symbol, name, parentSymbol, progress, graduated, holders, vol24hUsd, vol1hUsd, trades24h, hoursAgo, extra]
  const spec = [
    [config.ticker, config.brand, null, 1, true, 1840, 184_000, 9_400, 2_310, 216],
    ['PIKA', 'Pika Club', config.ticker, 1, true, 1210, 96_000, 6_400, 1_880, 30, { pack: 'pokemon_25' }],
    ['LUFFY', 'Straw Hat Pulls', config.ticker, 0.82, false, 640, 38_000, 2_900, 960, 22, { pack: 'onepiece_50' }],
    ['GEM', 'Gem Mint', config.ticker, 0.64, false, 412, 21_000, 1_900, 530, 18, { pack: 'pokemon_50' }],
    ['HOOP', 'Hoop Dreams', config.ticker, 0.41, false, 210, 8_800, 700, 240, 12, { pack: 'basketball_50' }],
    ['HOLO', 'Holo Rare', config.ticker, 0.33, false, 168, 6_900, 520, 190, 9, { pack: 'pokemon_100' }],
    ['VAULT', 'The Vault', config.ticker, 0.19, false, 96, 4_100, 200, 118, 6, { pack: 'sealed_80' }],
    ['SLAB', 'Slab Season', config.ticker, 0.12, false, 64, 2_100, 160, 70, 4, { pack: 'pokemon_25' }],
    ['GOKU', 'Kame House', config.ticker, 0.07, false, 31, 900, 40, 22, 2, { pack: 'dragonball_50' }],
    ['MOON', 'Moon Pull', config.ticker, 0.03, false, 11, 150, 10, 6, 0.6, { pack: 'pokemon_25' }],
    ['NUT', 'Fresh Pack', config.ticker, 0.01, false, 4, 40, 4, 3, 0.2, { pack: 'comic_25' }],
    ['TEST', 'Admin Test', config.ticker, 0.01, false, 2, 10, 0, 1, 1, { hidden: true, pack: 'pokemon_25' }],
  ]
  const bySym = {}, all = {}
  const ledger = { byPool: {}, byMint: {}, consumed: [], gasSpentLamports: L(0.0042) }
  for (const [symbol, name, parentSym, progress, graduated, holders, v24, v1, trades, hoursAgo, extra = {}] of spec) {
    const parent = parentSym ? bySym[parentSym] : null
    const level = parent ? parent.level + 1 : 0
    const mint = key(), holderPool = key(), launcher = key()
    const shares = parent
      ? mergeShares([[launcher, 4000, 'creator'], [parent.holderPool, 4000, 'parentHolders'], [burn, 1000, 'burn'], [protocol, 1000, 'protocol']])
      : mergeShares([[burn, 8000, 'burn'], [protocol, 2000, 'protocol']])
    // curve maths (pump Global): 30 SOL / 1.073B virtual, 793.1M real tokens → ~85 SOL real at completion
    const vt = 1_073_000_000 - progress * 793_100_000
    const vq = (30 * 1_073_000_000) / vt
    const priceSol = graduated ? (symbol === config.ticker ? 0.0000024 : 0.00000061) : vq / vt
    const realSol = graduated ? 85.005 : vq - 30
    const pendingSol = level ? +(0.0005 + rnd() * 0.02).toFixed(6) : 0
    const status = symbol === 'NUT' ? 'pending' : 'locked'
    const rec = {
      mint, symbol, name, description: parent ? `${name}: its fees rip real graded cards into its own machine. Burn $${symbol} to pull one.` : 'Every coin gets a gacha machine stocked with real graded cards.', uri: `http://localhost:3011/m/${mint}.json`, image: '',
      socials: symbol === config.ticker ? { website: config.siteUrl, twitter: '' } : {},
      parent: parent?.mint || null, level, root: !parent, packCode: parent ? (extra.pack || 'pokemon_25') : null, creator: launcher, creatorKey: key(), parentPool: parent?.holderPool || null, holderPool, shares,
      createdAt: ago(hoursAgo), launchSig: sig(), launchId: newId(12), hidden: !!extra.hidden, external: false, ...(extra.hidden ? { adminLaunch: true } : {}),
      sharing: status === 'locked' ? { address: key(), tx: sig(), at: ago(hoursAgo - 0.01), shareholders: shares } : null, setup: null, swept: status === 'locked', distributeBlocked: null,
      devLive: {
        graduated, progress, realSol, ammPool: graduated ? key() : null, priceSol, mcapSol: priceSol * 1e9, creatorFeeBps: 30,
        curveCreator: key(), chainSharing: status === 'locked' ? { adminRevoked: true, shareholders: shares.map(s => ({ address: s.address, shareBps: s.shareBps })) } : null, sharingOk: status === 'locked' ? true : null,
        vaultLamports: L(0.00065024 + pendingSol), pendingLamports: L(pendingSol), ammVaultLamports: '0', ammAtaExists: graduated,
        poolLamports: L(0.002 + rnd() * (level < 2 ? 0.8 : 0.05)), vol24hUsd: v24, vol1hUsd: v1, trades24h: trades, holders,
        holdersTop: Array.from({ length: Math.min(20, holders) }, (_, i) => ({ wallet: key(), amountUi: Math.round(40_000_000 / (i + 1)), share: +(0.04 / (i + 1)).toFixed(5) })),
        refreshedAt: Date.now(),
      },
    }
    if (level) {
      const dist = 0.02 + rnd() * (v24 / 20_000)
      ledger.byMint[mint] = { distributedLamports: L(dist), toParentLamports: L(dist * 0.4), toLauncherLamports: L(dist * 0.4), toBurnLamports: L(dist * 0.1), toProtocolLamports: L(dist * 0.1), sweptLamports: L(0.0012), cranks: 1 + Math.floor(rnd() * 20) }
    }
    bySym[symbol] = rec
    all[mint] = rec
  }
  // pools: what each parent's holders were paid, from the rounds below
  const rounds = [], events = [], earned = {}
  const pay = (parent, n, hoursAgo, status = 'done') => {
    const lines = Array.from({ length: n }, (_, i) => ({ wallet: key(), weight: String(Math.round(90_000_000_000_000 / (i + 2))), lamports: L(+(0.004 + 0.3 / (i + 3)).toFixed(6)), sig: null, status: status === 'done' ? 'paid' : 'dry' }))
    const sigs = []
    for (let i = 0; i < lines.length; i += 12) { const s = sig(); sigs.push(s); for (const l of lines.slice(i, i + 12)) l.sig = status === 'done' ? s : null }
    const paid = lines.reduce((a, l) => a + BigInt(l.lamports), 0n)
    const r = { id: newId(8), parentMint: parent.mint, parentSymbol: parent.symbol, pool: parent.holderPool, openedAt: ago(hoursAgo + 1), closedAt: ago(hoursAgo), budgetLamports: (paid + BigInt(L(0.01))).toString(), leftoverLamports: L(0.01), lines, status, sigs: status === 'done' ? sigs : [], eligible: n + 3, holdersOpen: n + 10, holdersClose: n + 9, ...(status === 'skipped' ? { reason: 'PAYOUTS_LIVE is off: planned, nothing sent' } : {}) }
    rounds.push(r)
    if (status === 'done') {
      const e = (ledger.byPool[parent.mint] ||= { paidLamports: '0', paidCount: 0, quarantinedLamports: '0', quarantinedCount: 0, rounds: 0, lastRoundAt: 0 })
      e.paidLamports = (BigInt(e.paidLamports) + paid).toString(); e.paidCount += n; e.rounds += 1; e.lastRoundAt = Math.max(e.lastRoundAt, r.closedAt)
      for (const l of lines) { const w = (earned[l.wallet] ||= { lamports: '0', rows: [] }); w.lamports = (BigInt(w.lamports) + BigInt(l.lamports)).toString(); w.rows.push({ key: `${l.sig}:${l.wallet}`, parentMint: parent.mint, symbol: parent.symbol, lamports: l.lamports, sig: l.sig, at: r.closedAt, roundId: r.id }) }
      for (const s of sigs) events.push({ id: `payout:${s}`, type: 'payout', at: r.closedAt + 5_000, mint: parent.mint, symbol: parent.symbol, amountSol: Number(paid) / 1e9 / sigs.length, sig: s, extra: { roundId: r.id, wallets: Math.min(12, n) } })
    }
    events.push({ id: `round:${r.id}`, type: 'round', at: r.closedAt, mint: parent.mint, symbol: parent.symbol, amountSol: Number(paid) / 1e9, extra: { roundId: r.id, status, wallets: n, budgetSol: Number(BigInt(r.budgetLamports)) / 1e9 } })
  }
  const root = bySym[config.ticker]
  for (const [p, rs] of [[root, [[40, 30], [28, 6], [33, 3]]]]) for (const [n, h] of rs) pay(p, n, h)
  // an open round per parent that has kids
  for (const c of Object.values(all)) if (Object.values(all).some(k => k.parent === c.mint && !k.hidden)) rounds.push({ id: newId(8), parentMint: c.mint, parentSymbol: c.symbol, pool: c.holderPool, openedAt: ago(0.4), openSnapshot: {}, status: 'open', lines: [], sigs: [] })
  // events: launches, locks, distributes, graduations, trades
  for (const c of Object.values(all)) {
    events.push({ id: `launch:${c.mint}`, type: 'launch', at: c.createdAt, mint: c.mint, symbol: c.symbol, parentMint: c.parent || undefined, wallet: c.creator, sig: c.launchSig, amountSol: +(rnd() * 1.5).toFixed(3), extra: { level: c.level, parentSymbol: c.parent ? all[c.parent].symbol : null, hidden: c.hidden } })
    if (c.sharing) events.push({ id: `lock:${c.mint}`, type: 'lock', at: c.sharing.at, mint: c.mint, symbol: c.symbol, parentMint: c.parent || undefined, wallet: c.creator, sig: c.sharing.tx, extra: { shareholders: c.shares } })
    const d = ledger.byMint[c.mint]
    if (d) { const s = sig(); events.push({ id: `dist:${s}`, type: 'distribute', at: ago(rnd() * 20), mint: c.mint, symbol: c.symbol, parentMint: c.parent || undefined, amountSol: Number(BigInt(d.distributedLamports)) / 1e9, sig: s, extra: { toParentHoldersSol: Number(BigInt(d.toParentLamports)) / 1e9, toLauncherSol: Number(BigInt(d.toLauncherLamports)) / 1e9, toBurnSol: Number(BigInt(d.toBurnLamports)) / 1e9, toProtocolSol: Number(BigInt(d.toProtocolLamports)) / 1e9 } }) }
    if (c.devLive.graduated) events.push({ id: `grad:${c.mint}`, type: 'graduate', at: c.createdAt + 3_600_000 * 10, mint: c.mint, symbol: c.symbol, parentMint: c.parent || undefined, extra: { ammPool: c.devLive.ammPool } })
    for (let i = 0; i < 3 && !c.hidden; i++) { const s = sig(); const side = rnd() > 0.4 ? 'buy' : 'sell'; events.push({ id: `trade:${s}`, type: 'trade', at: ago(rnd() * 6), mint: c.mint, symbol: c.symbol, parentMint: c.parent || undefined, wallet: key(), sig: s, amountSol: +(0.05 + rnd() * 2).toFixed(3), extra: { side, route: c.devLive.graduated ? 'amm' : 'curve' } }) }
  }
  // burns of ROOT
  const done = []
  let burnedRaw = 0n, spent = 0n
  for (let i = 0; i < 9; i++) {
    const amountUi = Math.round(80_000 + rnd() * 400_000), spentSol = +(amountUi * root.devLive.priceSol).toFixed(6)
    const b = { at: ago(2 + i * 5), amountUi, amountRaw: String(amountUi * 1e6), spentSol, sig: sig(), swapSig: sig(), priceUsdAt: 190 }
    done.push(b); burnedRaw += BigInt(b.amountRaw); spent += BigInt(L(spentSol))
    events.push({ id: `burn:${b.sig}`, type: 'burn', at: b.at, mint: root.mint, symbol: root.symbol, amountUi, amountSol: spentSol, sig: b.sig, extra: { swapSig: b.swapSig } })
  }
  done.sort((a, b) => a.at - b.at)
  events.sort((a, b) => a.at - b.at)
  coinsStore.set(all)
  ledgerStore.set(ledger)
  roundsStore.set({ rounds: rounds.sort((a, b) => a.openedAt - b.openedAt) })
  burnsStore.set({ pending: null, done, totalBurnedRaw: burnedRaw.toString(), totalSpentLamports: spent.toString() })
  eventsStore.set(events)
  earnedStore.set(earned)
  patchState({ rootMint: root.mint, seeded: true, seededAt: Date.now(), devWallets: { engine: key(), burn, protocol, engineSol: 0.412, burnSol: 0.0183 } })
  console.log(`[dev] seeded ROOT $${root.symbol} ${root.mint} + ${Object.keys(all).length - 1} coins, ${rounds.length} rounds, ${done.length} burns, ${events.length} events`)
}
