// The distribute crank: pump.fun's `distributeCreatorFees` is permissionless — we just run it on time for every
// locked coin (the engine wallet pays only the tx fee, never pool money). Graduated coins first move their
// PumpSwap creator vault into the pump vault (transferCreatorFeesToPumpV2) when that vault exists.
//
// Money rules:
//   - crank only when the vault ≥ max(rent(0) + COLLECT_MIN_SOL, pump's unfunded-shareholder minimum computed with
//     the shareholders' LIVE lamports) — below it pump returns OK and moves nothing (a silent no-op)
//   - book ONLY the measured delta of the confirmed tx (booking an estimate when nothing moved was a real bug in an earlier engine). 0 → nothing booked
//   - an executable shareholder (6052) blocks the coin forever: mark distributeBlocked and stop cranking it
//   - third-party cranks are fine: pool balances are the round budget; the fee totals come from the CHAIN — the fee
//     index (indexDistributions) books every DistributeCreatorFees that paid our shareholders, whoever sent it
//   - the crank decides on a LIVE vault read, never on the last refresh's (possibly stale) figure
import bs58 from 'bs58'
import { config } from './config.js'
import { bookDistribution, addGasSpent, isConsumed, readState, patchState } from './store.js'
import { getConnection, getEngine, engineAddress, protocolAddress, buildTx, simulate, sendAndConfirm, serializeTx, balanceOf, walletKinds, readLamportDeltas, lamportDeltasOf, sol, toLamports, txFeeLamports, rent0, rentLoaded, pk } from './solana.js'
import { readSharingConfig, readDistributable, distributeIxs, vaultAccounts, feeSharingConfigPda, bondingCurvePda, readCurveFeeBucket, SWEEP_CREATOR_FEE_DISC, PUMP_PROGRAM_ID } from './pump.js'
import { crankDecision, is6052 } from './math.js'
import { coins, coinRec, patchCoin, liveOf, setLive, warnEvery } from './registry.js'
import { isKilled } from './kill.js'
import { emitEvent } from './bus.js'

const errText = e => String(e?.message || e).slice(0, 200)
const lastCrankAt = new Map()
let running = false
const status = { lastRunAt: 0, lastSent: 0, lastError: null }
export const distributeStatus = () => ({ ...status, live: config.distributeLive })

/** Map a measured per-address delta onto the coin's roles. Pure. */
export function deltasByRole(shares, deltas) {
  const out = { toParent: 0n, toLauncher: 0n, toBurn: 0n, toProtocol: 0n }
  const key = { parentHolders: 'toParent', creator: 'toLauncher', burn: 'toBurn', protocol: 'toProtocol' }
  for (const s of shares || []) {
    const d = deltas.get(s.address)
    if (d != null && d > 0n && key[s.role]) out[key[s.role]] += d
  }
  return out
}

/**
 * What left a coin's OWN fee vaults in one fetched tx (lamports, ≥ 0): pump's creator vault of its sharing config +
 * the AMM creator-vault WSOL ATA (a graduated coin's fees, moved over by transferCreatorFeesToPumpV2). Pure.
 */
export function vaultDropOf(tx, mint) {
  const { curveVault, ammVaultAta } = vaultAccounts(feeSharingConfigPda(pk(mint)))
  const watch = [curveVault.toBase58(), ammVaultAta.toBase58()]
  // a sweep_creator_fee of this coin in the same tx first moves the curve's creator-fee bucket into the vault: what
  // left the curve account then is pump's fee too (a trade in the same tx only makes this drop smaller: conservative)
  if (sweepsCurveOf(tx, mint)) watch.push(bondingCurvePda(pk(mint)).toBase58())
  let net = 0n
  for (const d of lamportDeltasOf(tx, watch).values()) net += d
  return net < 0n ? -net : 0n
}
/** Does a fetched tx run pump's sweep_creator_fee (top-level) for this mint's curve? Pure. */
export function sweepsCurveOf(tx, mint) {
  const msg = tx?.transaction?.message
  if (!msg || !tx.meta) return false
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
  const pump = PUMP_PROGRAM_ID.toBase58()
  return msg.compiledInstructions.some(ix => keys.get(ix.programIdIndex)?.toBase58() === pump && Buffer.from(ix.data).subarray(0, 8).equals(SWEEP_CREATOR_FEE_DISC) && keys.get(ix.accountKeyIndexes[2])?.toBase58() === mint)
}

