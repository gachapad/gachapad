// pump.fun's packs: its public read of every Collector Crypt machine's stock (GET frontend-api-v3.pump.fun/gacha-inventory).
// Display only — the engine buys from Collector Crypt directly (cc.js) and never trusts this for money.
import { config } from './config.js'

let cache = { at: 0, map: new Map() }
/** Map pack_type → { level: healthy|low|empty, stock: { common, uncommon, rare, epic }, lowThreshold }. Cached 60 s. */
export async function pumpGacha() {
  if (Date.now() - cache.at < 60_000 && cache.map.size) return cache.map
  const r = await fetch(config.pumpGachaUrl, { signal: AbortSignal.timeout(10_000), headers: { Accept: 'application/json' } })
  if (!r.ok) throw new Error(`pump.fun gacha inventory: HTTP ${r.status}`)
  const j = await r.json()
  const map = new Map()
  for (const m of Array.isArray(j?.machines) ? j.machines : []) {
    if (!m?.pack_type) continue
    map.set(String(m.pack_type), { level: ['healthy', 'low', 'empty'].includes(m.level) ? m.level : null, stock: m.stock || null, lowThreshold: m.low_threshold ?? null })
  }
  cache = { at: Date.now(), map }
  return map
}
