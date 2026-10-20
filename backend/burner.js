// $TICKER (ROOT) buyback-and-burn. The burn wallet is a 10% fee-sharing shareholder of EVERY child (on-chain).
// Whenever it holds more than BURN_MIN_SOL over its reserve it buys ROOT and burns what it holds (burnChecked,
// Token-2022). ROOT is always a pump coin, so the buy is built HERE from on-chain reserves with the pump SDKs (curve,
// or PumpSwap once graduated) — the burn wallet never signs bytes a third party returned. Before the first broadcast
// the tx is checked (sole signer, allowed programs / instructions) and SIMULATED with the wallet's post-state: it must
// spend at most what it asked (+ fees + token-account rent) and receive at least the quoted minimum of ROOT. The swap
// is JOURNALED (raw bytes, signature, lastValidBlockHeight) before its first broadcast and settled from the chain on
// restart: a swap whose fate is unknown is never rebuilt. After a settle the balance is re-read (a swap that just
// landed never funds a second one), and a failed swap backs off. Until ROOT exists (or with BURN_LIVE off) the wallet
// just accumulates.
//
// A TOKEN-QUOTED ROOT ($GACHA on CARDS) takes two journaled stages, each its own tx with its own checks:
//   1. SOL → the quote token into the burn wallet's own account (Jupiter; assertSwapTx: sole signer, one Jupiter route;
//      the guaranteed minimum must sit within 5% + slippage of an independent USD price; simulated post-state).
//   2. the quote token the wallet MEASURABLY holds → ROOT: pump buy_v2 built here from the curve (assertBurnTx), or
//      Jupiter once ROOT graduated. Simulated: spends ≤ that balance, yields ≥ the minimum.
// Only one stage is ever in flight (the one `pending` journal slot). A crash between stages just leaves quote tokens
// in the wallet: the next tick spends them.
import { PublicKey, VersionedTransaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createBurnCheckedInstruction, getMint } from '@solana/spl-token'
import { config } from './config.js'
import { getConnection, getBurnWallet, burnAddress, engineAddress, protocolAddress, sendAndConfirm, settleTx, buildTx, simulate, accountInfos, sigOf, sol, toLamports, txFeeLamports, pk } from './solana.js'
import { burnsStore } from './store.js'
import { rootMint, coinRec, warnEvery } from './registry.js'
import { readCurves, curveTrade, ammTrade, curveBuyWithQuote, quotePriceSol, PUMP_PROGRAM_ID } from './pump.js'
import { assertSwapTx } from './swapcheck.js'
import { keyConflicts, COMPUTE_BUDGET_PROGRAM } from './math.js'
import { solUsdCached } from './price.js'
import { isKilled } from './kill.js'
import { emitEvent } from './bus.js'

const run = { lastError: null, balanceSol: null, at: 0 }
let tokenInfo = null
// after a failed / refused swap: wait 1 min, 2, 4 … (≤ 1 h) before building another (a doomed swap still pays fees)
const swapBackoff = { fails: 0, until: 0 }
export const _resetBackoff = () => { swapBackoff.fails = 0; swapBackoff.until = 0 } // tests
const noteSwapFailure = () => { swapBackoff.fails++; swapBackoff.until = Date.now() + Math.min(3_600_000, 60_000 * 2 ** (swapBackoff.fails - 1)) }

async function tokenMeta(mintStr) {
  if (tokenInfo?.mintStr === mintStr) return tokenInfo
  const conn = getConnection()
  const mint = new PublicKey(mintStr)
  const info = await conn.getAccountInfo(mint, 'confirmed')
  if (!info) throw new Error('ROOT mint not found')
  const program = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  const m = await getMint(conn, mint, 'confirmed', program)
  // the quote a pump curve trades in is fixed at create: SOL for the kids, CARDS for $GACHA
  const f = (await readCurves([mintStr])).get(mintStr)
  if (!f?.quoteMint) throw new Error('ROOT has no pump.fun curve')
  let quote = null
  if (f.quoteMint !== NATIVE_MINT.toBase58()) {
    const qi = await conn.getAccountInfo(new PublicKey(f.quoteMint), 'confirmed')
    if (!qi) throw new Error('ROOT quote mint not found')
    const qp = qi.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
    const qm = await getMint(conn, new PublicKey(f.quoteMint), 'confirmed', qp)
    quote = { mint: new PublicKey(f.quoteMint), mintStr: f.quoteMint, program: qp, decimals: qm.decimals }
  }
  tokenInfo = { mintStr, mint, program, decimals: m.decimals, quote }
  return tokenInfo
}

