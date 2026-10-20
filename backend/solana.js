// Solana plumbing: one Connection with timeouts, the engine + burn keypairs, the per-coin keys derived from
// the engine secret, rent read from the chain, a tx serializer per payer, and a confirm-by-polling sender.
import { Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage, ComputeBudgetProgram, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { createHmac } from 'crypto'
import bs58 from 'bs58'
import { config } from './config.js'

export const EXPLORER = 'https://solscan.io'
export const CHAIN_ID = 'solana-mainnet'
export const LAMPORTS = LAMPORTS_PER_SOL
export const SYSTEM_PROGRAM = SystemProgram.programId.toBase58()
export const sol = l => Number(l) / LAMPORTS_PER_SOL
export const toLamports = s => BigInt(Math.round(Number(s) * LAMPORTS_PER_SOL))
export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const sleep = ms => new Promise(r => setTimeout(r, ms))

// Every RPC call must time out: a hung call must never freeze a loop.
const timedFetch = (url, opts = {}) => fetch(url, { ...opts, signal: opts.signal || AbortSignal.timeout(config.rpcTimeoutMs) })

let _conn = null
export function getConnection() {
  if (!_conn) {
    if (!config.rpcUrl) throw new Error('RPC_URL not set')
    _conn = new Connection(config.rpcUrl, { commitment: 'confirmed', fetch: timedFetch, disableRetryOnRateLimit: false })
  }
  return _conn
}
/** Tests inject a fake connection. */
export function setConnection(c) { _conn = c }

/* ---------------- rent (read from the chain at boot; never a hardcoded 890,880) ---------------- */

let _rent0 = null
/** rent-exempt minimum of a 0-byte system account, as read from the chain (650,240 on 2026-09-24). */
export function rent0() {
  if (_rent0 == null) throw new Error('rent(0) not read from the chain yet')
  return _rent0
}
export const rentLoaded = () => _rent0 != null
export function setRent0(v) { _rent0 = BigInt(v) }
export async function loadRent() {
  const v = await getConnection().getMinimumBalanceForRentExemption(0, 'confirmed')
  if (!(Number(v) > 0)) throw new Error('bad rent value')
  _rent0 = BigInt(v)
  return _rent0
}

/* ---------------- keys ---------------- */

export function parseSecret(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  try {
    const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s)
    return Keypair.fromSecretKey(bytes)
  } catch { return null }
}

// parsed once per configured value (a changed value is re-parsed: never a stale key)
let _engine = null, _engineRaw = null
export function getEngine() {
  if (_engineRaw !== config.enginePrivateKey) { _engine = parseSecret(config.enginePrivateKey); _engineRaw = config.enginePrivateKey }
  return _engine
}
export function engineAddress() { const k = getEngine(); return k ? k.publicKey.toBase58() : '' }
let _burn = null, _burnRaw = null
export function getBurnWallet() { if (_burnRaw !== config.burnPrivateKey) { _burn = parseSecret(config.burnPrivateKey); _burnRaw = config.burnPrivateKey } return _burn }
export function burnAddress() { const k = getBurnWallet(); return k ? k.publicKey.toBase58() : '' }
export function protocolAddress() { return config.protocolWallet || '' }

