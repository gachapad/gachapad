// pump.fun wrappers (@pump-fun/pump-sdk 2.0.0 + @pump-fun/pump-swap-sdk 1.20.0): create, read curves and
// PumpSwap pools, creator-fee vaults, the one fee-sharing lock, distribute, and unsigned trade builders.
//
// The money model in one paragraph: a child is created with `creator` = its derived coin key (solana.js
// coinKeyFor). Right after the create lands, the coin key creates the child's fee-sharing config and sets the
// shareholders ONCE (pump.fun then revokes the admin: 6009 / 6024 on any second update). From that moment
// pump.fun itself routes every creator fee of the child — on the curve and on PumpSwap — 40% launcher / 40% the
// PARENT's holder pool / 10% burn / 10% protocol; `distributeCreatorFees` is a permissionless crank.
import BN from 'bn.js'
import { createRequire } from 'module'
import { PublicKey, SystemProgram } from '@solana/web3.js'
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createCloseAccountInstruction } from '@solana/spl-token'
import { getConnection, pk, rent0, accountInfos } from './solana.js'

// The pump SDKs' ESM builds import a named `BN` from Anchor's CommonJS module, which Node 22 cannot see.
// Their CommonJS builds work on every Node: load those.
const require = createRequire(import.meta.url)
const {
  PUMP_SDK, OnlinePumpSdk, bondingCurvePda, creatorVaultPda, feeSharingConfigPda, canonicalPumpPoolPda, PUMP_PROGRAM_ID,
  getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount, bondingCurveMarketCap, computeFeesBps, canonicalPumpPoolPdaWithQuote,
} = require('@pump-fun/pump-sdk')
const {
  coinCreatorVaultAuthorityPda, coinCreatorVaultAtaPda, OnlinePumpAmmSdk, PUMP_AMM_SDK, buyQuoteInput, sellBaseInput,
  computeFeesBps: ammComputeFeesBps, GLOBAL_CONFIG_PDA: AMM_GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA,
} = require('@pump-fun/pump-swap-sdk')

export const PUMP_ALT_MAINNET = '7mFD2mUtRS65XstiSAvCJuYmdesZoQwCwRJhq1p3eRMe' // pump.fun frontend's lookup table (create+buy size)
export const TARGET_SOL = 85.005 // real SOL in a completed curve (Global: 793.1M tokens sold from 30 SOL / 1.073B virtual)
export { PUMP_SDK, feeSharingConfigPda, creatorVaultPda, bondingCurvePda, canonicalPumpPoolPda, PUMP_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT }

let _online = null, _onlineAmm = null
export function online() { if (!_online) _online = new OnlinePumpSdk(getConnection()); return _online }
export function onlineAmm() { if (!_onlineAmm) _onlineAmm = new OnlinePumpAmmSdk(getConnection()); return _onlineAmm }
export function resetSdks() { _online = null; _onlineAmm = null; ctxCache = null; ammCache = null; altCache = null; stateCache.clear() }

let ctxCache = null
/** pump Global + fee config, cached for a minute. */
export async function ctx() {
  if (ctxCache && Date.now() - ctxCache.at < 60_000) return ctxCache
  const [global, feeConfig] = await Promise.all([online().fetchGlobal(), online().fetchFeeConfig()])
  ctxCache = { at: Date.now(), global, feeConfig }
  return ctxCache
}
let ammCache = null
/** PumpSwap GlobalConfig + FeeConfig, cached for a minute. */
export async function ammCtx() {
  if (ammCache && Date.now() - ammCache.at < 60_000) return ammCache
  const [g, f] = await getConnection().getMultipleAccountsInfo([AMM_GLOBAL_CONFIG_PDA, PUMP_AMM_FEE_CONFIG_PDA], 'confirmed')
  if (!g) throw new Error('PumpSwap global config not found')
  ammCache = { at: Date.now(), globalConfig: PUMP_AMM_SDK.decodeGlobalConfig(g), feeConfig: f ? PUMP_AMM_SDK.decodeFeeConfig(f) : null }
  return ammCache
}

let altCache = null
export async function loadAlts() {
  if (altCache && Date.now() - altCache.at < 600_000) return altCache.alts
  const res = await getConnection().getAddressLookupTable(pk(PUMP_ALT_MAINNET))
  altCache = { at: Date.now(), alts: res?.value ? [res.value] : [] }
  return altCache.alts
}

/* ---------------- create ---------------- */

