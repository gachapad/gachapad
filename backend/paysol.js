// Exactly-once SOL payouts from a parent's holder pool (the ONLY wallet that parent's holders are paid from).
//
// One transaction pays up to PAYOUTS_PER_TX holders (a Solana tx is atomic: all transfers happen, or none):
//   - re-read each line's status right before building (a line is sent at most once, even with two senders)
//   - check the pool can fund sum + fee and still keep its reserve; simulate; kill switch checked; then persist
//     {raw bytes, signature, lastValidBlockHeight, every payee} to the intent journal BEFORE the first broadcast
//   - settle by signature status; only the SAME bytes are ever re-broadcast; nothing is rebuilt
//   - "did not land" only on PROOF (finalized height past the last valid height + full-history lookups): nothing moved
//     and nothing ever can, so its lines stay PENDING and the next pass rebuilds them with a fresh blockhash; a line
//     proven not landed MAX_NOT_LANDED times is marked failed (the round's 2-window expiry bounds the rest)
//   - landed with an error = nothing moved: those lines are marked failed (the SOL stays in the pool)
//   - a confirmed batch books the slot it landed in (ledger lastPaidSlot): the pool's next balance reads — this pass's
//     next batch, the next round's budget — are answered at or after it (a lagging node never shows SOL already paid)
//   - no verdict → the intent waits; THIS POOL pays nothing more until the chain answers (other pools go on);
//     only after 30 min of silence is it quarantined (booked as possibly-sent, never resent)
// One tx in flight per pool wallet (serializeTx); pools never share a wallet, so one pool's trouble cannot touch another's money.
import { config } from './config.js'
import { poolKeyFor, serializeTx, buildTx, simulate, settleTx, sigOf, balanceOf, transferIx, sol, toLamports, txFeeLamports, rent0 } from './solana.js'
import { roundsStore, bookPayouts, appendQuarantineMany, appendPendingIntent, removePendingIntent, readPendingIntents, noteEarned, poolLedger } from './store.js'
import { chunkItems } from './math.js'
import { isKilled } from './kill.js'
import { emitEvent } from './bus.js'

export { chunkItems }
const unitsFor = n => 5_000 + 600 * n // a system transfer is ~150 CU; the two budget ixs 300
/** Worst-case tx fees of a round that pays `n` holders (set aside from the pool before the split). */
export const roundFeeLamports = n => BigInt(Math.ceil(Math.max(1, n) / config.payoutsPerTx)) * txFeeLamports(unitsFor(config.payoutsPerTx))
/** What a pool always keeps: rent(0) + POOL_MARGIN_SOL (its own tx fees). */
export const poolReserveLamports = () => rent0() + toLamports(config.poolMarginSol)
/** A payout batch proven not landed this many times marks its lines failed (before that they are rebuilt). */
export const MAX_NOT_LANDED = 3
/** The slot this parent's pool last paid out in (booked with the payout), or null: read the pool at or after it. */
export const lastPaidSlot = parentMint => Number(poolLedger(parentMint).lastPaidSlot) || null

/**
 * Does a simulation verdict name a PAYEE (so that payee, alone, is skipped this round)? Only two do:
 *   - InsufficientFundsForRent on an account other than the pool (index 0): that payee would end under rent
 *   - an instruction error on a TRANSFER (index ≥ 2, after the two compute-budget ixs) that is not the POOL running
 *     short (system error Custom:1, "insufficient lamports")
 * Everything else — BlockhashNotFound from a node that has not seen our blockhash yet, AccountNotFound,
 * InsufficientFundsForFee, … — is NOT the payee's fault: the pass stops and the round retries. Pure.
 */
export function payeeRefusal(err) {
  if (!err || typeof err !== 'object') return false
  const rent = err.InsufficientFundsForRent
  if (rent && Number(rent.account_index) > 0) return true
  const ie = err.InstructionError
  if (Array.isArray(ie) && Number(ie[0]) >= 2) return !(ie[1] && typeof ie[1] === 'object' && ie[1].Custom === 1)
  return false
}

/* ---------------- round lines (rounds.json, money) ---------------- */