/**
 * The most each share of a distribution of `drop` lamports can receive: pump pays every shareholder floor(drop × bps /
 * 10000) and the rounding remainder (< one lamport per shareholder) to one of them — measured on mainnet — so each
 * cap is its floor + that remainder. Pure.
 */
export function shareCaps(drop, bpsList) {
  const d = drop > 0n ? drop : 0n
  const floors = bpsList.map(b => (d * BigInt(Number(b) || 0)) / 10_000n)
  const rem = d - floors.reduce((a, f) => a + f, 0n)
  return floors.map(f => f + (rem > 0n ? rem : 0n))
}

/**
 * The booking of one distribute tx by role: each role's MEASURED delta, capped at its share of what left the coin's
 * fee vaults in that tx (shareCaps), and the total at most that drop. SOL a shareholder received from any other
 * instruction of the same tx (a launcher's own transfer next to a no-op distribute) is never booked as fees. Pure.
 */
export function cappedByRole(shares, deltas, drop) {
  const by = deltasByRole(shares, deltas)
  const key = { parentHolders: 'toParent', creator: 'toLauncher', burn: 'toBurn', protocol: 'toProtocol' }
  const roles = Object.keys(by)
  const bps = Object.fromEntries(roles.map(k => [k, 0]))
  for (const s of shares || []) if (key[s.role]) bps[key[s.role]] += Number(s.shareBps) || 0
  const d = drop > 0n ? drop : 0n
  const caps = shareCaps(d, roles.map(k => bps[k]))
  let total = 0n
  roles.forEach((k, i) => { if (by[k] > caps[i]) by[k] = caps[i]; total += by[k] })
  // the remainder allowance is per role: never book more than the drop in total (trim the launcher's own share first)
  for (const k of ['toLauncher', 'toProtocol', 'toBurn', 'toParent']) {
    if (total <= d) break
    const cut = total - d < by[k] ? total - d : by[k]
    by[k] -= cut; total -= cut
  }
  return by
}