/** Instructions to create a coin (optionally with a first buy paid by `user`, tokens to `user`). */
export async function createIxs({ mint, name, symbol, uri, creator, user, devBuyLamports = 0n, creatorFeeBps = 0 }) {
  // 0 = pump.fun's schedule rate; otherwise a fixed per-coin creator fee, stored on the curve forever
  const fee = Number(creatorFeeBps) > 0 ? new BN(String(creatorFeeBps)) : undefined
  if (BigInt(devBuyLamports) > 0n) {
    const { global, feeConfig } = await ctx()
    const solAmount = new BN(devBuyLamports.toString())
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: null, bondingCurve: null, amount: solAmount, quoteMint: NATIVE_MINT, ...(fee ? { creatorFeeBps: fee } : {}) })
    const ixs = await PUMP_SDK.createV2AndBuyInstructions({ global, mint: pk(mint), name, symbol, uri, creator: pk(creator), user: pk(user), amount, solAmount, mayhemMode: false, cashback: false, ...(fee ? { creatorFeeBps: fee } : {}) })
    return { ixs, alts: await loadAlts(), units: 400_000 }
  }
  const ix = await PUMP_SDK.createV2Instruction({ mint: pk(mint), name, symbol, uri, creator: pk(creator), user: pk(user), mayhemMode: false, cashback: false, ...(fee ? { creatorFeeBps: fee } : {}) })
  return { ixs: [ix], alts: [], units: 300_000 }
}

/* ---------------- curves ---------------- */

export function decodeCurve(info) {
  // not a pump curve account (a PDA someone sent lamports to, garbage): null, without the SDK's console noise
  if (!info || !info.data || info.data.length < 49 || (info.owner && !new PublicKey(info.owner).equals(PUMP_PROGRAM_ID))) return null
  try { return PUMP_SDK.decodeBondingCurveNullable(info) } catch { return null }
}

/**
 * Shape a decoded bonding curve into the numbers the site shows. A graduated curve has its virtual reserves
 * zeroed: the SDK's market-cap maths divides by zero on it, so it is reported as graduated and NEVER passed to
 * bondingCurveMarketCap (one throw here used to fail the refresh of every coin in an earlier engine).
 */
export function curveFigures(bc, global, feeConfig = null) {
  if (!bc) return null
  let creatorFeeBps = null
  const vt = bc.virtualTokenReserves
  const graduated = !!bc.complete || !vt || vt.isZero()
  const qm = bc.quoteMint && !bc.quoteMint.equals(PublicKey.default) ? bc.quoteMint.toBase58() : NATIVE_MINT.toBase58()
  const base = { quoteMint: qm, creator: bc.creator.toBase58(), realSol: Number(bc.realQuoteReserves?.toString?.() || 0) / 1e9, isMayhem: !!bc.isMayhemMode, isCashback: !!bc.isCashbackCoin, supplyRaw: bc.tokenTotalSupply?.toString?.() || '0' }
  if (graduated) return { ...base, graduated: true, progress: 1, mcapSol: null, priceSol: null, creatorFeeBps }
  const quoteMint = bc.quoteMint && !bc.quoteMint.equals(PublicKey.default) ? bc.quoteMint : NATIVE_MINT
  const custom = bc.creatorFeeBps && !bc.creatorFeeBps.isZero() ? bc.creatorFeeBps : undefined
  try { if (global) creatorFeeBps = Number(computeFeesBps({ global, feeConfig, mintSupply: bc.tokenTotalSupply, virtualQuoteReserves: bc.virtualQuoteReserves, virtualTokenReserves: bc.virtualTokenReserves, quoteMint, ...(custom ? { creatorFeeBps: custom } : {}) }).creatorFeeBps.toString()) } catch {}
  const mcapLamports = bondingCurveMarketCap({ mintSupply: bc.tokenTotalSupply, virtualQuoteReserves: bc.virtualQuoteReserves, virtualTokenReserves: bc.virtualTokenReserves })
  const initialReal = global?.initialRealTokenReserves ? Number(global.initialRealTokenReserves.toString()) : 793_100_000_000_000
  const real = Number(bc.realTokenReserves.toString())
  const progress = Math.max(0, Math.min(1, 1 - real / initialReal))
  if (qm !== NATIVE_MINT.toBase58()) {
    // priced in its quote token (e.g. CARDS, 6 decimals): quote per token + mcap in quote; readCurves turns them into SOL
    const qd = QUOTE_DECIMALS.get(qm) ?? 6
    const priceQuote = (Number(bc.virtualQuoteReserves.toString()) / 10 ** qd) / (Number(vt.toString()) / 1e6)
    return { ...base, graduated: false, progress, priceQuote, mcapQuote: priceQuote * Number(bc.tokenTotalSupply.toString()) / 1e6, realQuote: Number(bc.realQuoteReserves?.toString?.() || 0) / 10 ** qd, priceSol: null, mcapSol: null, creatorFeeBps }
  }
  return {
    ...base, graduated: false,
    progress,
    mcapSol: Number(mcapLamports.toString()) / 1e9,
    priceSol: Number(bc.virtualQuoteReserves.toString()) / Number(vt.toString()) / 1e3, // lamports/raw → SOL/token (6 dec)
    creatorFeeBps,
  }
}