const findRound = (s, roundId) => s.rounds.find(r => r.id === roundId)
export function lineStatuses(roundId) {
  const r = findRound(roundsStore.get(), roundId)
  return new Map((r?.lines || []).map(l => [l.wallet, l.status]))
}
function markLines(roundId, wallets, fields) {
  roundsStore.update(s => {
    const r = findRound(s, roundId)
    if (!r) return
    for (const l of r.lines || []) if (wallets.includes(l.wallet)) Object.assign(l, fields)
    if (fields.sig && !r.sigs.includes(fields.sig)) r.sigs.push(fields.sig)
  })
}

// Apply a settled outcome to every payee of an intent (all writes idempotent), THEN drop the intent.
function applyOutcome(it, outcome) {
  const wallets = it.items.map(m => m.wallet)
  if (outcome.status === 'confirmed') {
    let total = 0n
    // every payee of the tx in ONE durable ledger write (idempotent per sig:wallet), with the slot it landed in
    bookPayouts(it.parentMint, it.items.map(m => ({ lamports: m.lamports, key: `${it.sig}:${m.wallet}` })), { slot: outcome.slot })
    for (const m of it.items) {
      total += BigInt(m.lamports)
      noteEarned(m.wallet, { key: `${it.sig}:${m.wallet}`, parentMint: it.parentMint, symbol: it.parentSymbol, lamports: m.lamports, sig: it.sig, at: Date.now(), roundId: it.roundId })
    }
    markLines(it.roundId, wallets, { status: 'paid', sig: it.sig })
    emitEvent({ id: `payout:${it.sig}`, type: 'payout', mint: it.parentMint, symbol: it.parentSymbol, amountSol: sol(total), sig: it.sig, extra: { roundId: it.roundId, wallets: it.items.length, pool: it.from } })
  } else if (outcome.status === 'ambiguous') {
    // The tx MAY have landed. Never resend and never re-queue: book as possibly-sent, quarantine for review.
    bookPayouts(it.parentMint, it.items.map(m => ({ lamports: m.lamports, key: `${it.sig}:${m.wallet}` })), { quarantined: true })
    appendQuarantineMany(it.items.map(m => ({ key: `${it.sig}:${m.wallet}`, reason: outcome.reason || 'no verdict', sig: it.sig, from: it.from, wallet: m.wallet, lamports: String(m.lamports), parentMint: it.parentMint, roundId: it.roundId, time: Date.now() })))
    markLines(it.roundId, wallets, { status: 'quarantined', sig: it.sig })
  } else if (outcome.status === 'not-landed') {
    // PROVEN never landed: nothing moved and nothing ever can ("safe to rebuild"). The lines stay 'pending' — the next
    // pass rebuilds them with a fresh blockhash through every pre-send guard again — until MAX_NOT_LANDED proofs; then
    // failed (the SOL stays in the pool for the next round). A dropped batch never costs its payees their share.
    roundsStore.update(s => {
      const r = findRound(s, it.roundId)
      if (!r) return
      for (const l of r.lines || []) {
        if (!wallets.includes(l.wallet) || l.status !== 'pending') continue
        l.notLanded = (Number(l.notLanded) || 0) + 1
        l.error = 'not-landed'
        if (l.notLanded >= MAX_NOT_LANDED) l.status = 'failed'
      }
    })
  } else {
    // 'failed': landed with an error — provably nothing moved; the SOL stays in the pool for the next round.
    markLines(it.roundId, wallets, { status: 'failed', sig: it.sig, error: outcome.status })
  }
  removePendingIntent(it.sig)
}

/**
 * Pay each item its OWN lamports from `pool` (the parent's holder pool), exactly once.
 * pool = { parentMint, symbol, poolWallet }; items = [{ wallet, lamports (BigInt), weight }]; the caller (the round)
 * already applied exclusions, the budget, the cap and the rent rules.
 * Returns { paid: [wallets], spentLamports, halted, fatal, reason, refused: [wallets] }.
 */