const PUMP_AMM_PROGRAM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'
const SYSTEM = '11111111111111111111111111111111'
/**
 * The burn wallet signs ONLY a buy shaped like the ones the pump SDKs build: it is the sole signer and fee payer;
 * programs ⊆ {ComputeBudget, pump, PumpSwap, ATA, Token, Token-2022, System}; a System instruction is a transfer
 * from the wallet into its OWN WSOL account; Token instructions are SyncNative / CloseAccount back to the wallet;
 * ATA creations are paid by and owned by the wallet. Throws otherwise. Pure.
 */
export function assertBurnTx(tx, owner) {
  const me = pk(owner).toBase58()
  const msg = tx.message
  if (msg.header.numRequiredSignatures !== 1 || msg.staticAccountKeys[0].toBase58() !== me) throw new Error('burn tx: the burn wallet must be the sole signer and fee payer')
  if (msg.addressTableLookups?.length) throw new Error('burn tx: lookup tables are not expected in a burn buy')
  const keys = msg.staticAccountKeys.map(k => k.toBase58())
  const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, pk(me), false, TOKEN_PROGRAM_ID).toBase58()
  for (const ix of msg.compiledInstructions) {
    const prog = keys[ix.programIdIndex], acc = i => keys[ix.accountKeyIndexes[i]], d = Buffer.from(ix.data)
    if (prog === COMPUTE_BUDGET_PROGRAM || prog === PUMP_PROGRAM_ID.toBase58() || prog === PUMP_AMM_PROGRAM) continue
    if (prog === SYSTEM) {
      if (!(d.length >= 12 && d.readUInt32LE(0) === 2 && acc(0) === me && acc(1) === wsol)) throw new Error('burn tx: a System instruction that is not a transfer into the wallet\'s own WSOL account')
      continue
    }
    if (prog === TOKEN_PROGRAM_ID.toBase58() || prog === TOKEN_2022_PROGRAM_ID.toBase58()) {
      if (d[0] === 17) continue // SyncNative
      if (d[0] === 9 && acc(1) === me && acc(2) === me) continue // CloseAccount → the wallet
      throw new Error(`burn tx: token instruction ${d[0]} is not allowed`)
    }
    if (prog === ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()) {
      if ((d.length === 0 || d[0] === 0 || d[0] === 1) && acc(0) === me && acc(2) === me) continue // create(Idempotent), paid + owned by the wallet
      throw new Error('burn tx: an ATA instruction not paid and owned by the burn wallet')
    }
    throw new Error(`burn tx: program ${prog} is not allowed`)
  }
  return true
}

/**
 * The burn wallet's ROOT buy for `lamports`, built from on-chain reserves (the curve, or PumpSwap once graduated),
 * checked by assertBurnTx. `signers` = [the burn keypair] to sign it; [] for a dry run. Returns { tx, lastValidBlockHeight, builtSlot, quote }.
 */
export async function buildRootBuy({ owner, mint, lamports, signers = [] }) {
  const f = (await readCurves([mint])).get(mint)
  if (!f) throw new Error('ROOT has no pump.fun curve')
  const req = { mint, side: 'buy', amount: BigInt(lamports), slippageBps: config.burnSlippageBps, user: pk(owner).toBase58() }
  let q
  if (f.graduated) q = await ammTrade(req)
  else {
    try { q = await curveTrade(req) } catch (e) { if (!e.graduated) throw e; q = await ammTrade(req) }
  }
  if (!q?.ixs?.length || !(BigInt(q.minOut) > 0n)) throw new Error('no ROOT buy for that amount')
  const units = q.route === 'amm' ? 300_000 : 250_000
  const built = await buildTx({ payer: pk(owner), instructions: q.ixs, signers, units })
  assertBurnTx(built.tx, owner)
  return { ...built, units, quote: q }
}