/* ---------------- token quotes (a coin priced in CARDS, USDC …) ---------------- */

const QUOTE_DECIMALS = new Map([['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6], ['CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp', 6]])
const quotePx = new Map() // quote mint → { at, sol }
/** SOL per 1 whole unit of a quote token (Jupiter, cached 60 s; the last good value on a miss). null = unknown. */
export async function quotePriceSol(quoteMint) {
  const q = String(quoteMint)
  const hit = quotePx.get(q)
  if (hit && Date.now() - hit.at < 60_000) return hit.sol
  try {
    const qd = QUOTE_DECIMALS.get(q) ?? 6
    const u = new URLSearchParams({ inputMint: q, outputMint: NATIVE_MINT.toBase58(), amount: String(10 ** qd), slippageBps: '50', swapMode: 'ExactIn' })
    const r = await fetch(`https://lite-api.jup.ag/swap/v1/quote?${u}`, { signal: AbortSignal.timeout(8000) })
    const j = await r.json()
    const sol = Number(j?.outAmount) / 1e9
    if (sol > 0) { quotePx.set(q, { at: Date.now(), sol }); return sol }
  } catch {}
  return hit?.sol ?? null
}
async function toSolFigures(f) {
  if (!f || f.quoteMint === NATIVE_MINT.toBase58() || f.priceQuote == null) return f
  const px = await quotePriceSol(f.quoteMint)
  if (!(px > 0)) return f
  return { ...f, priceSol: f.priceQuote * px, mcapSol: f.mcapQuote * px, realSol: (f.realQuote || 0) * px }
}

/** Read many curves in one batch (chunks of 100). Map(mint → figures|null). One unreadable curve never takes the others down. */
export async function readCurves(mints) {
  const out = new Map()
  if (!mints.length) return out
  let global = null, feeConfig = null
  try { ({ global, feeConfig } = await ctx()) } catch {}
  const conn = getConnection()
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100)
    const infos = await conn.getMultipleAccountsInfo(chunk.map(m => bondingCurvePda(pk(m))), 'confirmed')
    chunk.forEach((m, j) => { try { out.set(m, curveFigures(decodeCurve(infos[j]), global, feeConfig)) } catch (e) { console.warn(`[pump] curve ${m} unreadable: ${String(e.message).slice(0, 80)}`); out.set(m, null) } })
  }
  for (const [m, f] of out) if (f && f.quoteMint !== NATIVE_MINT.toBase58()) out.set(m, await toSolFigures(f))
  return out
}

/* ---------------- PumpSwap pools (graduated coins) ---------------- */

const u64At = (data, off) => { try { return Buffer.from(data).readBigUInt64LE(off) } catch { return 0n } }

/**
 * Canonical PumpSwap pool figures of graduated coins. Map(mint → { pool, coinCreator, baseRaw, quoteLamports,
 * virtualQuote, priceSol, mcapSol, creatorFeeBps } | null (no pool yet: migration in flight)).
 */
export async function readAmmPools(mints, quoteOf = new Map()) {
  const out = new Map()
  if (!mints.length) return out
  const isToken = m => quoteOf.get(m) && quoteOf.get(m) !== NATIVE_MINT.toBase58()
  const pools = mints.map(m => (isToken(m) ? canonicalPumpPoolPdaWithQuote(pk(m), pk(quoteOf.get(m))) : canonicalPumpPoolPda(pk(m))))
  const infos = await accountInfos(pools)
  const decoded = mints.map((m, i) => { try { return infos[i] ? PUMP_AMM_SDK.decodePool(infos[i]) : null } catch { return null } })
  const vaults = decoded.flatMap(p => (p ? [p.poolBaseTokenAccount, p.poolQuoteTokenAccount] : []))
  const vInfos = vaults.length ? await accountInfos(vaults) : []
  let amm = null
  try { amm = await ammCtx() } catch {}
  let k = 0
  mints.forEach((m, i) => {
    const p = decoded[i]
    if (!p) { out.set(m, null); return }
    const bInfo = vInfos[k++], qInfo = vInfos[k++]
    const baseRaw = bInfo ? u64At(bInfo.data, 64) : 0n, quoteLamports = qInfo ? u64At(qInfo.data, 64) : 0n
    const virtualQuote = BigInt(p.virtualQuoteReserves?.toString?.() || '0')
    // SOL pools: lamports per raw token /1e3 = SOL per token; token-quoted pools: quote per token here, SOL after the loop
    const qd = isToken(m) ? (QUOTE_DECIMALS.get(quoteOf.get(m)) ?? 6) : 9
    const priceSol = baseRaw > 0n ? (Number(quoteLamports + virtualQuote) / 10 ** qd) / (Number(baseRaw) / 1e6) : null
    let creatorFeeBps = null
    try {
      if (amm && baseRaw > 0n) {
        const f = ammComputeFeesBps({ globalConfig: amm.globalConfig, feeConfig: amm.feeConfig, creator: p.creator, baseMintSupply: new BN('1000000000000000'), baseMint: p.baseMint, baseReserve: new BN(baseRaw.toString()), quoteReserve: new BN(quoteLamports.toString()), quoteMint: p.quoteMint, isMayhemMode: !!p.isMayhemMode, creatorFeeBps: p.creatorFeeBps })
        creatorFeeBps = Number(f.creatorFeeBps.toString())
      }
    } catch {}
    out.set(m, { pool: pools[i].toBase58(), coinCreator: p.coinCreator.toBase58(), baseRaw: baseRaw.toString(), quoteLamports: quoteLamports.toString(), virtualQuote: virtualQuote.toString(), priceSol, mcapSol: priceSol != null ? priceSol * 1e9 : null, creatorFeeBps })
  })
  for (const m of mints) {
    const v = out.get(m)
    if (!v || !isToken(m) || v.priceSol == null) continue
    const px = await quotePriceSol(quoteOf.get(m))
    out.set(m, px > 0 ? { ...v, quoteMint: quoteOf.get(m), priceSol: v.priceSol * px, mcapSol: v.priceSol * px * 1e9 } : { ...v, quoteMint: quoteOf.get(m), priceSol: null, mcapSol: null })
  }
  return out
}

/* ---------------- creator-fee vaults ---------------- */

/** Accounts that hold a creator's fees: the curve vault (native lamports) + the AMM vault ATA (WSOL). */
export function vaultAccounts(creator) {
  const c = pk(creator)
  return { curveVault: creatorVaultPda(c), ammVaultAta: coinCreatorVaultAtaPda(coinCreatorVaultAuthorityPda(c), NATIVE_MINT, TOKEN_PROGRAM_ID) }
}

/**
 * Creator vaults of many creators in one batch. Map(creator → { vaultLamports (whole curve-vault balance),
 * curve (lamports above rent(0)), amm (WSOL in the AMM vault ATA), ammAtaExists, total (curve + amm) }).
 */
export async function readVaults(creators, { minContextSlot = null } = {}) {
  const out = new Map()
  if (!creators.length) return out
  const r0 = rent0()
  const keys = creators.flatMap(c => { const v = vaultAccounts(c); return [v.curveVault, v.ammVaultAta] })
  const infos = await accountInfos(keys, { minContextSlot })
  creators.forEach((c, i) => {
    const vault = infos[i * 2], ata = infos[i * 2 + 1]
    const vaultLamports = vault ? BigInt(vault.lamports) : 0n
    const curve = vault && vaultLamports > r0 ? vaultLamports - r0 : 0n
    const amm = ata && ata.data.length >= 72 ? u64At(ata.data, 64) : 0n
    out.set(String(c), { vaultLamports, curve, amm, ammAtaExists: !!ata, total: curve + amm })
  })
  return out
}
/** Lamports claimable by each creator (curve above rent + AMM WSOL). Map(creator → BigInt). */
export async function readClaimable(creators) {
  const v = await readVaults(creators)
  return new Map([...v].map(([k, x]) => [k, x.total]))
}
/** A sharing-config coin's waiting fees: the vaults are keyed by the CONFIG PDA. Map(mint → vaults). */
export async function readDistributable(mints) {
  const cfgs = mints.map(m => feeSharingConfigPda(pk(m)).toBase58())
  const v = await readVaults(cfgs)
  return new Map(mints.map((m, i) => [m, v.get(cfgs[i])]))
}

/**
 * Collect a creator's fees to the creator's own wallet (coin key = creator = payer, it signs). A curve coin only
 * has native fees: the pump program's own collect (no token-account rent). `graduated && ammAtaExists` adds the AMM
 * leg (the sweep sets both from its ANCHORED vault read: the old AMM vault ATA exists and holds WSOL): the SDK then
 * creates the creator's own WSOL account (rent paid by the creator, refunded when it closes it in the same tx to
 * unwrap, since creator == payer) — only when the AMM vault ATA exists, so the key never pays to create an empty vault.
 */
export async function collectIxs(coinCreator, { graduated = false, ammAtaExists = false } = {}) {
  const all = await online().collectCoinCreatorFeeInstructions(pk(coinCreator), pk(coinCreator))
  if (graduated && ammAtaExists) return all
  return all.filter(ix => ix.programId.equals(PUMP_PROGRAM_ID))
}
/**
 * The coin creator's OWN WSOL account (the AMM leg of a collect lands there). pump_amm's collect_coin_creator_fee is
 * permissionless: anyone can move a graduated coin's AMM creator fees into it, where only closing it (the creator
 * signs) unwraps them.
 */
export const coinKeyWsolAta = owner => getAssociatedTokenAddressSync(NATIVE_MINT, pk(owner), true, TOKEN_PROGRAM_ID)
/** Close the creator's WSOL account into the creator (every lamport: the WSOL + its rent). */
export const closeWsolIx = owner => createCloseAccountInstruction(coinKeyWsolAta(owner), pk(owner), pk(owner), [], TOKEN_PROGRAM_ID)
/** Does one of `ixs` already close token account `account` (SPL Token CloseAccount = 9)? */
export const closesAccount = (ixs, account) => ixs.some(ix => ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data?.[0] === 9 && ix.keys?.[0]?.pubkey?.equals(pk(account)))
/** Does one of `ixs` create associated token account `account` (the ATA program; accounts [payer, ata, owner, …])? */
export const createsTokenAccount = (ixs, account) => ixs.some(ix => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) && ix.keys?.[1]?.pubkey?.equals(pk(account)))
/** Rent of a 165-byte SPL token account (a WSOL account): rent(n) = rent(0) × (n + 128) / 128, rounded up (1,488,440 today). */
export const tokenAccountRent = () => (rent0() * 293n + 127n) / 128n