export async function payPoolShares(pool, items, { roundId, settle = {}, keyFor = poolKeyFor } = {}) {
  const res = { paid: [], spentLamports: 0n, halted: false, fatal: false, reason: null, refused: [] }
  const halt = (reason, fatal = false) => { res.halted = true; res.fatal = fatal; res.reason = reason }
  const poolKey = keyFor(pool.parentMint)
  if (!poolKey) { halt('no engine key'); return res }
  const from = poolKey.publicKey.toBase58()
  if (from !== pool.poolWallet) { halt(`derived pool key ${from} ≠ recorded pool wallet ${pool.poolWallet}`); return res }
  if (readPendingIntents(from).length) { halt('this pool has an unresolved payout intent'); return res }
  const reserve = poolReserveLamports()

  const clean = []
  for (const it of items) {
    if (typeof it.lamports !== 'bigint' || it.lamports <= 0n) continue
    if (!it.wallet || it.wallet === from) continue
    clean.push(it)
  }
  // A queue, not a fixed list: a batch the simulation refuses is retried one payee at a time, so a single
  // unpayable address can never block everyone else in its batch.
  const queue = chunkItems(clean, config.payoutsPerTx)
  while (queue.length) {
    if (isKilled()) { halt('killed'); break }
    let chunk = queue.shift()
    let intent = null, outcome = null, journaled = false, skipped = null, simRefused = null, writeFailed = null, total = 0n
    try {
      // EVERYTHING that decides, builds, sends, settles and records a batch runs inside the pool's critical
      // section: a second sender (a stale-lock takeover, an admin call racing the timer) only enters after the
      // first one's outcome is WRITTEN, re-reads the lines and finds them paid.
      await serializeTx(from, async () => {
        if (isKilled()) { skipped = 'killed'; return }
        if (readPendingIntents(from).length) { skipped = 'this pool has an unresolved payout intent'; return }
        const st = lineStatuses(roundId)
        chunk = chunk.filter(c => st.get(c.wallet) === 'pending') // a line that is no longer pending is never sent again
        if (!chunk.length) return
        const units = unitsFor(chunk.length)
        total = chunk.reduce((a, c) => a + c.lamports, 0n)
        // answered at or after this pool's last landed payout (a node behind it errors instead of showing SOL paid out)
        const bal = await balanceOf(from, { minContextSlot: lastPaidSlot(pool.parentMint) })
        const fee = txFeeLamports(units)
        if (bal < total + fee + reserve) { skipped = `pool ${sol(bal)} SOL can't fund ${sol(total)} + fee + reserve ${sol(reserve)}`; return }
        const built = await buildTx({ payer: from, instructions: chunk.map(c => transferIx(from, c.wallet, c.lamports)), signers: [poolKey], units })
        // only a chain verdict that NAMES A PAYEE isolates one; an RPC error, or a node lagging behind our blockhash
        // (minContextSlot makes it answer with an RPC error), just ends this pool's pass
        try { await simulate(built.tx, { minContextSlot: built.builtSlot }) } catch (e) {
          const m = String(e.message).slice(0, 160)
          if (payeeRefusal(e.simErr)) simRefused = m
          else skipped = `simulation ${e.simErr ? 'refused the tx for a reason that is not a payee' : 'unavailable'} (${m})`
          return
        }
        if (isKilled()) { skipped = 'killed'; return } // checked at SEND time, after the slow part
        intent = { roundId, parentMint: pool.parentMint, parentSymbol: pool.symbol, from, time: Date.now(), items: chunk.map(c => ({ wallet: c.wallet, lamports: c.lamports.toString(), weight: c.weight != null ? String(c.weight) : null })) }
        intent.sig = sigOf(built.tx)
        intent.raw = Buffer.from(built.tx.serialize()).toString('base64')
        intent.lastValidBlockHeight = built.lastValidBlockHeight
        intent.builtSlot = built.builtSlot
        appendPendingIntent(intent) // durable pre-send intent: after this line the tx may reach the chain
        journaled = true
        try { outcome = await settleTx({ raw: intent.raw, sig: intent.sig, lastValidBlockHeight: intent.lastValidBlockHeight, builtSlot: intent.builtSlot }, settle) } catch (e) { outcome = { status: 'ambiguous', reason: `settle threw: ${e.message}` } }
        if (outcome.status !== 'ambiguous') { try { applyOutcome(intent, outcome) } catch (e) { writeFailed = e } }
      })
    } catch (e) {
      if (!journaled) { halt(`pre-send failure: ${e.message}`); break }
      outcome = outcome || { status: 'ambiguous', reason: `settle threw: ${e.message}` }
    }
    if (!chunk.length && !skipped) continue
    if (writeFailed) {
      // THE money-safety writes failed (disk full / read-only): STOP. The intent journal keeps it repairable.
      console.error(`[paysol] CRITICAL: durable writes failed after tx ${intent.sig} (${outcome.status}): ${writeFailed.message} — halting`)
      halt('durable write failed', true); break
    }
    if (simRefused) {
      if (chunk.length > 1) { console.warn(`[paysol] $${pool.symbol}: simulation refused a batch of ${chunk.length} (${simRefused}) — retrying one payee at a time`); queue.unshift(...chunk.map(c => [c])); continue }
      console.warn(`[paysol] $${pool.symbol}: ${chunk[0].wallet} cannot be paid (${simRefused}) — skipped this round`)
      markLines(roundId, [chunk[0].wallet], { status: 'refused', error: simRefused.slice(0, 120) })
      res.refused.push(chunk[0].wallet)
      continue
    }
    if (skipped) { console.warn(`[paysol] $${pool.symbol}: ${skipped} — nothing sent`); halt(skipped); break }
    // No verdict yet: the intent STAYS in the journal, nothing is marked, and this pool waits for the chain.
    if (outcome.status === 'ambiguous') { console.error(`[paysol] $${pool.symbol}: no verdict for payout tx ${intent.sig} yet (${outcome.reason}) — kept in the intent journal, this pool waits`); halt(`unsettled payout: ${outcome.reason}`, true); break }
    if (outcome.status === 'confirmed') { res.paid.push(...chunk.map(c => c.wallet)); res.spentLamports += total; console.log(`[paysol] $${pool.symbol}: paid ${sol(total)} SOL to ${chunk.length} holder(s) | tx=${intent.sig}`); continue }
    console.error(`[paysol] $${pool.symbol}: payout tx ${intent.sig} ${outcome.status === 'failed' ? `failed on-chain (${outcome.err}); nothing moved` : 'provably did not land — its lines are rebuilt on the next pass'}`)
    halt(outcome.status); break
  }
  return res
}