const u64At = (b64, off) => { try { return Buffer.from(b64, 'base64').readBigUInt64LE(off) } catch { return 0n } }
/**
 * Simulate the buy and check the burn wallet's POST-state: it spends at most `lamports` + the tx fee + token-account
 * rent, and its ROOT account gains at least the quoted minimum. Throws (nothing is journaled) otherwise.
 */
export async function checkBurnSimulation(built, { owner, mint, program, lamports, balance }) {
  const ata = getAssociatedTokenAddressSync(pk(mint), pk(owner), false, program).toBase58()
  const [pre] = await accountInfos([ata])
  const preAmount = pre?.data?.length >= 72 ? Buffer.from(pre.data).readBigUInt64LE(64) : 0n
  const v = await simulate(built.tx, { minContextSlot: built.builtSlot, accounts: [pk(owner).toBase58(), ata] })
  const [w, a] = v.accounts || []
  if (!w || !a) throw new Error('the simulation did not return the burn wallet state: not sending')
  const spentMax = BigInt(lamports) + txFeeLamports(built.units || 300_000) + 3_000_000n // + ROOT ATA rent (the WSOL one is closed again)
  if (BigInt(balance) - BigInt(w.lamports) > spentMax) throw new Error(`the simulated buy spends ${sol(BigInt(balance) - BigInt(w.lamports))} SOL, more than the ${sol(spentMax)} allowed: not sending`)
  const gained = u64At(Array.isArray(a.data) ? a.data[0] : a.data, 64) - preAmount
  if (gained < BigInt(built.quote.minOut)) throw new Error(`the simulated buy yields ${gained} ROOT, below the quoted minimum ${built.quote.minOut}: not sending`)
  return { gained }
}

/* ---------------- token-quoted ROOT: SOL → quote token → ROOT ---------------- */

/** USD per whole token from a source other than the Jupiter route being checked: Dexscreener (deepest pair), then Jupiter's price API. 0 = unknown. */
export async function usdPriceOf(mint) {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal: AbortSignal.timeout(6000) })
    const pairs = ((await r.json())?.pairs || []).filter(p => p.baseToken?.address === String(mint) && Number(p.priceUsd) > 0)
    pairs.sort((a, b) => (Number(b.liquidity?.usd) || 0) - (Number(a.liquidity?.usd) || 0))
    if (pairs[0] && Number(pairs[0].liquidity?.usd) >= 10_000) return Number(pairs[0].priceUsd)
  } catch {}
  try {
    const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mint}`, { signal: AbortSignal.timeout(6000) })
    const v = Number((await r.json())?.[String(mint)]?.usdPrice)
    if (v > 0) return v
  } catch {}
  return 0
}

/** A Jupiter ExactIn swap `owner` signs: quoted, built for `owner`'s own accounts, checked by assertSwapTx. */
async function jupiterSwap({ owner, inputMint, outputMint, amount, slippageBps, signers = [], checkQuote = null }) {
  const q = new URLSearchParams({ inputMint: String(inputMint), outputMint: String(outputMint), amount: BigInt(amount).toString(), slippageBps: String(slippageBps), swapMode: 'ExactIn', restrictIntermediateTokens: 'true' })
  const qr = await fetch(`${config.jupiterBase}/quote?${q}`, { signal: AbortSignal.timeout(15_000) })
  if (!qr.ok) throw new Error(`jupiter quote ${qr.status}`)
  const quote = await qr.json()
  if (!quote?.outAmount || !(BigInt(quote.otherAmountThreshold || 0) > 0n)) throw new Error('jupiter: no route')
  if (checkQuote) await checkQuote(BigInt(quote.otherAmountThreshold)) // refuse BEFORE asking for tx bytes
  const sr = await fetch(`${config.jupiterBase}/swap`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ quoteResponse: quote, userPublicKey: pk(owner).toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 150_000, priorityLevel: 'high' } } }),
  })
  if (!sr.ok) throw new Error(`jupiter swap build ${sr.status}`)
  const j = await sr.json()
  const tx = VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, 'base64'))
  assertSwapTx(tx, owner)
  if (signers.length) tx.sign(signers)
  const lastValidBlockHeight = j.lastValidBlockHeight || (await getConnection().getLatestBlockhash('confirmed')).lastValidBlockHeight
  return { tx, lastValidBlockHeight, builtSlot: null, units: 400_000, quote: { route: 'jupiter', outAmount: String(quote.outAmount), minOut: String(quote.otherAmountThreshold) } }
}

/**
 * Stage 1: SOL → the quote token (CARDS) into the burn wallet's own account. The guaranteed minimum must be within
 * 5% + slippage of the fair amount by SOL/USD (Coinbase) ÷ quote/USD (Dexscreener, else Jupiter price API).
 */
export async function buildQuoteBuy({ owner, quote, lamports, signers = [] }) {
  const checkQuote = async minOut => {
    const solUsdNow = solUsdCached(), qUsd = await usdPriceOf(quote.mintStr)
    if (!(solUsdNow > 0) || !(qUsd > 0)) throw new Error('no independent price for SOL or the quote token: not swapping')
    const fair = (Number(lamports) / 1e9) * solUsdNow / qUsd * 10 ** quote.decimals
    if (Number(minOut) < fair * (0.95 - config.burnSlippageBps / 10_000)) throw new Error(`jupiter's minimum ${Number(minOut) / 10 ** quote.decimals} is too far below the market (${(fair / 10 ** quote.decimals).toFixed(2)}): not swapping`)
  }
  return { ...(await jupiterSwap({ owner, inputMint: NATIVE_MINT.toBase58(), outputMint: quote.mintStr, amount: lamports, slippageBps: config.burnSlippageBps, signers, checkQuote })), stage: 'quote' }
}

