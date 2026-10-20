// SOL/USD for the USD figures on the site: Coinbase spot, CoinGecko fallback, cached 60 s, negative-cached
// 60 s, one in-flight fetch shared by concurrent callers. Plus Dexscreener market stats (24 h / 1 h volume and
// trades) for pump coins on the curve and on PumpSwap, batched 30 mints per call and cached 2 min.
let cache = { usd: 0, at: 0 }
let lastAttempt = 0
let inflight = null
const T = ms => AbortSignal.timeout(ms)

async function fetchPrice() {
  try {
    const r = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot', { signal: T(5000) })
    const v = Number((await r.json())?.data?.amount)
    if (v > 0) return v
  } catch {}
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { signal: T(5000) })
    const v = Number((await r.json())?.solana?.usd)
    if (v > 0) return v
  } catch {}
  return 0
}

export async function solUsd() {
  if (cache.usd > 0 && Date.now() - cache.at < 60_000) return cache.usd
  if (inflight) return inflight
  if (Date.now() - lastAttempt < 60_000) return cache.usd || 0
  lastAttempt = Date.now()
  inflight = fetchPrice()
    .then(v => { if (v > 0) cache = { usd: v, at: Date.now() }; return cache.usd || 0 })
    .catch(() => cache.usd || 0)
    .finally(() => { inflight = null })
  return inflight
}
export const solUsdCached = () => cache.usd || 0
export const solUsdAgeMs = () => (cache.at ? Date.now() - cache.at : Infinity)
/** Dev seed / tests: pin a price without the network. */
export const setSolUsd = v => { cache = { usd: Number(v) || 0, at: Date.now() } }

// Dexscreener stats per mint (the deepest SOL pair: pump.fun curve or PumpSwap). A miss keeps the last value.
const dex = new Map()
export async function dexStatsMany(mints) {
  const want = mints.filter(m => { const h = dex.get(m); return !h || Date.now() - h.at > 120_000 })
  for (let i = 0; i < want.length; i += 30) {
    const chunk = want.slice(i, i + 30)
    let pairs = []
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(',')}`, { signal: T(8000) })
      pairs = ((await r.json())?.pairs || []).filter(p => p?.chainId === 'solana')
    } catch {}
    for (const m of chunk) {
      const mine = pairs.filter(p => p?.baseToken?.address === m).sort((a, b) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0))
      const agg = mine.length ? {
        vol24hUsd: mine.reduce((s, p) => s + (Number(p.volume?.h24) || 0), 0),
        vol1hUsd: mine.reduce((s, p) => s + (Number(p.volume?.h1) || 0), 0),
        trades24h: mine.reduce((s, p) => s + (Number(p.txns?.h24?.buys) || 0) + (Number(p.txns?.h24?.sells) || 0), 0),
        priceNative: Number(mine[0].priceNative) || 0,
      } : null
      dex.set(m, { v: agg ?? dex.get(m)?.v ?? null, at: Date.now() })
    }
  }
  if (dex.size > 5000) for (const k of [...dex.keys()].slice(0, dex.size - 5000)) dex.delete(k)
  return new Map(mints.map(m => [m, dex.get(m)?.v ?? null]))
}
export const dexStatsCached = m => dex.get(m)?.v ?? null