/**
 * Resolve journaled in-flight payouts (of one pool, or all). The chain decides each; the writes are idempotent,
 * so a half-recorded payout is finished, never recorded twice. Re-broadcasting the journaled bytes is always safe.
 * Returns true when no intent of that pool remains.
 */
export async function resolvePendingIntents({ poolWallet = null, deadlineMs = 60_000, quarantineAfterMs = 30 * 60_000, settle = {} } = {}) {
  for (const it of readPendingIntents(poolWallet)) {
    try {
      // inside the pool's critical section: a sender can never interleave with a recovery of the same pool
      await serializeTx(it.from, async () => {
        if (!readPendingIntents(it.from).some(x => x.sig === it.sig)) return // resolved meanwhile
        const outcome = await settleTx({ raw: it.raw, sig: it.sig, lastValidBlockHeight: it.lastValidBlockHeight, builtSlot: it.builtSlot ?? null }, { deadlineMs, ...settle })
        if (outcome.status === 'ambiguous') {
          if (Date.now() - (it.time || 0) < quarantineAfterMs) { console.warn(`[intents] ${String(it.sig).slice(0, 10)}… still has no verdict (${outcome.reason}) — waiting`); return }
          outcome.reason = `intent-recovery: ${outcome.reason}`
        }
        applyOutcome(it, outcome)
        console.log(`[intents] in-flight payout ${String(it.sig).slice(0, 10)}… (${it.items?.length || 0} payee(s)) resolved: ${outcome.status}`)
      })
    } catch (e) { console.error(`[intents] could not resolve ${it.sig}: ${e.message} — will retry`) }
  }
  return readPendingIntents(poolWallet).length === 0
}
