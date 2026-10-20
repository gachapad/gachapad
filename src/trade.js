// Trading: quote → engine builds the swap tx → wallet signs → engine relays → poll status. No custody anywhere.
// There is nothing to claim here: pump.fun's fee sharing pays the launcher directly.
import bs58 from 'bs58'
import { api, post } from './api'
import { signTx } from './wallet'
import { DECIMALS } from './config'

const friendly = (message, extra) => Object.assign(new Error(message), { shortMessage: message }, extra)

/** The signature of a signed base64 v0 tx: its first signature (after the 1-byte count) — what the chain calls it. */
export function sigOfSigned(b64) {
  const b = Uint8Array.from(atob(String(b64 || '')), ch => ch.charCodeAt(0))
  return b.length >= 65 && b[0] >= 1 ? bs58.encode(b.subarray(1, 65)) : null
}

export const decimalsOf = token => (token === 'SOL' ? DECIMALS.SOL : DECIMALS.COIN)

/** Human name of a /quote route. */
export const routeLabel = r => ({ curve: 'pump.fun curve', amm: 'PumpSwap', jupiter: 'Jupiter' }[r] || r || 'pump.fun')

/** '0.25' → raw integer string for `token` (SOL 9 dp, coins 6 dp); null when not an amount. Accepts ',' as the point. */
export function toRaw(str, token) {
  const dp = decimalsOf(token)
  const m = new RegExp(`^(\\d*)(?:[.,](\\d{0,${dp}})\\d*)?$`).exec(String(str ?? '').trim())
  if (!m || (!m[1] && !m[2])) return null
  const whole = BigInt(m[1] || '0'), frac = BigInt(((m[2] || '') + '0'.repeat(dp)).slice(0, dp))
  const v = whole * 10n ** BigInt(dp) + frac
  return v > 0n ? v.toString() : null
}
/** raw integer string → number of UI units. */
export function fromRaw(raw, token) {
  try { return Number(BigInt(raw)) / 10 ** decimalsOf(token) } catch { return 0 }
}

export async function getQuote({ input, output, amount, slippageBps = 100, signal }) {
  const qs = new URLSearchParams({ input, output, amount: String(amount), slippageBps: String(slippageBps) })
  return api(`/quote?${qs}`, { fresh: true, signal, timeout: 15_000 })
}

/** Poll GET /tx/status/:sig until landed / failed / dead (≤ timeoutMs). A timeout says "still pending", never "failed". */
export async function waitTx(sig, { timeoutMs = 120_000, everyMs = 1_500, onStatus } = {}) {
  const until = Date.now() + timeoutMs
  let last = 'pending'
  while (Date.now() < until) {
    try {
      const s = await api(`/tx/status/${encodeURIComponent(sig)}`, { fresh: true })
      last = s.status || 'pending'
      onStatus?.(last)
      if (last === 'landed') return { sig, status: 'landed' }
      if (last === 'failed') throw friendly('The transaction failed on-chain. Nothing moved.', { sig, status: 'failed' })
      if (last === 'dead') throw friendly('The transaction expired before it landed. Nothing moved; try again.', { sig, status: 'dead' })
    } catch (e) { if (e.status === 'failed' || e.status === 'dead') throw e }
    await new Promise(r => setTimeout(r, everyMs))
  }
  return { sig, status: 'pending' }
}

/**
 * The whole swap. onStage gets 'building' | 'signing' | 'sending' | 'confirming'.
 * Resolves { sig, status: 'landed' | 'pending', route }.
 */
export async function swap({ wallet, input, output, amount, slippageBps = 100, onStage }) {
  onStage?.('building')
  const built = await post('/tx/swap', { wallet, input, output, amount: String(amount), slippageBps })
  if (!built?.tx) throw friendly('The engine did not return a transaction. Nothing was signed.')
  onStage?.('signing')
  const signedTx = await signTx(built.tx, wallet, { label: 'swap' })
  onStage?.('sending')
  // 200 { sig } or 202 { sig, status: 'unknown' } (the RPC may have forwarded it): either way poll the signature.
  // No answer at all (network / timeout): the engine may have relayed it too — poll the signature we signed, never
  // invite a second, different tx (both could land). Only an engine ERROR (e.g. 502 send failed) means nothing was sent.
  let sent
  try { sent = await post('/tx/send', { signedTx }) } catch (e) {
    const sig = e?.network ? sigOfSigned(signedTx) : null
    if (!sig) throw e
    sent = { sig, status: 'unknown' }
  }
  if (!sent?.sig) throw friendly('The engine did not return a signature.')
  onStage?.('confirming')
  const r = await waitTx(sent.sig)
  return { ...r, route: built.route, quote: built.quote }
}