/** Stage 2: `quoteAmount` raw quote units → ROOT (pump buy_v2 on the curve, built here; Jupiter once graduated). */
export async function buildQuotedRootBuy({ owner, mint, quote, quoteAmount, signers = [] }) {
  let q = null
  try { q = await curveBuyWithQuote({ mint, quoteMint: quote.mintStr, quoteAmount, slippageBps: config.burnSlippageBps, user: pk(owner).toBase58() }) } catch (e) { if (!e.graduated) throw e }
  if (!q) return { ...(await jupiterSwap({ owner, inputMint: quote.mintStr, outputMint: mint, amount: quoteAmount, slippageBps: config.burnSlippageBps, signers })), stage: 'root', maxIn: BigInt(quoteAmount) }
  if (!q.ixs?.length || !(BigInt(q.minOut) > 0n)) throw new Error('no ROOT buy for that amount')
  const units = 400_000
  const built = await buildTx({ payer: pk(owner), instructions: q.ixs, signers, units })
  assertBurnTx(built.tx, owner)
  return { ...built, units, quote: q, stage: 'root', maxIn: BigInt(q.maxQuote) }
}

const tokAmt = acc => (acc ? u64At(Array.isArray(acc.data) ? acc.data[0] : acc.data, 64) : 0n)
const preAmt = info => (info?.data?.length >= 72 ? Buffer.from(info.data).readBigUInt64LE(64) : 0n)
/**
 * Simulate a stage and check the burn wallet's POST-state: SOL spent ≤ `solMax`; the `inAta` (if any) drops by
 * ≤ `maxIn`; the `outAta` gains ≥ the quoted minimum. Throws (nothing is journaled) otherwise.
 */
