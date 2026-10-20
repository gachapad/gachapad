// ============================================================================
// BRAND — this file and backend/config.js are the ONLY two places brand strings
// live (plus the tagged lines in index.html, which cannot import).
// ============================================================================

const env = import.meta.env || {}

export const MOCK = env.VITE_MOCK === '1' || env.VITE_MOCK === 'true'

export const BRAND = {
  name: 'Gachapad',
  ticker: 'GACHA',                                     // the platform coin (shown as $GACHA)
  handle: env.VITE_X_HANDLE || '',                     // X handle incl. '@' — empty until the account is live (hides every X link)
  siteUrl: env.VITE_SITE_URL || 'https://www.gachapad.tech',
  siteHost: 'gachapad.tech',
  xUrl: env.VITE_X_URL || '',
  githubUrl: 'https://github.com/gachapad/gachapad',     // the open-source engine + site
  tagline: 'Every coin gets a gacha machine.',
  sub: 'Its fees rip real graded cards from pump.fun packs into its own machine. Burn the coin to pull one.',
}

/** The canonical one-paragraph explanation. */
export const INTRO_LEDE = `${BRAND.name} is a launchpad for pump.fun coins where every coin gets its own gacha machine. The coin's creator fees buy real graded-card packs (the same Collector Crypt machines pump.fun now sells), and every card that comes out stays inside that coin's machine. The only way to take a card out is to burn the coin.`

export const INTRO_SECOND = `Every coin launched on ${BRAND.name} is a standard pump.fun coin: it trades on pump.fun's bonding curve, graduates to PumpSwap and shows up in every wallet and terminal. 80% of its creator fees stock its machine and 20% buys and burns $${BRAND.ticker}. The split is locked on pump.fun at launch.`

// Engine. Dev: .env.development → local engine. Mock: '' (never fetched).
export const API_URL = MOCK
  ? ''
  : String(env.VITE_API_URL ?? (env.DEV ? 'http://localhost:3071' : '/api')).replace(/\/$/, '')

export const EXPLORER = 'https://solscan.io'

// The mechanic (the engine's /stats and /launch-meta are the source of truth at runtime).
export const SPLIT = { creator: 0, parentHolders: 80, burn: 20, protocol: 0 } // parentHolders = the coin's OWN machine
export const ROOT_SPLIT = { burn: 0, protocol: 100 }   // $GACHA's own creator fees go to the team
export const PULL_MARGIN_PCT = 10                       // a pull costs the machine's average card value + 10%
export const MAX_DEPTH = 1                              // every coin sits directly under $GACHA
export const SETUP_SOL = 0.0105                         // fallback only; /launch-meta.setupSol wins
export const DECIMALS = { SOL: 9, COIN: 6 }
export const MIN_HOLD = 0
export const MAX_WALLET_PCT = 100
export const ROUND_MIN = 5

/** pump.fun facts shown as copy (pump.fun can change them). */
export const PUMP = {
  gradSol: 85,
  curveCreatorFee: '0.30%',
  bigPoolCreatorFee: '0.95%',
  program: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  feesProgram: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  swapProgram: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
}

export const PUMP_URL = m => `https://pump.fun/coin/${m}`

export const SOLSCAN = {
  tx: s => `${EXPLORER}/tx/${s}`,
  account: a => `${EXPLORER}/account/${a}`,
  token: m => `${EXPLORER}/token/${m}`,
}

export const pctOf = bps => Number(bps || 0) / 100
export const splitOf = stats => {
  const s = stats?.engine?.split
  return s ? { creator: pctOf(s.creator), parentHolders: pctOf(s.parentHolders), burn: pctOf(s.burn), protocol: pctOf(s.protocol) } : SPLIT
}
export const rootSplitOf = stats => {
  const s = stats?.engine?.rootSplit
  return s && (s.burn || s.protocol) ? { burn: pctOf(s.burn), protocol: pctOf(s.protocol) } : ROOT_SPLIT
}
export const maxDepthOf = (stats, meta) => Number(meta?.maxDepth || stats?.engine?.maxDepth || MAX_DEPTH)