/* ---------------- fee sharing ---------------- */

/**
 * A coin's fee-sharing config: { address, config } | null ONLY when no account exists there. A config that EXISTS but
 * does not decode (a pump-fees layout change this SDK does not know) THROWS (`undecodable: true`): it is never
 * mistaken for "no config yet" (a second lock would be built over it, or a sweep skipped for it).
 */
export async function readSharingConfig(mint) {
  const address = feeSharingConfigPda(pk(mint))
  const info = await getConnection().getAccountInfo(address, 'confirmed')
  if (!info) return null
  try { return { address, config: PUMP_SDK.decodeSharingConfig(info) } } catch (e) {
    throw Object.assign(new Error(`the fee-sharing config ${address.toBase58()} exists but does not decode (a pump-fees change? update @pump-fun/pump-sdk): ${String(e?.message || e).slice(0, 120)}`), { undecodable: true })
  }
}

/** A SharingConfig account's size on mainnet (1024 B, padded): its rent is 5,852,160 at rent(0) 650,240. */
export const SHARING_CONFIG_SPACE = 1024
/** Rent the coin key pays for its sharing config: rent(n) = rent(0) × (n + 128) / 128 (Solana's rent formula). */
export const sharingConfigRent = () => (rent0() * BigInt(SHARING_CONFIG_SPACE + 128)) / 128n