/** One pass over every locked coin. Returns the number of cranks sent. */
export async function distributeDue({ force = false, only = null } = {}) {
  if (running) return 0
  const payer = getEngine()
  if (!payer || !config.rpcUrl || config.offline || !rentLoaded()) return 0
  running = true
  // `attempts` (not confirmed cranks) caps a pass: a crank that does not land blocks ~85 s (180 s when the RPC also
  // fails) inside settleTx, and this pass runs inline in the chain loop (refresh, launch locks, the burner wait on it)
  let sent = 0, attempts = 0, floatOk = null
  try {
    const r0 = rent0(), minPending = toLamports(config.collectMinSol)
    for (const c of Object.values(coins())) {
      if (only && c.mint !== only) continue
      if (!c.sharing?.address || c.external || c.distributeBlocked) continue
      const l = liveOf(c.mint)
      if (l.sharingOk === false) continue
      // + the curve's un-swept creator fee: v3 trades leave it there and the crank sweeps it into the vault first
      const cached = BigInt(l.vaultLamports || '0') + (l.graduated && l.ammAtaExists ? BigInt(l.ammVaultLamports || '0') : 0n) + BigInt(l.curveFeeLamports || '0')
      if (cached < r0 + minPending) continue // cheap pre-check from the last refresh (no RPC)
      if (!force && (Date.now() - (lastCrankAt.get(c.mint) || 0) < 90_000 || attempts >= 8)) continue
      if (floatOk == null) {
        const bal = await balanceOf(payer.publicKey).catch(() => 0n)
        floatOk = bal >= toLamports(config.gasReserveSol)
        if (!floatOk) { warnEvery('float', 600_000, `[distribute] engine wallet ${engineAddress()} holds ${sol(bal).toFixed(4)} SOL, below GAS_RESERVE_SOL ${config.gasReserveSol}: cranks paused, top it up`); break }
      }
      lastCrankAt.set(c.mint, Date.now())
      try {
        // decide on a LIVE read of both vaults: the refresh figure may be stale (our own last crank, a third party's,
        // a refresh that failed) and a crank of an empty vault still costs a tx fee
        const [v, bucket] = await Promise.all([readDistributable([c.mint]).then(m => m.get(c.mint)), readCurveFeeBucket(c.mint)])
        const ammAtaExists = !!v?.ammAtaExists
        const vault = (v?.vaultLamports || 0n) + (l.graduated && ammAtaExists ? v?.amm || 0n : 0n) + bucket
        setLive(c.mint, { vaultLamports: String(v?.vaultLamports || 0n), pendingLamports: String((v?.total || 0n) + bucket), ammVaultLamports: String(v?.amm || 0n), ammAtaExists, curveFeeLamports: String(bucket) })
        if (vault < r0 + minPending) continue
        const sharing = await readSharingConfig(c.mint)
        if (!sharing) continue
        const shareholders = sharing.config.shareholders.map(s => ({ address: s.address.toBase58(), shareBps: Number(s.shareBps) }))
        const kinds = await walletKinds(shareholders.map(s => s.address))
        if ([...kinds.values()].some(k => k.kind == null)) continue // unknown: next pass
        const lamportsOf = new Map([...kinds].map(([a, k]) => [a, k.lamports]))
        const executable = new Set([...kinds].filter(([, k]) => k.executable).map(([a]) => a))
        const d = crankDecision({ vaultLamports: vault, rent0: r0, collectMinLamports: minPending, shareholders, lamportsOf, executable })
        if (d.blocked) { block(c, d.reason); continue }
        if (!d.crank) { setLive(c.mint, { crankNeedLamports: d.need.toString() }); continue }
        if (!config.distributeLive) { warnEvery(`dry:${c.mint}`, 3_600_000, `[distribute] $${c.symbol}: ${sol(vault).toFixed(5)} SOL waiting — DISTRIBUTE_LIVE is off, not cranked`); continue }
        const ixs = await distributeIxs({ mint: c.mint, sharing, graduated: !!l.graduated, ammAtaExists, payer: payer.publicKey })
        const units = 200_000
        const built = await buildTx({ payer: payer.publicKey, instructions: ixs, signers: [payer], units })
        try { await simulate(built.tx, { minContextSlot: built.builtSlot }) } catch (e) { if (is6052(e)) { block(c, 'a shareholder is a program account (pump error 6052): distribution is blocked forever'); continue } throw e }
        if (isKilled()) { console.warn('[distribute] killed — stopping before send'); break }
        attempts++
        const { sig } = await serializeTx(payer.publicKey.toBase58(), () => sendAndConfirm(built.tx, built))
        sent++
        addGasSpent(txFeeLamports(units))
        // Book ONLY what the confirmed tx measurably moved into each shareholder (0 → nothing moved, nothing booked).
        const deltas = await readLamportDeltas(sig, (c.shares || []).map(s => s.address))
        const by = deltas ? deltasByRole(c.shares, deltas) : null
        const booked = by ? bookDistribution(c.mint, sig, by) : false
        const total = by ? by.toParent + by.toLauncher + by.toBurn + by.toProtocol : 0n
        setLive(c.mint, { pendingLamports: '0', vaultLamports: r0.toString(), ammVaultLamports: '0', curveFeeLamports: '0' })
        if (!by) console.warn(`[distribute] $${c.symbol}: crank ${sig} confirmed but the tx is not readable yet — the fee index books it later`)
        else if (!booked) console.warn(`[distribute] $${c.symbol}: crank ${sig} moved NOTHING (pump's minimum not met or someone else cranked first) — nothing booked`)
        else {
          console.log(`[distribute] $${c.symbol}: ${sol(total).toFixed(6)} SOL distributed → parent holders ${sol(by.toParent).toFixed(6)} (${sig})`)
          emitEvent({ id: `dist:${sig}`, type: 'distribute', mint: c.mint, symbol: c.symbol, parentMint: c.parent || undefined, amountSol: sol(total), sig, extra: { toParentHoldersSol: sol(by.toParent), toLauncherSol: sol(by.toLauncher), toBurnSol: sol(by.toBurn), toProtocolSol: sol(by.toProtocol) } })
        }
      } catch (e) {
        status.lastError = errText(e); console.warn(`[distribute] $${c.symbol}: ${errText(e)}`)
        // txs are not landing (congestion, an RPC dropping sends): the next crank would only wait the same ~85 s
        if (/TX_NOT_LANDED|CONFIRM_UNKNOWN/.test(String(e?.message))) { console.warn('[distribute] a crank did not land — ending this pass (the rest wait for the next one)'); break }
      }
    }
  } finally { running = false; status.lastRunAt = Date.now(); status.lastSent = sent }
  return sent
}

