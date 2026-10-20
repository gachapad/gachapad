// GACHAPAD engine config (pump.fun launchpad: every coin's fees stock its own gacha machine with real graded cards; burn the coin to pull one). Everything from env; no secrets in the repo.
// Brand strings live HERE (defaults) and in the site's src/config.js: renaming is a 2-file change.
import { readFileSync, existsSync } from 'fs'
import { dirname, resolve, join } from 'path'
import { fileURLToPath } from 'url'

// Everything resolves against THIS directory, never the process cwd: a start from the wrong directory
// must not boot on an empty data dir (empty journals = re-paying people) or miss the .env.
export const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * KEY=value per line; # comments; a quoted value ("…" or '…') is unquoted even when a " # comment" follows it; an
 * unquoted value loses a trailing " # comment". Pure.
 */
export function parseEnv(text) {
  const out = {}
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i <= 0) continue
    const key = t.slice(0, i).trim().replace(/^export\s+/, '')
    let val = t.slice(i + 1).trim()
    const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(val)
    if (quoted) val = quoted[2]
    else val = val.replace(/(^|\s+)#.*$/, '')
    out[key] = val
  }
  return out
}

function loadEnv() {
  if (process.env.ENGINE_NO_DOTENV === '1') return // unit tests + dry runs: never load a live .env
  let text
  try { text = readFileSync(resolve(HERE, process.env.ENGINE_ENV_FILE || process.env.ENV_FILE || '.env'), 'utf-8') } catch { return }
  // Documented precedence: the .env file wins over the inherited environment (a stray shell RPC_URL must not drive this engine).
  for (const [k, v] of Object.entries(parseEnv(text))) process.env[k] = v
}
loadEnv()

/**
 * Express `trust proxy`. `true` would trust EVERY hop: req.ip becomes the client-supplied leftmost
 * X-Forwarded-For entry and every per-IP limit (prepare, admin lockout) is spoofable. So 'true' means
 * ONE trusted hop (Caddy); a number = that many hops; 'false' = none. Pure.
 */
export function parseTrustProxy(v) {
  const s = String(v ?? '').trim()
  if (/^(1|true|yes|on)$/i.test(s)) return 1
  if (/^(0|false|no|off|)$/i.test(s)) return false
  if (/^\d+$/.test(s)) return Number(s)
  return s // 'loopback', 'uniquelocal', a CIDR list: passed to express as is
}

/**
 * ROOT_SHARES: the shareholders of ROOT's own fee-sharing lock when ROOT is launched through the admin.
 * "burn:8000,protocol:2000". Roles: burn | protocol | holders (ROOT's own holder pool) | creator (the admin wallet).
 * Returns [{ role, bps }] or throws. Pure.
 */
export function parseRootShares(s) {
  const parts = String(s || '').split(',').map(x => x.trim()).filter(Boolean)
  const out = []
  for (const p of parts) {
    const m = /^(burn|protocol|holders|creator)\s*:\s*(\d+)$/.exec(p)
    if (!m) throw new Error(`ROOT_SHARES entry "${p}" must look like role:bps (roles burn, protocol, holders, creator)`)
    if (out.some(o => o.role === m[1])) throw new Error(`ROOT_SHARES names ${m[1]} twice`)
    out.push({ role: m[1], bps: Number(m[2]) })
  }
  const sum = out.reduce((a, o) => a + o.bps, 0)
  if (!out.length || sum !== 10_000 || out.some(o => o.bps <= 0)) throw new Error(`ROOT_SHARES must sum to 10000 with no zero share (got ${sum})`)
  return out
}

// Strict numbers: "300000ms" is NaN (and fails configProblems), not 300000.
const envNum = (k, d) => { const v = process.env[k]; return v === undefined || String(v).trim() === '' ? d : Number(v) }
const envStr = (k, d = '') => { const v = process.env[k]; return v === undefined || v === '' ? d : String(v) }
// Live flags: only an explicit true turns money on.
const envBool = (k, d) => { const v = process.env[k]; if (v === undefined || String(v).trim() === '') return d; return /^(1|true|yes|on)$/i.test(String(v).trim()) }
const list = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean)
const dataDir = resolve(HERE, process.env.DATA_DIR || 'data')
let rootShares = null, rootSharesError = null
try { rootShares = parseRootShares(envStr('ROOT_SHARES', 'burn:8000,protocol:2000')) } catch (e) { rootSharesError = e.message }