/**
 * The ONE fee-sharing setup of a coin: create the config (the creator = coin key pays its rent, 5,852,160) and set
 * the shareholders. After this pump.fun refuses any further update (6009 SharingConfigAdminRevoked / 6024).
 * `shareholders` = [{ address, shareBps }], 1-10, sum exactly 10000, no duplicates, no zero.
 */
export async function sharingIxs({ creator, mint, graduated, shareholders }) {
  const sum = shareholders.reduce((a, s) => a + s.shareBps, 0)
  if (sum !== 10_000) throw new Error(`shares sum to ${sum}, must be 10000`)
  if (shareholders.length < 1 || shareholders.length > 10) throw new Error('1-10 shareholders')
  if (new Set(shareholders.map(s => s.address)).size !== shareholders.length) throw new Error('duplicate shareholder')
  const c = pk(creator), m = pk(mint)
  const create = await PUMP_SDK.createFeeSharingConfig({ creator: c, mint: m, pool: graduated ? canonicalPumpPoolPda(m) : null })
  const update = await PUMP_SDK.updateFeeShares({ authority: c, mint: m, currentShareholders: [c], newShareholders: shareholders.map(s => ({ address: pk(s.address), shareBps: s.shareBps })) })
  return [create, update]
}

/**
 * Distribute a sharing-config coin's accrued fees (permissionless; `payer` only pays the tx fee). A graduated coin
 * first moves its AMM creator vault into the pump vault — only when that ATA exists (3012 AccountNotInitialized otherwise).
 */