/*
  Two kinds of key, both derived from the engine secret + a MINT (HMAC-SHA512 keyed by the engine secret's
  first 32 bytes, the same derive() our earlier engines use), never stored, recoverable from the engine key + public data alone:

    coin key    'gpump-coin:v1:' + CHILD mint   — the child's pump.fun `creator`. It signs the ONE fee-sharing
                                                  lock of that child (then pump.fun revokes it) and holds nothing after the sweep.
    pack pool   'gpump-pool:v1:' + mint  — the coin's OWN 80% fee-sharing shareholder (GACHAPAD: its fees stock the coin's machine),
    card vault  'gpump-vault:v1:' + mint — that coin's pack USDC + pulled cards (packs.js),
                                                  and the only wallet that parent's holders are paid from.

  ⚠️ These strings are FOREVER. Renaming them orphans every coin key and every pool. They differ from the earlier engines'
  ('coin-key:v1:' / 'pool-key:v1:') and the engine secret is this engine's own, so no key can ever collide with theirs.
*/
export const DERIVE_COIN = 'gpump-coin:v1:'
export const DERIVE_POOL = 'gpump-pool:v1:'
export const DERIVE_VAULT = 'gpump-vault:v1:'
export function derive(label, id, secret) {
  if (!secret) return null
  const seed = createHmac('sha512', Buffer.from(secret.slice(0, 32))).update(`${label}${String(id)}`).digest().subarray(0, 32)
  return Keypair.fromSeed(seed)
}
/** The child's pump.fun creator key (signs its one lock). */
export const coinKeyFor = (childMint, secret = getEngine()?.secretKey) => derive(DERIVE_COIN, childMint, secret)
/** The holder pool OF `parentMint`: receives 40% of every child of that parent, pays that parent's holders. */
export const poolKeyFor = (parentMint, secret = getEngine()?.secretKey) => derive(DERIVE_POOL, parentMint, secret)
/** A coin's card VAULT: holds its pack USDC + pulled cards; signs only checked pack payments and our card transfers. */
export const vaultKeyFor = (mint, secret = getEngine()?.secretKey) => derive(DERIVE_VAULT, mint, secret)

// One transaction at a time PER PAYER: two in-flight txs from the same payer race for the same balance.
const chains = new Map()
export function serializeTx(payer, fn) {
  const k = String(payer)
  const run = (chains.get(k) || Promise.resolve()).then(fn, fn)
  chains.set(k, run.catch(() => {}))
  if (chains.size > 5000) chains.delete(chains.keys().next().value)
  return run
}

export function budgetIxs(units = 300_000) {
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: config.priorityFeeMicroLamports }),
  ]
}
/** Exact fee of a tx built by buildTx: base 5000/signature + the priority fee for `units` (charged on the limit, not usage). */
export const txFeeLamports = (units, signatures = 1) => BigInt(5000 * signatures) + (BigInt(units) * BigInt(config.priorityFeeMicroLamports) + 999_999n) / 1_000_000n

export async function buildTx({ payer, instructions, signers = [], alts = [], units = 300_000 }) {
  const conn = getConnection()
  const { context, value: { blockhash, lastValidBlockHeight } } = await conn.getLatestBlockhashAndContext('confirmed')
  const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: [...budgetIxs(units), ...instructions] }).compileToV0Message(alts)
  const tx = new VersionedTransaction(msg)
  if (signers.length) tx.sign(signers)
  return { tx, blockhash, lastValidBlockHeight, builtSlot: Number(context?.slot ?? 0) || null }
}

/**
 * Simulate; throw with the program's error + last logs if it would fail.
 * `minContextSlot` (the slot the blockhash was read at): a node that has not reached it answers with an RPC ERROR
 * (thrown as such) instead of a misleading `BlockhashNotFound` verdict. `accounts`: return their post-state.
 */
export async function simulate(tx, { replaceRecentBlockhash = false, minContextSlot = null, accounts = null } = {}) {
  const cfg = { sigVerify: false, commitment: 'confirmed', ...(replaceRecentBlockhash ? { replaceRecentBlockhash: true } : {}), ...(minContextSlot ? { minContextSlot: Number(minContextSlot) } : {}), ...(accounts?.length ? { accounts: { addresses: accounts.map(String), encoding: 'base64' } } : {}) }
  const sim = await getConnection().simulateTransaction(tx, cfg)
  if (sim.value.err) {
    const logs = (sim.value.logs || []).slice(-6).join(' | ')
    throw Object.assign(new Error(`would fail on-chain: ${JSON.stringify(sim.value.err)}${logs ? ` — ${logs}` : ''}`), { simErr: sim.value.err, logs: sim.value.logs || [] })
  }
  return sim.value
}