export async function checkStageSimulation(built, { owner, balance, solMax, inAta = null, maxIn = 0n, outAta }) {
  const me = pk(owner).toBase58()
  const [preOut, preIn] = await accountInfos(inAta ? [outAta, inAta] : [outAta])
  const v = await simulate(built.tx, { ...(built.builtSlot ? { minContextSlot: built.builtSlot } : {}), accounts: inAta ? [me, outAta, inAta] : [me, outAta] })
  const [w, o, i] = v.accounts || []
  if (!w || !o) throw new Error('the simulation did not return the burn wallet state: not sending')
  if (BigInt(balance) - BigInt(w.lamports) > BigInt(solMax)) throw new Error(`the simulated ${built.stage} stage spends ${sol(BigInt(balance) - BigInt(w.lamports))} SOL, more than the ${sol(BigInt(solMax))} allowed: not sending`)
  if (inAta && preAmt(preIn) - tokAmt(i) > BigInt(maxIn)) throw new Error(`the simulated ${built.stage} stage spends ${preAmt(preIn) - tokAmt(i)} quote, more than ${maxIn}: not sending`)
  const gained = tokAmt(o) - preAmt(preOut)
  if (gained < BigInt(built.quote.minOut)) throw new Error(`the simulated ${built.stage} stage yields ${gained}, below the minimum ${built.quote.minOut}: not sending`)
  return { gained }
}

async function burnAll(kp, t) {
  const ata = getAssociatedTokenAddressSync(t.mint, kp.publicKey, false, t.program)
  const b = await getConnection().getTokenAccountBalance(ata, 'confirmed').catch(() => null)
  const bal = b ? BigInt(b.value.amount) : 0n
  if (bal <= 0n) return null
  const { tx, lastValidBlockHeight, builtSlot } = await buildTx({ payer: kp.publicKey, instructions: [createBurnCheckedInstruction(ata, t.mint, kp.publicKey, bal, t.decimals, [], t.program)], signers: [kp], units: 100_000 })
  if (isKilled()) return null
  const { sig } = await sendAndConfirm(tx, { lastValidBlockHeight, builtSlot })
  return { sig, burned: bal }
}

/**
 * Settle a journaled swap from a previous tick / process. Returns 'clear' (nothing was pending), 'settled' (a
 * pending swap got its verdict now: re-read the balance before spending again) or 'wait' (no verdict yet).
 */
async function settlePending({ settle = {} } = {}) {
  const p = burnsStore.get().pending
  if (!p) return 'clear'
  const r = await settleTx({ raw: p.raw, sig: p.sig, lastValidBlockHeight: p.lastValidBlockHeight, builtSlot: p.builtSlot ?? null }, { deadlineMs: 60_000, ...settle })
  if (r.status === 'ambiguous') {
    if (Date.now() - p.at < 30 * 60_000) return 'wait'
    console.error(`[burner] swap ${p.sig} has no verdict after 30 min — written off (quarantined), never resent`)
  }
  burnsStore.update(s => {
    if (p.stage === 'root') {
      // stage 2 of a token-quoted ROOT: quote tokens → ROOT (the SOL was counted when stage 1 landed)
      s.lastRootBuy = { sig: p.sig, status: r.status, at: Date.now(), spendQuote: p.spendQuote }
    } else {
      if (r.status === 'confirmed') {
        s.totalSpentLamports = (BigInt(s.totalSpentLamports || '0') + BigInt(p.spendLamports)).toString()
        if (p.stage === 'quote') s.carryLamports = (BigInt(s.carryLamports || '0') + BigInt(p.spendLamports)).toString() // SOL behind the next burn
      }
      s.lastSwap = { sig: p.sig, status: r.status, at: Date.now(), spendLamports: p.spendLamports, ...(p.stage ? { stage: p.stage } : {}) }
    }
    s.pending = null
  })
  if (r.status === 'confirmed') swapBackoff.fails = 0
  else noteSwapFailure()
  return 'settled'
}

/** Why the burner must not spend at all right now (a config the permanent split would regret), or null. */
function burnBlocker(token) {
  const kc = keyConflicts({ engine: engineAddress(), burn: burnAddress(), protocol: protocolAddress() })
  if (kc.length) return kc[0]
  const rec = coinRec(token)
  if (!rec || rec.parent || rec.retiredAt) return `ROOT ${token} is not registered as ROOT here (check ROOT_MINT / adopt it): not buying it`
  return null
}

