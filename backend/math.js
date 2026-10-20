// Pure money + rule logic, free of chain and server state so every branch is unit-tested.
// BigInt everywhere lamports or raw token amounts are involved: sums must be exact to the unit.
import { PublicKey, VersionedMessage } from '@solana/web3.js'
import bs58 from 'bs58'

const BPS = 10_000n
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
const isPubkey = s => { try { return BASE58_RE.test(String(s)) && bs58.decode(String(s)).length === 32 } catch { return false } }
const isWalletKey = s => { try { return isPubkey(s) && PublicKey.isOnCurve(new PublicKey(s).toBytes()) } catch { return false } }

/* ---------------- never-pay keys ---------------- */

// Programs + the runtime's reserved keys. Several reserved keys are ON-curve and look like empty wallets, but the
// runtime demotes them to read-only, so a transfer to them fails (and would fail its whole batch).
export const PROGRAMS = [
  '11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'So11111111111111111111111111111111111111112', 'ComputeBudget111111111111111111111111111111', '1nc1nerator11111111111111111111111111111111',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  'NativeLoader1111111111111111111111111111111', 'BPFLoader1111111111111111111111111111111111', 'BPFLoader2111111111111111111111111111111111', 'BPFLoaderUpgradeab1e11111111111111111111111',
  'LoaderV411111111111111111111111111111111111', 'Config1111111111111111111111111111111111111', 'Stake11111111111111111111111111111111111111', 'StakeConfig11111111111111111111111111111111',
  'Vote111111111111111111111111111111111111111', 'Feature111111111111111111111111111111111111', 'AddressLookupTab1e1111111111111111111111111', 'Ed25519SigVerify111111111111111111111111111',
  'KeccakSecp256k11111111111111111111111111111', 'Secp256r1SigVerify1111111111111111111111111', 'ZkTokenProof1111111111111111111111111111111', 'ZkE1Gama1Proof11111111111111111111111111111',
  'Sysvar1111111111111111111111111111111111111', 'SysvarC1ock11111111111111111111111111111111', 'SysvarEpochSchedu1e111111111111111111111111', 'SysvarFees111111111111111111111111111111111',
  'Sysvar1nstructions1111111111111111111111111', 'SysvarRecentB1ockHashes11111111111111111111', 'SysvarRent111111111111111111111111111111111', 'SysvarRewards111111111111111111111111111111',
  'SysvarS1otHashes111111111111111111111111111', 'SysvarS1otHistory11111111111111111111111111', 'SysvarStakeHistory1111111111111111111111111', 'SysvarEpochRewards1111111111111111111111111',
  'SysvarLastRestartS1ot1111111111111111111111', 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s', 'JUP6LqRVnohqEJRZz3yeqsJiVgfuKP6EDQ6Q97vpqS6',
  'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95',
]
const PROGRAM_SET = new Set(PROGRAMS)
/** Reserved / program / off-curve: never a payee. Vanity program ids end in a run of '1's; no real wallet does. Pure. */
export function isReservedKey(addr) {
  const a = String(addr || '')
  if (PROGRAM_SET.has(a) || /^Sysvar/.test(a) || /1{8,}$/.test(a)) return true
  return !isWalletKey(a)
}

/* ---------------- fee-sharing shareholders (FIXED) ---------------- */

export const ROLES = ['creator', 'parentHolders', 'burn', 'protocol']

/**
 * The fee-sharing shareholders of a child coin: [launcher 4000, parent's holder pool 4000, burn 1000, protocol 1000].
 * Duplicates merge (pump.fun refuses duplicates), zero shares are omitted, the sum is asserted to be exactly 10000.
 * The launcher must be an on-curve wallet that is none of the infra keys (an executable or derived key could block
 * or capture the split forever). Returns [{ address, shareBps, role }] in pump's stored order.
 */
export function shareholdersFor({ launcher, parentPool, burn, protocol, split = { creator: 4000, parentHolders: 4000, burn: 1000, protocol: 1000 }, infra = new Set() }) {
  if (!isWalletKey(launcher)) throw new Error('the launcher must be an on-curve wallet')
  if (infra.has(launcher)) throw new Error('the launcher cannot be an engine, pool, coin or protocol key')
  if (!protocol) throw new Error('no protocol wallet')
  if (!parentPool) throw new Error('no parent holder pool')
  // never fold a missing burn wallet into protocol: the split is locked FOREVER, so it is not planned at all until the
  // burn wallet exists (registration retries; the old fold locked a burn-less split once the key came back)
  if (split.burn > 0 && !burn) throw new Error('no burn wallet (BURN_PRIVATE_KEY): the split cannot be planned without it')
  return mergeShares([[launcher, split.creator, 'creator'], [parentPool, split.parentHolders, 'parentHolders'], [burn, split.burn, 'burn'], [protocol, split.protocol, 'protocol']])
}