/**
 * Drive a SIGNED tx to a definite state. The SAME bytes are re-broadcast until confirmed; nothing is ever
 * rebuilt here. Resolves one of
 *   { status: 'confirmed', sig }
 *   { status: 'failed', sig, err }      landed and reverted: nothing moved (a tx is atomic)
 *   { status: 'not-landed', sig }       PROVEN: the FINALIZED chain is past the blockhash's last valid height
 *                                       and a full-history lookup does not know the signature
 *   { status: 'ambiguous', sig, reason } anything else after the deadline → never resend
 * `broadcast: false` only settles (journaled intents at boot).
 */
export async function settleTx({ raw, sig, lastValidBlockHeight, builtSlot = null }, { broadcast = true, deadlineMs = 180_000, pollMs = 2000, conn = getConnection() } = {}) {
  const bytes = raw ? (Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'base64')) : null
  const send = () => (bytes ? conn.sendRawTransaction(bytes, { skipPreflight: true, maxRetries: 0 }).catch(() => {}) : Promise.resolve())
  if (broadcast) await send()
  const started = Date.now()
  let lastSend = Date.now(), lastErr = ''
  // A verdict only counts at confirmed/finalized: a status seen at `processed` may sit on a dropped fork.
  const settled = st => st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')
  const lookup = async () => { const r = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true }); return { st: r?.value?.[0] ?? null, slot: Number(r?.context?.slot ?? 0) } }
  // a confirmed verdict carries the slot it landed in (a read "after" the tx then asks for minContextSlot = that slot)
  const verdict = st => (st.err ? { status: 'failed', sig, err: JSON.stringify(st.err) } : { status: 'confirmed', sig, slot: Number(st.slot) || null })
  for (;;) {
    try {
      const { st } = await lookup()
      if (settled(st)) return verdict(st)
      if (!st && lastValidBlockHeight != null) {
        // Expiry needs PROOF, from nodes that are provably up to date:
        //  - the FINALIZED chain is past the blockhash's last valid height
        //  - two history lookups, seconds apart, each answered at a slot AT or PAST that finalized slot
        //  - the node still HOLDS the ledger back to when the tx was built (a pruned node forgets old txs)
        const fin = await conn.getEpochInfo('finalized')
        if (Number(fin.blockHeight) > Number(lastValidBlockHeight)) {
          let proven = true
          for (let i = 0; i < 2 && proven; i++) {
            await sleep(Math.min(4000, pollMs * 2))
            const again = await lookup()
            if (settled(again.st)) return verdict(again.st)
            if (again.st || !(again.slot >= Number(fin.absoluteSlot))) proven = false
          }
          if (proven && builtSlot != null) { const first = Number(await conn.getFirstAvailableBlock()); if (!(first <= Number(builtSlot))) proven = false }
          if (proven) return { status: 'not-landed', sig }
        } else if (broadcast && Date.now() - lastSend > 4000) { lastSend = Date.now(); send() }
      }
    } catch (e) { lastErr = String(e?.message || e).slice(0, 120) }
    if (Date.now() - started >= deadlineMs) break
    await sleep(pollMs)
  }
  return { status: 'ambiguous', sig, reason: `no verdict after ${Math.round(deadlineMs / 1000)}s${lastErr ? ` (last RPC error: ${lastErr})` : ''}` }
}

export const sigOf = tx => bs58.encode(tx.signatures[0])

/**
 * Send a signed tx and confirm it (cranks, locks). `onSig` runs BEFORE the first broadcast (journal there).
 * Resolves { sig, slot } (slot: where it landed, when the RPC said) or throws TX_NOT_LANDED (safe to rebuild) /
 * TX_FAILED / CONFIRM_UNKNOWN (do NOT rebuild).
 */
export async function sendAndConfirm(tx, { lastValidBlockHeight, builtSlot = null }, { onSig, settle = {} } = {}) {
  const sig = sigOf(tx)
  const raw = Buffer.from(tx.serialize())
  if (onSig) await onSig(sig, raw)
  const r = await settleTx({ raw, sig, lastValidBlockHeight, builtSlot }, settle)
  if (r.status === 'confirmed') return { sig, slot: r.slot ?? null }
  if (r.status === 'failed') throw Object.assign(new Error(`TX_FAILED: ${r.err}`), { sig })
  if (r.status === 'not-landed') throw Object.assign(new Error('TX_NOT_LANDED: expired without landing'), { sig })
  throw Object.assign(new Error(`CONFIRM_UNKNOWN: ${sig}`), { sig })
}