const journalStage = (built, extra) => burnsStore.update(x => { x.pending = { sig: sigOf(built.tx), raw: Buffer.from(built.tx.serialize()).toString('base64'), lastValidBlockHeight: built.lastValidBlockHeight, builtSlot: built.builtSlot ?? null, quotedOut: String(built.quote.outAmount), minOut: String(built.quote.minOut), route: built.quote.route, at: Date.now(), ...extra } })
const stageFailed = e => { run.lastError = String(e.message).slice(0, 160); if (!/killed/.test(e.message)) noteSwapFailure() }

/** The two stages of a token-quoted ROOT (see the header). Returns 'wait' while a journaled stage has no verdict. */
async function quotedStages(kp, t, { bal, settle }) {
  const conn = getConnection()
  const q = t.quote
  const quoteAta = getAssociatedTokenAddressSync(q.mint, kp.publicKey, false, q.program).toBase58()
  const rootAta = getAssociatedTokenAddressSync(t.mint, kp.publicKey, false, t.program).toBase58()
  const ready = () => !isKilled() && Date.now() >= swapBackoff.until
  // 1. SOL above the reserve → the quote token
  const spend = bal - toLamports(config.burnReserveSol)
  if (spend >= toLamports(config.burnMinSol) && ready()) {
    try {
      const built = await buildQuoteBuy({ owner: kp.publicKey, quote: q, lamports: spend, signers: [kp] })
      // + Jupiter's fees (priority ≤ 0.00015) + its temporary WSOL account (refunded) + the quote account's rent
      await checkStageSimulation(built, { owner: kp.publicKey, balance: bal, solMax: spend + 7_000_000n, outAta: quoteAta })
      if (isKilled()) throw new Error('killed')
      journalStage(built, { stage: 'quote', spendLamports: spend.toString() }) // BEFORE the first broadcast
      if ((await settlePending({ settle })) === 'wait') return 'wait'
    } catch (e) { stageFailed(e) }
  }
  // 2. every quote token the wallet MEASURABLY holds → ROOT (dust under half a BURN_MIN_SOL waits for more)
  const qb = await conn.getTokenAccountBalance(new PublicKey(quoteAta), 'confirmed').catch(() => null)
  const held = qb ? BigInt(qb.value.amount) : 0n
  if (held > 0n && ready()) {
    const px = await quotePriceSol(q.mintStr)
    if (px > 0 && (Number(held) / 10 ** q.decimals) * px >= config.burnMinSol / 2) {
      try {
        const solNow = BigInt(await conn.getBalance(kp.publicKey, 'confirmed'))
        const built = await buildQuotedRootBuy({ owner: kp.publicKey, mint: t.mintStr, quote: q, quoteAmount: held, signers: [kp] })
        const solMax = built.quote.route === 'jupiter' ? 7_000_000n : txFeeLamports(built.units) + 8_000_000n // fees + rent: the ROOT account, pump's volume account, and a quote account buy_v2 may open (the buyer pays)
        await checkStageSimulation(built, { owner: kp.publicKey, balance: solNow, solMax, inAta: quoteAta, maxIn: built.maxIn, outAta: rootAta })
        if (isKilled()) throw new Error('killed')
        journalStage(built, { stage: 'root', spendQuote: held.toString() })
        if ((await settlePending({ settle })) === 'wait') return 'wait'
      } catch (e) { stageFailed(e) }
    }
  }
  return 'ok'
}