/**
 * Key mix-ups that would write a wrong address into a PERMANENT fee lock (or hand the gas float to the burner):
 * burn = engine, burn = protocol, protocol = engine. Returns human-readable problems ([] = fine). Pure.
 */
export function keyConflicts({ engine, burn, protocol }) {
  const out = []
  if (burn && engine && burn === engine) out.push('BURN_PRIVATE_KEY is the engine key: the burn wallet must be its own wallet (every lock would name the engine as the 10% burn shareholder forever, and the burner would spend the engine gas float)')
  if (burn && protocol && burn === protocol) out.push('PROTOCOL_WALLET is the burn wallet: every lock would merge the protocol 10% into the burn share forever')
  if (protocol && engine && protocol === engine) out.push('PROTOCOL_WALLET must not be the engine wallet')
  return out
}

/** ROOT's own lock (admin launch): ROOT_SHARES roles → addresses. Pure. */
export function rootShareholdersFor(rootShares, { burn, protocol, holders, creator }) {
  if (rootShares.some(s => s.role === 'burn' && s.bps > 0) && !burn) throw new Error('no burn wallet (BURN_PRIVATE_KEY): ROOT\'s split cannot be planned without it')
  const addr = { burn, protocol, holders, creator }
  return mergeShares(rootShares.map(s => [addr[s.role], s.bps, s.role === 'holders' ? 'parentHolders' : s.role]))
}

export function mergeShares(parts) {
  const merged = new Map()
  for (const [a, bps, role] of parts) {
    if (!(bps > 0)) continue
    if (!a) throw new Error('missing shareholder address')
    const cur = merged.get(a)
    merged.set(a, cur ? { ...cur, shareBps: cur.shareBps + bps } : { address: a, shareBps: bps, role })
  }
  const out = [...merged.values()]
  const sum = out.reduce((s, x) => s + x.shareBps, 0)
  if (sum !== 10_000) throw new Error(`shares sum to ${sum}`)
  if (out.length > 10) throw new Error('pump.fun allows at most 10 shareholders')
  return out
}

/** Split `lamports` by shareholders' bps. Exact: parts sum to the input; rounding dust goes to the first. Pure. */
export function splitByShares(lamports, shareholders) {
  const l = BigInt(lamports)
  const parts = shareholders.map(s => ({ address: s.address, role: s.role, lamports: (l * BigInt(s.shareBps)) / BPS }))
  const dust = l - parts.reduce((a, p) => a + p.lamports, 0n)
  if (parts.length) parts[0].lamports += dust
  return parts
}

/**
 * The sweep of a coin key after its lock: `pot` split by the shares. A part owed to an account that does not
 * exist yet and is below rent(0) would make the whole transfer fail ("insufficient funds for rent"), so it is
 * FOLDED into the part of `foldRole` (the parent pool, seeded in the lock tx), or the first part whose account
 * exists. Zero parts are dropped. Returns [{ address, role, lamports }]; Σ lamports === pot, or [] when nothing
 * can be paid (every recipient missing and every part sub-rent). Pure.
 */
export function sweepParts(pot, shareholders, lamportsOf, rent0, foldRole = 'parentHolders') {
  const total = BigInt(pot)
  if (total <= 0n) return []
  const parts = splitByShares(total, shareholders)
  const exists = a => (lamportsOf.get(a) ?? 0n) > 0n
  const target = parts.find(p => p.role === foldRole && exists(p.address)) || parts.find(p => exists(p.address))
  const out = []
  let folded = 0n
  for (const p of parts) {
    if (p.lamports <= 0n) continue
    if (!exists(p.address) && p.lamports < BigInt(rent0)) { folded += p.lamports; continue }
    out.push({ ...p })
  }
  if (folded > 0n) {
    if (!target) {
      // nobody exists: the folded dust can only go to a part big enough to open its own account
      const big = out[0]
      if (!big) return []
      big.lamports += folded
    } else {
      const t = out.find(p => p.address === target.address)
      if (t) t.lamports += folded
      else out.push({ address: target.address, role: target.role, lamports: folded })
    }
  }
  const sum = out.reduce((a, p) => a + p.lamports, 0n)
  if (sum !== total) throw new Error('sweep split is not exact')
  return out
}