/* ---------------- the fee index: book every distribution from the chain ---------------- */

// pump's two distribute instructions, and where each carries the mint: `distribute_creator_fees` (SOL coins) has
// mint at account 0; `distribute_creator_fees_v2` (any quote — it works on SOL coins too, paying lamports from the same
// vault) has payer at 0 and mint at 1. A third party may crank one of our coins with either.
const DIST_IXS = [
  { disc: Buffer.from([165, 114, 103, 0, 121, 206, 247, 81]), mintAt: 0 }, // distribute_creator_fees
  { disc: Buffer.from([255, 203, 19, 79, 244, 68, 8, 159]), mintAt: 1 }, // distribute_creator_fees_v2
]
// The highest transaction version the fee index asks for: web3.js 1.99 decodes version-1 messages (MessageV1).
const TX_VERSION = 1
const index = { running: false, at: 0, lastBooked: 0, lastError: null, skippedUnsupported: 0 }
export const indexStatus = () => ({ lastRunAt: index.at || null, lastBooked: index.lastBooked, lastError: index.lastError, skippedUnsupported: index.skippedUnsupported, cursor: readState().distIndexUntil || null })

/**
 * The ONE coin a fetched tx ran pump's distributeCreatorFees (V1 or V2) for (top-level or through a CPI), or null
 * (none — or several, where a per-coin split of shared shareholders' deltas would be a guess). Pure.
 */
export function distributedMint(tx) {
  const msg = tx?.transaction?.message
  if (!msg || !tx.meta) return null
  const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses })
  const at = i => (i == null ? undefined : keys.get(i)?.toBase58())
  const pump = PUMP_PROGRAM_ID.toBase58()
  const mintIndex = d => { if (d.length < 8) return null; const k = DIST_IXS.find(x => d.subarray(0, 8).equals(x.disc)); return k ? k.mintAt : null }
  const mints = new Set()
  for (const ix of msg.compiledInstructions) {
    const mi = at(ix.programIdIndex) === pump ? mintIndex(Buffer.from(ix.data)) : null
    if (mi != null) mints.add(at(ix.accountKeyIndexes[mi]))
  }
  for (const inner of tx.meta.innerInstructions || []) for (const ix of inner.instructions || []) {
    let d
    try { d = Buffer.from(typeof ix.data === 'string' ? bs58.decode(ix.data) : ix.data) } catch { continue }
    const mi = at(ix.programIdIndex) === pump ? mintIndex(d) : null
    if (mi != null) mints.add(at((ix.accounts || ix.accountKeyIndexes || [])[mi]))
  }
  mints.delete(undefined)
  return mints.size === 1 ? [...mints][0] : null
}

/**
 * Book one fetched tx if it distributed a registered coin's fees, idempotent per sig: the measured shareholder deltas,
 * each capped at its share of what left the coin's own fee vaults in that tx. Anyone can put a distribute (even a
 * no-op one) next to their own transfers in one tx; only the vaults' drop is pump's.
 */
function bookFromTx(sig, tx) {
  const mint = distributedMint(tx)
  const c = mint ? coinRec(mint) : null
  if (!c?.shares?.length) return false
  const by = cappedByRole(c.shares, lamportDeltasOf(tx, c.shares.map(s => s.address)), vaultDropOf(tx, mint))
  if (!bookDistribution(mint, sig, by)) return false
  const total = by.toParent + by.toLauncher + by.toBurn + by.toProtocol
  emitEvent({ id: `dist:${sig}`, type: 'distribute', mint, symbol: c.symbol, parentMint: c.parent || undefined, amountSol: sol(total), sig, extra: { toParentHoldersSol: sol(by.toParent), toLauncherSol: sol(by.toLauncher), toBurnSol: sol(by.toBurn), toProtocolSol: sol(by.toProtocol), indexed: true } })
  return true
}

