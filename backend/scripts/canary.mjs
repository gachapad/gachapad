// The canary, by hand: SIMULATES (throwaway keys, sigVerify off, the pump ALT) create_v2 + the coin-key funding +
// createFeeSharingConfig + updateFeeShares(4 shareholders that do not exist) in ONE tx — the exact shapes the
// engine depends on. The engine runs the same check at boot and hourly; a failing canary pauses launches.
// Usage: node scripts/canary.mjs [funded-payer]
import { dryEnv } from './_env.mjs'

await dryEnv(process.argv[2] ? { CANARY_PAYER: process.argv[2] } : {})
const { simulateCanary, runCanary } = await import('../canary.js')
const { launchBlocker } = await import('../launch.js')
const { loadRent } = await import('../solana.js')
const { loadAllStores } = await import('../store.js')
loadAllStores()
await loadRent()
const r = await simulateCanary()
console.log(`canary tx: ${r.bytes} / 1232 bytes · ${r.unitsConsumed} CU · ${r.ok ? 'SIMULATED OK' : 'FAILED ' + JSON.stringify(r.err)}`)
if (!r.ok) console.log(r.logs.join('\n'))
const status = await runCanary()
console.log(`canary status → ${status.status} (${status.detail})`)
console.log(`launch blocker with this canary (LAUNCH_ENABLED off in a dry run): ${launchBlocker()}`)
console.log(r.ok && status.status === 'ok' ? '\nCANARY OK — nothing was sent.' : '\nCANARY FAILING — launches would be paused.')
process.exit(r.ok && status.status === 'ok' ? 0 : 1)