/**
 * How much the lock tx may seed the parent's holder pool with: the configured POOL_SEED_SOL (`want`), but never more
 * than the coin key can pay beyond the lock's own costs (the sharing config's rent + the tx fee) while keeping
 * rent(0) (a fee payer must end rent-exempt) — the key was funded at PREPARE time, under the config of that moment.
 * A seed that could not make a missing pool rent-exempt is skipped (0n): the distribute minimum then just waits for
 * the vault. Pure; lamports (BigInt).
 */
export function lockSeedLamports({ want, keyLamports, poolLamports, configRent, lockFee, rent0 }) {
  const afford = BigInt(keyLamports) - BigInt(configRent) - BigInt(lockFee) - BigInt(rent0)
  let seed = BigInt(want) < afford ? BigInt(want) : afford
  const pool = BigInt(poolLamports)
  const min = pool > 0n ? 1n : BigInt(rent0) // a transfer that creates an account must make it rent-exempt
  if (seed < min) seed = 0n
  return seed
}

/**
 * The smallest round budget that can pay ANYONE: every share is capped at budget × maxShareBps / 10000 and must reach
 * minPayout, so below ceil(minPayout × 10000 / maxShareBps) no holder can ever be paid, whoever holds. Pure.
 */
export function payableFloor(minPayout, maxShareBps) {
  const bps = BigInt(maxShareBps)
  return (BigInt(minPayout) * BPS + bps - 1n) / bps
}

/* ---------------- the distribute crank ---------------- */

/**
 * pump.fun's minimum creator-vault balance for `distributeCreatorFees` to actually pay (measured on mainnet,
 * agent4 critic2/3): with every shareholder funded it is rent(0); a shareholder with 0 lamports makes the crank a
 * silent NO-OP until the vault holds rent(0) + ceil(rent(0) × 10000 / bps) of the SMALLEST unfunded share (pump then
 * creates that account and pays it). Returns that minimum vault balance (BigInt lamports). Pure.
 */
export function distributeMinimum(shareholders, lamportsOf, rent0) {
  const r = BigInt(rent0)
  let need = r
  for (const s of shareholders) {
    if ((lamportsOf.get(s.address) ?? 0n) > 0n) continue
    const extra = (r * BPS + BigInt(s.shareBps) - 1n) / BigInt(s.shareBps)
    if (r + extra > need) need = r + extra
  }
  return need
}

/**
 * Should the crank run for this coin? `vaultLamports` = the creator vault's balance (+ AMM WSOL for graduated).
 * Crank only when the vault holds ≥ max(rent(0) + COLLECT_MIN, pump's unfunded-shareholder minimum) and no
 * shareholder is executable (6052: pump refuses forever). Pure.
 */
export function crankDecision({ vaultLamports, rent0, collectMinLamports, shareholders, lamportsOf, executable = new Set() }) {
  if (shareholders.some(s => executable.has(s.address))) return { crank: false, blocked: true, reason: 'a shareholder is a program account (pump error 6052): distribution is blocked forever' }
  const need = distributeMinimum(shareholders, lamportsOf, rent0)
  const floor = BigInt(rent0) + BigInt(collectMinLamports)
  const min = need > floor ? need : floor
  const v = BigInt(vaultLamports)
  return v >= min ? { crank: true, need: min } : { crank: false, need: min, reason: `vault ${v} < ${min}` }
}

/** Did pump refuse because a shareholder is executable (6052 = 0x17a4)? Pure. */
export function is6052(errOrText) {
  const s = typeof errOrText === 'string' ? errOrText : `${errOrText?.message || ''} ${JSON.stringify(errOrText?.simErr || '')} ${(errOrText?.logs || []).join(' ')}`
  return /"Custom":\s*6052(?!\d)|custom program error: 0x17a4(?![0-9a-f])|Error Number: 6052(?!\d)/i.test(s)
}

/* ---------------- holder rounds ---------------- */