// sig → when a caught-up node first proved it absent past its expiry (bounded; a proof is final once made)
const deadProofs = new Map()
const DEAD_PROOF_GAP_MS = 2000
/**
 * The fate of up to 256 signatures in ONE status read (+ at most one finalized-epoch read), for read-only status
 * views: Map(sig → 'landed' | 'failed' | 'dead' | 'pending'). `items` = [{ sig, lastValidBlockHeight }].
 * 'dead' needs PROOF, as settleTx does: the finalized height is past lastValidBlockHeight + 40, the history lookup
 * that did not know the sig was answered at a slot AT or PAST that finalized slot (a lagging node proves nothing:
 * a load-balanced RPC may answer the two reads from different nodes), and that proof was seen again at least
 * DEAD_PROOF_GAP_MS later. Anything short of that is 'pending' — never "dead" for a tx that may have landed.
 */
export async function sigStatuses(items, conn = getConnection()) {
  const out = new Map()
  if (!items.length) return out
  if (items.length > 256) throw new Error('at most 256 signatures per status read')
  const r = await conn.getSignatureStatuses(items.map(i => i.sig), { searchTransactionHistory: true })
  const lookupSlot = Number(r?.context?.slot ?? 0)
  let fin = null
  for (let i = 0; i < items.length; i++) {
    const { sig, lastValidBlockHeight } = items[i]
    const st = r?.value?.[i] ?? null
    if (st) {
      deadProofs.delete(sig)
      out.set(sig, st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized' ? (st.err ? 'failed' : 'landed') : 'pending')
      continue
    }
    if (!lastValidBlockHeight) { out.set(sig, 'pending'); continue }
    fin ||= await conn.getEpochInfo('finalized')
    const proof = Number(fin.blockHeight) > Number(lastValidBlockHeight) + 40 && lookupSlot >= Number(fin.absoluteSlot)
    if (!proof) { out.set(sig, 'pending'); continue }
    const first = deadProofs.get(sig)
    if (first == null) {
      deadProofs.set(sig, Date.now())
      if (deadProofs.size > 20_000) deadProofs.delete(deadProofs.keys().next().value)
      out.set(sig, 'pending')
    } else out.set(sig, Date.now() - first >= DEAD_PROOF_GAP_MS ? 'dead' : 'pending')
  }
  return out
}
/** One signature's fate (see sigStatuses): 'landed' | 'failed' | 'dead' | 'pending'. */
export async function sigStatus(sig, lastValidBlockHeight = null, conn = getConnection()) {
  return (await sigStatuses([{ sig, lastValidBlockHeight }], conn)).get(sig)
}

export async function accountExists(pubkey) {
  return !!(await getConnection().getAccountInfo(new PublicKey(pubkey), 'confirmed'))
}
// `minContextSlot`: a node that has not reached that slot answers with an RPC ERROR, never with an older state — the
// way to read "after" a known slot (a finalized height proof, a tx that just landed) through a load-balanced RPC
const readCfg = minContextSlot => (minContextSlot ? { commitment: 'confirmed', minContextSlot: Number(minContextSlot) } : 'confirmed')
export async function balanceOf(pubkey, { minContextSlot = null } = {}) {
  return BigInt(await getConnection().getBalance(new PublicKey(pubkey), readCfg(minContextSlot)))
}

/** Batched getMultipleAccountsInfo (100 per call). Returns infos aligned with `keys`. */
export async function accountInfos(keys, { minContextSlot = null } = {}) {
  const conn = getConnection(), out = []
  for (let i = 0; i < keys.length; i += 100) out.push(...await conn.getMultipleAccountsInfo(keys.slice(i, i + 100).map(k => (k instanceof PublicKey ? k : new PublicKey(k))), readCfg(minContextSlot)))
  return out
}

/** Lamport balances of many accounts in batches. Map(address → BigInt); a missing account is 0n. */
export async function balancesOf(addresses) {
  const out = new Map()
  const infos = await accountInfos(addresses)
  addresses.forEach((a, i) => out.set(String(a), BigInt(infos[i]?.lamports || 0)))
  return out
}

/**
 * What kind of address is this, for a SOL payout?  Map(address → { kind, lamports, executable }):
 *   'wallet'   a plain system account, or one that does not exist yet (lamports 0) → payable
 *   'program'  owned by another program, executable, or carrying data → never payable
 *   null       read failed → unknown: the round waits
 */
export async function walletKinds(addresses) {
  const out = new Map()
  let infos
  try { infos = await accountInfos(addresses) } catch { for (const a of addresses) out.set(a, { kind: null, lamports: 0n, executable: false }); return out }
  addresses.forEach((a, i) => {
    const info = infos[i]
    if (!info) out.set(a, { kind: 'wallet', lamports: 0n, executable: false })
    else if (info.owner.toBase58() === SYSTEM_PROGRAM && !info.executable && info.data.length === 0) out.set(a, { kind: 'wallet', lamports: BigInt(info.lamports), executable: false })
    else out.set(a, { kind: 'program', lamports: BigInt(info.lamports), executable: !!info.executable })
  })
  return out
}

/** Which token program owns this mint (pump.fun create_v2 coins are Token-2022). */
export async function tokenProgramOf(mint) {
  const info = await getConnection().getAccountInfo(new PublicKey(mint), 'confirmed')
  if (!info) throw new Error('unknown mint')
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
}

/**
 * Native lamport deltas for several owners in ONE confirmed tx (the fee is added back for the fee payer).
 * Map(owner → BigInt; 0n when the owner is not in the tx) or null when the tx is not readable yet.
 */
export async function readLamportDeltas(sig, owners, { tries = 10, waitMs = 1500 } = {}) {
  const conn = getConnection()
  for (let i = 0; i < tries; i++) {
    const info = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' }).catch(() => null)
    if (info?.meta) return lamportDeltasOf(info, owners)
    if (i < tries - 1) await sleep(waitMs)
  }
  return null
}
/** Native lamport deltas of `owners` in one fetched tx (getTransaction shape; the fee is added back for the fee payer). Pure. */
export function lamportDeltasOf(info, owners) {
  const keys = info.transaction.message.getAccountKeys({ accountKeysFromLookups: info.meta.loadedAddresses })
  const all = []
  for (let k = 0; k < keys.length; k++) all.push(keys.get(k).toBase58())
  const out = new Map()
  for (const owner of owners) {
    const idx = all.indexOf(String(owner))
    if (idx < 0) { out.set(String(owner), 0n); continue }
    let d = BigInt(info.meta.postBalances[idx]) - BigInt(info.meta.preBalances[idx])
    if (idx === 0) d += BigInt(info.meta.fee || 0)
    out.set(String(owner), d)
  }
  return out
}
export async function readLamportDelta(sig, owner) { const m = await readLamportDeltas(sig, [owner]); return m ? m.get(String(owner)) : null }

export const pk = s => (s instanceof PublicKey ? s : new PublicKey(s))
export const short = a => (a ? `${String(a).slice(0, 4)}…${String(a).slice(-4)}` : '')
/** A 32-byte base58 public key. */
export const isPubkey = s => { try { return BASE58_RE.test(String(s)) && bs58.decode(String(s)).length === 32 } catch { return false } }
/** …that is also ON the ed25519 curve: a real wallet, never a PDA (token account, vault, config, pool). */
export const isWalletKey = s => { try { return isPubkey(s) && PublicKey.isOnCurve(new PublicKey(s).toBytes()) } catch { return false } }
export const transferIx = (from, to, lamports) => SystemProgram.transfer({ fromPubkey: pk(from), toPubkey: pk(to), lamports: BigInt(lamports) })