export const WSOL = 'So11111111111111111111111111111111111111112'
export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

export const config = {
  // --- identity / brand ---
  brand: envStr('BRAND', 'Gachapad'),
  ticker: envStr('TICKER', 'GACHA').toUpperCase(),
  siteUrl: envStr('SITE_URL', 'http://localhost:5173').replace(/\/$/, ''),
  publicUrl: envStr('PUBLIC_URL', '').replace(/\/$/, ''), // the engine's own https origin (/img, /m, /c)
  // where self-hosted coin metadata lives (the PERMANENT on-chain URI): an origin you own that serves /m/* from the
  // engine. Default SITE_URL (vercel.json rewrites /m/* to the engine). Never the engine's IP-encoded host.
  metaBaseUrl: envStr('META_BASE_URL', '').replace(/\/$/, ''),

  // --- chain ---
  // Named RPC_URL on purpose: a global SOLANA_RPC_URL in the shell must never drive this engine.
  rpcUrl: envStr('RPC_URL', ''),
  rpcTimeoutMs: envNum('RPC_TIMEOUT_MS', 30_000),
  priorityFeeMicroLamports: envNum('PRIORITY_FEE_MICROLAMPORTS', 50_000),
  // THE engine key. It pays the distribute cranks; every coin key and holder pool derives from it.
  enginePrivateKey: envStr('ENGINE_PRIVATE_KEY'),
  // 10% of every child's creator fees (on-chain, pump fee sharing). A plain wallet, never the engine's address.
  protocolWallet: envStr('PROTOCOL_WALLET'),
  // 10% of every child's creator fees land here; it buys $TICKER and burns it (burner.js).
  burnPrivateKey: envStr('BURN_PRIVATE_KEY'),
  // $TICKER (ROOT). Empty until ROOT exists (then state.json holds it; this env pins it).
  rootMint: envStr('ROOT_MINT'),
  rootShares, rootSharesError,
  jupiterBase: envStr('JUPITER_BASE', 'https://lite-api.jup.ag/swap/v1').replace(/\/$/, ''),
  pinataJwt: envStr('PINATA_JWT'),
  metaSelfHost: envBool('META_SELF_HOST', false), // true: never upload to Pinata / pump.fun (dry runs); metadata is served from PUBLIC_URL/m/
  canaryPayer: envStr('CANARY_PAYER', '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'), // any funded mainnet wallet: simulations only

  // --- the mechanic (FIXED shares, see coins.js shareholdersFor) ---
  maxDepth: envNum('MAX_DEPTH', 1),
  // GACHAPAD: every coin locks [ITS OWN pack pool 8000, $GACHA burn 2000]. 'parentHolders' is the pool slot (the coin's
  // own pool here, see launch.js sharesFor): the shared seed + sweep logic applies to it unchanged.
  split: { creator: 0, parentHolders: 8000, burn: 2000, protocol: 0 },
  // paid by the launcher inside the create tx, to the coin key: fee-sharing rent (5,852,160) + lock/sweep fees;
  // the surplus is split by the shares. POOL_SEED_SOL makes the parent's holder pool exist (pump cannot pay a missing account cheaply).
  setupSol: envNum('SETUP_SOL', 0.0105),
  poolSeedSol: envNum('POOL_SEED_SOL', 0.002),
  firstBuyMaxSol: envNum('FIRST_BUY_MAX_SOL', 5),
  maxLaunchesPerDay: envNum('MAX_LAUNCHES_PER_DAY', 1000),
  refreshMs: envNum('REFRESH_MS', 30_000),
  // crank a coin's distribution once at least this much waits (and pump's unfunded-shareholder minimum is met)
  collectMinSol: envNum('COLLECT_MIN_SOL', 0.005),
  // the engine wallet never cranks below this (it only ever pays tx fees)
  gasReserveSol: envNum('GAS_RESERVE_SOL', 0.01),

  // --- holder rounds (per parent pool) ---
  roundMs: envNum('ROUND_MS', 3_600_000),
  maxWalletShareBps: envNum('MAX_WALLET_SHARE_BPS', 500),
  minPayoutSol: envNum('MIN_PAYOUT_SOL', 0.001),
  maxRecipients: envNum('MAX_RECIPIENTS', 400),
  holderMinTokens: envNum('HOLDER_MIN_TOKENS', 100_000),
  poolMarginSol: envNum('POOL_MARGIN_SOL', 0.001), // a pool keeps rent(0) + this (its own tx fees)
  payoutsPerTx: envNum('PAYOUTS_PER_TX', 12),

  // --- packs (Collector Crypt) ---
  ccBase: envStr('CC_BASE', 'https://gacha.collectorcrypt.com'),
  // pump.fun's own read of Collector Crypt stock per machine (healthy / low / empty) — the "packs" update
  pumpGachaUrl: envStr('PUMP_GACHA_URL', 'https://frontend-api-v3.pump.fun/gacha-inventory'),
  packCode: envStr('PACK_CODE', 'pokemon_25'), // the default machine a launch form offers first
  // the machines a coin may pick at launch (fixed for life). Collector Crypt codes, also pump.fun's pack_type.
  packCodes: list(envStr('PACK_CODES', 'pokemon_25,pokemon_50,pokemon_100,onepiece_50,sealed_80,anime_75,comic_25,comic_50,lorcana_50,riftbound_50,dragonball_50,basketball_50,baseball_50,football_50,soccer_50,sports_100')),
  packMaxUsdc: Math.min(envNum('PACK_MAX_USDC', 100), 1000),
  maxRipsPerDay: envNum('MAX_RIPS_PER_DAY', 288),
  ripGapMs: envNum('RIP_GAP_MS', 60_000),

  // --- pulls: burn a coin to pull a card from ITS machine (pulls.js) ---
  pullMarginBps: envNum('PULL_MARGIN_BPS', 1000),        // pull price = average card value in the machine × (1 + this)
  pullQuoteMs: envNum('PULL_QUOTE_MS', 120_000),         // a quote reserves one card this long
  pullMaxOpenPerWallet: envNum('PULL_MAX_OPEN_PER_WALLET', 2),
  pullTwapMs: envNum('PULL_TWAP_MS', 600_000),           // token price = the lowest of spot and every reading in this window
  pullMinSamples: envNum('PULL_MIN_SAMPLES', 3),         // price readings needed before a coin can be pulled
  pullMaxUsd: envNum('PULL_MAX_USD', 2000),              // hard ceiling on one pull's price
  poolReserveSol: envNum('POOL_RESERVE_SOL', 0.004),   // a pack pool keeps rent(0) + this (its swap fees)
  convertMinSol: envNum('CONVERT_MIN_SOL', 0.05),      // a pool swaps SOL → USDC once it holds this much above its reserve
  swapSlippageBps: envNum('SWAP_SLIPPAGE_BPS', 100),
  vaultGasMinSol: envNum('VAULT_GAS_MIN_SOL', 0.004),
  vaultGasTopUpSol: envNum('VAULT_GAS_TOPUP_SOL', 0.008),
  sampleMs: envNum('SAMPLE_MS', 300_000),
  sampleStartFraction: envNum('SAMPLE_START_FRACTION', 0.25), // readings start once a coin's pot is 25% of a pack
  minRoundSamples: envNum('MIN_ROUND_SAMPLES', 3),
  maxWalletChanceBps: envNum('MAX_WALLET_CHANCE_BPS', 1000),
  drawDelaySlots: envNum('DRAW_DELAY_SLOTS', 40),

  // --- burner ---
  burnMinSol: envNum('BURN_MIN_SOL', 0.02),
  burnReserveSol: envNum('BURN_RESERVE_SOL', 0.01),
  burnSlippageBps: envNum('BURN_SLIPPAGE_BPS', 300),

  // --- live flags: ALL default false (LAUNCH_PRESIGN default true: the mint signs first) ---
  launchEnabled: envBool('LAUNCH_ENABLED', false),
  distributeLive: envBool('DISTRIBUTE_LIVE', false),
  payoutsLive: false, // SOL holder payouts (inherited code path) are not used by GACHAPAD
  convertLive: envBool('CONVERT_LIVE', false),
  ripLive: envBool('RIP_LIVE', false),
  deliverLive: envBool('DELIVER_LIVE', false),
  pullsLive: envBool('PULLS_LIVE', false),
  burnLive: envBool('BURN_LIVE', false),
  launchPresign: envBool('LAUNCH_PRESIGN', true),

  // --- server ---
  port: envNum('PORT', 3043),
  host: envStr('HOST', '127.0.0.1'),
  dataDir,
  adminSecret: envStr('ADMIN_SECRET'),
  corsOrigins: list(envStr('CORS_ORIGINS', '*')),
  trustProxy: parseTrustProxy(envStr('TRUST_PROXY', 'true')),
  maxSseClients: envNum('MAX_SSE_CLIENTS', 1500),
  ssePerIp: envNum('SSE_PER_IP', 4),
  reservedTickers: list(envStr('RESERVED_TICKERS', '')).map(s => s.toUpperCase()),
  offline: envBool('DEV_OFFLINE', false), // dev: no chain reads, no money loops, seeded data stays put
  devSeed: envBool('DEV_SEED', false),

  get killFile() { return join(this.dataDir, 'KILL') },
}