export async function distributeIxs({ mint, sharing, graduated, ammAtaExists = true, payer }) {
  const m = pk(mint)
  const ixs = []
  if (graduated && ammAtaExists) ixs.push(await PUMP_SDK.transferCreatorFeesToPumpV2({ payer: pk(payer), mint: m, quoteMint: NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID }))
  ixs.push(await PUMP_SDK.distributeCreatorFees({ mint: m, sharingConfig: sharing.config, sharingConfigAddress: sharing.address }))
  return ixs
}

/* ---------------- trades (built here, signed in the browser) ---------------- */

// Public QUOTES (no user) read a coin's state at most once per QUOTE_STATE_MS, whatever the request rate or amount:
// a /quote flood costs O(coins) RPC, not O(requests). Builds (a user) always read fresh. In-flight reads are shared.
const QUOTE_STATE_MS = 2000
const stateCache = new Map()
function cached(key, ms, fn) {
  const hit = stateCache.get(key)
  if (hit && Date.now() - hit.at < ms) return hit.p
  const p = Promise.resolve().then(fn)
  stateCache.set(key, { at: Date.now(), p })
  p.catch(() => { if (stateCache.get(key)?.p === p) stateCache.delete(key) })
  if (stateCache.size > 5000) stateCache.delete(stateCache.keys().next().value)
  return p
}
/** A coin's curve figures for a quote (null = not a pump coin), shared for QUOTE_STATE_MS. */
export const quoteCurve = mint => cached(`curve-fig:${mint}`, QUOTE_STATE_MS, async () => (await readCurves([mint])).get(mint) || null)

async function tokenProgramOfMint(mint) {
  // a mint's owner program never changes: read once
  return cached(`tprog:${mint}`, 86_400_000, async () => {
    const info = await getConnection().getAccountInfo(pk(mint), 'confirmed')
    if (!info) throw new Error('unknown mint')
    return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  })
}
const bpsDown = (x, bps) => (BigInt(x) * 10_000n) / (10_000n + BigInt(bps))
const minus = (x, bps) => (BigInt(x) * (10_000n - BigInt(bps))) / 10_000n
const impactPct = (out, ideal) => (ideal > 0 ? Math.max(0, (1 - Number(out) / Number(ideal)) * 100) : 0)

/**
 * Quote (and optionally build) a bonding-curve trade. side 'buy': amount = lamports in; 'sell': amount = raw tokens in.
 * A buy never spends more than `amount`: the guaranteed tokens are priced for amount/(1+slippage) and the SDK's
 * max-cost is that times (1+slippage). Returns { route:'curve', outAmount, minOut, priceImpactPct, feeBps, ixs? }.
 */
