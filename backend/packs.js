// GACHAPAD: every coin's pack machine. One per coin, all driven from this module.
//
// GACHAPAD (pump.fun packs edition): a coin's fees rip ITS machine's packs (the machine it picked at launch, fixed for
// life) and every pulled card STAYS in the coin's vault — the machine's stock. Nobody is drawn here: cards leave the
// machine only through pulls.js (burn the coin → a card from its machine). Rip statuses below end at 'stock' (in the
// machine) and 'pulled' (assigned to a pull, pulls.js owns it from there). The holder-round / draw code is kept for
// records written by the old mechanic and is never reached by a new pack.
//
//   pool   poolKeyFor(mint)  — the coin's 80% fee-sharing shareholder (pump.fun pays it on every distribute crank).
//                               It swaps its SOL → USDC through Jupiter into the VAULT's USDC account. It is the only
//                               per-coin key that signs third-party (Jupiter) bytes; it never holds cards or USDC.
//   vault  vaultKeyFor(mint) — holds the coin's pack USDC + pulled cards. Signs exactly two kinds of tx: a Collector
//                               Crypt pack payment that passes cc.assertPackTx, and a card transfer built here.
//
// The pot IS the vault's USDC balance (chain truth: no ledger to drift). A pack is bought when a coin's vault holds
// the pack price and its round has MIN_ROUND_SAMPLES readings with at least one entrant. Readings start once the pot
// is SAMPLE_START_FRACTION of a pack. The round FREEZES WHEN THE PACK IS BOUGHT — before anyone, us included, can know
// the card — the winner is drawn from a finalized blockhash after the freeze, and the card goes to the winner. One
// pack in flight at a time, platform-wide.
//
// Rip statuses: signed → paid → ready|frozen → drawn → delivered; void (reverted / provably never landed),
// quarantined (no verdict 30 min: still watched), needs-attention (never opened: blocks new packs), stuck.
import { VersionedTransaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, NATIVE_MINT, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { config } from './config.js'
import { moneyStore, writeJsonAtomic, newId } from './store.js'
import { getConnection, poolKeyFor, vaultKeyFor, buildTx, simulate, settleTx, sigOf, accountInfos, sol, toLamports, rent0, rentLoaded, isWalletKey, transferIx, pk } from './solana.js'
import { coins, coinRec, isVisible, neverPay } from './registry.js'
import { snapshotHolders } from './rounds.js'
import { machine, machineEv, generatePack, submitPack, openPack, usdcAta, usdcRaw, USDC_MINT, ccAssetUrl } from './cc.js'
import { readCard, cardTransfer } from './core.js'
import { addSample, averages, capWeights, entriesHash, drawSeed, pickWinner, chanceOf } from './draw.js'
import { assertSwapTx } from './swapcheck.js'
import { solUsd, solUsdCached } from './price.js'
import { isKilled } from './kill.js'
import { emitEvent } from './bus.js'

const QUARANTINE_MS = 30 * 60_000
const MAX_SHELF_PER_COIN = 3
const OPEN_GIVE_UP_TRIES = 40
const OPEN_GIVE_UP_MS = 6 * 3_600_000
const CARD_ARRIVAL_GIVE_UP_MS = 6 * 3_600_000 // opened, but the card never showed up in the vault
const STEP_SETTLE_MS = 8_000 // convert steps: settle briefly and come back next tick (one slow coin never stalls the loop)
const BLOCKHASH_MARGIN = 171
const MAX_RIPS = 20_000
const errText = e => String(e?.message || e).slice(0, 180)
const sleep = ms => new Promise(r => setTimeout(r, ms))
export const run = { lastError: null, lastRipCheck: null, lastConvertError: null, at: 0, busy: false }

/* ---------------- stores ---------------- */

export const ripsStore = moneyStore('pack-rips', () => ({ rips: [] }))
export const convertStore = moneyStore('pack-convert', () => ({}))   // { [mint]: in-flight setup/swap record }
const roundStores = new Map()
/** A coin's live holder round (its own file: rounds are rewritten on every reading). */
export function roundStore(mint) {
  let s = roundStores.get(mint)
  if (!s) { s = moneyStore(`pack-rounds/${mint}`, () => ({ id: 1, startedAt: 0, samples: 0, lastSampleAt: 0, sums: {} })); roundStores.set(mint, s) }
  return s
}
const drawFile = id => join(config.dataDir, 'pack-draws', `${id}.json`)
export function readDrawEntries(id) { try { const f = drawFile(id); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf-8')) : null } catch { return null } }

export const rips = () => ripsStore.get().rips
export const ripById = id => rips().find(r => r.id === id) || null
function saveRip(rec) {
  ripsStore.update(s => {
    const i = s.rips.findIndex(r => r.id === rec.id)
    if (i >= 0) s.rips[i] = rec; else s.rips.push(rec)
    if (s.rips.length > MAX_RIPS) s.rips.splice(0, s.rips.length - MAX_RIPS)
  })
  return ripById(rec.id)
}
const patchRip = (id, fn) => { const r = structuredClone(ripById(id)); if (!r) return null; fn(r); return saveRip(r) }

/* ---------------- which coins have a machine, and their figures ---------------- */

/** Coins whose fees buy packs: public, locked, not $GACHA itself (ROOT's fees go to the team). */
export const packCoins = () => Object.values(coins()).filter(c => !c.root && !c.external && !c.retiredAt && !c.hidden && c.packCode && c.sharing?.address && isVisible(c.mint))
/** The cards in a coin's machine right now (oldest first). */
export const stockOf = mint => rips().filter(r => r.mint === mint && r.status === 'stock' && r.card?.id)
export const poolOf = mint => poolKeyFor(mint)?.publicKey.toBase58() || ''
export const vaultOf = mint => vaultKeyFor(mint)?.publicKey.toBase58() || ''

const figCache = new Map() // mint → { at, poolLamports, vaultLamports, usdcRaw, ataExists }
const u64 = (data, off) => { try { return Buffer.from(data).readBigUInt64LE(off) } catch { return 0n } }
/** Pool SOL, vault SOL and vault USDC for many coins, batched (3 accounts per coin). */
export async function readFigures(mints) {
  const keys = mints.flatMap(m => [poolOf(m), vaultOf(m), usdcAta(vaultOf(m)).toBase58()])
  const infos = keys.length ? await accountInfos(keys) : []
  const out = new Map()
  mints.forEach((m, i) => {
    const [p, v, a] = infos.slice(i * 3, i * 3 + 3)
    const f = { at: Date.now(), poolLamports: BigInt(p?.lamports || 0), vaultLamports: BigInt(v?.lamports || 0), usdcRaw: a?.data?.length >= 72 ? u64(a.data, 64) : 0n, ataExists: !!a }
    figCache.set(m, f); out.set(m, f)
  })
  return out
}
export const figuresOf = mint => figCache.get(mint) || null
/** Offline dev seed only: pin a coin's pot figures. */
export const setFigures = (mint, f) => { figCache.set(mint, { at: Date.now(), poolLamports: 0n, vaultLamports: 0n, usdcRaw: 0n, ataExists: true, ...f }) }
const poolSpendable = f => { const r = (rentLoaded() ? rent0() : 890_880n) + toLamports(config.poolReserveSol); return f.poolLamports > r ? f.poolLamports - r : 0n }

/* ---------------- convert: pool SOL → vault USDC ---------------- */

const convBackoff = new Map() // mint → until
async function settleStep(step) {
  const r = await settleTx({ raw: step.raw, sig: step.sig, lastValidBlockHeight: step.lastValidBlockHeight, builtSlot: step.builtSlot ?? null }, { deadlineMs: STEP_SETTLE_MS })
  if (r.status === 'ambiguous' && Date.now() - (step.at || 0) < QUARANTINE_MS) return 'wait'
  return r.status
}
const patchConv = (mint, fn) => convertStore.update(s => { if (s[mint]) { const r = fn(s[mint]); if (r === null) delete s[mint] } })

/** The swap: pool SOL → USDC landing in the vault's USDC account. Checked (assertSwapTx) + simulated before signing. */
export async function buildPoolSwap(mint, lamports, signers = []) {
  const pool = poolOf(mint), dest = usdcAta(vaultOf(mint)).toBase58()
  const q = new URLSearchParams({ inputMint: NATIVE_MINT.toBase58(), outputMint: USDC_MINT, amount: BigInt(lamports).toString(), slippageBps: String(config.swapSlippageBps), swapMode: 'ExactIn', restrictIntermediateTokens: 'true' })
  const qr = await fetch(`${config.jupiterBase}/quote?${q}`, { signal: AbortSignal.timeout(15_000) })
  if (!qr.ok) throw new Error(`jupiter quote ${qr.status}`)
  const quote = await qr.json()
  if (!quote?.outAmount || !(BigInt(quote.otherAmountThreshold || 0) > 0n)) throw new Error('jupiter: no route')
  // never trust Jupiter's number alone: the guaranteed minimum must be within 3% (+ slippage) of SOL's market price
  const usd = solUsdCached()
  if (!(usd > 0)) throw new Error('no SOL/USD price to check the swap against: not swapping')
  const fair = (Number(lamports) / 1e9) * usd * 1e6
  if (Number(quote.otherAmountThreshold) < fair * (0.97 - config.swapSlippageBps / 10_000)) throw new Error(`jupiter quote ${Number(quote.otherAmountThreshold) / 1e6} USDC is too far below the market (${(fair / 1e6).toFixed(2)}): not swapping`)
  const sr = await fetch(`${config.jupiterBase}/swap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: pool, destinationTokenAccount: dest, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 150_000, priorityLevel: 'high' } } }),
  })
  if (!sr.ok) throw new Error(`jupiter swap build ${sr.status}`)
  const j = await sr.json()
  const tx = VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, 'base64'))
  assertSwapTx(tx, pool)
  if (signers.length) tx.sign(signers)
  const lastValidBlockHeight = j.lastValidBlockHeight || (await getConnection().getLatestBlockhash('confirmed')).lastValidBlockHeight
  return { tx, lastValidBlockHeight, minOut: BigInt(quote.otherAmountThreshold), outAmount: BigInt(quote.outAmount) }
}
async function checkSwapSimulation(mint, built, { lamports }) {
  const pool = poolOf(mint), dest = usdcAta(vaultOf(mint)).toBase58()
  const [poolInfo, destInfo] = await accountInfos([pool, dest])
  const balance = BigInt(poolInfo?.lamports || 0)
  const preAmount = destInfo?.data?.length >= 72 ? u64(destInfo.data, 64) : 0n
  const v = await simulate(built.tx, { accounts: [pool, dest] })
  const [w, a] = v.accounts || []
  if (!w || !a) throw new Error('the swap simulation did not return the accounts: not sending')
  if (balance - BigInt(w.lamports) > BigInt(lamports) + toLamports(0.004)) throw new Error('the simulated swap spends more SOL than asked: not sending')
  const gained = u64(Buffer.from(Array.isArray(a.data) ? a.data[0] : a.data, 'base64'), 64) - preAmount
  if (gained < built.minOut) throw new Error(`the simulated swap yields ${gained} USDC raw, below the minimum ${built.minOut}: not sending`)
}
async function vaultUsdcDelta(mint, sig) {
  const vault = vaultOf(mint)
  for (let i = 0; i < 2; i++) {
    const info = await getConnection().getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null)
    if (info?.meta) {
      const pick = list => (list || []).filter(b => b.owner === vault && b.mint === USDC_MINT).reduce((a, b) => a + BigInt(b.uiTokenAmount.amount), 0n)
      return pick(info.meta.postTokenBalances) - pick(info.meta.preTokenBalances)
    }
    await sleep(1500)
  }
  return null
}

/** Drive one coin's convert: [setup: vault gas + vault USDC account] then [swap]. Journaled before every broadcast. */
async function convertCoin(c, f) {
  const mint = c.mint
  const pool = poolKeyFor(mint)
  let rec = convertStore.get()[mint]
  if (!rec) {
    if (!config.convertLive || Date.now() < (convBackoff.get(mint) || 0)) return
    const spend = poolSpendable(f)
    const topUp = f.vaultLamports < toLamports(config.vaultGasMinSol) ? toLamports(config.vaultGasTopUpSol) : 0n
    const ataRent = f.ataExists ? 0n : toLamports(0.0021)
    if (spend - topUp - ataRent < toLamports(config.convertMinSol)) return
    convertStore.update(s => { s[mint] = { id: newId(6), at: Date.now(), topUp: topUp.toString(), createAta: !f.ataExists, setup: null, swap: null, swapAttempts: 0 } })
    rec = convertStore.get()[mint]
  }
  // step 1: vault gas + the vault's USDC account (paid by the pool)
  if ((BigInt(rec.topUp) > 0n || rec.createAta) && rec.setup?.status !== 'done') {
    if (rec.setup?.sig) {
      const st = await settleStep(rec.setup)
      if (st === 'wait') return
      if (st === 'confirmed' || st === 'ambiguous') patchConv(mint, x => { x.setup.status = 'done' })
      else patchConv(mint, x => { x.setup = { attempts: (x.setup.attempts || 0) + 1 } })
      rec = convertStore.get()[mint]
    }
    if (rec.setup?.status !== 'done') {
      if ((rec.setup?.attempts || 0) >= 3) { patchConv(mint, () => null); convBackoff.set(mint, Date.now() + 600_000); run.lastConvertError = `$${c.symbol}: vault setup failed 3 times`; return }
      const ixs = []
      if (rec.createAta) ixs.push(createAssociatedTokenAccountIdempotentInstruction(pool.publicKey, usdcAta(vaultOf(mint)), pk(vaultOf(mint)), pk(USDC_MINT), TOKEN_PROGRAM_ID))
      if (BigInt(rec.topUp) > 0n) ixs.push(transferIx(pool.publicKey, vaultOf(mint), rec.topUp))
      const built = await buildTx({ payer: pool.publicKey, instructions: ixs, signers: [pool], units: 60_000 })
      await simulate(built.tx, { minContextSlot: built.builtSlot })
      if (isKilled()) return
      const sig = sigOf(built.tx)
      patchConv(mint, x => { x.setup = { ...(x.setup || {}), sig, raw: Buffer.from(built.tx.serialize()).toString('base64'), lastValidBlockHeight: built.lastValidBlockHeight, builtSlot: built.builtSlot ?? null, at: Date.now() } })
      const st = await settleStep(convertStore.get()[mint].setup)
      if (st === 'wait') return
      if (st === 'confirmed') patchConv(mint, x => { x.setup.status = 'done' })
      else { patchConv(mint, x => { x.setup = { attempts: (x.setup.attempts || 0) + 1 } }); return }
      rec = convertStore.get()[mint]
    }
  }
  // step 2: the swap (amount = what the pool can spend NOW, read fresh)
  for (let pass = 0; pass < 2; pass++) {
    rec = convertStore.get()[mint]
    if (rec.swap?.sig) {
      const st = await settleStep(rec.swap)
      if (st === 'wait') return
      if (st === 'confirmed') {
        const got = await vaultUsdcDelta(mint, rec.swap.sig)
        patchConv(mint, () => null)
        emitEvent({ id: `topacks:${rec.swap.sig}`, type: 'to-packs', mint, symbol: c.symbol, amountSol: sol(BigInt(rec.swap.lamports)), sig: rec.swap.sig, extra: { usdc: got != null ? Number(got) / 1e6 : null } })
        console.log(`[packs] $${c.symbol}: ${sol(BigInt(rec.swap.lamports)).toFixed(4)} SOL → ${got != null ? (Number(got) / 1e6).toFixed(2) : '?'} USDC (${rec.swap.sig})`)
        return
      }
      if (st === 'ambiguous') { console.error(`[packs] $${c.symbol}: swap ${rec.swap.sig} no verdict after 30 min — written off`); patchConv(mint, () => null); return }
      patchConv(mint, x => { x.swap = null; x.swapAttempts = (x.swapAttempts || 0) + 1 })
      rec = convertStore.get()[mint]
    }
    if (pass > 0) return
    if ((rec.swapAttempts || 0) >= 3) { patchConv(mint, () => null); convBackoff.set(mint, Date.now() + 600_000); run.lastConvertError = `$${c.symbol}: swap failed 3 times, retry in 10 min`; return }
    const fresh = (await readFigures([mint])).get(mint)
    const lamports = poolSpendable(fresh)
    if (lamports < toLamports(config.convertMinSol) / 2n) { patchConv(mint, () => null); return }
    let built
    try {
      built = await buildPoolSwap(mint, lamports, [pool])
      await checkSwapSimulation(mint, built, { lamports })
    } catch (e) { patchConv(mint, x => { x.swapAttempts = (x.swapAttempts || 0) + 1 }); throw e }
    if (isKilled()) return
    const sig = sigOf(built.tx)
    patchConv(mint, x => { x.swap = { sig, raw: Buffer.from(built.tx.serialize()).toString('base64'), lastValidBlockHeight: built.lastValidBlockHeight, builtSlot: null, at: Date.now(), lamports: lamports.toString(), minOut: built.minOut.toString() } })
  }
}

/* ---------------- holder rounds ---------------- */

/** Holders that can win: real wallets (on-curve), never an engine / pool / vault / coin / program address. */
function eligibleFn() {
  const never = neverPay()
  const extra = new Set(Object.values(coins()).flatMap(c => [poolOf(c.mint), vaultOf(c.mint)]))
  return owner => !never.has(owner) && !extra.has(owner) && isWalletKey(owner)
}
const IN_FLIGHT = ['signed', 'paid', 'quarantined']
async function sampleCoin(c, f, price, usd, eligible) {
  if (rips().some(r => r.mint === c.mint && (IN_FLIGHT.includes(r.status) || (r.status === 'ready' && !r.draw)))) return
  const rs = roundStore(c.mint)
  const r = rs.get()
  const potUsd = Number(f.usdcRaw) / 1e6 + (usd > 0 ? sol(poolSpendable(f)) * usd : 0)
  if (!r.samples && potUsd < price * config.sampleStartFraction) return
  if (r.lastSampleAt && Date.now() - r.lastSampleAt < config.sampleMs - 5_000) return
  const holders = await snapshotHolders(c.mint)
  rs.update(s => { if (!s.startedAt) s.startedAt = Date.now(); addSample(s.sums, holders, { isEligibleOwner: eligible }); s.samples += 1; s.lastSampleAt = Date.now() })
}
const minHoldRaw = () => BigInt(Math.floor(config.holderMinTokens)) * 1_000_000n
export function liveEntries(mint) { const r = roundStore(mint).get(); return capWeights(averages(r.sums, r.samples, { minRaw: minHoldRaw() }), config.maxWalletChanceBps) }
export function liveOdds(mint, wallet) {
  const r = roundStore(mint).get()
  const entries = liveEntries(mint)
  const avg = r.samples ? BigInt(r.sums[wallet] || '0') / BigInt(r.samples) : 0n
  return { mint, wallet, chance: chanceOf(entries, wallet), averageTokens: Number(avg) / 1e6, entered: entries.some(e => e.wallet === wallet), entrants: entries.length, samples: r.samples, minHoldTokens: Number(config.holderMinTokens) }
}

/**
 * Freeze a coin's live round into draw file `id`. Returns the draw summary, or null when the round cannot be drawn
 * (too few readings / nobody eligible). Idempotent: a file already written for `id` AND this mint is reused (a crash
 * between the file and the round reset is repaired here); a file for another mint (a restored backup reusing ids) is
 * never used. Throws on a file that does not match its own hash.
 */
export function freezeRoundFor(id, mint) {
  const rs = roundStore(mint)
  const existing = readDrawEntries(id)
  if (existing && existing.mint === mint) {
    const entries = existing.entries.map(([wallet, w]) => ({ wallet, weight: BigInt(w) }))
    if (entriesHash(entries) !== existing.hash) throw new Error(`draw ${id}: the entries file does not match its own hash`)
    if (rs.get().id === existing.roundId) rs.set({ id: existing.roundId + 1, startedAt: Date.now(), samples: 0, lastSampleAt: 0, sums: {} })
    return { roundId: existing.roundId, samples: existing.samples, entrants: entries.length, total: existing.total, hash: existing.hash }
  }
  const round = rs.get()
  if (round.samples < config.minRoundSamples) return null
  const entries = liveEntries(mint)
  if (!entries.length) return null
  const total = entries.reduce((a, e) => a + e.weight, 0n)
  const hash = entriesHash(entries)
  writeJsonAtomic(drawFile(id), { drawId: id, mint, roundId: round.id, startedAt: round.startedAt, frozenAt: Date.now(), samples: round.samples, total: total.toString(), hash, capBps: config.maxWalletChanceBps, minHoldRaw: minHoldRaw().toString(), entries: entries.map(e => [e.wallet, e.weight.toString()]) }, false, true)
  rs.set({ id: round.id + 1, startedAt: Date.now(), samples: 0, lastSampleAt: 0, sums: {} })
  return { roundId: round.id, samples: round.samples, entrants: entries.length, total: total.toString(), hash }
}

/** Older records (bought before freeze-at-purchase) may still need a freeze; new packs carry their draw from birth. */
async function freezeFor(r) {
  if (r.draw) return true
  const slot = await getConnection().getSlot('confirmed')
  const f = freezeRoundFor(r.id, r.mint)
  if (!f) return false
  patchRip(r.id, x => { x.draw = { ...f, frozenAt: Date.now(), freezeSlot: slot, seedSlot: slot + config.drawDelaySlots } })
  emitEvent({ id: `freeze:${r.id}`, type: 'freeze', mint: r.mint, symbol: r.symbol, extra: { ripId: r.id, n: r.n, entrants: f.entrants, hash: f.hash, seedSlot: slot + config.drawDelaySlots } })
  return true
}

/* ---------------- packs ---------------- */

const BLOCKING = ['signed', 'paid', 'needs-attention']
/** { reason } or { coin, machine }: the next pack to buy platform-wide. */
export async function ripCheck() {
  if (!config.ripLive) return { reason: 'RIP_LIVE is off' }
  if (isKilled()) return { reason: 'kill switch on' }
  const all = rips()
  const blocking = all.find(r => BLOCKING.includes(r.status))
  if (blocking) return { reason: blocking.status === 'needs-attention' ? `pack ${blocking.id} needs attention` : 'a pack is in flight' }
  const dayAgo = Date.now() - 86_400_000
  if (all.filter(r => r.at > dayAgo && r.status !== 'void').length >= config.maxRipsPerDay) return { reason: 'daily pack limit reached' }
  const last = all.filter(r => r.status !== 'void').at(-1)
  if (last && Date.now() - last.at < config.ripGapMs) return { reason: 'too soon after the last pack' }
  const ready = []
  const closed = []
  for (const c of packCoins()) {
    const f = figuresOf(c.mint)
    if (!f) continue
    let m
    try { m = await machine(c.packCode) } catch { closed.push(c.packCode); continue }
    if (!m.open) { closed.push(m.name); continue }
    if (!(m.priceUsdc > 0) || m.priceUsdc > config.packMaxUsdc) continue // re-priced above the limit: the pot waits
    if (f.usdcRaw < usdcRaw(m.priceUsdc)) continue
    if (all.some(r => r.mint === c.mint && IN_FLIGHT.includes(r.status))) continue
    ready.push({ c, f, m, fill: Number(f.usdcRaw) / (m.priceUsdc * 1e6) })
  }
  if (!ready.length) return { reason: closed.length ? `no full pot on an open machine (closed: ${[...new Set(closed)].join(', ')})` : 'no coin has a full pot yet' }
  // the fullest pot (relative to its own pack price) first; ties → the oldest coin
  ready.sort((a, b) => b.fill - a.fill || (a.c.createdAt || 0) - (b.c.createdAt || 0))
  return { coin: ready[0].c, machine: ready[0].m }
}

async function startRip(c, m) {
  const vault = vaultKeyFor(c.mint)
  const bal = await getConnection().getTokenAccountBalance(usdcAta(vault.publicKey), 'confirmed').then(b => BigInt(b.value.amount)).catch(() => 0n)
  if (bal < usdcRaw(m.priceUsdc)) throw new Error('the vault USDC balance is below the pack price')
  const n = (rips().filter(r => r.n).at(-1)?.n || 0) + 1
  const id = `p${n}`
  if (c.packCode !== m.code) throw new Error(`$${c.symbol}: machine ${m.code} is not the coin's machine ${c.packCode}`)
  const p = await generatePack({ treasury: vault.publicKey, code: m.code, priceUsdc: m.priceUsdc, maxUsdc: config.packMaxUsdc })
  const height = await getConnection().getBlockHeight('processed')
  p.tx.partialSign(vault)
  const raw = p.tx.serialize({ requireAllSignatures: true, verifySignatures: true }).toString('base64')
  if (isKilled()) throw new Error('killed')
  const rec = saveRip({ id, n, mint: c.mint, symbol: c.symbol, at: Date.now(), code: m.code, machineName: m.name, priceUsdc: m.priceUsdc, status: 'signed', memo: p.memo, sig: p.sig, raw, blockhash: p.blockhash, lastValidBlockHeight: height + BLOCKHASH_MARGIN })
  emitEvent({ id: `rip:${rec.id}`, type: 'rip', mint: c.mint, symbol: c.symbol, sig: p.sig, extra: { ripId: rec.id, n, pack: m.name, priceUsdc: m.priceUsdc } })
  console.log(`[packs] ${rec.id} $${c.symbol}: paying ${m.priceUsdc} USDC for ${m.name} (${p.sig})`)
  submitPack(raw).then(r => { if (!r.ok) console.warn(`[packs] ${rec.id}: collector crypt submit said ${r.status} ${r.error || ''}`) }).catch(() => {})
  return rec
}

async function blockhashExpired(blockhash) {
  if (!blockhash) return false
  try { return (await getConnection().isBlockhashValid(blockhash, { commitment: 'processed' })).value === false } catch { return false }
}
async function drivePayment(r) {
  const res = await settleTx({ raw: r.raw, sig: r.sig, lastValidBlockHeight: r.lastValidBlockHeight }, { deadlineMs: r.status === 'quarantined' ? 20_000 : 90_000, broadcast: r.status === 'signed' })
  if (res.status === 'confirmed') { patchRip(r.id, x => { x.status = 'paid'; x.paidAt = Date.now(); x.ambiguousSince = null }); return }
  if (res.status === 'failed' || (res.status === 'not-landed' && await blockhashExpired(r.blockhash))) {
    patchRip(r.id, x => { x.status = 'void'; x.voidReason = res.status === 'failed' ? `reverted: ${res.err}` : 'expired without landing' })
    return
  }
  if (r.status === 'signed') {
    const since = r.ambiguousSince || Date.now()
    if (!r.ambiguousSince) patchRip(r.id, x => { x.ambiguousSince = since })
    if (Date.now() - since > QUARANTINE_MS) patchRip(r.id, x => { x.status = 'quarantined' })
  }
}
async function driveOpen(r) {
  if (!r.card) {
    const o = await openPack(r.memo, { maxMs: 30_000 })
    if (!o.done) {
      r = patchRip(r.id, x => { x.openError = o.reason; x.openTries = (x.openTries || 0) + 1 })
      if (r.openTries >= OPEN_GIVE_UP_TRIES || Date.now() - (r.paidAt || r.at) > OPEN_GIVE_UP_MS) patchRip(r.id, x => { x.status = 'needs-attention' })
      return
    }
    if (!o.nft?.id) { patchRip(r.id, x => { x.openError = 'opened without a card id'; x.status = 'needs-attention' }); return }
    r = patchRip(r.id, x => { x.card = o.nft; x.rarity = o.rarity; x.openedAt = Date.now(); x.openError = null })
    emitEvent({ id: `pull:${r.id}`, type: 'pull', mint: r.mint, symbol: r.symbol, extra: { ripId: r.id, n: r.n, card: r.card, rarity: r.rarity } })
    console.log(`[packs] ${r.id} $${r.symbol}: pulled ${r.card.name} ($${r.card.valueUsd ?? '?'})`)
  }
  const a = await readCard(r.card.id)
  if (a && a.owner === vaultOf(r.mint)) {
    patchRip(r.id, x => { x.status = x.draw ? 'frozen' : 'stock'; x.collection = a.collection; x.cardStandard = a.standard; x.readyAt = Date.now(); x.stockedAt = Date.now() })
    emitEvent({ id: `stock:${r.id}`, type: 'stock', mint: r.mint, symbol: r.symbol, extra: { ripId: r.id, n: r.n, card: r.card } })
    return
  }
  if (Date.now() - (r.openedAt || r.paidAt || r.at) > CARD_ARRIVAL_GIVE_UP_MS) {
    patchRip(r.id, x => { x.status = 'needs-attention'; x.openError = `the card ${r.card.id} never reached the vault (owner ${a?.owner || 'none'})` })
    console.error(`[packs] ${r.id}: card never reached the vault in 6 h — needs attention (new packs blocked)`)
  }
}
async function driveDraw(r) {
  const conn = getConnection()
  const fin = await conn.getSlot('finalized')
  if (fin < r.draw.seedSlot) return
  const blocks = await conn.getBlocks(r.draw.seedSlot, Math.min(fin, r.draw.seedSlot + 200), 'finalized')
  if (!blocks.length) return
  const blk = await conn.getBlock(blocks[0], { commitment: 'finalized', transactionDetails: 'none', rewards: false, maxSupportedTransactionVersion: 0 })
  if (!blk?.blockhash) return
  const file = readDrawEntries(r.id)
  if (!file) throw new Error(`draw ${r.id}: the frozen entries file is missing`)
  const entries = file.entries.map(([wallet, w]) => ({ wallet, weight: BigInt(w) }))
  const hash = entriesHash(entries)
  if (hash !== r.draw.hash || file.hash !== r.draw.hash) throw new Error(`draw ${r.id}: the entries do not match the frozen hash`)
  const seed = drawSeed({ blockhash: blk.blockhash, drawId: r.id, hash })
  const w = pickWinner(entries, seed)
  if (!w || !isWalletKey(w.wallet)) throw new Error(`draw ${r.id}: no valid winner`)
  patchRip(r.id, x => { x.status = 'drawn'; x.draw = { ...x.draw, blockSlot: blocks[0], blockhash: blk.blockhash, seed, r: w.r.toString(), winner: w.wallet, weight: w.weight.toString(), chance: Number((w.weight * 1_000_000n) / w.total) / 1_000_000, drawnAt: Date.now() } })
  emitEvent({ id: `draw:${r.id}`, type: 'draw', mint: r.mint, symbol: r.symbol, wallet: w.wallet, extra: { ripId: r.id, n: r.n, card: r.card, blockhash: blk.blockhash } })
}
function markDelivered(r, sig) {
  patchRip(r.id, x => { x.status = 'delivered'; x.deliveredAt = Date.now(); x.delivery = { ...(x.delivery || {}), status: 'confirmed', sig: sig || x.delivery?.sig || null } })
  emitEvent({ id: `deliver:${r.id}`, type: 'delivered', mint: r.mint, symbol: r.symbol, wallet: r.draw.winner, sig: sig || r.delivery?.sig || undefined, extra: { ripId: r.id, n: r.n, card: r.card } })
}
async function driveDelivery(r) {
  if (!config.deliverLive) return
  const vault = vaultKeyFor(r.mint)
  const d = r.delivery
  if (d?.sig) {
    const res = await settleTx({ raw: d.raw, sig: d.sig, lastValidBlockHeight: d.lastValidBlockHeight, builtSlot: d.builtSlot ?? null }, { deadlineMs: 60_000 })
    if (res.status === 'confirmed') return markDelivered(r, d.sig)
    if (res.status === 'ambiguous') return
    r = patchRip(r.id, x => { x.delivery = { attempts: (x.delivery?.attempts || 0) + 1, lastError: res.status === 'failed' ? res.err : 'expired' } })
    if ((r.delivery?.attempts || 0) >= 5) { patchRip(r.id, x => { x.status = 'stuck'; x.deliveryError = 'the transfer failed 5 times' }); return }
  }
  const a = await readCard(r.card.id)
  if (a && a.owner === r.draw.winner) return markDelivered(r, null)
  if (!a || a.owner !== vault.publicKey.toBase58()) { patchRip(r.id, x => { x.deliveryError = `the card is owned by ${a?.owner || 'nobody'}, not the vault`; x.status = 'stuck' }); return }
  if (isKilled()) return
  const mv = cardTransfer({ id: r.card.id, a, owner: vault.publicKey, to: r.draw.winner })
  const built = await buildTx({ payer: vault.publicKey, instructions: [mv.ix], signers: [vault], units: mv.units })
  await simulate(built.tx, { minContextSlot: built.builtSlot })
  if (isKilled()) return
  const sig = sigOf(built.tx)
  patchRip(r.id, x => { x.delivery = { attempts: x.delivery?.attempts || 0, sig, raw: Buffer.from(built.tx.serialize()).toString('base64'), lastValidBlockHeight: built.lastValidBlockHeight, builtSlot: built.builtSlot ?? null, at: Date.now() } })
  const res = await settleTx({ raw: ripById(r.id).delivery.raw, sig, lastValidBlockHeight: built.lastValidBlockHeight, builtSlot: built.builtSlot ?? null }, { deadlineMs: 60_000 })
  if (res.status === 'confirmed') return markDelivered(ripById(r.id), sig)
  if (res.status === 'failed' || res.status === 'not-landed') patchRip(r.id, x => { x.delivery = { attempts: (x.delivery?.attempts || 0) + 1, lastError: res.status } })
}

/* ---------------- the tick ---------------- */

export async function packsTick() {
  if (run.busy || config.offline || !config.rpcUrl) return
  run.busy = true
  try {
    const list = packCoins()
    const figs = list.length ? await readFigures(list.map(c => c.mint)) : new Map()
    let m = null
    try { m = await machine(config.packCode); run.machine = m; run.evUsd = await machineEv(config.packCode).catch(() => run.evUsd || null) } catch {}
    const usd = await solUsd().catch(() => solUsdCached())
    // 1. convert: every coin's pool SOL → its vault USDC
    for (const c of list) { try { await convertCoin(c, figs.get(c.mint)) } catch (e) { run.lastConvertError = `$${c.symbol}: ${errText(e)}` } }
    void m; void usd // (no holder rounds: cards stay in the machine until pulled)
    // 3. packs in flight
    for (const r of rips()) {
      try {
        if (r.status === 'signed' || r.status === 'quarantined') await drivePayment(r)
        else if (r.status === 'paid') await driveOpen(r)
      } catch (e) { run.lastError = `${r.id}: ${errText(e)}` }
    }
    for (const r of rips().filter(x => ['ready', 'frozen', 'drawn'].includes(x.status))) {
      try {
        if (r.status === 'ready') { if (await freezeFor(r)) patchRip(r.id, x => { x.status = 'frozen' }) }
        else if (r.status === 'frozen') await driveDraw(r)
        else if (r.status === 'drawn') await driveDelivery(r)
      } catch (e) { run.lastError = `${r.id}: ${errText(e)}` }
    }
    // 4. maybe one new pack
    const check = await ripCheck().catch(e => ({ reason: errText(e) }))
    run.lastRipCheck = check.reason || null
    if (check.coin) { try { const rec = await startRip(check.coin, check.machine); await drivePayment(rec) } catch (e) { run.lastError = `new pack: ${errText(e)}` } }
    run.at = Date.now()
  } finally { run.busy = false }
}

export function resolvePack(id, action) {
  const r = ripById(id)
  if (!r || !['needs-attention', 'stuck'].includes(r.status)) throw new Error('only needs-attention / stuck packs can be resolved')
  if (action === 'retry') return patchRip(id, x => { x.status = x.card ? (x.draw?.winner ? 'drawn' : 'paid') : 'paid'; x.openTries = 0; x.paidAt = Date.now(); if (x.status === 'drawn') x.delivery = null })
  if (action === 'restock') { if (!r.card?.id) throw new Error('no card to put back'); return patchRip(id, x => { x.status = 'stock'; x.pullId = null }) }
  if (action === 'write-off') return patchRip(id, x => { x.status = 'written-off' })
  throw new Error('action must be retry or write-off')
}

/* ---------------- public shapes ---------------- */

export function publicRip(r, { full = false } = {}) {
  if (!r) return null
  return {
    id: r.id, n: r.n, mint: r.mint, symbol: r.symbol, at: r.at, status: r.status, pack: r.machineName, priceUsdc: r.priceUsdc, sig: r.sig,
    card: r.card || null, rarity: r.rarity || null, cardUrl: r.card?.id ? ccAssetUrl(r.card.id) : null,
    draw: r.draw ? { entrants: r.draw.entrants, samples: r.draw.samples, hash: r.draw.hash, frozenAt: r.draw.frozenAt, seedSlot: r.draw.seedSlot, blockSlot: r.draw.blockSlot || null, blockhash: r.draw.blockhash || null, seed: r.draw.seed || null, winner: r.draw.winner || null, chance: r.draw.chance ?? null, drawnAt: r.draw.drawnAt || null, ...(full ? { total: r.draw.total, r: r.draw.r || null } : {}) } : null,
    deliveredAt: r.deliveredAt || null, deliverySig: r.status === 'delivered' ? (r.delivery?.sig || null) : null,
    stockedAt: r.stockedAt || null, pullId: r.pullId || null,
  }
}
/** A coin's machine as the site shows it. */
export function coinPacks(mint, priceUsdc = null) {
  const f = figuresOf(mint)
  const usdc = f ? Number(f.usdcRaw) / 1e6 : 0
  const poolSol = f ? sol(poolSpendable(f)) : 0
  const usd = solUsdCached()
  const potUsd = usdc + (usd > 0 ? poolSol * usd : 0)
  const mine = rips().filter(x => x.mint === mint && x.status !== 'void')
  return {
    pool: poolOf(mint), vault: vaultOf(mint), vaultUsdc: vaultOf(mint) ? usdcAta(vaultOf(mint)).toBase58() : null,
    usdc, poolSol, potUsd, priceUsdc, progress: priceUsdc ? Math.min(1, potUsd / priceUsdc) : 0,
    stock: stockOf(mint).map(x => publicRip(x)), stockUsd: stockOf(mint).reduce((a, x) => a + (Number(x.card?.valueUsd) || 0), 0),
    packs: mine.length, pulledUsd: mine.reduce((a, x) => a + (Number(x.card?.valueUsd) || 0), 0),
    lastPull: publicRip(mine.filter(x => x.card).at(-1) || null),
  }
}
export function packTotals() {
  const all = rips().filter(r => r.status !== 'void' && isVisible(r.mint))
  const pulled = all.filter(r => r.card)
  return { packs: all.length, pulled: pulled.length, inMachines: all.filter(r => r.status === 'stock').length, delivered: all.filter(r => r.status === 'delivered').length, valueUsd: pulled.reduce((a, r) => a + (Number(r.card.valueUsd) || 0), 0), spentUsdc: all.reduce((a, r) => a + (Number(r.priceUsdc) || 0), 0) }
}
export { machineEv, coinRec }