/**
 * The fee totals come from the chain, not from our own cranks: the protocol wallet is a shareholder of EVERY lock, so
 * its signature list holds every DistributeCreatorFees of every coin — ours, the launcher's from pump.fun's page, a
 * bot's — plus our own cranks that ended CONFIRM_UNKNOWN or were unreadable. One getSignaturesForAddress per pass
 * (forward from a cursor in state.json) + one getTransaction per new signature (at most `maxTx` per pass). The first
 * pass only sets the cursor (no history backfill). Display-only: nothing here moves money.
 */
export async function indexDistributions({ force = false, maxTx = 25 } = {}) {
  const anchor = protocolAddress()
  if (index.running || !anchor || !config.rpcUrl || config.offline) return 0
  if (!force && Date.now() - index.at < 60_000) return 0
  index.running = true
  let booked = 0
  try {
    const conn = getConnection()
    const until = readState().distIndexUntil || ''
    if (!until) {
      const [newest] = await conn.getSignaturesForAddress(pk(anchor), { limit: 1 }, 'confirmed')
      if (newest) patchState({ distIndexUntil: newest.signature })
      return 0
    }
    const sigs = []
    let before = null
    for (let page = 0; page < 5; page++) {
      const batch = await conn.getSignaturesForAddress(pk(anchor), { until, limit: 100, ...(before ? { before } : {}) }, 'confirmed')
      sigs.push(...batch)
      if (batch.length < 100) break
      before = batch[batch.length - 1].signature
      if (page === 4) warnEvery('idx-gap', 3_600_000, '[distribute] fee index: more than 500 new protocol-wallet signatures in one pass — older ones are skipped (display totals only)')
    }
    let cursor = until, n = 0
    try {
      for (const s of sigs.reverse()) { // oldest first
        if (!s.err && !isConsumed(`dist:${s.signature}`)) {
          if (n >= maxTx) break
          n++
          let tx
          try { tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: TX_VERSION, commitment: 'confirmed' }) } catch (e) {
            // a tx version newer than this client decodes (version-1 txs ARE read: a wallet or bot may send a
            // distribute as v1): skip it rather than stall the index on it forever — counted and logged, since it may
            // have been a distribution these totals then miss; any other error is transient: stop here, retry next pass
            if (/version.*not supported|not supported by the requesting client/i.test(String(e?.message || e))) {
              index.skippedUnsupported++
              warnEvery('idx-ver', 3_600_000, `[distribute] fee index: skipped ${s.signature}, a transaction version this client cannot decode (a distribution in it would be missing from the display totals)`)
              cursor = s.signature; continue
            }
            throw e
          }
          if (!tx?.meta) {
            // not readable yet: the cursor stops before it and the next pass retries — unless it is over an hour old
            // (a node that pruned it): then skip it rather than stall the index forever (display totals only)
            if (s.blockTime && Date.now() / 1000 - s.blockTime > 3600) { cursor = s.signature; continue }
            break
          }
          if (!tx.meta.err && bookFromTx(s.signature, tx)) booked++
        }
        cursor = s.signature
      }
    } finally { if (cursor && cursor !== until) patchState({ distIndexUntil: cursor }) } // keep the progress of this pass
    index.lastBooked = booked; index.lastError = null
    if (booked) console.log(`[distribute] fee index: booked ${booked} distribution(s) from the chain`)
  } catch (e) { index.lastError = errText(e); warnEvery('idx', 600_000, `[distribute] fee index: ${index.lastError}`) } finally { index.running = false; index.at = Date.now() }
  return booked
}

function block(c, reason) {
  if (c.distributeBlocked) return
  patchCoin(c.mint, { distributeBlocked: { at: Date.now(), reason } })
  console.error(`[distribute] $${c.symbol} ${c.mint}: ${reason} — marked distributeBlocked, no more cranks`)
}

/** Boot check: the burn + protocol wallets should exist (pump pays a missing 10% shareholder only above ~0.0072 SOL). */
export async function checkShareholderWallets(addresses) {
  try {
    const kinds = await walletKinds(addresses.filter(Boolean))
    for (const [a, k] of kinds) if (k.kind === 'wallet' && k.lamports === 0n) console.error(`[distribute] ⚠️ ${a} does not exist on-chain yet: send it 0.002 SOL before the first distribution (pump skips a missing 10% shareholder until the vault holds ~0.0072 SOL)`)
  } catch {}
}