const QUOTE_NAMES = new Map([['CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp', 'CARDS'], ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC']])
// the site's trade box speaks SOL only: a coin priced in a token ($GACHA on CARDS) is traded on pump.fun
const quotedTradeError = qm => Object.assign(new Error(`this coin trades in ${QUOTE_NAMES.get(String(qm)) || 'a token'}, not SOL: trade it on pump.fun`), { quoted: true, status: 400 })

export async function curveTrade({ mint, side, amount, slippageBps, user = null }) {
  const { global, feeConfig } = await ctx()
  const m = pk(mint)
  const tokenProgram = await tokenProgramOfMint(mint)
  const who = user ? pk(user) : PublicKey.default
  // a quote needs only the curve; the SDK's buy/sell states also read the user's token account (a sell state throws without one)
  let st = null, bc
  if (user) { st = side === 'buy' ? await online().fetchBuyState(m, who, tokenProgram) : await online().fetchSellState(m, who, tokenProgram); bc = st.bondingCurve }
  else bc = await cached(`curve:${mint}`, QUOTE_STATE_MS, async () => { const x = decodeCurve(await getConnection().getAccountInfo(bondingCurvePda(m), 'confirmed')); if (!x) throw new Error('no curve'); return x })
  if (bc.quoteMint && !bc.quoteMint.equals(PublicKey.default) && !bc.quoteMint.equals(NATIVE_MINT)) throw quotedTradeError(bc.quoteMint)
  if (bc.complete || bc.virtualTokenReserves.isZero()) throw Object.assign(new Error('graduated'), { graduated: true })
  const slipPct = Number(slippageBps) / 100
  const fees = computeFeesBps({ global, feeConfig, mintSupply: bc.tokenTotalSupply, virtualQuoteReserves: bc.virtualQuoteReserves, virtualTokenReserves: bc.virtualTokenReserves, quoteMint: NATIVE_MINT })
  const feeBps = Number(fees.protocolFeeBps.toString()) + Number(fees.creatorFeeBps.toString())
  const vq = BigInt(bc.virtualQuoteReserves.toString()), vt = BigInt(bc.virtualTokenReserves.toString())
  if (side === 'buy') {
    const lamports = BigInt(amount)
    const out = BigInt(getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: new BN(lamports.toString()), quoteMint: NATIVE_MINT }).toString())
    const solForMin = bpsDown(lamports, slippageBps)
    const minOut = BigInt(getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: new BN(solForMin.toString()), quoteMint: NATIVE_MINT }).toString())
    const ideal = (lamports * vt) / vq
    const q = { route: 'curve', outAmount: out.toString(), minOut: minOut.toString(), priceImpactPct: +Math.max(0, impactPct(out, ideal) - feeBps / 100).toFixed(3), feeBps }
    if (!user) return q
    const ixs = await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: bc, associatedUserAccountInfo: st.associatedUserAccountInfo, mint: m, user: who, amount: new BN(minOut.toString()), solAmount: new BN(solForMin.toString()), slippage: slipPct, tokenProgram })
    return { ...q, ixs }
  }
  const tokens = BigInt(amount)
  const out = BigInt(getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: new BN(tokens.toString()) }).toString())
  const minOut = minus(out, slippageBps)
  const ideal = (tokens * vq) / vt
  const q = { route: 'curve', outAmount: out.toString(), minOut: minOut.toString(), priceImpactPct: +Math.max(0, impactPct(out, ideal) - feeBps / 100).toFixed(3), feeBps }
  if (!user) return q
  const ixs = await PUMP_SDK.sellInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: bc, mint: m, user: who, amount: new BN(tokens.toString()), solAmount: new BN(out.toString()), slippage: slipPct, tokenProgram, mayhemMode: !!bc.isMayhemMode, cashback: !!bc.isCashbackCoin })
  return { ...q, ixs }
}

/**
 * A curve buy PAID IN THE CURVE'S QUOTE TOKEN (e.g. $GACHA on CARDS): spend up to `quoteAmount` raw quote units via
 * buy_v2. Like curveTrade: exact tokens out = the minimum for the slipped amount, max quote in = slipped × (1 + slip) < quoteAmount.
 * Throws { graduated } once the curve completed. Returns { route:'curve-quote', quoteMint, outAmount, minOut, maxQuote, ixs }.
 */
export async function curveBuyWithQuote({ mint, quoteMint, quoteAmount, slippageBps, user }) {
  const { global, feeConfig } = await ctx()
  const m = pk(mint), who = pk(user)
  const tokenProgram = await tokenProgramOfMint(mint)
  const st = await online().fetchBuyState(m, who, tokenProgram, quoteMint ? pk(quoteMint) : undefined)
  const bc = st.bondingCurve
  if (bc.complete || bc.virtualTokenReserves.isZero()) throw Object.assign(new Error('graduated'), { graduated: true })
  if (st.quoteMint.equals(NATIVE_MINT)) throw new Error('this curve is quoted in SOL: use curveTrade')
  if (quoteMint && st.quoteMint.toBase58() !== String(quoteMint)) throw new Error(`curve quote ${st.quoteMint.toBase58()} is not ${quoteMint}`)
  const q = BigInt(quoteAmount)
  const tokensFor = x => BigInt(getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: new BN(x.toString()), quoteMint: st.quoteMint }).toString())
  const out = tokensFor(q)
  const slipped = bpsDown(q, slippageBps)
  const minOut = tokensFor(slipped)
  const slipPct = Number(slippageBps) / 100
  const ixs = await PUMP_SDK.buyV2Instructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: bc, associatedUserAccountInfo: st.associatedUserAccountInfo, mint: m, user: who, amount: new BN(minOut.toString()), quoteAmount: new BN(slipped.toString()), slippage: slipPct, tokenProgram, quoteTokenProgram: st.quoteTokenProgram })
  const maxQuote = slipped + (slipped * BigInt(Math.floor(slipPct * 10))) / 1000n // what buy_v2 is told it may spend (the SDK's own formula)
  if (maxQuote > q) throw new Error('curve-quote buy: max quote above the amount held')
  return { route: 'curve-quote', quoteMint: st.quoteMint.toBase58(), outAmount: out.toString(), minOut: minOut.toString(), maxQuote: maxQuote.toString(), ixs }
}

