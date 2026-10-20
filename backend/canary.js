// The canary: pump.fun's programs are upgradeable (the pump program was redeployed on 2026-09-23). At boot and
// hourly (every 5 min while not 'ok') the engine SIMULATES, with throwaway keys, the exact shape it depends on:
// create_v2 under a derived-style creator + the funding transfer + createFeeSharingConfig + updateFeeShares with 4
// shareholders that do not exist yet — one simulated tx (sigVerify off, replaceRecentBlockhash, the pump ALT).
// Nothing is signed or sent. A PROGRAM error sets the launch blocker ("pump changed, launches paused"); an RPC error
// or a payer that cannot fund the simulated create only leaves it 'unknown' (a payer problem is not "pump changed").
import { Keypair, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { config } from './config.js'
import { getConnection, budgetIxs, transferIx, toLamports, balanceOf, sol, pk } from './solana.js'
import { createIxs, sharingIxs, loadAlts } from './pump.js'
import { setCanary, canaryStatus } from './launch.js'

// what the simulated create + funding costs the payer: SETUP_SOL + create_v2's rents and fees (≈ 5.3M lamports measured)
const CREATE_COST_LAMPORTS = 6_500_000n

/** Build + simulate the canary tx. Returns { ok, err, logs, bytes, unitsConsumed }. Never sends. */
export async function simulateCanary({ payer = config.canaryPayer } = {}) {
  const conn = getConnection()
  const mint = Keypair.generate(), coinKey = Keypair.generate()
  const holders = [0, 1, 2, 3].map(() => Keypair.generate().publicKey.toBase58())
  const shares = [4000, 4000, 1000, 1000].map((bps, i) => ({ address: holders[i], shareBps: bps }))
  const { ixs } = await createIxs({ mint: mint.publicKey, name: 'Canary', symbol: 'CNRY', uri: 'https://x.co/c', creator: coinKey.publicKey, user: pk(payer), devBuyLamports: 0n })
  const lock = await sharingIxs({ creator: coinKey.publicKey, mint: mint.publicKey, graduated: false, shareholders: shares })
  const alts = await loadAlts()
  const { blockhash } = await conn.getLatestBlockhash('confirmed')
  const msg = new TransactionMessage({ payerKey: pk(payer), recentBlockhash: blockhash, instructions: [...budgetIxs(500_000), ...ixs, transferIx(payer, coinKey.publicKey, toLamports(config.setupSol)), ...lock] }).compileToV0Message(alts)
  const tx = new VersionedTransaction(msg)
  const bytes = tx.serialize().length
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed' })
  return { ok: !r.value.err, err: r.value.err || null, logs: (r.value.logs || []).slice(-8), bytes, unitsConsumed: r.value.unitsConsumed ?? null }
}

/**
 * The verdict of one canary simulation. An error the PAYER causes (it cannot fund the create: InsufficientFundsForRent
 * on account 0, the system transfer's "insufficient lamports" Custom:1, AccountNotFound / InsufficientFundsForFee) or
 * the RPC causes (BlockhashNotFound) is 'unknown' — never "pump changed" — except that a 'failing' verdict stays
 * until a simulation succeeds. Any other error is 'failing'. Pure.
 */
export function canaryVerdict(r, prev = 'unknown') {
  if (r.ok) return { status: 'ok', detail: `create + lock simulated OK (${r.unitsConsumed} CU, ${r.bytes} bytes)` }
  const text = JSON.stringify(r.err)
  const logs = (r.logs || []).join(' | ')
  const rentOnPayer = Number(r.err?.InsufficientFundsForRent?.account_index) === 0 && r.err?.InsufficientFundsForRent != null
  const payerShort = Array.isArray(r.err?.InstructionError) && r.err.InstructionError[1]?.Custom === 1 && /insufficient lamports/i.test(logs)
  if (rentOnPayer || payerShort || /AccountNotFound|InsufficientFundsForFee|BlockhashNotFound/.test(text)) {
    return { status: prev === 'failing' ? 'failing' : 'unknown', detail: `canary payer / RPC problem, not a pump change (fund CANARY_PAYER or point it at a funded wallet): ${text}` }
  }
  return { status: 'failing', detail: `${text} ${logs.slice(0, 400)}` }
}

/** Run the canary and record its verdict for launchBlocker. */
export async function runCanary() {
  if (config.offline || !config.rpcUrl) return canaryStatus()
  const prev = canaryStatus().status
  try {
    // a payer that cannot fund the simulated create would fail it for a reason that is not pump's
    const need = toLamports(config.setupSol) + CREATE_COST_LAMPORTS
    const bal = await balanceOf(config.canaryPayer)
    if (bal < need) {
      setCanary({ status: prev === 'failing' ? 'failing' : 'unknown', detail: `canary payer ${config.canaryPayer} holds ${sol(bal).toFixed(4)} SOL, needs ≥ ${sol(need).toFixed(4)} to simulate a create: top it up or set CANARY_PAYER to a funded wallet` })
      return canaryStatus()
    }
    const v = canaryVerdict(await simulateCanary(), prev)
    setCanary(v)
    if (v.status === 'failing') console.error(`[canary] FAILING — launches paused: ${v.detail.slice(0, 300)}`)
  } catch (e) { setCanary({ status: prev === 'failing' ? 'failing' : 'unknown', detail: `rpc: ${String(e.message).slice(0, 160)}` }) }
  return canaryStatus()
}