const WEAK_SECRETS = new Set(['changeme', 'change-me', 'secret', 'password', 'admin', 'test', 'dev'])

/**
 * Every reason this config must not run, as human-readable lines. Pure over (config, env, exists) so it can be
 * unit-tested. Never includes a secret value.
 */
export function configProblems(c = config, env = process.env, exists = existsSync) {
  const bad = []
  const num = (v, ok) => Number.isFinite(v) && ok(v)
  const int = (v, ok) => Number.isInteger(v) && ok(v)
  const need = (cond, msg) => { if (!cond) bad.push(msg) }
  const got = k => `(got "${env[k] ?? ''}")`

  need(c.maxDepth === 1, `MAX_DEPTH must be 1 on GACHAPAD (every coin sits directly under $GACHA) ${got('MAX_DEPTH')}`)
  need(c.split.creator + c.split.parentHolders + c.split.burn + c.split.protocol === 10_000, 'the fixed split must sum to 10000')
  need(!c.rootSharesError, `ROOT_SHARES: ${c.rootSharesError}`)
  need(num(c.setupSol, v => v >= 0.0095), `SETUP_SOL must be >= 0.0095 (fee-sharing rent 0.00585 + the lock and sweep fees) ${got('SETUP_SOL')}`)
  need(num(c.poolSeedSol, v => v >= 0.001), `POOL_SEED_SOL must be >= 0.001 (a pool must exist rent-exempt before pump pays it) ${got('POOL_SEED_SOL')}`)
  need(num(c.firstBuyMaxSol, v => v >= 0), `FIRST_BUY_MAX_SOL must be a number >= 0 ${got('FIRST_BUY_MAX_SOL')}`)
  need(int(c.maxLaunchesPerDay, v => v >= 0), `MAX_LAUNCHES_PER_DAY must be an integer >= 0 ${got('MAX_LAUNCHES_PER_DAY')}`)
  need(int(c.refreshMs, v => v >= 5_000), `REFRESH_MS must be an integer >= 5000 ${got('REFRESH_MS')}`)
  need(num(c.collectMinSol, v => v >= 0.001), `COLLECT_MIN_SOL must be a number >= 0.001 ${got('COLLECT_MIN_SOL')}`)
  need(num(c.gasReserveSol, v => v >= 0), `GAS_RESERVE_SOL must be a number >= 0 ${got('GAS_RESERVE_SOL')}`)
  need(int(c.roundMs, v => v >= 60_000), `ROUND_MS must be an integer >= 60000 ${got('ROUND_MS')}`)
  need(int(c.maxWalletShareBps, v => v >= 1 && v <= 10_000), `MAX_WALLET_SHARE_BPS must be an integer 1-10000 ${got('MAX_WALLET_SHARE_BPS')}`)
  need(num(c.minPayoutSol, v => v >= 0.001), `MIN_PAYOUT_SOL must be a number >= 0.001 ${got('MIN_PAYOUT_SOL')}`)
  need(int(c.maxRecipients, v => v >= 1 && v <= 5000), `MAX_RECIPIENTS must be an integer 1-5000 ${got('MAX_RECIPIENTS')}`)
  need(num(c.holderMinTokens, v => v >= 0), `HOLDER_MIN_TOKENS must be a number >= 0 ${got('HOLDER_MIN_TOKENS')}`)
  need(num(c.poolMarginSol, v => v >= 0.0005), `POOL_MARGIN_SOL must be a number >= 0.0005 (a pool pays its own tx fees) ${got('POOL_MARGIN_SOL')}`)
  need(int(c.payoutsPerTx, v => v >= 1 && v <= 18), `PAYOUTS_PER_TX must be an integer 1-18 ${got('PAYOUTS_PER_TX')}`)
  need(num(c.burnMinSol, v => v >= 0), `BURN_MIN_SOL must be a number >= 0 ${got('BURN_MIN_SOL')}`)
  // --- packs: a typo must never switch a limit off (NaN compares false) ---
  need(num(c.packMaxUsdc, v => v > 0 && v <= 1000), `PACK_MAX_USDC must be a number in (0, 1000] ${got('PACK_MAX_USDC')}`)
  need(int(c.maxRipsPerDay, v => v >= 1 && v <= 1000), `MAX_RIPS_PER_DAY must be an integer 1-1000 ${got('MAX_RIPS_PER_DAY')}`)
  need(int(c.ripGapMs, v => v >= 60_000), `RIP_GAP_MS must be an integer >= 60000 ${got('RIP_GAP_MS')}`)
  need(c.packCodes.length > 0 && c.packCodes.every(x => /^[a-z0-9_]{2,40}$/.test(x)), `PACK_CODES must be a comma list of machine codes ${got('PACK_CODES')}`)
  need(c.packCodes.includes(c.packCode), `PACK_CODE must be one of PACK_CODES ${got('PACK_CODE')}`)
  need(int(c.pullMarginBps, v => v >= 0 && v <= 5000), `PULL_MARGIN_BPS must be an integer 0-5000 ${got('PULL_MARGIN_BPS')}`)
  need(int(c.pullQuoteMs, v => v >= 30_000 && v <= 600_000), `PULL_QUOTE_MS must be an integer 30000-600000 ${got('PULL_QUOTE_MS')}`)
  need(int(c.pullMaxOpenPerWallet, v => v >= 1 && v <= 10), `PULL_MAX_OPEN_PER_WALLET must be an integer 1-10 ${got('PULL_MAX_OPEN_PER_WALLET')}`)
  need(int(c.pullTwapMs, v => v >= 60_000), `PULL_TWAP_MS must be an integer >= 60000 ${got('PULL_TWAP_MS')}`)
  need(int(c.pullMinSamples, v => v >= 1 && v <= 100), `PULL_MIN_SAMPLES must be an integer 1-100 ${got('PULL_MIN_SAMPLES')}`)
  need(num(c.pullMaxUsd, v => v > 0 && v <= 10_000), `PULL_MAX_USD must be a number in (0, 10000] ${got('PULL_MAX_USD')}`)
  need(num(c.poolReserveSol, v => v >= 0.003), `POOL_RESERVE_SOL must be >= 0.003 (swap fees + the temporary WSOL account) ${got('POOL_RESERVE_SOL')}`)
  need(num(c.convertMinSol, v => v >= 0.01), `CONVERT_MIN_SOL must be >= 0.01 ${got('CONVERT_MIN_SOL')}`)
  need(int(c.swapSlippageBps, v => v >= 1 && v <= 300), `SWAP_SLIPPAGE_BPS must be an integer 1-300 ${got('SWAP_SLIPPAGE_BPS')}`)
  need(num(c.vaultGasMinSol, v => v >= 0.001), `VAULT_GAS_MIN_SOL must be >= 0.001 ${got('VAULT_GAS_MIN_SOL')}`)
  need(num(c.vaultGasTopUpSol, v => v >= 0.002 && v >= c.vaultGasMinSol), `VAULT_GAS_TOPUP_SOL must be >= 0.002 (above rent) and >= VAULT_GAS_MIN_SOL ${got('VAULT_GAS_TOPUP_SOL')}`)
  need(int(c.sampleMs, v => v >= 60_000), `SAMPLE_MS must be an integer >= 60000 ${got('SAMPLE_MS')}`)
  need(num(c.sampleStartFraction, v => v > 0 && v <= 1), `SAMPLE_START_FRACTION must be in (0, 1] ${got('SAMPLE_START_FRACTION')}`)
  need(int(c.minRoundSamples, v => v >= 1 && v <= 100), `MIN_ROUND_SAMPLES must be an integer 1-100 ${got('MIN_ROUND_SAMPLES')}`)
  need(int(c.maxWalletChanceBps, v => v >= 100 && v <= 10_000), `MAX_WALLET_CHANCE_BPS must be an integer 100-10000 ${got('MAX_WALLET_CHANCE_BPS')}`)
  need(int(c.drawDelaySlots, v => v >= 32 && v <= 2000), `DRAW_DELAY_SLOTS must be an integer 32-2000 (the seed block must not exist when entries freeze) ${got('DRAW_DELAY_SLOTS')}`)
  need(num(c.burnReserveSol, v => v >= 0.005), `BURN_RESERVE_SOL must be >= 0.005 (fees + the $TICKER token account rent) ${got('BURN_RESERVE_SOL')}`)
  need(int(c.burnSlippageBps, v => v >= 1 && v <= 5000), `BURN_SLIPPAGE_BPS must be an integer 1-5000 ${got('BURN_SLIPPAGE_BPS')}`)
  need(int(c.priorityFeeMicroLamports, v => v >= 0 && v <= 5_000_000), `PRIORITY_FEE_MICROLAMPORTS must be an integer 0-5000000 ${got('PRIORITY_FEE_MICROLAMPORTS')}`)
  need(int(c.port, v => v >= 1 && v <= 65535), `PORT must be an integer 1-65535 ${got('PORT')}`)
  need(int(c.rpcTimeoutMs, v => v >= 1000), `RPC_TIMEOUT_MS must be an integer >= 1000 ${got('RPC_TIMEOUT_MS')}`)
  need(int(c.maxSseClients, v => v >= 0), `MAX_SSE_CLIENTS must be an integer >= 0 ${got('MAX_SSE_CLIENTS')}`)
  need(int(c.ssePerIp, v => v >= 1), `SSE_PER_IP must be an integer >= 1 ${got('SSE_PER_IP')}`)
  need(!!c.host, 'HOST must not be empty')
  need(/^[A-Z0-9]{2,10}$/.test(c.ticker), `TICKER must be 2-10 A-Z0-9 ${got('TICKER')}`)
  // pump.fun pays a missing shareholder only once the vault holds rent + rent*10000/bps: keep the 10% shares
  // funded (burner reserve, protocol) — this floor only guards against a nonsense value.
  if (c.rpcUrl) need(/^https?:\/\/\S+$/.test(c.rpcUrl), 'RPC_URL must be an http(s) URL')
  need(c.corsOrigins.length > 0 && c.corsOrigins.every(o => o === '*' || /^https?:\/\/[^\s/]+$/.test(o)), 'CORS_ORIGINS must be * or a comma list of origins like https://example.fun')
  if (c.rootMint) need(BASE58_RE.test(c.rootMint), `ROOT_MINT must be a base58 mint address ${got('ROOT_MINT')}`)
  if (c.protocolWallet) need(BASE58_RE.test(c.protocolWallet), `PROTOCOL_WALLET must be a base58 address ${got('PROTOCOL_WALLET')}`)
  need(/^https?:\/\/[^\s/]+/.test(c.siteUrl), `SITE_URL must be an http(s) URL ${got('SITE_URL')}`)
  if (c.publicUrl) need(/^https?:\/\/[^\s/]+/.test(c.publicUrl), `PUBLIC_URL must be an http(s) URL ${got('PUBLIC_URL')}`)
  if (c.metaBaseUrl) need(/^https?:\/\/[^\s/"']+/.test(c.metaBaseUrl), `META_BASE_URL must be an http(s) URL ${got('META_BASE_URL')}`)
  // a mistyped value here would silently switch a safety net off (the canary) or starve the trade fallback
  if (c.canaryPayer) need(BASE58_RE.test(c.canaryPayer), `CANARY_PAYER must be a base58 address ${got('CANARY_PAYER')}`)
  need(/^https?:\/\/[^\s/"']+(\/[^\s"']*)?$/.test(c.jupiterBase || ''), `JUPITER_BASE must be an http(s) URL ${got('JUPITER_BASE')}`)
  if (c.adminSecret) need(c.adminSecret.length >= 24 && !WEAK_SECRETS.has(c.adminSecret.toLowerCase()), 'ADMIN_SECRET must be >= 24 random chars (`openssl rand -hex 32`)')

  if (env.NODE_ENV === 'production' && env.ALLOW_DEGRADED !== '1') {
    need(!!c.rpcUrl, 'RPC_URL is required in production (a paid RPC: holder snapshots need getProgramAccounts)')
    need(!!c.enginePrivateKey, 'ENGINE_PRIVATE_KEY is required in production')
    need(!!c.protocolWallet, 'PROTOCOL_WALLET is required in production')
    need(!!c.burnPrivateKey, 'BURN_PRIVATE_KEY is required in production (10% of every child lands in the burn wallet)')
    need(!!c.adminSecret, 'ADMIN_SECRET is required in production')
    need(!c.offline, 'DEV_OFFLINE must be off in production')
    // the dev seed writes a fake ROOT, fake coins (random pools, "locked" splits) and fake totals into the MONEY stores
    need(!c.devSeed, 'DEV_SEED must be off in production (it writes fake coins and a fake ROOT into the data dir)')
    // A first boot is a deliberate act: an empty data dir in production is far more often a wrong DATA_DIR,
    // and an empty intent journal re-pays people.
    need(exists(join(c.dataDir, 'coins.json')) || exists(join(c.dataDir, 'identity.json')) || env.ENGINE_FRESH === '1',
      `DATA_DIR ${c.dataDir} holds no engine state; if this really is the first boot set ENGINE_FRESH=1 once`)
  }
  return bad
}

/** Loud, non-fatal notes. */
export function configWarnings(c = config) {
  const w = []
  if (c.rpcUrl && /api\.mainnet-beta\.solana\.com/.test(c.rpcUrl)) w.push('RPC_URL is the public RPC: it rate-limits; use a paid one before real money flows')
  if (!c.rootMint) w.push(`ROOT_MINT not set: until $${c.ticker} exists (admin prepare or adopt) coins launch pre-ROOT (attached to it on adopt) and the burn wallet accumulates`)
  if (!c.adminSecret) w.push('ADMIN_SECRET not set: every /admin route answers 401')
  return w
}

/** Money-critical config must be sane BEFORE any loop starts. */
export function assertConfig() {
  for (const w of configWarnings()) console.warn(`[config] WARNING: ${w}`)
  const bad = configProblems()
  if (bad.length) {
    console.error('[config] FATAL — refusing to start with unsafe config:\n  - ' + bad.join('\n  - '))
    process.exit(1)
  }
}