/**
 * Quote (and optionally build) a PumpSwap trade on the coin's canonical pool. Throws { migrating } when the curve
 * completed but the pool does not exist yet. Returns { route:'amm', outAmount, minOut, priceImpactPct, feeBps, ixs? }.
 */
export async function ammTrade({ mint, side, amount, slippageBps, user = null }) {
  const poolKey = canonicalPumpPoolPda(pk(mint))
  let st
  try { st = user ? await onlineAmm().swapSolanaState(poolKey, pk(user)) : await cached(`amm:${mint}`, QUOTE_STATE_MS, () => onlineAmm().swapSolanaState(poolKey, PublicKey.default)) } catch (e) {
    if (/Pool account not found/i.test(String(e.message))) {
      const f = (await readCurves([String(mint)])).get(String(mint))
      if (f?.quoteMint && f.quoteMint !== NATIVE_MINT.toBase58()) throw quotedTradeError(f.quoteMint)
      throw Object.assign(new Error('migrating to PumpSwap: try again in a minute'), { migrating: true })
    }
    throw e
  }
  const slipPct = Number(slippageBps) / 100
  const common = { baseReserve: st.poolBaseAmount, quoteReserve: st.poolQuoteAmount, virtualQuoteReserves: st.pool.virtualQuoteReserves, globalConfig: st.globalConfig, baseMintAccount: st.baseMintAccount, baseMint: st.baseMint, coinCreator: st.pool.coinCreator, creator: st.pool.creator, feeConfig: st.feeConfig, quoteMint: st.pool.quoteMint, isMayhemMode: st.pool.isMayhemMode, creatorFeeBps: st.pool.creatorFeeBps }
  let feeBps = null
  try {
    const f = ammComputeFeesBps({ globalConfig: st.globalConfig, feeConfig: st.feeConfig, creator: st.pool.creator, baseMintSupply: new BN(String(st.baseMintAccount?.supply ?? '1000000000000000')), baseMint: st.baseMint, baseReserve: st.poolBaseAmount, quoteReserve: st.poolQuoteAmount, quoteMint: st.pool.quoteMint, isMayhemMode: st.pool.isMayhemMode, creatorFeeBps: st.pool.creatorFeeBps })
    feeBps = Number(f.lpFeeBps.toString()) + Number(f.protocolFeeBps.toString()) + Number(f.creatorFeeBps.toString())
  } catch {}
  const base = BigInt(st.poolBaseAmount.toString()), quote = BigInt(st.poolQuoteAmount.toString()) + BigInt(st.pool.virtualQuoteReserves?.toString?.() || '0')
  if (side === 'buy') {
    const lamports = BigInt(amount)
    const full = buyQuoteInput({ ...common, quote: new BN(lamports.toString()), slippage: slipPct })
    const reduced = bpsDown(lamports, slippageBps)
    const g = buyQuoteInput({ ...common, quote: new BN(reduced.toString()), slippage: slipPct })
    const out = BigInt(full.base.toString())
    const ideal = quote > 0n ? (lamports * base) / quote : 0n
    const q = { route: 'amm', outAmount: out.toString(), minOut: g.base.toString(), priceImpactPct: +Math.max(0, impactPct(out, ideal) - (feeBps || 0) / 100).toFixed(3), feeBps }
    if (!user) return q
    return { ...q, ixs: await PUMP_AMM_SDK.buyInstructions(st, g.base, g.maxQuote) }
  }
  const tokens = BigInt(amount)
  const r = sellBaseInput({ ...common, base: new BN(tokens.toString()), slippage: slipPct })
  const out = BigInt(r.uiQuote.toString())
  const ideal = base > 0n ? (tokens * quote) / base : 0n
  const q = { route: 'amm', outAmount: out.toString(), minOut: r.minQuote.toString(), priceImpactPct: +Math.max(0, impactPct(out, ideal) - (feeBps || 0) / 100).toFixed(3), feeBps }
  if (!user) return q
  return { ...q, ixs: await PUMP_AMM_SDK.sellInstructions(st, new BN(tokens.toString()), r.minQuote) }
}

export const transfer = (from, to, lamports) => SystemProgram.transfer({ fromPubkey: pk(from), toPubkey: pk(to), lamports: BigInt(lamports) })