let busy = false
/** One crank: settle a journaled swap, buy with the balance above the reserve, then burn every ROOT the wallet holds. */
export async function crankBurner({ force = false, settle = {} } = {}) { // eslint-disable-line no-unused-vars
  const kp = getBurnWallet()
  if (!kp || busy || config.offline || !config.rpcUrl) return null
  busy = true
  try {
    const conn = getConnection()
    let bal = BigInt(await conn.getBalance(kp.publicKey, 'confirmed'))
    run.balanceSol = sol(bal); run.at = Date.now()
    const token = rootMint()
    if (!token || !config.burnLive) return null // no ROOT yet, or BURN_LIVE off (admin triggers too): accumulate
    const blocked = burnBlocker(token)
    if (blocked) { run.lastError = blocked.slice(0, 160); warnEvery('burn-block', 600_000, `[burner] ${blocked}`); return null }
    const first = await settlePending({ settle })
    if (first === 'wait') return null
    let swapSig = null, spent = 0n
    if (first === 'settled') {
      // a journaled swap just got its verdict: the balance read above predates it — never spend it twice
      bal = BigInt(await conn.getBalance(kp.publicKey, 'confirmed'))
      run.balanceSol = sol(bal)
      const ls = burnsStore.get().lastSwap
      if (ls?.status === 'confirmed') { swapSig = ls.sig; spent = BigInt(ls.spendLamports || 0) }
    }
    const t = await tokenMeta(token)
    const spend = bal - toLamports(config.burnReserveSol)
    if (t.quote) {
      if ((await quotedStages(kp, t, { bal, settle })) === 'wait') return null
      const s = burnsStore.get()
      swapSig = s.lastRootBuy?.status === 'confirmed' ? s.lastRootBuy.sig : null
      spent = BigInt(s.carryLamports || '0')
    } else if (spend >= toLamports(config.burnMinSol) && !isKilled() && Date.now() >= swapBackoff.until) {
      try {
        const built = await buildRootBuy({ owner: kp.publicKey, mint: token, lamports: spend, signers: [kp] })
        await checkBurnSimulation(built, { owner: kp.publicKey, mint: token, program: t.program, lamports: spend, balance: bal })
        const sig = sigOf(built.tx)
        if (isKilled()) throw new Error('killed')
        // journal BEFORE the first broadcast
        burnsStore.update(x => { x.pending = { sig, raw: Buffer.from(built.tx.serialize()).toString('base64'), lastValidBlockHeight: built.lastValidBlockHeight, builtSlot: built.builtSlot ?? null, spendLamports: spend.toString(), quotedOut: String(built.quote.outAmount), minOut: String(built.quote.minOut), route: built.quote.route, at: Date.now() } })
        if ((await settlePending({ settle })) === 'wait') return null
        if (burnsStore.get().lastSwap?.sig === sig && burnsStore.get().lastSwap.status === 'confirmed') { swapSig = sig; spent = spend }
      } catch (e) {
        run.lastError = String(e.message).slice(0, 160)
        if (!/killed/.test(e.message)) noteSwapFailure()
      }
    }
    const b = await burnAll(kp, t)
    if (b) {
      const amountUi = Number(b.burned) / 10 ** t.decimals
      burnsStore.update(s => {
        s.totalBurnedRaw = (BigInt(s.totalBurnedRaw || '0') + b.burned).toString()
        if (t.quote) s.carryLamports = '0'
        s.done.push({ at: Date.now(), amountUi, amountRaw: b.burned.toString(), spentSol: sol(spent), sig: b.sig, swapSig, priceUsdAt: solUsdCached() })
        if (s.done.length > 2000) s.done.splice(0, s.done.length - 2000)
      })
      run.lastError = null
      emitEvent({ id: `burn:${b.sig}`, type: 'burn', mint: token, symbol: config.ticker, amountUi, amountSol: sol(spent), sig: b.sig, extra: { swapSig } })
      console.log(`[burner] burned ${amountUi.toFixed(0)} $${config.ticker} (${b.sig})`)
    }
    return b
  } catch (e) { run.lastError = String(e.message).slice(0, 120); console.warn('[burner]', run.lastError); return null } finally { busy = false }
}

export function burnerStatus() {
  const s = burnsStore.get()
  return { wallet: burnAddress() || null, token: rootMint() || null, quote: tokenInfo?.quote?.mintStr || null, live: config.burnLive, balanceSol: run.balanceSol, reserveSol: config.burnReserveSol, minSol: config.burnMinSol, totalBurnedUi: Number(BigInt(s.totalBurnedRaw || '0')) / 1e6, burns: s.done.length, pending: s.pending ? { sig: s.pending.sig, at: s.pending.at, stage: s.pending.stage || null } : null, lastSwap: s.lastSwap || null, lastRootBuy: s.lastRootBuy || null, lastError: run.lastError, at: run.at || null, retryAt: swapBackoff.until > Date.now() ? swapBackoff.until : null }
}
export const burnerBalanceSol = () => run.balanceSol