/** Decode one 40-byte getProgramAccounts slice (dataSlice {32, 40} of a token account) → { owner, amount }. Pure. */
export function decodeHolderSlice(data) {
  const d = Buffer.isBuffer(data) ? data : Buffer.from(data)
  if (d.length < 40) return null
  return { owner: new PublicKey(d.subarray(0, 32)).toBase58(), amount: d.readBigUInt64LE(32) }
}
/** Fold raw gPA rows [{ account: { data } } | { data }] into Map(owner → amount summed). Zero balances dropped. Pure. */
export function foldHolders(rows) {
  const out = new Map()
  for (const r of rows) {
    const h = decodeHolderSlice(r.account ? r.account.data : r.data)
    if (!h || h.amount <= 0n) continue
    out.set(h.owner, (out.get(h.owner) || 0n) + h.amount)
  }
  return out
}
/**
 * The part of a holder snapshot worth STORING as a round's open snapshot: owners holding at least `minTokensRaw`.
 * Lossless for the round: weight = min(open, close) < minTokensRaw is never paid anyway. Returns { owner: raw string }. Pure.
 */
export function compactSnapshot(snap, minTokensRaw = 0n) {
  const out = {}
  const min = BigInt(minTokensRaw)
  for (const [owner, amt] of snap instanceof Map ? snap : Object.entries(snap || {})) if (BigInt(amt) >= min && BigInt(amt) > 0n) out[owner] = BigInt(amt).toString()
  return out
}

/** weight = min(open, close) per owner; an owner missing from either snapshot weighs 0 (dropped). Pure. */
export function minWeights(open, close) {
  const o = open instanceof Map ? open : new Map(Object.entries(open || {}).map(([k, v]) => [k, BigInt(v)]))
  const c = close instanceof Map ? close : new Map(Object.entries(close || {}).map(([k, v]) => [k, BigInt(v)]))
  const out = new Map()
  for (const [owner, a] of o) {
    const b = c.get(owner)
    if (b == null) continue
    const w = BigInt(a) < BigInt(b) ? BigInt(a) : BigInt(b)
    if (w > 0n) out.set(owner, w)
  }
  return out
}

/**
 * The eligible holders of a round, ranked by weight (desc, then address). Excludes off-curve owners (curve PDA,
 * AMM pools, vaults), reserved/program keys, every key in `excluded` (engine, protocol, burn, every coin key, every
 * holder pool, mints, configs) and dust under `minTokensRaw`. Pure.
 */
export function rankEligible(weights, { excluded = new Set(), minTokensRaw = 0n } = {}) {
  const out = []
  for (const [owner, w] of weights) {
    if (w <= 0n || w < BigInt(minTokensRaw) || excluded.has(owner) || isReservedKey(owner)) continue
    out.push({ owner, weight: w })
  }
  return out.sort((a, b) => (b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : a.owner < b.owner ? -1 : 1))
}

/**
 * Pro-rata allocation of a pool's round budget, exact in BigInt:
 *   - candidates (ranked, from rankEligible) whose account kind is 'wallet' (program-owned / executable / unknown skipped)
 *   - the top `maxRecipients` of them share the budget by weight: share = budget × w / Σw (floor)
 *   - each share is capped at maxShareBps of the budget; the excess STAYS in the pool
 *   - an existing account is paid only ≥ minPayout; a missing account (0 lamports) only ≥ max(minPayout, rent(0))
 *     (a transfer that leaves a new account under rent fails its whole batch); anything skipped stays in the pool
 * Returns { items: [{ wallet, weight, lamports }], leftover, considered }. Σ lamports + leftover === budget.
 */
export function allocateRound({ budget, candidates, kinds, maxShareBps, minPayout, rent0, maxRecipients }) {
  const B = BigInt(budget)
  const rows = candidates.filter(c => kinds.get(c.owner)?.kind === 'wallet').slice(0, Math.max(0, maxRecipients))
  const total = rows.reduce((s, r) => s + BigInt(r.weight), 0n)
  if (B <= 0n || total <= 0n) return { items: [], leftover: B > 0n ? B : 0n, considered: rows.length }
  const cap = (B * BigInt(maxShareBps)) / BPS
  const minP = BigInt(minPayout), r0 = BigInt(rent0)
  const items = []
  let paid = 0n
  for (const r of rows) {
    let share = (B * BigInt(r.weight)) / total
    if (share > cap) share = cap
    const missing = (kinds.get(r.owner)?.lamports ?? 0n) <= 0n
    const floor = missing ? (r0 > minP ? r0 : minP) : minP
    if (share <= 0n || share < floor) continue
    items.push({ wallet: r.owner, weight: BigInt(r.weight), lamports: share })
    paid += share
  }
  if (paid > B) throw new Error('allocation overflow') // cannot happen; belt and braces
  return { items, leftover: B - paid, considered: rows.length }
}

