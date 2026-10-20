// The pure rules of the SLAB draw. No I/O: every rule here is unit-tested (test.js).
//
//   round    = everything since the previous card's draw froze. Holders are read every SAMPLE_MS.
//   weight   = a wallet's AVERAGE balance over the round's readings (a reading it was not in counts as 0):
//              held all round → full weight; bought 5 minutes before the draw → almost nothing. A wallet that
//              arrives mid-round still earns its share of the time (no "launched mid-round = out" rule).
//   entry    = average ≥ MIN_HOLD, a real wallet (on the ed25519 curve: never a pool, curve or vault PDA),
//              never one of SLAB's own wallets.
//   cap      = no wallet's weight above MAX_WALLET_CHANCE_BPS of the uncapped total (one pass): clips a whale,
//              never flattens everyone to one ticket per wallet (that would make splitting into wallets pay).
//   pick     = seed (sha256 of a blockhash that did not exist when the entries froze) mod total, walked over
//              the entries sorted by wallet address. Anyone can recompute it from /draw/:id.
import { createHash } from 'crypto'

/** Add one holder reading to a round's running sums. `holders`: Map(owner → raw bigint). Mutates `sums` (owner → string). */
export function addSample(sums, holders, { isEligibleOwner = () => true } = {}) {
  for (const [owner, amount] of holders) {
    if (amount <= 0n || !isEligibleOwner(owner)) continue
    sums[owner] = (BigInt(sums[owner] || '0') + amount).toString()
  }
  return sums
}

/** Average holdings over `samples` readings, above `minRaw`. Returns [{ wallet, weight }] sorted by wallet. */
export function averages(sums, samples, { minRaw = 0n } = {}) {
  const n = BigInt(samples)
  if (n <= 0n) return []
  const out = []
  for (const [wallet, sum] of Object.entries(sums)) {
    const w = BigInt(sum) / n
    if (w <= 0n || w < BigInt(minRaw)) continue
    out.push({ wallet, weight: w })
  }
  return out.sort((a, b) => (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0))
}

/**
 * Cap every weight at `capBps` of the UNCAPPED total, in one pass. Never iterated to a fixed point: that turns
 * token weighting into one-ticket-per-wallet with few entrants (a 50M whale and a 100k minnow end up equal), which
 * makes splitting into many minimum-size wallets pay. One pass only clips a whale; splitting gains nothing.
 */
export function capWeights(entries, capBps) {
  if (!entries.length || capBps >= 10_000) return entries.map(e => ({ ...e }))
  const total = entries.reduce((a, e) => a + e.weight, 0n)
  const cap = (total * BigInt(capBps)) / 10_000n
  if (cap <= 0n) return entries.map(e => ({ ...e }))
  return entries.map(e => (e.weight > cap ? { ...e, weight: cap } : { ...e }))
}

/** Canonical hash of a draw's entries (what was frozen before the seed existed). */
export function entriesHash(entries) {
  const canon = entries.map(e => `${e.wallet}:${e.weight.toString()}`).join('\n')
  return createHash('sha256').update(canon).digest('hex')
}

/** The draw seed: sha256(blockhash | draw id | entries hash), hex. */
export function drawSeed({ blockhash, drawId, hash }) {
  return createHash('sha256').update(`${blockhash}|${drawId}|${hash}`).digest('hex')
}

/**
 * Pick one entry: r = seed mod total, walk the entries (sorted by wallet) until the running weight passes r.
 * Returns { wallet, weight, index, r, total } or null when there is nobody.
 */
export function pickWinner(entries, seedHex) {
  const total = entries.reduce((a, e) => a + e.weight, 0n)
  if (total <= 0n) return null
  const r = BigInt(`0x${seedHex}`) % total
  let acc = 0n
  for (let i = 0; i < entries.length; i++) {
    acc += entries[i].weight
    if (r < acc) return { wallet: entries[i].wallet, weight: entries[i].weight, index: i, r, total }
  }
  return null // unreachable
}

/** A wallet's chance (0-1) in a live or frozen entry list. */
export function chanceOf(entries, wallet) {
  const total = entries.reduce((a, e) => a + e.weight, 0n)
  const me = entries.find(e => e.wallet === wallet)
  if (!me || total <= 0n) return 0
  return Number((me.weight * 1_000_000n) / total) / 1_000_000
}

/** Split claimed lamports by bps. Exact: parts sum to the input, dust goes to the packs. */
export function splitClaim(lamports, { burnBps, opsBps }) {
  const l = BigInt(lamports)
  const burn = (l * BigInt(burnBps)) / 10_000n
  const ops = (l * BigInt(opsBps)) / 10_000n
  return { packs: l - burn - ops, burn, ops }
}