/** Split items into transactions of at most `size` transfers, order kept. Pure. */
export function chunkItems(items, size) {
  const n = Math.max(1, Math.floor(size) || 1), out = []
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n))
  return out
}

/* ---------------- launch rules ---------------- */

/** Depth gate: a kid of a parent at `parentLevel` sits at parentLevel + 1, which must be ≤ maxDepth. Pure. */
export const depthOk = (parentLevel, maxDepth) => Number.isInteger(parentLevel) && parentLevel >= 0 && parentLevel + 1 <= maxDepth

export const SYMBOL_RULE = '^[A-Z][A-Z0-9]{1,9}$'
/** Ticker: 2-10 of A-Z 0-9 starting with a letter (upper-cased, leading $ dropped), not reserved. Pure. */
export function validateTicker(raw, reserved = []) {
  const s = String(raw || '').trim().replace(/^\$/, '').toUpperCase()
  if (!new RegExp(SYMBOL_RULE).test(s)) return { ok: false, error: 'ticker: 2-10 characters, A-Z and 0-9, starting with a letter' }
  if (reserved.map(r => String(r).toUpperCase()).includes(s)) return { ok: false, error: `$${s} is reserved` }
  return { ok: true, symbol: s }
}
/** Name: 1-32 BYTES (pump's create_v2 limit), whitespace collapsed, no control characters. Pure. */
export function validateName(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ')
  if (/[\x00-\x1f\x7f]/.test(String(raw || ''))) return { ok: false, error: 'name has control characters' }
  if (s.length < 1 || Buffer.byteLength(s, 'utf8') > 32) return { ok: false, error: 'name must be 1-32 bytes' }
  return { ok: true, name: s }
}
const URLISH = /^https?:\/\/[^\s"'<>]{3,200}$/
export function normalizeSocials(s = {}) {
  const out = {}
  const tw = String(s?.twitter || '').trim(); if (tw && (URLISH.test(tw) || /^@?[A-Za-z0-9_]{1,15}$/.test(tw))) out.twitter = URLISH.test(tw) ? tw : `https://x.com/${tw.replace(/^@/, '')}`
  const web = String(s?.website || '').trim(); if (URLISH.test(web)) out.website = web
  const tg = String(s?.telegram || '').trim(); if (tg && (URLISH.test(tg) || /^@?[A-Za-z0-9_]{3,32}$/.test(tg))) out.telegram = URLISH.test(tg) ? tg : `https://t.me/${tg.replace(/^@/, '')}`
  return out
}

/**
 * The parent pinned into a coin's metadata JSON at prepare (`pulls.parent`), so a launch broadcast without
 * submit — or across a restart that lost the prepared record — is still adopted under the right parent.
 * Returns { parent (mint|null for ROOT), level } or null when the JSON carries no valid pin. Pure.
 */
export function parentFromMetadata(json) {
  const c = json && typeof json === 'object' ? json.gachapad : null
  if (!c || typeof c !== 'object') return null
  const level = Number(c.level)
  if (!Number.isInteger(level) || level < 0 || level > 6) return null
  // the coin's pack machine (fixed at launch); absent on ROOT
  const machine = typeof c.machine === 'string' && /^[a-z0-9_]{2,40}$/.test(c.machine) ? c.machine : null
  const m = machine ? { machine } : {}
  if (level === 0) return c.parent == null || c.parent === '' ? { parent: null, level: 0 } : null
  if (level === 1 && (c.parent == null || c.parent === '')) return { parent: null, level: 1, preRoot: true, ...m } // launched before ROOT existed
  return isPubkey(c.parent) ? { parent: String(c.parent), level, ...m } : null
}

/* ---------------- byte identity ---------------- */

/** The message a wallet signed must be byte-identical to the one the engine built (fail closed). Pure. */
export function sameMessage(builtMessage, signedMessage) {
  const a = Buffer.from(builtMessage), b = Buffer.from(signedMessage)
  return a.length === b.length && a.equals(b)
}

/** Programs a wallet may add to a transaction it signs: Phantom's Lighthouse guard assertions + compute budget. */
export const LIGHTHOUSE_PROGRAM = 'L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95'
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111'
const WALLET_EXTRA_PROGRAMS = new Set([LIGHTHOUSE_PROGRAM, COMPUTE_BUDGET_PROGRAM])

function resolveMessage(msg, alts) {
  const hasTables = (msg.addressTableLookups?.length || 0) > 0
  let keyAt
  if (hasTables) {
    const keys = msg.getAccountKeys({ addressLookupTableAccounts: alts }) // throws when a table is missing
    keyAt = i => keys.get(i)?.toBase58()
  } else { const s = msg.staticAccountKeys.map(k => k.toBase58()); keyAt = i => s[i] }
  const ixs = msg.compiledInstructions.map(ix => ({
    program: keyAt(ix.programIdIndex),
    accounts: ix.accountKeyIndexes.map(i => keyAt(i)),
    data: Buffer.from(ix.data).toString('hex'),
  }))
  if (ixs.some(ix => !ix.program || ix.accounts.some(a => !a))) throw new Error('unresolvable account')
  return { ixs, signers: msg.staticAccountKeys.slice(0, msg.header.numRequiredSignatures).map(k => k.toBase58()), blockhash: msg.recentBlockhash, tables: hasTables }
}

/**
 * With LAUNCH_PRESIGN=false the WALLET signs first and may insert its own guard (Lighthouse) and compute-budget
 * instructions before signing. "Ours" then means: identical bytes, OR the same blockhash, the same signer set in
 * the same order, and OUR instructions unchanged and in order once the wallet's Lighthouse / ComputeBudget
 * instructions are ignored. A message using lookup tables is resolved only against `alts` (the tables the engine
 * built with); without them it must be byte-identical. Anything else fails closed. Pure.
 */
export function messageIsOurs(builtMessage, signedMessage, { alts = [] } = {}) {
  try { if (sameMessage(builtMessage, signedMessage)) return true } catch { return false }
  let a, b
  try { a = resolveMessage(VersionedMessage.deserialize(Buffer.from(builtMessage)), alts); b = resolveMessage(VersionedMessage.deserialize(Buffer.from(signedMessage)), alts) } catch { return false }
  if ((a.tables || b.tables) && !alts.length) return false
  if (a.blockhash !== b.blockhash) return false
  if (a.signers.length !== b.signers.length || a.signers.some((k, i) => k !== b.signers[i])) return false
  const core = ixs => ixs.filter(ix => !WALLET_EXTRA_PROGRAMS.has(ix.program))
  const ca = core(a.ixs), cb = core(b.ixs)
  if (ca.length !== cb.length) return false
  for (let i = 0; i < ca.length; i++) {
    const x = ca[i], y = cb[i]
    if (x.program !== y.program || x.data !== y.data || x.accounts.length !== y.accounts.length || x.accounts.some((k, j) => k !== y.accounts[j])) return false
  }
  return true
}

/* ---------------- launches ---------------- */

/**
 * Is a ROOT launch already prepared (and not expired) or sent-but-not-settled? ROOT is only set once a ROOT lands,
 * so two admin prepares in a row would both build valid creates: the second to land would be a stranded level-0 coin. Pure.
 */
export function rootLaunchInFlight(preparedRecs, launches, now = Date.now()) {
  if (preparedRecs.some(p => p.root && !p.adopted && now <= p.expiresAt)) return true
  return Object.values(launches || {}).some(l => l.root && (l.status === 'sent' || l.status === 'created'))
}

/**
 * Launch records that may still become a coin: every prepared record not yet dropped (sweepPrepared only drops one
 * on chain PROOF: the finalized height past its lastValidBlockHeight + a caught-up "no curve" read), every journal still sent / created,
 * and a failed one still inside its 24 h recheck window without a coin. `match(rec)` picks the ones of interest. Pure.
 */
export function launchesInFlight(preparedRecs, launches, match, { now = Date.now(), registered = () => false } = {}) {
  const out = []
  for (const p of preparedRecs || []) if (!p.adopted && match(p)) out.push(p)
  for (const l of Object.values(launches || {})) {
    const open = l.status === 'sent' || l.status === 'created' || (l.status === 'failed' && now - (l.sentAt || 0) < 86_400_000 && !registered(l.mint))
    if (open && match(l)) out.push(l)
  }
  return out
}

/** Which ids to drop so a bounded store stays bounded: settled ones, oldest first, beyond `max`. In-flight ones never. Pure. */
export function pruneIds(all, max, settled = l => l.status === 'live' || l.status === 'failed' || l.status === 'expired') {
  const done = Object.entries(all).filter(([, l]) => settled(l)).sort((a, b) => (a[1].updatedAt || a[1].createdAt || 0) - (b[1].updatedAt || b[1].createdAt || 0))
  const excess = Object.keys(all).length - max
  return excess > 0 ? done.slice(0, excess).map(([id]) => id) : []
}
