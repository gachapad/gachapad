// Money-path checks for the GACHAPAD engine (pump.fun build). No network: every chain call goes to a fake
// Connection. Run: node test.js
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRequire } from 'module'
import { spawn } from 'child_process'
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, TransactionInstruction, Connection, AddressLookupTableAccount, SendTransactionError } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import { randomBytes } from 'crypto'
import bs58 from 'bs58'
import BN from 'bn.js'

process.env.ENGINE_NO_DOTENV = '1'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gachapad-test-'))
const ENGINE = Keypair.generate(), BURN = Keypair.generate(), PROTOCOL = Keypair.generate()
process.env.ENGINE_PRIVATE_KEY = bs58.encode(ENGINE.secretKey)
process.env.BURN_PRIVATE_KEY = bs58.encode(BURN.secretKey)
process.env.PROTOCOL_WALLET = PROTOCOL.publicKey.toBase58()
process.env.RPC_URL = 'http://127.0.0.1:1' // never reached: tests inject a fake connection
process.env.SITE_URL = 'https://gachapad.example'
process.env.PUBLIC_URL = 'https://engine.example'
process.env.ADMIN_SECRET = 'a'.repeat(40)
for (const k of ['LAUNCH_ENABLED', 'DISTRIBUTE_LIVE', 'PAYOUTS_LIVE', 'BURN_LIVE', 'LAUNCH_PRESIGN', 'NODE_ENV', 'ROOT_MINT', 'PINATA_JWT', 'MAX_DEPTH', 'ROOT_SHARES', 'TRUST_PROXY']) delete process.env[k]

const cfgMod = await import('./config.js')
const { config, configProblems, parseEnv, parseTrustProxy, parseRootShares } = cfgMod
// The production split (asserted below). The money-mechanics fixtures further down were written against a
// 4000/4000/1000/1000 split, so they run with that one; the split is a parameter of those mechanics, not their subject.
const PROD_SPLIT = { ...config.split }
Object.assign(config.split, { creator: 4000, parentHolders: 4000, burn: 1000, protocol: 1000 })
// the defaults are read before the live flags are switched on for the money-path tests
const defaultsLive = { ...{ launch: config.launchEnabled, distribute: config.distributeLive, payouts: config.payoutsLive, burn: config.burnLive, presign: config.launchPresign, trust: config.trustProxy, depth: config.maxDepth } }
Object.assign(config, { launchEnabled: true, distributeLive: true, payoutsLive: true })
const sol = await import('./solana.js')
const store = await import('./store.js')
const M = await import('./math.js')
const registry = await import('./registry.js')
const launch = await import('./launch.js')
const dist = await import('./distribute.js')
const paysol = await import('./paysol.js')
const rounds = await import('./rounds.js')
const trades = await import('./trades.js')
const pump = await import('./pump.js')
const ipfs = await import('./ipfs.js')
const guard = await import('./guard.js')
const killMod = await import('./kill.js')
const burner = await import('./burner.js')
const canary = await import('./canary.js')
store.loadAllStores()
sol.setRent0(650_240n)
const RENT0 = 650_240n

const require = createRequire(import.meta.url)
const psdk = require('@pump-fun/pump-sdk')
const offlineConn = new Connection('http://127.0.0.1:1')
const pumpProg = psdk.getPumpProgram(offlineConn), feeProg = psdk.getPumpFeeProgram(offlineConn)

let pass = 0, fail = 0
const check = (name, cond, extra = '') => { if (cond) pass++; else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`) } }
const section = t => console.log(`\n${t}`)
const throws = fn => { try { fn(); return false } catch { return true } }
const rejects = async fn => { try { await fn(); return null } catch (e) { return e } }
const wallet = () => Keypair.generate().publicKey.toBase58()
const offCurve = () => PublicKey.findProgramAddressSync([Buffer.from('x'), Keypair.generate().publicKey.toBuffer()], new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))[0].toBase58()
const E = ENGINE.publicKey.toBase58(), B = BURN.publicKey.toBase58(), P = PROTOCOL.publicKey.toBase58()
const sysAcct = lamports => ({ lamports, owner: SystemProgram.programId, executable: false, data: Buffer.alloc(0), rentEpoch: 0 })

/* ---------------- a fake chain ---------------- */

function fakeConn(o = {}) {
  const c = {
    sent: [], sentSigs: new Set(), height: 100, statuses: new Map(), balance: 10_000_000_000, balances: new Map(), accounts: new Map(), simErr: null, simulations: 0, throwStatus: false,
    slot: 5000, statusSlot: null, firstBlock: 0, autoConfirm: false, txMeta: new Map(), gpa: [], onSend: null,
    async getLatestBlockhash() { return { blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 150 } },
    async getLatestBlockhashAndContext() { return { context: { slot: c.slot }, value: { blockhash: bs58.encode(Buffer.alloc(32, 7)), lastValidBlockHeight: 150 } } },
    async getEpochInfo() { return { absoluteSlot: c.slot, blockHeight: c.height } },
    async getFirstAvailableBlock() { return c.firstBlock },
    async getMinimumBalanceForRentExemption() { return Number(RENT0) },
    async getBalance(k) { const a = String(k); if (c.balances.has(a)) return c.balances.get(a); if (c.accounts.has(a)) return c.accounts.get(a)?.lamports || 0; return c.balance },
    async getAccountInfo(k) { return c.accounts.get(String(k)) ?? null },
    async getMultipleAccountsInfo(keys) { return keys.map(k => c.accounts.get(String(k)) ?? null) },
    async simulateTransaction(tx) { c.simulations++; const err = typeof c.simErr === 'function' ? c.simErr(tx) : c.simErr; return { value: { err, logs: err ? ['Program log: AnchorError occurred. Error Number: ' + (err?.InstructionError?.[1]?.Custom ?? 0)] : [], unitsConsumed: 1000 } } },
    async sendRawTransaction(raw) { const b = Buffer.from(raw); const tx = VersionedTransaction.deserialize(b); const s = bs58.encode(tx.signatures[0]); c.sent.push(b.toString('base64')); c.sentSigs.add(s); if (c.onSend) c.onSend(tx, s); return s },
    async getSignatureStatuses(sigs) { if (c.throwStatus) throw new Error('rpc down'); return { context: { slot: c.statusSlot ?? c.slot }, value: sigs.map(s => c.statuses.get(s) ?? (c.autoConfirm && c.sentSigs.has(s) ? { confirmationStatus: 'confirmed', err: null } : null)) } },
    async getBlockHeight() { return c.height },
    async getTransaction(s) { return c.txMeta.get(s) ?? null },
    async getProgramAccounts() { return c.gpa },
    async getAddressLookupTable() { return { value: null } },
    ...o,
  }
  return c
}
const use = c => { sol.setConnection(c); pump.resetSdks(); return c }
const txFromB64 = b => VersionedTransaction.deserialize(Buffer.from(b, 'base64'))
const transfersIn = b64 => { const tx = txFromB64(b64); const keys = tx.message.staticAccountKeys.map(k => k.toBase58()); return tx.message.compiledInstructions.filter(ix => keys[ix.programIdIndex] === '11111111111111111111111111111111').map(ix => keys[ix.accountKeyIndexes[1]]) }

async function curveAccount({ creator, complete = false, vt = '1000000000000000', vq = '30000000000', realTokens = '793100000000000', realSol = '0', quoteMint = 'So11111111111111111111111111111111111111112' }) {
  const data = await pumpProg.coder.accounts.encode('bondingCurve', { virtualTokenReserves: new BN(vt), virtualQuoteReserves: new BN(vq), realTokenReserves: new BN(realTokens), realQuoteReserves: new BN(realSol), tokenTotalSupply: new BN('1000000000000000'), complete, creator: new PublicKey(creator), isMayhemMode: false, isCashbackCoin: false, quoteMint: new PublicKey(quoteMint), creatorFeeBps: new BN(0), canEditCreatorFee: false, isHolderReward: false })
  return { lamports: 1_500_000, owner: psdk.PUMP_PROGRAM_ID, executable: false, data, rentEpoch: 0 }
}
async function sharingAccount(mint, shareholders, admin = mint) {
  const data = await feeProg.coder.accounts.encode('sharingConfig', { bump: 255, version: 2, status: { active: {} }, mint: new PublicKey(mint), admin: new PublicKey(admin), adminRevoked: true, shareholders: shareholders.map(s => ({ address: new PublicKey(s.address), shareBps: s.shareBps })) })
  return { lamports: 5_852_160, owner: psdk.PUMP_FEE_PROGRAM_ID, executable: false, data, rentEpoch: 0 }
}
/** Register a coin record directly (the registry is a money store; this is what registerCoin writes). */
function addCoin({ symbol = 'KID', parent = null, level = parent ? (registry.coinRec(parent)?.level ?? 0) + 1 : 0, hidden = false, locked = true, launcher = wallet(), mint = wallet() } = {}) {
  const l = { mint, wallet: launcher, parent, level, root: !parent, holderPool: sol.poolKeyFor(mint).publicKey.toBase58(), parentPool: parent ? sol.poolKeyFor(parent).publicKey.toBase58() : null, creatorKey: sol.coinKeyFor(mint).publicKey.toBase58() }
  const shares = launch.sharesFor(l)
  registry.putCoin({ mint, symbol, name: symbol, description: '', uri: '', image: '', socials: {}, parent, level, root: !parent, creator: launcher, creatorKey: l.creatorKey, parentPool: l.parentPool, holderPool: l.holderPool, shares, createdAt: Date.now(), hidden, external: false, sharing: locked ? { address: pump.feeSharingConfigPda(new PublicKey(mint)).toBase58(), tx: 'x', at: Date.now(), shareholders: shares } : null, setup: null, swept: locked, distributeBlocked: null })
  return registry.coinRec(mint)
}

/* ------------------------------------------------------------------ */
section('config')
{
  check('default config is sane', configProblems().length === 0, configProblems().join('; '))
  check('live flags all default false', !defaultsLive.launch && !defaultsLive.distribute && !defaultsLive.payouts && !defaultsLive.burn)
  check('LAUNCH_PRESIGN defaults true (the mint signs first)', defaultsLive.presign === true)
  check('MAX_DEPTH defaults to 1 (GACHAPAD: every coin sits under $GACHA)', defaultsLive.depth === 1)
  check('TRUST_PROXY defaults to exactly ONE hop', defaultsLive.trust === 1)
  check("trust proxy 'true' → 1 hop, never trust-all", parseTrustProxy('true') === 1 && parseTrustProxy('false') === false && parseTrustProxy('2') === 2 && parseTrustProxy('loopback') === 'loopback')
  check('NaN env is caught', configProblems({ ...config, maxRecipients: NaN }).length > 0)
  check('payouts per tx is bounded 1-18', configProblems({ ...config, payoutsPerTx: 40 }).length > 0)
  check('MIN_PAYOUT_SOL below 0.001 refused', configProblems({ ...config, minPayoutSol: 0.0005 }).length > 0)
  check('SETUP_SOL below the sharing rent refused', configProblems({ ...config, setupSol: 0.005 }).length > 0)
  check('MAX_DEPTH other than 1 refused', configProblems({ ...config, maxDepth: 0 }).length > 0 && configProblems({ ...config, maxDepth: 2 }).length > 0)
  check('MAX_WALLET_SHARE_BPS outside 1-10000 refused', configProblems({ ...config, maxWalletShareBps: 0 }).length > 0)
  const prod = configProblems({ ...config, enginePrivateKey: '', protocolWallet: '', burnPrivateKey: '', rpcUrl: '', adminSecret: '' }, { NODE_ENV: 'production' }, () => true)
  check('production refuses to run without RPC, engine key, protocol, burn, admin secret', prod.length >= 5)
  check('production refuses an empty data dir unless ENGINE_FRESH=1', configProblems(config, { NODE_ENV: 'production' }, () => false).some(m => m.includes('ENGINE_FRESH')) && !configProblems(config, { NODE_ENV: 'production', ENGINE_FRESH: '1' }, () => false).some(m => m.includes('ENGINE_FRESH')))
  check('parseEnv strips quotes and comments', parseEnv('A="1"\nB=2 # c\n#D=3').A === '1' && parseEnv('A="1"\nB=2 # c\n#D=3').B === '2' && !('D' in parseEnv('#D=3')))
  const rs = parseRootShares('burn:8000,protocol:2000')
  check('ROOT_SHARES default burn 8000 / protocol 2000', rs.length === 2 && rs[0].role === 'burn' && rs[0].bps === 8000 && rs[1].bps === 2000 && config.rootShares.map(s => `${s.role}:${s.bps}`).join() === 'burn:8000,protocol:2000')
  check('ROOT_SHARES must sum to 10000, no zero, no dup, known roles', throws(() => parseRootShares('burn:8000')) && throws(() => parseRootShares('burn:10000,protocol:0')) && throws(() => parseRootShares('burn:5000,burn:5000')) && throws(() => parseRootShares('whale:10000')))
  check('ROOT_SHARES may include ROOT holders', parseRootShares('holders:5000,burn:3000,protocol:2000').length === 3)
  check('the production split is the coin own pack pool 8000 / $GACHA burn 2000', JSON.stringify(PROD_SPLIT) === JSON.stringify({ creator: 0, parentHolders: 8000, burn: 2000, protocol: 0 }))
  check('the production split sums to 10000', PROD_SPLIT.creator + PROD_SPLIT.parentHolders + PROD_SPLIT.burn + PROD_SPLIT.protocol === 10000)
  { const k = () => Keypair.generate().publicKey.toBase58(); const sh = M.shareholdersFor({ launcher: k(), parentPool: k(), burn: k(), protocol: k(), split: PROD_SPLIT }); check('shareholdersFor with the production split writes 8000/2000 (zero shares omitted)', JSON.stringify(sh.map(x => x.shareBps)) === '[8000,2000]' && sh.map(x => x.role).join() === 'parentHolders,burn') }
}

/* ------------------------------------------------------------------ */
section('derived keys (FROZEN strings, parent-keyed pool)')
{
  check("frozen strings 'gpump-coin:v1:' / 'gpump-pool:v1:'", sol.DERIVE_COIN === 'gpump-coin:v1:' && sol.DERIVE_POOL === 'gpump-pool:v1:')
  // A fixed vector: if either string (or the HMAC recipe) ever changes, every pool and coin key is orphaned. This test pins them.
  const secret = Uint8Array.from({ length: 64 }, (_, i) => i)
  const vmint = 'So11111111111111111111111111111111111111112'
  const vc = sol.coinKeyFor(vmint, secret).publicKey.toBase58(), vp = sol.poolKeyFor(vmint, secret).publicKey.toBase58()
  check('coin-key vector pinned (engine secret 0..63, mint So111…112)', vc === 'D72NKde73SgsfSnmcuKEG6u2RtQjQro5QmXKegxoM5Nr')
  check('pool-key vector pinned', vp === 'ADoc1b62rqgSZ55BFhcmdSudh9wyscYzue8tfJMP4rwm')
  check('vault-key vector pinned', sol.vaultKeyFor(vmint, secret).publicKey.toBase58() === 'EmsQf5suhkahXy2kRHKqUdmSEto7RED6hbGvNsKbbtiz')
  const m1 = wallet(), m2 = wallet()
  const a = sol.coinKeyFor(m1), b = sol.coinKeyFor(m1), p = sol.poolKeyFor(m1)
  check('deterministic', a.publicKey.equals(b.publicKey))
  check('coin key ≠ pool key for the same mint', !a.publicKey.equals(p.publicKey))
  check('different mint → different keys', !sol.coinKeyFor(m2).publicKey.equals(a.publicKey) && !sol.poolKeyFor(m2).publicKey.equals(p.publicKey))
  check('different engine secret → different keys', !sol.coinKeyFor(m1, Keypair.generate().secretKey).publicKey.equals(a.publicKey))
  check('case matters in the id (base58 is case-sensitive)', !sol.poolKeyFor(m1.toLowerCase()).publicKey.equals(p.publicKey) || m1.toLowerCase() === m1)
  check('derived keys are real wallets (on curve)', sol.isWalletKey(a.publicKey.toBase58()) && sol.isWalletKey(p.publicKey.toBase58()))
  check("never collides with the earlier engines' labels", !sol.derive('coin-key:v1:', m1, ENGINE.secretKey).publicKey.equals(a.publicKey) && !sol.derive('pool-key:v1:', m1, ENGINE.secretKey).publicKey.equals(p.publicKey))
  const parent = wallet()
  const m1k = wallet()
  const k1 = { wallet: wallet(), parent, level: 1, holderPool: sol.poolKeyFor(m1k).publicKey.toBase58(), parentPool: sol.poolKeyFor(parent).publicKey.toBase58(), creatorKey: 'y', mint: wallet() }
  const m2k = wallet()
  const k2 = { ...k1, wallet: wallet(), mint: m2k, holderPool: sol.poolKeyFor(m2k).publicKey.toBase58() }
  const s1 = launch.sharesFor(k1), s2 = launch.sharesFor(k2)
  check('GACHAPAD: each coin locks its OWN pack pool (never the parent pool)', s1.find(s => s.role === 'parentHolders').address === k1.holderPool && s2.find(s => s.role === 'parentHolders').address === k2.holderPool && s1.find(s => s.role === 'parentHolders').address !== s2.find(s => s.role === 'parentHolders').address)
  check('vector stable within the run', sol.poolKeyFor(vmint, secret).publicKey.toBase58() === vp)
}

/* ------------------------------------------------------------------ */
section('fixed shareholders + merge + launcher rules')
{
  const launcher = wallet(), pool = wallet()
  const sh = M.shareholdersFor({ launcher, parentPool: pool, burn: B, protocol: P })
  check('[launcher 4000, pool(parent) 4000, burn 1000, protocol 1000] in that order', sh.map(s => `${s.role}:${s.shareBps}`).join() === 'creator:4000,parentHolders:4000,burn:1000,protocol:1000' && sh[0].address === launcher && sh[1].address === pool && sh[2].address === B && sh[3].address === P)
  check('sums to exactly 10000, no duplicates, no zero', sh.reduce((a, s) => a + s.shareBps, 0) === 10_000 && new Set(sh.map(s => s.address)).size === 4 && sh.every(s => s.shareBps > 0))
  // the split is locked FOREVER: without the burn wallet it must not be planned at all (folding the burn 10% into
  // protocol, the old behaviour, locked a burn-less split once the key came back — review 2 #11)
  check('no burn wallet → planning the split throws (never folds the burn share into protocol)', throws(() => M.shareholdersFor({ launcher, parentPool: pool, burn: '', protocol: P })))
  check('a split with no burn share needs no burn wallet', M.shareholdersFor({ launcher, parentPool: pool, burn: '', protocol: P, split: { creator: 4000, parentHolders: 4000, burn: 0, protocol: 2000 } }).length === 3)
  const zero = M.shareholdersFor({ launcher, parentPool: pool, burn: B, protocol: P, split: { creator: 0, parentHolders: 8000, burn: 1000, protocol: 1000 } })
  check('a zero share is omitted, not added as 0', zero.length === 3 && !zero.some(s => s.address === launcher))
  const dup = M.mergeShares([[pool, 4000, 'creator'], [pool, 4000, 'parentHolders'], [B, 1000, 'burn'], [P, 1000, 'protocol']])
  check('duplicate addresses merge (pump refuses duplicates)', dup.length === 3 && dup.find(s => s.address === pool).shareBps === 8000)
  check('a sum other than 10000 throws', throws(() => M.mergeShares([[pool, 4000, 'x'], [B, 1000, 'burn']])))
  check('more than 10 shareholders throws', throws(() => M.mergeShares(Array.from({ length: 11 }, (_, i) => [wallet(), i === 0 ? 10_000 - 900 * 10 : 900, 'x']))))
  check('an off-curve launcher (PDA) is refused', throws(() => M.shareholdersFor({ launcher: offCurve(), parentPool: pool, burn: B, protocol: P })))
  check('an infra launcher (engine / pool / coin key) is refused', throws(() => M.shareholdersFor({ launcher: E, parentPool: pool, burn: B, protocol: P, infra: new Set([E]) })))
  check('a missing protocol wallet throws', throws(() => M.shareholdersFor({ launcher, parentPool: pool, burn: B, protocol: '' })))
  check('a missing parent pool throws', throws(() => M.shareholdersFor({ launcher, parentPool: '', burn: B, protocol: P })))
  const root = M.rootShareholdersFor(config.rootShares, { burn: B, protocol: P, holders: pool, creator: launcher })
  check('ROOT lock: burn 8000 / protocol 2000, no launcher, no parent pool', root.length === 2 && root[0].address === B && root[0].shareBps === 8000 && root[1].address === P && root[1].shareBps === 2000)
  const rootH = M.rootShareholdersFor(parseRootShares('holders:5000,burn:3000,protocol:2000'), { burn: B, protocol: P, holders: pool, creator: launcher })
  check('ROOT_SHARES holders → ROOT’s own holder pool', rootH.find(s => s.address === pool)?.shareBps === 5000)
  let exact = true
  for (let i = 0; i < 2000; i++) {
    const amt = BigInt(Math.floor(Math.random() * 5e9) + 1)
    const parts = M.splitByShares(amt, sh)
    if (parts.reduce((a, p) => a + p.lamports, 0n) !== amt || parts.some(p => p.lamports < 0n)) exact = false
  }
  check('splitByShares is exact to the lamport (2000 random amounts)', exact)
}

/* ------------------------------------------------------------------ */
section('sweep fold (sub-rent parts owed to missing accounts → parent pool)')
{
  const launcher = wallet(), pool = wallet()
  const sh = M.shareholdersFor({ launcher, parentPool: pool, burn: B, protocol: P })
  const exists = (...a) => new Map(a.map(x => [x, 1_000_000n]))
  const small = M.sweepParts(1_000_000n, sh, exists(pool, B, P), RENT0) // launcher part 400k < rent, launcher missing
  check('a sub-rent part owed to a missing launcher is folded into the pool part', !small.some(p => p.address === launcher) && small.find(p => p.address === pool).lamports === 800_000n)
  check('…and the parts still sum to the pot exactly', small.reduce((a, p) => a + p.lamports, 0n) === 1_000_000n)
  const funded = M.sweepParts(1_000_000n, sh, exists(launcher, pool, B, P), RENT0)
  check('an existing launcher is paid its part even below rent', funded.find(p => p.address === launcher).lamports === 400_000n)
  const big = M.sweepParts(10_000_000n, sh, exists(pool), RENT0)
  check('parts at or above rent(0) are paid to missing accounts (they get created)', big.find(p => p.address === launcher).lamports === 4_000_000n && big.find(p => p.address === B).lamports === 1_000_000n)
  const missingBurn = M.sweepParts(4_000_000n, sh, exists(launcher, pool, P), RENT0) // burn part 400k, missing
  check('a missing burn wallet with a sub-rent part: folded into the pool', !missingBurn.some(p => p.address === B) && missingBurn.find(p => p.address === pool).lamports === 1_600_000n + 400_000n)
  const nobody = M.sweepParts(100_000n, sh, new Map(), RENT0)
  check('nobody exists and every part is sub-rent: nothing is sent', nobody.length === 0)
  check('a zero pot sends nothing', M.sweepParts(0n, sh, exists(pool), RENT0).length === 0)
  let ok = true
  for (let i = 0; i < 1000; i++) {
    const pot = BigInt(Math.floor(Math.random() * 3e7) + 1)
    const lam = new Map(sh.map(s => [s.address, Math.random() < 0.5 ? 0n : 1_000_000n])); lam.set(pool, 2_000_000n)
    const parts = M.sweepParts(pot, sh, lam, RENT0)
    if (parts.reduce((a, p) => a + p.lamports, 0n) !== pot || parts.some(p => p.lamports <= 0n) || parts.some(p => lam.get(p.address) === 0n && p.lamports < RENT0)) ok = false
  }
  check('1000 random sweeps: exact sum, no zero part, no sub-rent part to a missing account', ok)
}

/* ------------------------------------------------------------------ */
section("distribute: pump's unfunded-shareholder threshold + 6052")
{
  const sh = [{ address: 'L', shareBps: 4000 }, { address: 'Pp', shareBps: 4000 }, { address: 'Bb', shareBps: 1000 }, { address: 'Pr', shareBps: 1000 }]
  const all = new Map(sh.map(s => [s.address, 1_000_000n]))
  check('every shareholder funded → the minimum is rent(0)', M.distributeMinimum(sh, all, RENT0) === RENT0)
  const noProto = new Map(all); noProto.set('Pr', 0n)
  check('one unfunded 10% share → rent + ceil(rent×10000/1000) = 7,152,640 (mainnet-measured)', M.distributeMinimum(sh, noProto, RENT0) === 7_152_640n)
  const noLauncher = new Map(all); noLauncher.set('L', 0n)
  check('one unfunded 40% share → rent + ceil(rent×10000/4000) = 2,275,840', M.distributeMinimum(sh, noLauncher, RENT0) === 650_240n + 1_625_600n)
  const two = new Map(all); two.set('L', 0n); two.set('Bb', 0n)
  check('two unfunded → the smallest share decides (max threshold)', M.distributeMinimum(sh, two, RENT0) === 7_152_640n)
  check('rounds UP (ceil)', M.distributeMinimum([{ address: 'z', shareBps: 3 }], new Map(), 10n) === 10n + 33_334n)
  const min = 5_000_000n
  check('crank when vault ≥ rent + COLLECT_MIN and every holder funded', M.crankDecision({ vaultLamports: RENT0 + min, rent0: RENT0, collectMinLamports: min, shareholders: sh, lamportsOf: all }).crank === true)
  check('no crank below rent + COLLECT_MIN', M.crankDecision({ vaultLamports: RENT0 + min - 1n, rent0: RENT0, collectMinLamports: min, shareholders: sh, lamportsOf: all }).crank === false)
  const d1 = M.crankDecision({ vaultLamports: 7_000_000n, rent0: RENT0, collectMinLamports: min, shareholders: sh, lamportsOf: noProto })
  check('an unfunded 10% share raises the bar: 7.0M vault is a silent no-op → not cranked', d1.crank === false && d1.need === 7_152_640n)
  check('…and at 7,152,640 it cranks (pump then creates + pays the account)', M.crankDecision({ vaultLamports: 7_152_640n, rent0: RENT0, collectMinLamports: min, shareholders: sh, lamportsOf: noProto }).crank === true)
  const ex = M.crankDecision({ vaultLamports: 1_000_000_000n, rent0: RENT0, collectMinLamports: min, shareholders: sh, lamportsOf: all, executable: new Set(['L']) })
  check('an executable shareholder → blocked forever (6052), never cranked', ex.crank === false && ex.blocked === true)
  check('6052 detected in a sim error object', M.is6052({ simErr: { InstructionError: [1, { Custom: 6052 }] } }))
  check('6052 detected in logs (hex and decimal)', M.is6052('Program log: custom program error: 0x17a4') && M.is6052('AnchorError ... Error Number: 6052. Error Message: Shareholder is a program account'))
  check('other codes are not 6052', !M.is6052({ simErr: { InstructionError: [1, { Custom: 6016 }] } }) && !M.is6052('Error Number: 60520') && !M.is6052('lamports 16052'))
  const by = dist.deltasByRole(M.shareholdersFor({ launcher: sol.coinKeyFor(wallet()).publicKey.toBase58(), parentPool: 'PP', burn: B, protocol: P }), new Map([['PP', 8n], [B, 2n], [P, 2n]]))
  check('measured deltas map onto roles (a missing / negative delta counts 0)', by.toParent === 8n && by.toBurn === 2n && by.toProtocol === 2n && by.toLauncher === 0n)
}

/* ------------------------------------------------------------------ */
section('distribute crank end to end (fake chain): book ONLY measured deltas')
{
  const root = addCoin({ symbol: 'ROOTD' })
  const kid = addCoin({ symbol: 'KIDD', parent: root.mint })
  const cfg = pump.feeSharingConfigPda(new PublicKey(kid.mint)).toBase58()
  const c = use(fakeConn())
  c.accounts.set(cfg, await sharingAccount(kid.mint, kid.shares))
  for (const s of kid.shares) c.accounts.set(s.address, sysAcct(5_000_000))
  // the crank reads the vault LIVE (not the refresh figure): the chain holds 20M above rent in the config's creator vault
  const vaultOf = m => pump.creatorVaultPda(pump.feeSharingConfigPda(new PublicKey(m))).toBase58()
  c.accounts.set(vaultOf(kid.mint), sysAcct(Number(RENT0 + 20_000_000n)))
  c.balances.set(E, 1_000_000_000)
  c.autoConfirm = true
  let sentTx = null
  c.onSend = tx => { sentTx = tx }
  const meta = deltas => ({ meta: { fee: 5000, preBalances: sentTx.message.staticAccountKeys.map(() => 1_000_000), postBalances: sentTx.message.staticAccountKeys.map(k => 1_000_000 + Number(deltas.get(k.toBase58()) || 0)), loadedAddresses: { writable: [], readonly: [] } }, transaction: { message: sentTx.message } })
  c.getTransaction = async () => meta(new Map()) // the crank moved NOTHING
  registry.setLive(kid.mint, { vaultLamports: String(RENT0 + 20_000_000n), graduated: false, sharingOk: true, ammAtaExists: false })
  const before = JSON.stringify(store.mintLedger(kid.mint))
  const n0 = await dist.distributeDue({ only: kid.mint })
  check('a crank that moved nothing is sent…', n0 === 1 && c.sent.length === 1)
  check('…but books NOTHING (no estimate)', JSON.stringify(store.mintLedger(kid.mint)) === before && store.mintLedger(kid.mint).cranks === 0)
  registry.setLive(kid.mint, { vaultLamports: String(RENT0 + 20_000_000n) })
  c.getTransaction = async () => meta(new Map([[kid.shares[0].address, 8_000_000n], [kid.shares[1].address, 8_000_000n], [B, 2_000_000n], [P, 2_000_000n]]))
  const n1 = await dist.distributeDue({ force: true, only: kid.mint })
  const led = store.mintLedger(kid.mint)
  check('a real distribution books exactly the measured deltas', n1 === 1 && led.distributedLamports === '20000000' && led.toParentLamports === '8000000' && led.toLauncherLamports === '8000000' && led.toBurnLamports === '2000000' && led.cranks === 1)
  check('booking is idempotent per signature', store.bookDistribution(kid.mint, sol.sigOf(sentTx), { toParent: 8_000_000n }) === false && store.mintLedger(kid.mint).distributedLamports === '20000000')
  check('a distribution event carries the measured parent share', store.eventsStore.get().some(e => e.type === 'distribute' && e.mint === kid.mint && Math.abs(e.extra.toParentHoldersSol - 0.008) < 1e-12))
  // 6052 in simulation → distributeBlocked, nothing sent
  const kid2 = addCoin({ symbol: 'KIDX', parent: root.mint })
  c.accounts.set(pump.feeSharingConfigPda(new PublicKey(kid2.mint)).toBase58(), await sharingAccount(kid2.mint, kid2.shares))
  for (const s of kid2.shares) c.accounts.set(s.address, sysAcct(5_000_000))
  c.accounts.set(vaultOf(kid2.mint), sysAcct(Number(RENT0 + 20_000_000n)))
  registry.setLive(kid2.mint, { vaultLamports: String(RENT0 + 20_000_000n), graduated: false, sharingOk: true })
  c.simErr = { InstructionError: [2, { Custom: 6052 }] }
  const sentBefore = c.sent.length
  await dist.distributeDue({ force: true, only: kid2.mint })
  check('6052 in simulation → distributeBlocked, nothing sent', !!registry.coinRec(kid2.mint).distributeBlocked && c.sent.length === sentBefore)
  c.simErr = null
  const n2 = await dist.distributeDue({ force: true, only: kid2.mint })
  check('a blocked coin is never cranked again', n2 === 0 && c.sent.length === sentBefore)
  check('its sharing status reads "blocked"', registry.view(registry.coinRec(kid2.mint)).sharing.status === 'blocked')
  // the site's proof says "read back from chain": the view must show the CHAIN's recipients once read (a mismatch must never show ours)
  {
    const rec = registry.coinRec(kid2.mint), recorded = (rec.sharing?.shareholders || rec.shares).map(s => s.address).join()
    const before = registry.view(rec).sharing
    check('view: before any chain read → the recorded split, readBack false', before.readBack === false && before.shareholders.map(s => s.address).join() === recorded)
    const other = wallet()
    registry.setLive(kid2.mint, { chainSharing: { adminRevoked: true, admin: other, shareholders: [{ address: other, shareBps: 10_000 }] } })
    const after = registry.view(rec).sharing
    check('view: chain-read recipients win over the recorded ones (readBack true; an unknown recipient has no role)', after.readBack === true && after.adminRevoked === true && after.shareholders.length === 1 && after.shareholders[0].address === other && after.shareholders[0].bps === 10_000 && after.shareholders[0].role === null)
    registry.setLive(kid2.mint, { chainSharing: null })
  }
  // an executable shareholder is caught BEFORE simulating
  const kid3 = addCoin({ symbol: 'KIDE', parent: root.mint })
  c.accounts.set(pump.feeSharingConfigPda(new PublicKey(kid3.mint)).toBase58(), await sharingAccount(kid3.mint, kid3.shares))
  for (const s of kid3.shares) c.accounts.set(s.address, sysAcct(5_000_000))
  c.accounts.set(vaultOf(kid3.mint), sysAcct(Number(RENT0 + 20_000_000n)))
  c.accounts.set(kid3.shares[0].address, { lamports: 1_000_000, owner: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'), executable: true, data: Buffer.alloc(36), rentEpoch: 0 })
  registry.setLive(kid3.mint, { vaultLamports: String(RENT0 + 20_000_000n), graduated: false, sharingOk: true })
  const sims = c.simulations
  await dist.distributeDue({ force: true, only: kid3.mint })
  check('an executable launcher slot → blocked without even simulating', !!registry.coinRec(kid3.mint).distributeBlocked && c.simulations === sims)
  // an unfunded 10% share with a vault below pump's minimum → not cranked
  const kid4 = addCoin({ symbol: 'KIDU', parent: root.mint })
  c.accounts.set(pump.feeSharingConfigPda(new PublicKey(kid4.mint)).toBase58(), await sharingAccount(kid4.mint, kid4.shares))
  for (const s of kid4.shares) c.accounts.set(s.address, sysAcct(5_000_000))
  c.accounts.set(vaultOf(kid4.mint), sysAcct(7_000_000))
  c.accounts.delete(P)
  registry.setLive(kid4.mint, { vaultLamports: String(7_000_000n), graduated: false, sharingOk: true })
  const s4 = c.sent.length
  await dist.distributeDue({ force: true, only: kid4.mint })
  check('below the unfunded-shareholder minimum: not cranked (pump would no-op)', c.sent.length === s4 && !registry.coinRec(kid4.mint).distributeBlocked)
  c.accounts.set(P, sysAcct(5_000_000))
  c.accounts.set(vaultOf(kid4.mint), sysAcct(Number(RENT0 + 50_000_000n)))
  registry.setLive(kid4.mint, { sharingOk: false, vaultLamports: String(RENT0 + 50_000_000n) })
  await dist.distributeDue({ force: true, only: kid4.mint })
  check('a sharing mismatch (curve creator ≠ config) is never cranked', c.sent.length === s4)
  const saved = config.distributeLive; config.distributeLive = false
  registry.setLive(kid4.mint, { sharingOk: true })
  await dist.distributeDue({ force: true, only: kid4.mint })
  check('DISTRIBUTE_LIVE=false sends nothing', c.sent.length === s4)
  config.distributeLive = saved
}

/* ------------------------------------------------------------------ */
section('depth gate + launch terms')
{
  check('depthOk: ROOT (0) and level 1-2 parents may have kids at MAX_DEPTH 3', M.depthOk(0, 3) && M.depthOk(1, 3) && M.depthOk(2, 3))
  check('depthOk: a level-3 parent may not', !M.depthOk(3, 3) && !M.depthOk(-1, 3) && !M.depthOk(1.5, 3))
  const r = addCoin({ symbol: 'RDEPTH' })
  registry.setRootMint(r.mint)
  launch.setCanary({ status: 'ok' })
  const l1 = addCoin({ symbol: 'LONE', parent: r.mint }), l2 = addCoin({ symbol: 'LTWO', parent: l1.mint }), l3 = addCoin({ symbol: 'LTHREE', parent: l2.mint })
  check('levels follow the tree (0 → 1 → 2 → 3)', l1.level === 1 && l2.level === 2 && l3.level === 3)
  const img = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')
  const body = { wallet: wallet(), name: 'Deep', symbol: 'DEEP', image: img }
  use(fakeConn())
  const e3 = await rejects(() => launch.prepareLaunch({ ...body, parent: l3.mint }))
  check('prepare under a level-3 parent is refused (400, max depth)', e3 && e3.code === 400 && /maximum depth/.test(e3.message), e3?.message)
  const eUnknown = await rejects(() => launch.prepareLaunch({ ...body, parent: wallet() }))
  check('prepare under an unknown parent is refused', eUnknown && eUnknown.code === 400)
  const hid = addCoin({ symbol: 'HIDP', parent: r.mint, hidden: true })
  const eHidden = await rejects(() => launch.prepareLaunch({ ...body, parent: hid.mint }))
  check('prepare under a HIDDEN parent is refused for the public', eHidden && /not a coin/.test(eHidden.message))
  const eInfra = await rejects(() => launch.prepareLaunch({ ...body, wallet: E, parent: r.mint }))
  check('the engine wallet cannot launch', eInfra && eInfra.code === 400)
  const ePool = await rejects(() => launch.prepareLaunch({ ...body, wallet: r.holderPool, parent: r.mint }))
  check('a holder pool cannot launch', ePool && ePool.code === 400)
  const ePda = await rejects(() => launch.prepareLaunch({ ...body, wallet: offCurve(), parent: r.mint }))
  check('an off-curve launcher is refused', ePda && ePda.code === 400)
  const eRes = await rejects(() => launch.prepareLaunch({ ...body, symbol: config.ticker, parent: r.mint }))
  check('the platform ticker is reserved', eRes && /reserved/.test(eRes.message))
  const eImg = await rejects(() => launch.prepareLaunch({ ...body, image: 'data:image/png;base64,AAAA', parent: r.mint }))
  check('an image whose bytes are not its type is refused', eImg && eImg.code === 400)
  const eBuy = await rejects(() => launch.prepareLaunch({ ...body, firstBuySol: config.firstBuyMaxSol + 1, parent: r.mint }))
  check('a first buy above FIRST_BUY_MAX_SOL is refused', eBuy && /first buy/.test(eBuy.message))
  check('ticker: 2-10, A-Z0-9, starts with a letter, $ and case normalized', M.validateTicker('$abc').symbol === 'ABC' && !M.validateTicker('1ABC').ok && !M.validateTicker('ABCDEFGHIJK').ok && !M.validateTicker('A').ok)
  check('name: 1-32 BYTES (pump limit), control characters refused', M.validateName('  My   Coin ').name === 'My Coin' && !M.validateName('x'.repeat(33)).ok && !M.validateName('é'.repeat(17)).ok && !M.validateName('a\u0001b').ok)
  check('socials: handles → urls, javascript: dropped', JSON.stringify(M.normalizeSocials({ twitter: '@usegachapad', website: 'javascript:alert(1)', telegram: 'https://t.me/usegachapad' })) === JSON.stringify({ twitter: 'https://x.com/usegachapad', telegram: 'https://t.me/usegachapad' }))
  check('parseImage: png sniffed, too-big refused, garbage null', ipfs.parseImage(img)?.ext === 'png' && throws(() => ipfs.parseImage('data:image/png;base64,' + Buffer.alloc(4 * 1024 * 1024 + 10, 0x89).toString('base64'))) && ipfs.parseImage('hello') === null)
  const mj = ipfs.metaJson({ name: 'A', symbol: 'A', mint: 'm', parent: l1.mint, level: 2, launcher: body.wallet })
  check('the metadata JSON pins the parent + launcher (pulls.parent)', mj.gachapad.parent === l1.mint && mj.gachapad.level === 2 && mj.gachapad.launcher === body.wallet && mj.ca === 'm')
}

/* ------------------------------------------------------------------ */
section('launch blockers + ROOT in flight')
{
  check('a fully configured engine serves launches', launch.launchBlocker() === null, launch.launchBlocker())
  launch.setCanary({ status: 'failing' })
  check('a failing canary pauses launches ("pump changed")', /pump changed/.test(launch.launchBlocker() || ''))
  launch.setCanary({ status: 'ok' })
  killMod.kill('test')
  check('the kill switch pauses launches', launch.launchBlocker() === 'the engine is paused')
  killMod.unkill()
  const saved = registry.rootMint(); registry.setRootMint('')
  check('no ROOT → launches OPEN pre-ROOT (and the ROOT launch itself is allowed)', launch.launchBlocker() === null && launch.launchBlocker({ root: true }) === null, launch.launchBlocker())
  registry.setRootMint(saved)
  config.launchEnabled = false
  check('LAUNCH_ENABLED=false → paused', launch.launchBlocker() === 'launching is paused')
  config.launchEnabled = true
  const savedProto = config.protocolWallet; config.protocolWallet = E
  check('the lock refuses PROTOCOL_WALLET == the engine wallet', /engine wallet/.test(launch.lockBlocker() || ''))
  config.protocolWallet = 'not-a-key'
  check('the lock refuses a PROTOCOL_WALLET that is not an address', /PROTOCOL_WALLET/.test(launch.lockBlocker() || ''))
  config.protocolWallet = savedProto
  check('a ROOT draft in flight blocks a second ROOT prepare', M.rootLaunchInFlight([{ root: true, expiresAt: Date.now() + 10_000 }], {}) && M.rootLaunchInFlight([], { a: { root: true, status: 'sent' } }) && !M.rootLaunchInFlight([{ root: true, expiresAt: Date.now() - 1 }], { a: { root: true, status: 'live' } }))
  const many = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`l${i}`, { status: i < 3 ? 'sent' : 'live', updatedAt: i }]))
  const drop = M.pruneIds(many, 5)
  check('bounded launch store never drops an in-flight launch', drop.length === 5 && drop.every(id => many[id].status === 'live'))
}

/* ------------------------------------------------------------------ */
section('submit: byte identity / messageIsOurs, wallet signature, journal before broadcast')
{
  const parent = registry.rootMint()
  const w = Keypair.generate(), mintKp = Keypair.generate()
  const coinKey = sol.coinKeyFor(mintKp.publicKey.toBase58())
  const blockhash = bs58.encode(randomBytes(32))
  const ours = [SystemProgram.createAccount({ fromPubkey: w.publicKey, newAccountPubkey: mintKp.publicKey, lamports: 1_000_000, space: 82, programId: SystemProgram.programId }), sol.transferIx(w.publicKey, coinKey.publicKey, 12_500_000n)]
  const msg = new TransactionMessage({ payerKey: w.publicKey, recentBlockhash: blockhash, instructions: ours }).compileToV0Message()
  const mkRec = (id, presign = true) => {
    const rec = { id, status: 'prepared', mint: mintKp.publicKey.toBase58(), wallet: w.publicKey.toBase58(), parent, level: 1, root: false, hidden: false, expiresAt: Date.now() + 60_000, createdAt: Date.now(), symbol: 'SUB', name: 'Sub', uri: 'u', image: '', socials: {}, buyLamports: '0', fundLamports: '12500000', creatorKey: coinKey.publicKey.toBase58(), holderPool: sol.poolKeyFor(mintKp.publicKey.toBase58()).publicKey.toBase58(), parentPool: sol.poolKeyFor(parent).publicKey.toBase58(), message: Buffer.from(msg.serialize()).toString('base64'), lastValidBlockHeight: 150, builtSlot: 1, alts: [], presign }
    store.preparedStore.update(all => { all[id] = rec })
    return rec
  }
  const c = use(fakeConn())
  let journaledAtSend = null
  c.onSend = () => { if (journaledAtSend == null) journaledAtSend = store.launchesStore.get()['sub1']?.status === 'sent' }
  // the presigned tx: mint signed first (at prepare), the wallet signs second
  mkRec('sub1'); launch._secrets.set('sub1', mintKp)
  const tx = new VersionedTransaction(msg); tx.sign([mintKp]); tx.sign([w])
  const r1 = await launch.submitLaunch('sub1', Buffer.from(tx.serialize()).toString('base64'))
  await new Promise(r => setTimeout(r, 50))
  check('a byte-identical signed launch is accepted and journaled as sent', r1.status === 'sent' && store.launchesStore.get().sub1?.sig === r1.sig)
  check('the launch journal (raw bytes) is on disk BEFORE the first broadcast', journaledAtSend === true)
  check('the journal carries the persisted parent', store.launchesStore.get().sub1.parent === parent)
  check('a double submit answers with where it is, never re-sends', (await launch.submitLaunch('sub1', 'x')).sig === r1.sig)
  check('the prepared record is gone once journaled (and never held the secret)', !store.preparedStore.get().sub1 && !JSON.stringify(store.preparedStore.get()).includes(bs58.encode(mintKp.secretKey)))
  // tampered: an extra transfer
  mkRec('sub2'); launch._secrets.set('sub2', mintKp)
  const evil = new VersionedTransaction(new TransactionMessage({ payerKey: w.publicKey, recentBlockhash: blockhash, instructions: [...ours, sol.transferIx(w.publicKey, Keypair.generate().publicKey, 1n)] }).compileToV0Message()); evil.sign([w])
  const e2 = await rejects(() => launch.submitLaunch('sub2', Buffer.from(evil.serialize()).toString('base64')))
  check('a changed message is refused (the mint never signs it)', e2 && /not the one that was prepared/.test(e2.message))
  // a forged wallet signature
  const forged = new VersionedTransaction(msg); forged.signatures[0] = new Uint8Array(randomBytes(64))
  const e3 = await rejects(() => launch.submitLaunch('sub2', Buffer.from(forged.serialize()).toString('base64')))
  check('an invalid wallet signature is refused', e3 && /not valid/.test(e3.message))
  const unsigned = new VersionedTransaction(msg)
  const e4 = await rejects(() => launch.submitLaunch('sub2', Buffer.from(unsigned.serialize()).toString('base64')))
  check('a missing wallet signature is refused', e4 && /missing/.test(e4.message))
  // after a "restart": no secret in memory. A presigned identical tx still goes (its mint signature is ours)…
  mkRec('sub3'); launch._secrets.delete('sub3')
  const e5 = await rejects(() => launch.submitLaunch('sub3', Buffer.from(tx.serialize()).toString('base64')))
  check('after a restart, a presigned byte-identical launch is still relayed', !e5 && store.launchesStore.get().sub3?.status === 'sent', e5?.message)
  // …but a tx WITHOUT the mint signature cannot be completed any more
  mkRec('sub4', false); launch._secrets.delete('sub4')
  const walletOnly = new VersionedTransaction(msg); walletOnly.sign([w])
  const e6 = await rejects(() => launch.submitLaunch('sub4', Buffer.from(walletOnly.serialize()).toString('base64')))
  check('after a restart, a wallet-first tx without the mint signature is refused (410)', e6 && e6.code === 410)
  mkRec('sub5'); store.preparedStore.update(all => { all.sub5.expiresAt = Date.now() - 1 })
  const e7 = await rejects(() => launch.submitLaunch('sub5', Buffer.from(tx.serialize()).toString('base64')))
  check('an expired prepare is refused (410)', e7 && e7.code === 410)
  killMod.kill('t')
  mkRec('sub6'); launch._secrets.set('sub6', mintKp)
  const e8 = await rejects(() => launch.submitLaunch('sub6', Buffer.from(tx.serialize()).toString('base64')))
  check('the kill switch refuses a launch relay', e8 && e8.code === 503)
  killMod.unkill()
}

/* ------------------------------------------------------------------ */
section('messageIsOurs (LAUNCH_PRESIGN=false: the wallet signs first)')
{
  const A = Keypair.generate().publicKey, MINT = Keypair.generate().publicKey, C = Keypair.generate().publicKey
  const blockhash = bs58.encode(randomBytes(32))
  const create = SystemProgram.createAccount({ fromPubkey: A, newAccountPubkey: MINT, lamports: 1_000_000, space: 82, programId: SystemProgram.programId })
  const msgOf = (ixs, payer = A, alts = []) => new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts).serialize()
  const ours = msgOf([create])
  const guardIx = new TransactionInstruction({ programId: new PublicKey(M.LIGHTHOUSE_PROGRAM), keys: [{ pubkey: A, isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) })
  const budget = new TransactionInstruction({ programId: new PublicKey(M.COMPUTE_BUDGET_PROGRAM), keys: [], data: Buffer.from([3, 0, 0, 0, 0, 0, 0, 0, 0]) })
  const transfer = SystemProgram.transfer({ fromPubkey: A, toPubkey: C, lamports: 1 })
  check('identical', M.messageIsOurs(ours, ours) === true)
  check('Lighthouse before + after is accepted', M.messageIsOurs(ours, msgOf([guardIx, create, guardIx])) === true)
  check('compute budget added is accepted', M.messageIsOurs(ours, msgOf([budget, create])) === true)
  check('an extra transfer is refused', M.messageIsOurs(ours, msgOf([create, transfer])) === false)
  check('our instruction dropped is refused', M.messageIsOurs(ours, msgOf([guardIx])) === false)
  check('instruction data changed is refused', M.messageIsOurs(ours, msgOf([SystemProgram.createAccount({ fromPubkey: A, newAccountPubkey: MINT, lamports: 2_000_000, space: 82, programId: SystemProgram.programId })])) === false)
  check('the payer swapped is refused', M.messageIsOurs(ours, msgOf([create], C)) === false)
  const extraSigner = SystemProgram.createAccount({ fromPubkey: A, newAccountPubkey: C, lamports: 1, space: 0, programId: SystemProgram.programId })
  check('a new signer is refused', M.messageIsOurs(ours, msgOf([create, extraSigner])) === false)
  const other = new TransactionMessage({ payerKey: A, recentBlockhash: bs58.encode(randomBytes(32)), instructions: [create] }).compileToV0Message().serialize()
  check('a different blockhash is refused', M.messageIsOurs(ours, other) === false)
  check('garbage is refused', M.messageIsOurs(ours, Buffer.from([1, 2, 3])) === false)
  // a lookup table (first buy): resolved against the engine's own table only
  const extra = Keypair.generate().publicKey
  const alt = new AddressLookupTableAccount({ key: Keypair.generate().publicKey, state: { deactivationSlot: BigInt('18446744073709551615'), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, authority: undefined, addresses: [extra, C] } })
  const useAlt = new TransactionInstruction({ programId: SystemProgram.programId, keys: [{ pubkey: extra, isSigner: false, isWritable: false }], data: Buffer.from([9]) })
  const builtAlt = msgOf([create, useAlt], A, [alt])
  check('with a lookup table: Lighthouse added is accepted when the table is known', M.messageIsOurs(builtAlt, msgOf([guardIx, create, useAlt], A, [alt]), { alts: [alt] }) === true)
  check('with a lookup table: refused when the table is unknown (fail closed)', M.messageIsOurs(builtAlt, msgOf([guardIx, create, useAlt], A, [alt])) === false)
  check('with a lookup table: an extra transfer is still refused', M.messageIsOurs(builtAlt, msgOf([create, useAlt, transfer], A, [alt]), { alts: [alt] }) === false)
  check('sameMessage: identical bytes only', M.sameMessage(ours, ours) && !M.sameMessage(ours, msgOf([budget, create])))
}

/* ------------------------------------------------------------------ */
section('orphan adoption uses the pinned / persisted parent')
{
  const parent = addCoin({ symbol: 'ORPHP', parent: registry.rootMint() })
  const mint = wallet(), launcher = wallet()
  const ck = sol.coinKeyFor(mint).publicKey.toBase58()
  store.preparedStore.update(all => { all.orph1 = { id: 'orph1', status: 'prepared', mint, wallet: launcher, parent: parent.mint, level: parent.level + 1, root: false, hidden: false, expiresAt: Date.now() - 120_000, createdAt: Date.now() - 200_000, symbol: 'ORPH', name: 'Orphan', uri: 'u', image: '', socials: {}, buyLamports: '0', fundLamports: '12500000', creatorKey: ck, holderPool: sol.poolKeyFor(mint).publicKey.toBase58(), parentPool: sol.poolKeyFor(parent.mint).publicKey.toBase58(), message: '', lastValidBlockHeight: 150, alts: [] } })
  launch._secrets.delete('orph1') // a restart: nothing in memory
  const c = use(fakeConn())
  c.accounts.set(pump.bondingCurvePda(new PublicKey(mint)).toBase58(), await curveAccount({ creator: ck }))
  await launch.sweepPrepared()
  check('a launch broadcast without submit (across a restart) is adopted from the persisted record', store.launchesStore.get().orph1?.status === 'sent' && store.launchesStore.get().orph1.recovered === true)
  c.autoConfirm = true
  c.accounts.set(sol.poolKeyFor(parent.mint).publicKey.toBase58(), sysAcct(5_000_000))
  await launch.advanceLaunch('orph1')
  const rec = registry.coinRec(mint)
  check('…registered under the PERSISTED parent', rec && rec.parent === parent.mint && rec.level === parent.level + 1)
  check('…its lock uses its OWN pack pool (never the parent pool)', rec.shares.find(s => s.role === 'parentHolders').address === sol.poolKeyFor(mint).publicKey.toBase58())
  check('…and the lock tx was sent by the coin key with the 4 shareholders', !!rec.sharing?.address && c.sent.some(b => txFromB64(b).message.staticAccountKeys[0].toBase58() === ck))
  // a prepared record whose coin never landed is dropped once its blockhash is PROVABLY dead (finalized height past
  // its lastValidBlockHeight 150, and a caught-up read shows no curve)
  store.preparedStore.update(all => { all.orph2 = { ...all.orph1 ?? {}, id: 'orph2', mint: wallet(), creatorKey: wallet(), expiresAt: Date.now() - 700_000, lastValidBlockHeight: 150 } })
  c.height = 151
  await launch.sweepPrepared()
  check('a prepared record whose coin never landed is dropped (not adopted)', !store.preparedStore.get().orph2 && !store.launchesStore.get().orph2)
  // the pin in the metadata JSON (a lost prepared record)
  check('parentFromMetadata reads a pinned kid', JSON.stringify(M.parentFromMetadata({ gachapad: { parent: parent.mint, level: 2 } })) === JSON.stringify({ parent: parent.mint, level: 2 }))
  check('parentFromMetadata: ROOT pin, garbage, missing', M.parentFromMetadata({ gachapad: { parent: null, level: 0 } })?.level === 0 && M.parentFromMetadata({ gachapad: { parent: 'nope', level: 1 } }) === null && M.parentFromMetadata({}) === null && M.parentFromMetadata(null) === null)
  const m2 = wallet(), l2 = wallet()
  const adopted = launch.adoptWithPin(m2, { name: 'Pinned', symbol: 'PIN', uri: 'u' }, { gachapad: { parent: parent.mint, level: parent.level + 1, launcher: l2 } })
  check('adoptWithPin registers under the pinned parent with the pinned launcher', adopted.parent === parent.mint && adopted.creator === l2 && adopted.shares.find(s => s.role === 'parentHolders').address === sol.poolKeyFor(m2).publicKey.toBase58())
  check('adoptWithPin refuses a coin without a pin', throws(() => launch.adoptWithPin(wallet(), { name: 'x', symbol: 'X', uri: 'u' }, { name: 'x' })))
  check('adoptWithPin refuses a pinned parent that is not registered', throws(() => launch.adoptWithPin(wallet(), { name: 'x', symbol: 'X', uri: 'u' }, { gachapad: { parent: wallet(), level: 1, launcher: wallet() } })))
}

/* ------------------------------------------------------------------ */
section('graduated-curve guard')
{
  const k = wallet()
  const decode = async o => pump.decodeCurve(await curveAccount(o))
  const g = pump.curveFigures(await decode({ creator: k, complete: true, vt: '0', vq: '0', realTokens: '0', realSol: '0' }), null)
  check('a completed curve with zero virtual reserves is reported graduated, never divided by zero', g.graduated === true && g.progress === 1 && g.priceSol === null && g.creator === k)
  const g2 = pump.curveFigures(await decode({ creator: k, complete: false, vt: '0', vq: '0' }), null)
  check('zero virtual token reserves alone is treated as graduated', g2.graduated === true)
  const live = pump.curveFigures(await decode({ creator: k, vt: '1073000000000000', vq: '30000000000', realTokens: '793100000000000' }), null)
  check('a fresh curve: progress 0, ~28 SOL mcap, price > 0', live.graduated === false && live.progress === 0 && live.mcapSol > 27 && live.mcapSol < 29 && live.priceSol > 0)
  const c = use(fakeConn())
  const good = wallet(), bad = wallet(), grad = wallet()
  c.accounts.set(pump.bondingCurvePda(new PublicKey(good)).toBase58(), await curveAccount({ creator: k }))
  c.accounts.set(pump.bondingCurvePda(new PublicKey(bad)).toBase58(), { lamports: 1, owner: psdk.PUMP_PROGRAM_ID, executable: false, data: Buffer.from([1, 2, 3]), rentEpoch: 0 })
  c.accounts.set(pump.bondingCurvePda(new PublicKey(grad)).toBase58(), await curveAccount({ creator: k, complete: true, vt: '0', vq: '0' }))
  const m = await pump.readCurves([good, bad, grad, wallet()])
  check('readCurves: one unreadable / graduated curve never takes the others down', m.get(good)?.graduated === false && m.get(bad) === null && m.get(grad)?.graduated === true)
}

/* ------------------------------------------------------------------ */
section('holder round math')
{
  const a = wallet(), b = wallet(), cc = wallet(), d = wallet()
  const w = M.minWeights({ [a]: '100', [b]: '50', [cc]: '10' }, { [a]: '80', [b]: '70', [d]: '999' })
  check('weight = min(open, close)', w.get(a) === 80n && w.get(b) === 50n)
  check('bought after the open snapshot → weight 0 (dropped)', !w.has(d))
  check('sold out before the close → weight 0 (dropped)', !w.has(cc))
  const pool = wallet(), coinKeyX = wallet()
  const weights = new Map([[a, 10n ** 12n], [b, 10n ** 11n], [offCurve(), 10n ** 13n], ['11111111111111111111111111111111', 10n ** 13n], [pool, 10n ** 13n], [coinKeyX, 10n ** 13n], [E, 10n ** 13n], [cc, 5n]])
  const ranked = M.rankEligible(weights, { excluded: new Set([pool, coinKeyX, E]), minTokensRaw: 1000n })
  check('exclusions: off-curve (curve/AMM pools), reserved program keys, every pool / coin key / engine, dust', ranked.length === 2 && ranked[0].owner === a && ranked[1].owner === b)
  const reservedOnCurve = ['NativeLoader1111111111111111111111111111111', 'Sysvar1111111111111111111111111111111111111', 'Stake11111111111111111111111111111111111111']
  check('runtime-reserved on-curve keys are never payees', reservedOnCurve.every(M.isReservedKey))
  const kinds = new Map([[a, { kind: 'wallet', lamports: 5_000_000n }], [b, { kind: 'wallet', lamports: 5_000_000n }]])
  let exact = true, capOk = true
  for (let i = 0; i < 500; i++) {
    const n = 1 + Math.floor(Math.random() * 60)
    const cands = Array.from({ length: n }, () => ({ owner: wallet(), weight: BigInt(Math.floor(Math.random() * 1e12) + 1) })).sort((x, y) => (y.weight > x.weight ? 1 : -1))
    const ks = new Map(cands.map(x => [x.owner, { kind: Math.random() < 0.1 ? 'program' : 'wallet', lamports: Math.random() < 0.25 ? 0n : 1_000_000n }]))
    const budget = BigInt(Math.floor(Math.random() * 3e9))
    const r = M.allocateRound({ budget, candidates: cands, kinds: ks, maxShareBps: 500, minPayout: 1_000_000n, rent0: RENT0, maxRecipients: 40 })
    if (r.items.reduce((s, x) => s + x.lamports, 0n) + r.leftover !== budget) exact = false
    const cap = (budget * 500n) / 10_000n
    if (r.items.some(x => x.lamports > cap || x.lamports < 1_000_000n || (ks.get(x.wallet).lamports === 0n && x.lamports < RENT0) || ks.get(x.wallet).kind !== 'wallet')) capOk = false
    if (r.items.length > 40) capOk = false
  }
  check('500 random rounds: Σ paid + leftover === budget exactly (BigInt)', exact)
  check('…every payout ≤ the cap, ≥ the minimum, ≥ rent(0) for missing accounts, never a program account, ≤ MAX_RECIPIENTS', capOk)
  const whale = wallet(), minnow = wallet()
  const cap = M.allocateRound({ budget: 1_000_000_000n, candidates: [{ owner: whale, weight: 9_000n }, { owner: minnow, weight: 1_000n }], kinds: new Map([[whale, { kind: 'wallet', lamports: 1n }], [minnow, { kind: 'wallet', lamports: 1n }]]), maxShareBps: 500, minPayout: 1_000_000n, rent0: RENT0, maxRecipients: 400 })
  check('the cap: a 90% whale gets 5% of the budget, the excess STAYS in the pool (leftover)', cap.items.find(i => i.wallet === whale).lamports === 50_000_000n && cap.leftover === 1_000_000_000n - 50_000_000n - 50_000_000n)
  const miss = wallet(), has = wallet()
  const rr = M.allocateRound({ budget: 10_000_000n, candidates: [{ owner: miss, weight: 55n }, { owner: has, weight: 45n }], kinds: new Map([[miss, { kind: 'wallet', lamports: 0n }], [has, { kind: 'wallet', lamports: 2n }]]), maxShareBps: 10_000, minPayout: 1_000_000n, rent0: 6_000_000n, maxRecipients: 400 })
  check('rent(0) rule: a MISSING account whose share is below rent(0) is skipped (stays in the pool)', !rr.items.some(i => i.wallet === miss) && rr.items.some(i => i.wallet === has) && rr.leftover === 5_500_000n)
  const rr2 = M.allocateRound({ budget: 20_000_000n, candidates: [{ owner: miss, weight: 55n }, { owner: has, weight: 45n }], kinds: new Map([[miss, { kind: 'wallet', lamports: 0n }], [has, { kind: 'wallet', lamports: 2n }]]), maxShareBps: 10_000, minPayout: 1_000_000n, rent0: 6_000_000n, maxRecipients: 400 })
  check('…and paid once its share reaches rent(0)', rr2.items.find(i => i.wallet === miss)?.lamports === 11_000_000n)
  const many = Array.from({ length: 50 }, (_, i) => ({ owner: wallet(), weight: BigInt(1000 - i) }))
  const mr = M.allocateRound({ budget: 10_000_000_000n, candidates: many, kinds: new Map(many.map(x => [x.owner, { kind: 'wallet', lamports: 1n }])), maxShareBps: 10_000, minPayout: 1n, rent0: 1n, maxRecipients: 10 })
  check('MAX_RECIPIENTS: only the top N by weight share the budget', mr.items.length === 10 && mr.items.every((it, i) => it.wallet === many[i].owner))
  const prog = wallet()
  const pr = M.allocateRound({ budget: 10_000_000n, candidates: [{ owner: prog, weight: 10n }], kinds: new Map([[prog, { kind: 'program', lamports: 5n }]]), maxShareBps: 10_000, minPayout: 1n, rent0: 1n, maxRecipients: 10 })
  check('program-owned / executable holders are never paid', pr.items.length === 0 && pr.leftover === 10_000_000n)
  check('an empty or negative budget pays nobody', M.allocateRound({ budget: 0n, candidates: many, kinds: new Map(), maxShareBps: 500, minPayout: 1n, rent0: 1n, maxRecipients: 10 }).items.length === 0)
  // planRound: budget = pool − reserve − fees; exclusions from the registry
  const parent = registry.coinRec(registry.rootMint())
  const ex = rounds.roundExclusions(parent.holderPool)
  const everyCoinKey = Object.values(registry.coins()).every(cn => ex.has(cn.mint) && ex.has(cn.holderPool) && (!cn.creatorKey || ex.has(cn.creatorKey)) && (!cn.parentPool || ex.has(cn.parentPool)))
  check('round exclusions: every coin mint / coin key / holder pool / parent pool', everyCoinKey)
  check('…plus engine, protocol, burn, programs and the paying pool itself', ex.has(E) && ex.has(P) && ex.has(B) && ex.has(parent.holderPool) && ex.has('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'))
  const h1 = wallet(), h2 = wallet()
  const tok = x => BigInt(x) * 1_000_000n
  const plan = rounds.planRound({ open: { [h1]: tok(3_000_000).toString(), [h2]: tok(1_000_000).toString(), [parent.holderPool]: tok(9_000_000).toString() }, close: { [h1]: tok(3_000_000).toString(), [h2]: tok(1_000_000).toString(), [parent.holderPool]: tok(9_000_000).toString() }, poolLamports: 1_000_000_000n, kinds: new Map([[h1, { kind: 'wallet', lamports: 1n }], [h2, { kind: 'wallet', lamports: 1n }]]), excluded: ex, rent: RENT0 })
  const reserve = RENT0 + sol.toLamports(config.poolMarginSol) + paysol.roundFeeLamports(2)
  check('planRound: budget = pool − (rent(0) + margin) − the round’s tx fees', plan.budget === 1_000_000_000n - reserve)
  check('planRound: the pool’s own holding is never a payee; 5% cap applies', plan.items.length === 2 && !plan.items.some(i => i.wallet === parent.holderPool) && plan.items.every(i => i.lamports <= (plan.budget * 500n) / 10_000n))
  check('planRound: a pool at its reserve pays nobody', rounds.planRound({ open: { [h1]: '5' }, close: { [h1]: '5' }, poolLamports: RENT0, kinds: new Map(), excluded: ex, rent: RENT0 }).items.length === 0)
  const rows = [{ account: { data: Buffer.concat([new PublicKey(h1).toBuffer(), Buffer.from(new BigUint64Array([7n]).buffer)]) } }, { account: { data: Buffer.concat([new PublicKey(h1).toBuffer(), Buffer.from(new BigUint64Array([3n]).buffer)]) } }, { account: { data: Buffer.concat([new PublicKey(h2).toBuffer(), Buffer.from(new BigUint64Array([0n]).buffer)]) } }]
  const folded = M.foldHolders(rows)
  check('gPA slices fold per owner (two accounts summed), zero balances dropped', folded.get(h1) === 10n && !folded.has(h2))
  const c = use(fakeConn())
  let gpaArgs = null
  c.getProgramAccounts = async (prog, cfg) => { gpaArgs = { prog: String(prog), cfg }; return rows }
  c.accounts.set(parent.mint, { lamports: 1, owner: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), executable: false, data: Buffer.alloc(82), rentEpoch: 0 })
  const snap = await rounds.snapshotHolders(parent.mint)
  check('snapshot: Token-2022, memcmp mint @0, dataSlice {32,40}, and NO dataSize filter', gpaArgs.prog === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' && gpaArgs.cfg.filters.length === 1 && gpaArgs.cfg.filters[0].memcmp.offset === 0 && gpaArgs.cfg.filters[0].memcmp.bytes === parent.mint && gpaArgs.cfg.dataSlice.offset === 32 && gpaArgs.cfg.dataSlice.length === 40 && !gpaArgs.cfg.filters.some(f => f.dataSize) && snap.get(h1) === 10n)
}

/* ------------------------------------------------------------------ */
section('settleTx verdicts (fake chain)')
{
  const fast = { deadlineMs: 400, pollMs: 20 }
  let c = fakeConn(); c.statuses.set('S1', { confirmationStatus: 'confirmed', err: null })
  check('confirmed', (await sol.settleTx({ raw: Buffer.from('aa'), sig: 'S1', lastValidBlockHeight: 150 }, { ...fast, conn: c })).status === 'confirmed')
  c = fakeConn(); c.statuses.set('S2', { confirmationStatus: 'confirmed', err: { InstructionError: [0, 'Custom'] } })
  check('landed with an error = failed (nothing moved)', (await sol.settleTx({ raw: Buffer.from('aa'), sig: 'S2', lastValidBlockHeight: 150 }, { ...fast, conn: c })).status === 'failed')
  c = fakeConn(); c.height = 151; c.sendRawTransaction = async raw => { c.sent.push(Buffer.from(raw).toString('base64')); return 'x' }
  check('finalized past the last valid height + unknown signature = provably not landed', (await sol.settleTx({ raw: Buffer.from('aa'), sig: 'S3', lastValidBlockHeight: 150 }, { ...fast, conn: c })).status === 'not-landed')
  c = fakeConn(); c.height = 150; c.sendRawTransaction = async raw => { c.sent.push(Buffer.from(raw).toString('base64')); return 'x' }
  const r4 = await sol.settleTx({ raw: Buffer.from('aa'), sig: 'S4', lastValidBlockHeight: 150 }, { ...fast, conn: c })
  check('blockhash still valid + unknown = ambiguous, NEVER not-landed', r4.status === 'ambiguous')
  check('the same bytes were re-broadcast, never different ones', c.sent.length >= 1 && new Set(c.sent).size === 1)
  c = fakeConn(); c.throwStatus = true; c.height = 9999
  check('RPC down = ambiguous even when the height looks expired', (await sol.settleTx({ raw: Buffer.from('aa'), sig: 'S5', lastValidBlockHeight: 150 }, { ...fast, conn: c, broadcast: false })).status === 'ambiguous')
  c = fakeConn(); c.height = 151
  let calls = 0
  c.getSignatureStatuses = async sigs => { calls++; return { context: { slot: 5000 }, value: sigs.map(() => (calls >= 2 ? { confirmationStatus: 'finalized', err: null } : null)) } }
  check('a tx indexed late is found by the second look, not written off', (await sol.settleTx({ raw: Buffer.from('aa'), sig: 'S6', lastValidBlockHeight: 150 }, { ...fast, conn: c, broadcast: false })).status === 'confirmed')
  c = fakeConn(); c.statuses.set('S8', { confirmationStatus: 'processed', err: { InstructionError: [0, 'x'] } })
  check('an error seen only at `processed` (a fork) is NOT a verdict', (await sol.settleTx({ raw: Buffer.from('aa'), sig: 'S8', lastValidBlockHeight: 150 }, { ...fast, conn: c, broadcast: false })).status === 'ambiguous')
  c = fakeConn(); c.height = 151; c.statusSlot = 4000
  check('a lagging node (lookup answered at an older slot) cannot prove not-landed', (await sol.settleTx({ raw: Buffer.from('aa'), sig: 'S9', lastValidBlockHeight: 150 }, { ...fast, conn: c, broadcast: false })).status === 'ambiguous')
  c = fakeConn(); c.height = 151; c.firstBlock = 4900
  check('a node that pruned the ledger past the build slot cannot prove not-landed', (await sol.settleTx({ raw: Buffer.from('aa'), sig: 'S10', lastValidBlockHeight: 150, builtSlot: 4800 }, { ...fast, conn: c, broadcast: false })).status === 'ambiguous')
  check('…but one that still holds it can', (await sol.settleTx({ raw: Buffer.from('aa'), sig: 'S11', lastValidBlockHeight: 150, builtSlot: 4950 }, { ...fast, conn: c, broadcast: false })).status === 'not-landed')
  c = fakeConn(); let sent = 0; c.sendRawTransaction = async () => { sent++; return 'x' }
  await sol.settleTx({ raw: Buffer.from('aa'), sig: 'S7', lastValidBlockHeight: 150 }, { ...fast, conn: c, broadcast: false })
  check('broadcast:false never sends', sent === 0)
  c = fakeConn(); c.statuses.set('S12', { confirmationStatus: 'finalized', err: null })
  check('/tx/status: landed', (await sol.sigStatus('S12', 150, c)) === 'landed')
  c = fakeConn(); c.height = 500
  // (review 2 #7: one null lookup is no longer enough — the caught-up proof must be seen twice, seconds apart)
  const s13a = await sol.sigStatus('S13', 150, c)
  const realNow13 = Date.now
  let s13b
  try { Date.now = () => realNow13() + 3000; s13b = await sol.sigStatus('S13', 150, c) } finally { Date.now = realNow13 }
  check('/tx/status: dead only past lastValidBlockHeight + 40 at finalized', s13a === 'pending' && s13b === 'dead' && (await sol.sigStatus('S14', 470, c)) === 'pending' && (await sol.sigStatus('S15', null, c)) === 'pending', `${s13a} / ${s13b}`)
}

/* ------------------------------------------------------------------ */
section('holder payouts: exactly once')
{
  const parent = addCoin({ symbol: 'PAYP' })
  const poolW = sol.poolKeyFor(parent.mint).publicKey.toBase58()
  const pool = { parentMint: parent.mint, symbol: 'PAYP', poolWallet: poolW }
  const fast = { settle: { deadlineMs: 300, pollMs: 20 } }
  const mkRound = (n, lamports = 3_000_000n) => {
    const id = store.newId(6), items = Array.from({ length: n }, () => ({ wallet: wallet(), lamports, weight: 1n }))
    store.roundsStore.update(s => { s.rounds.push({ id, parentMint: parent.mint, parentSymbol: 'PAYP', pool: poolW, openedAt: Date.now() - 1000, closedAt: Date.now(), budgetLamports: '0', lines: items.map(i => ({ wallet: i.wallet, weight: '1', lamports: String(i.lamports), sig: null, status: 'pending' })), status: 'paying', sigs: [] }) })
    return { id, items }
  }
  const status = (id, w) => rounds.roundById(id).lines.find(l => l.wallet === w)?.status
  // 1. happy path: journaled BEFORE the first broadcast, paid once
  let c = use(fakeConn()), journaledAtSend = null
  c.onSend = () => { if (journaledAtSend == null) journaledAtSend = store.readPendingIntents(poolW).length }
  c.autoConfirm = true
  const r1 = mkRound(3)
  const res = await paysol.payPoolShares(pool, r1.items, { roundId: r1.id, ...fast })
  check('3 holders paid in one tx', res.paid.length === 3 && !res.halted && c.sent.length === 1, JSON.stringify({ n: res.paid.length, h: res.reason }))
  check('the intent was on disk before the first broadcast', journaledAtSend === 1)
  check('the intent journal is empty afterwards', store.readPendingIntents().length === 0)
  check('lines marked paid with the signature', r1.items.every(i => status(r1.id, i.wallet) === 'paid') && rounds.roundById(r1.id).sigs.length === 1)
  check('the pool ledger booked once per payee', store.poolLedger(parent.mint).paidCount === 3 && store.poolLedger(parent.mint).paidLamports === '9000000')
  check('booking again with the same key is a no-op', store.bookPayout(parent.mint, 3_000_000n, `${rounds.roundById(r1.id).sigs[0]}:${r1.items[0].wallet}`) === false && store.poolLedger(parent.mint).paidCount === 3)
  const again = await paysol.payPoolShares(pool, r1.items, { roundId: r1.id, ...fast })
  check('paying the same lines again sends NOTHING (lines no longer pending)', again.paid.length === 0 && c.sent.length === 1)
  // 2. batching of 12
  c = use(fakeConn()); c.autoConfirm = true
  const r2 = mkRound(config.payoutsPerTx + 3)
  const rb = await paysol.payPoolShares(pool, r2.items, { roundId: r2.id, ...fast })
  check(`${config.payoutsPerTx + 3} holders → 2 transactions of ≤ 12, all paid`, rb.paid.length === r2.items.length && c.sent.length === 2 && transfersIn(c.sent[0]).length === 12)
  // 3. underfunded pool
  c = use(fakeConn()); c.balance = 4_000_000
  const r3 = mkRound(1)
  const ru = await paysol.payPoolShares(pool, r3.items, { roundId: r3.id, ...fast })
  check('a pool that cannot keep its reserve (rent + margin) sends nothing', ru.halted && c.sent.length === 0 && status(r3.id, r3.items[0].wallet) === 'pending' && store.readPendingIntents().length === 0)
  // 4. one unpayable address in a batch: the others are still paid, singly
  c = use(fakeConn()); c.autoConfirm = true
  const r4 = mkRound(3); const badW = r4.items[1].wallet
  c.simErr = tx => (tx.message.staticAccountKeys.some(k => k.toBase58() === badW) ? { InstructionError: [2, 'x'] } : null)
  const rm = await paysol.payPoolShares(pool, r4.items, { roundId: r4.id, ...fast })
  check('a poisoned batch is retried singly: good payees paid, the bad one refused, nothing halted', rm.paid.length === 2 && !rm.halted && status(r4.id, badW) === 'refused' && rm.refused[0] === badW)
  c = use(fakeConn()); c.simulateTransaction = async () => { throw new Error('fetch failed') }
  const r5 = mkRound(2)
  const rr = await paysol.payPoolShares(pool, r5.items, { roundId: r5.id, ...fast })
  check('an RPC error during simulation excludes nobody: the pass just stops', rr.halted && !rr.refused.length && c.sent.length === 0 && r5.items.every(i => status(r5.id, i.wallet) === 'pending'))
  // 5. landed with an error
  c = use(fakeConn()); c.getSignatureStatuses = async sigs => ({ context: { slot: 5000 }, value: sigs.map(() => ({ confirmationStatus: 'confirmed', err: { x: 1 } })) })
  const r6 = mkRound(1)
  await paysol.payPoolShares(pool, r6.items, { roundId: r6.id, ...fast })
  check('a failed tx: nothing moved, the line is marked failed, nothing booked', status(r6.id, r6.items[0].wallet) === 'failed' && store.poolLedger(parent.mint).paidCount === 3 + r2.items.length + 2 && store.readPendingIntents().length === 0)
  // 6. provably not landed: nothing moved and nothing can — the line stays pending and is rebuilt next pass (R4#4)
  c = use(fakeConn()); c.height = 999
  const r7 = mkRound(1)
  await paysol.payPoolShares(pool, r7.items, { roundId: r7.id, ...fast })
  check('an expired tx: the line stays pending (rebuilt next pass), nothing booked, no intent left', status(r7.id, r7.items[0].wallet) === 'pending' && store.readPendingIntents().length === 0 && store.poolLedger(parent.mint).paidCount === 3 + r2.items.length + 2)
  // 7. no verdict: the intent WAITS, THIS pool is blocked, another pool is not
  c = use(fakeConn()); c.throwStatus = true
  const r8 = mkRound(1)
  const ra = await paysol.payPoolShares(pool, r8.items, { roundId: r8.id, ...fast })
  check('no verdict → halted, intent kept, line neither paid nor failed', ra.halted && ra.fatal && store.readPendingIntents(poolW).length === 1 && status(r8.id, r8.items[0].wallet) === 'pending')
  const r8b = mkRound(1)
  const blocked = await paysol.payPoolShares(pool, r8b.items, { roundId: r8b.id, ...fast })
  check('the SAME pool pays nothing while its intent is unresolved', blocked.halted && /unresolved/.test(blocked.reason) && status(r8b.id, r8b.items[0].wallet) === 'pending')
  const other = addCoin({ symbol: 'OTHERP' })
  const oPool = { parentMint: other.mint, symbol: 'OTHERP', poolWallet: sol.poolKeyFor(other.mint).publicKey.toBase58() }
  const oid = store.newId(6), ow = wallet()
  store.roundsStore.update(s => { s.rounds.push({ id: oid, parentMint: other.mint, pool: oPool.poolWallet, lines: [{ wallet: ow, weight: '1', lamports: '3000000', status: 'pending' }], status: 'paying', sigs: [] }) })
  c.throwStatus = false; c.autoConfirm = true
  const ro = await paysol.payPoolShares(oPool, [{ wallet: ow, lamports: 3_000_000n }], { roundId: oid, ...fast })
  check('…while ANOTHER pool keeps paying (the block is scoped to the pool)', ro.paid.length === 1)
  c.throwStatus = true
  check('recovery keeps waiting while the chain is unreadable', (await paysol.resolvePendingIntents({ poolWallet: poolW, deadlineMs: 200, settle: { pollMs: 20 } })) === false && store.readPendingIntents(poolW).length === 1)
  c.throwStatus = false; c.getSignatureStatuses = async sigs => ({ context: { slot: 5000 }, value: sigs.map(() => ({ confirmationStatus: 'finalized', err: null })) })
  const before = store.poolLedger(parent.mint).paidCount
  const nSent = c.sent.length
  check('recovery settles it from the chain and books it once', (await paysol.resolvePendingIntents({ poolWallet: poolW, deadlineMs: 300, settle: { pollMs: 20 } })) === true && status(r8.id, r8.items[0].wallet) === 'paid' && store.poolLedger(parent.mint).paidCount === before + 1)
  check('…re-broadcasting only the journaled bytes', c.sent.slice(nSent).every(b => b === c.sent[nSent]))
  // 8. stale unknowable intent → quarantined, never resent
  c = use(fakeConn()); c.throwStatus = true
  const r9 = mkRound(1)
  await paysol.payPoolShares(pool, r9.items, { roundId: r9.id, ...fast })
  const okq = await paysol.resolvePendingIntents({ poolWallet: poolW, deadlineMs: 100, quarantineAfterMs: 0, settle: { pollMs: 20 } })
  check('a stale unknowable intent → quarantined (booked as possibly sent), line flagged', okq && status(r9.id, r9.items[0].wallet) === 'quarantined' && store.readQuarantine().some(q => q.wallet === r9.items[0].wallet) && store.poolLedger(parent.mint).quarantinedCount === 1)
  // 9. guards
  c = use(fakeConn()); c.autoConfirm = true
  const wrong = { ...pool, poolWallet: wallet() }
  const r10 = mkRound(1)
  check('a pool wallet that is not the derived key is never touched', (await paysol.payPoolShares(wrong, r10.items, { roundId: r10.id, ...fast })).halted && c.sent.length === 0)
  const selfId = store.newId(6)
  store.roundsStore.update(s => { s.rounds.push({ id: selfId, parentMint: parent.mint, pool: poolW, lines: [{ wallet: poolW, weight: '1', lamports: '3000000', status: 'pending' }], status: 'paying', sigs: [] }) })
  await paysol.payPoolShares(pool, [{ wallet: poolW, lamports: 3_000_000n }], { roundId: selfId, ...fast })
  check('the pool never pays itself', c.sent.length === 0)
  // 10. two concurrent senders on one round: each line paid exactly once
  c = use(fakeConn()); c.autoConfirm = true
  const r11 = mkRound(30)
  await Promise.all([paysol.payPoolShares(pool, r11.items, { roundId: r11.id, ...fast }), paysol.payPoolShares(pool, r11.items, { roundId: r11.id, ...fast }), paysol.payPoolShares(pool, r11.items, { roundId: r11.id, ...fast })])
  await paysol.payPoolShares(pool, r11.items, { roundId: r11.id, ...fast }) // whatever a halted sender left
  const counts = new Map()
  for (const b of c.sent) for (const to of transfersIn(b)) counts.set(to, (counts.get(to) || 0) + 1)
  check('three concurrent senders on one round: every holder paid exactly once', r11.items.every(i => counts.get(i.wallet) === 1) && r11.items.every(i => status(r11.id, i.wallet) === 'paid'))
  check('…and no transaction was ever built twice for a line', [...counts.values()].every(v => v === 1) && c.sent.length === 3)
}

/* ------------------------------------------------------------------ */
section('kill switch stops sends mid-round; unkill finishes without re-paying')
{
  const parent = addCoin({ symbol: 'KILLP' })
  const poolW = sol.poolKeyFor(parent.mint).publicKey.toBase58()
  const c = use(fakeConn()); c.autoConfirm = true
  const id = store.newId(6)
  const items = Array.from({ length: 30 }, () => ({ wallet: wallet(), lamports: 3_000_000n }))
  store.roundsStore.update(s => { s.rounds.push({ id, parentMint: parent.mint, parentSymbol: 'KILLP', pool: poolW, openedAt: Date.now() - 1000, closedAt: Date.now(), budgetLamports: '0', lines: items.map(i => ({ wallet: i.wallet, weight: '1', lamports: String(i.lamports), sig: null, status: 'pending' })), status: 'paying', sigs: [] }) })
  c.onSend = () => { if (c.sent.length === 1) killMod.kill('mid-round') }
  const r = await rounds.payRound(rounds.roundById(id), { settle: { deadlineMs: 300, pollMs: 20 } })
  const paidNow = rounds.roundById(id).lines.filter(l => l.status === 'paid').length
  check('the kill switch stops the round after the batch in flight (checked at send time)', c.sent.length === 1 && paidNow === 12 && rounds.roundById(id).status === 'paying')
  const r2 = await rounds.payRound(rounds.roundById(id), { settle: { deadlineMs: 300, pollMs: 20 } })
  check('while killed, a round sends nothing', r2.note === 'killed' && c.sent.length === 1)
  killMod.unkill(); c.onSend = null
  const r3 = await rounds.payRound(rounds.roundById(id), { settle: { deadlineMs: 300, pollMs: 20 } })
  const counts = new Map()
  for (const b of c.sent) for (const to of transfersIn(b)) counts.set(to, (counts.get(to) || 0) + 1)
  check('unkill + continue pays the rest without re-paying anyone', rounds.roundById(id).status === 'done' && items.every(i => counts.get(i.wallet) === 1) && c.sent.length === 3, JSON.stringify(r3))
  check('the kill file works without the HTTP server (touch DATA_DIR/KILL)', (() => { writeFileSync(config.killFile, 'x'); const k = killMod.isKilled(); killMod.unkill(); return k && !killMod.isKilled() })())
  config.payoutsLive = false
  const id2 = store.newId(6)
  store.roundsStore.update(s => { s.rounds.push({ id: id2, parentMint: parent.mint, pool: poolW, closedAt: Date.now(), lines: [{ wallet: wallet(), weight: '1', lamports: '3000000', status: 'pending' }], status: 'paying', sigs: [] }) })
  const n = c.sent.length
  await rounds.payRound(rounds.roundById(id2))
  check('PAYOUTS_LIVE=false sends nothing', c.sent.length === n)
  config.payoutsLive = true
}

/* ------------------------------------------------------------------ */
section('a full round: open → close → pay (fake chain)')
{
  const parent = addCoin({ symbol: 'RNDP' })
  addCoin({ symbol: 'RNDK', parent: parent.mint })
  const poolW = parent.holderPool
  const h = Array.from({ length: 5 }, () => wallet())
  const slice = (o, amt) => ({ account: { data: Buffer.concat([new PublicKey(o).toBuffer(), Buffer.from(new BigUint64Array([amt]).buffer)]) } })
  const c = use(fakeConn()); c.autoConfirm = true
  c.accounts.set(parent.mint, { lamports: 1, owner: new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'), executable: false, data: Buffer.alloc(82), rentEpoch: 0 })
  c.gpa = h.map((o, i) => slice(o, BigInt((i + 1) * 100_000) * 1_000_000n))
  registry.setLive(parent.mint, { poolLamports: '2000000000' }) // the refresh saw its locked kid's fees arrive
  const o1 = await rounds.roundStep(parent.mint)
  check('a parent whose pool holds fees opens a round with an open snapshot', !!o1.opened && rounds.roundById(o1.opened).status === 'open')
  c.gpa = [...h.slice(0, 4).map((o, i) => slice(o, BigInt((i + 1) * 100_000) * 1_000_000n)), slice(wallet(), 10n ** 15n)] // the last holder sold out; a new whale bought
  c.balances.set(poolW, 2_000_000_000)
  for (const o of h) c.accounts.set(o, sysAcct(1_000_000))
  const cl = await rounds.roundStep(parent.mint, { force: true, settle: { deadlineMs: 300, pollMs: 20 } })
  const closed = rounds.roundById(o1.opened)
  check('close: weights = min(open, close) → the seller and the late whale get nothing', closed.lines.length === 4 && !closed.lines.some(l => l.wallet === h[4]))
  check('the round paid every line and is done', closed.status === 'done' && closed.lines.every(l => l.status === 'paid'), JSON.stringify(cl))
  check('the close snapshot opened the next round', rounds.rounds().some(r => r.parentMint === parent.mint && r.status === 'open' && r.id !== o1.opened))
  check('budget = pool − reserve − fees, and nothing more than the budget left the pool', BigInt(closed.budgetLamports) <= 2_000_000_000n - RENT0 && closed.lines.reduce((a, l) => a + BigInt(l.lamports), 0n) <= BigInt(closed.budgetLamports))
  check('a round event was emitted', store.eventsStore.get().some(e => e.type === 'round' && e.extra?.roundId === o1.opened))
  const lonely = addCoin({ symbol: 'LONELY' })
  check('a parent without locked kids and with an empty pool opens no round (no RPC)', !!(await rounds.roundStep(lonely.mint)).note)
}

/* ------------------------------------------------------------------ */
section('hidden coins')
{
  const root = addCoin({ symbol: 'HROOT' })
  const vis = addCoin({ symbol: 'HVIS', parent: root.mint })
  const hid = addCoin({ symbol: 'HHID', parent: root.mint, hidden: true })
  const under = addCoin({ symbol: 'HUNDER', parent: hid.mint })
  check('a hidden coin and its whole subtree are invisible', !registry.isVisible(hid.mint) && !registry.isVisible(under.mint) && registry.isVisible(vis.mint))
  check('hidden coins are excluded from the public list', !registry.allRecs().some(c => c.mint === hid.mint || c.mint === under.mint) && registry.allRecs({ includeHidden: true }).some(c => c.mint === hid.mint))
  check('hidden kids do not count in the parent’s kids', registry.view(registry.coinRec(root.mint)).kids === 1)
  check('the tree is built from visible coins only', !registry.allRecs().map(registry.treeNode).some(n => n.mint === hid.mint))
  registry.setHidden(hid.mint, false)
  check('POST /admin/hide {hidden:false} makes it (and its subtree) visible again', registry.isVisible(hid.mint) && registry.isVisible(under.mint))
}

/* ------------------------------------------------------------------ */
section('/tx/send refuses engine-signed txs')
{
  use(fakeConn())
  const parent = addCoin({ symbol: 'TXP' })
  const kid = addCoin({ symbol: 'TXK', parent: parent.mint })
  const user = Keypair.generate()
  const mk = (payer, extraSigner = null, signers = []) => {
    const ixs = [sol.transferIx(payer.publicKey, Keypair.generate().publicKey, 1n)]
    if (extraSigner) ixs.push(sol.transferIx(extraSigner, Keypair.generate().publicKey, 1n))
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: bs58.encode(randomBytes(32)), instructions: ixs }).compileToV0Message())
    tx.sign([payer, ...signers])
    return Buffer.from(tx.serialize()).toString('base64')
  }
  const ok = await rejects(() => trades.relay(mk(user), { send: false }))
  check('a user-signed tx is relayed (and journaled)', !ok && store.relaysStore.get().length >= 1)
  const e1 = await rejects(() => trades.relay(mk(ENGINE), { send: false }))
  check('a tx signed-for by the engine wallet is refused (403)', e1 && e1.code === 403)
  const e2 = await rejects(() => trades.relay(mk(user, sol.poolKeyFor(parent.mint).publicKey), { send: false }))
  check('a tx that needs a holder-pool signature is refused', e2 && e2.code === 403)
  const e3 = await rejects(() => trades.relay(mk(user, sol.coinKeyFor(kid.mint).publicKey), { send: false }))
  check('a tx that needs a coin-key signature is refused', e3 && e3.code === 403)
  const e4 = await rejects(() => trades.relay(mk(user, BURN.publicKey), { send: false }))
  check('a tx that needs the burn wallet is refused', e4 && e4.code === 403)
  const unsigned = Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: bs58.encode(randomBytes(32)), instructions: [sol.transferIx(user.publicKey, wallet(), 1n)] }).compileToV0Message()).serialize()).toString('base64')
  check('an unsigned tx is refused', (await rejects(() => trades.relay(unsigned, { send: false })))?.code === 400)
  check('garbage is refused', (await rejects(() => trades.relay('bm9wZQ==', { send: false })))?.code === 400)
  const tx = VersionedTransaction.deserialize(Buffer.from(mk(user), 'base64'))
  check('assertSoleSigner: only the wallet may sign what the engine builds', trades.assertSoleSigner(tx, user.publicKey.toBase58()) && throws(() => trades.assertSoleSigner(tx, wallet())))
}

/* ------------------------------------------------------------------ */
section('stores + guards')
{
  const f = join(config.dataDir, 'corrupt-test.json')
  writeFileSync(f, '{not json')
  const ms = store.moneyStore('corrupt-test', () => ({}))
  check('a corrupt money store refuses to load (fail closed)', throws(() => ms.get()))
  check('case-sensitive ledger keys', (() => { const m = wallet(); store.bookPayout(m, 5n, 'k-case'); return store.poolLedger(m).paidCount === 1 && store.poolLedger(m.toLowerCase()).paidCount === (m.toLowerCase() === m ? 1 : 0) })())
  check('identity: same chain + key ok', guard.identityDecision({ chainId: 'solana-mainnet', treasury: 'A', factories: [] }, { chainId: 'solana-mainnet', treasury: 'A', factories: [] }) === 'ok')
  check('identity: another engine key refuses', String(guard.identityDecision({ chainId: 'solana-mainnet', treasury: 'A', factories: [] }, { chainId: 'solana-mainnet', treasury: 'B', factories: [] })).includes('belongs'))
  check('isWalletKey / isPubkey', sol.isWalletKey(wallet()) && sol.isPubkey(offCurve()) && !sol.isWalletKey(offCurve()) && !sol.isPubkey('abc'))
  check('tx fee helper (5000 + CU × price)', sol.txFeeLamports(200_000) === 5000n + 10_000n)
  check('round fee covers every tx of the round', paysol.roundFeeLamports(25) === 3n * paysol.roundFeeLamports(1))
  check('chunkItems keeps order and size', JSON.stringify(M.chunkItems([1, 2, 3, 4, 5], 2)) === '[[1,2],[3,4],[5]]')
  check('rent(0) comes from the chain (never a hardcoded 890,880)', sol.rent0() === 650_240n && !readFileSync(new URL('./solana.js', import.meta.url), 'utf-8').includes('890_880') && !readFileSync(new URL('./pump.js', import.meta.url), 'utf-8').includes('890_880'))
  check('prepared records on disk never hold a secret key', !JSON.stringify(store.preparedStore.get()).includes(bs58.encode(ENGINE.secretKey)))
}

/* ------------------------------------------------------------------ */
section('review fixes (regressions, one block per confirmed finding)')

// A block that throws counts as ONE failure (a missing export must not abort the whole suite).
const block = async (name, fn) => { try { await fn() } catch (e) { fail++; console.error(`  ✗ ${name} threw: ${e?.stack || e}`) } }
const PNG = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString('base64')
const T22 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')
const TOKENKEG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
const ATA_RENT = Number((RENT0 * 293n + 127n) / 128n) // rent of a 165-byte token account (1,488,440 at rent(0) 650,240)
const filesIn = d => { try { return readdirSync(d).length } catch { return 0 } }
// pump Global + FeeConfig encoded from the IDL (zero values + what the maths needs), so real pump trades build offline
function zeroOf(type, types) {
  if (typeof type === 'string') {
    if (type === 'bool') return false
    if (type === 'pubkey') return PublicKey.default
    if (/^[ui](8|16|32)$/.test(type)) return 0
    if (/^[ui](64|128)$/.test(type)) return new BN(0)
    return ''
  }
  if (type.array) return Array.from({ length: type.array[1] }, () => zeroOf(type.array[0], types))
  if (type.vec) return []
  if (type.option) return null
  const t = types.find(x => x.name === type.defined.name)
  return t.type.kind === 'struct' ? Object.fromEntries(t.type.fields.map(f => [f.name, zeroOf(f.type, types)])) : { [t.type.variants[0].name]: {} }
}
const zeroAcct = (prog, name) => zeroOf({ defined: { name } }, prog.idl.types)
const encodeBig = (prog, name, v, pad = 0) => { const l = prog.coder.accounts.accountLayouts.get(name); const buf = Buffer.alloc(8 + 20_000); const n = l.layout.encode(v, buf, 8); Buffer.from(l.discriminator).copy(buf, 0); return Buffer.concat([buf.subarray(0, 8 + n), Buffer.alloc(pad)]) }
function primePump(c) {
  const g = zeroAcct(pumpProg, 'global')
  Object.assign(g, { initialized: true, initialVirtualTokenReserves: new BN('1073000000000000'), initialVirtualSolReserves: new BN('30000000000'), initialRealTokenReserves: new BN('793100000000000'), tokenTotalSupply: new BN('1000000000000000'), feeBasisPoints: new BN(95), creatorFeeBasisPoints: new BN(30), feeRecipient: Keypair.generate().publicKey, feeRecipients: Array.from({ length: 7 }, () => Keypair.generate().publicKey) })
  const fc = zeroAcct(pumpProg, 'feeConfig'), fees = { lpFeeBps: new BN(0), protocolFeeBps: new BN(95), creatorFeeBps: new BN(30) }
  fc.flatFees = fees; fc.feeTiers = [{ marketCapLamportsThreshold: new BN(0), fees }]
  c.accounts.set(psdk.GLOBAL_PDA.toBase58(), { lamports: 2_000_000, owner: psdk.PUMP_PROGRAM_ID, executable: false, data: encodeBig(pumpProg, 'global', g), rentEpoch: 0 })
  c.accounts.set(psdk.PUMP_FEE_CONFIG_PDA.toBase58(), { lamports: 2_000_000, owner: psdk.PUMP_FEE_PROGRAM_ID, executable: false, data: encodeBig(pumpProg, 'feeConfig', fc, 3000), rentEpoch: 0 })
  return c
}
const { MintLayout, MINT_SIZE, getAssociatedTokenAddressSync } = require('@solana/spl-token')
function mintAccount() { const d = Buffer.alloc(MINT_SIZE); MintLayout.encode({ mintAuthorityOption: 0, mintAuthority: PublicKey.default, supply: 10n ** 15n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, d); return { lamports: 1_461_600, owner: T22, executable: false, data: d, rentEpoch: 0 } }
const tokenAcct = (mint, owner, amount) => { const d = Buffer.alloc(170); new PublicKey(mint).toBuffer().copy(d, 0); new PublicKey(owner).toBuffer().copy(d, 32); d.writeBigUInt64LE(BigInt(amount), 64); d[108] = 1; return { lamports: 2_074_080, owner: T22, executable: false, data: d, rentEpoch: 0 } }
const savedMetaSelfHost = config.metaSelfHost
config.metaSelfHost = true // prepares below never upload anything
const prepBody = (parent, extra = {}) => ({ wallet: wallet(), parent, name: 'Kid Coin', symbol: 'KIDX', image: PNG, ...extra })

await block('PRE-ROOT: coins launch before $TICKER exists, keep the kid split, and join ROOT when it is adopted', async () => {
  const savedRoot = registry.rootMint()
  use(fakeConn())
  registry.setRootMint('')
  try {
    const w = Keypair.generate()
    const p = await launch.prepareLaunch(prepBody(undefined, { wallet: w.publicKey.toBase58(), symbol: 'PREK' }))
    const rec = store.preparedStore.get()[p.id]
    check('PRE-ROOT: no ROOT + no parent → prepared at level 1, no parent, not ROOT', rec.preRoot === true && rec.parent === null && rec.level === 1 && rec.root === false, JSON.stringify({ preRoot: rec.preRoot, parent: rec.parent, level: rec.level, root: rec.root }))
    // the wallet signs + the engine relays it: the submit re-check must accept a pre-ROOT launch (it has no parent)
    const signed = VersionedTransaction.deserialize(Buffer.from(p.tx, 'base64')); signed.sign([w])
    const sub = await launch.submitLaunch(p.id, Buffer.from(signed.serialize()).toString('base64')).catch(e => ({ error: e.message }))
    const jl = Object.values(store.launchesStore.get()).find(x => x.mint === rec.mint)
    check('PRE-ROOT: the signed launch is accepted at submit and journaled with its preRoot flag', sub?.status === 'sent' && jl?.status === 'sent' && jl.preRoot === true && jl.parent === null, JSON.stringify(sub))
    const reg = launch.registerCoin(jl || { ...rec, message: undefined, status: 'sent', sig: 'x', sentAt: Date.now() })
    const want = launch.plannedShares(reg).shares || []
    const kid = launch.sharesFor({ ...rec, root: false }), rootSplit = (() => { try { return launch.sharesFor({ ...rec, root: true }) } catch { return [] } })()
    check('PRE-ROOT: its split is the KID split (its OWN pack pool + burn), never the ROOT split', launch.sameShares(want, kid) && launch.sameShares(reg.shares, kid) && !launch.sameShares(want, rootSplit) && want.some(x => x.role === 'parentHolders' && x.address === rec.holderPool) && want.some(x => x.role === 'burn' && x.address === B), JSON.stringify(want))
    check('PRE-ROOT: registered visible, not ROOT, ROOT still unset', registry.isVisible(reg.mint) && !reg.parent && reg.root === false && !registry.rootMint())
    const R = addCoin({ symbol: 'RPRE' })
    registry.setRootMint(R.mint)
    check('PRE-ROOT: attach is a no-op for coins that already have a parent', registry.attachPreRootKids() === 1)
    const after = registry.coinRec(reg.mint)
    check('PRE-ROOT: adopting ROOT attaches it under ROOT; its recorded + planned split are untouched', after.parent === R.mint && after.level === 1 && after.parentPool === sol.poolKeyFor(R.mint).publicKey.toBase58() && launch.sameShares(after.shares, reg.shares) && launch.sameShares(launch.plannedShares(after).shares, reg.shares))
    check('PRE-ROOT: attaching again changes nothing', registry.attachPreRootKids() === 0)
    const m2 = wallet()
    const late = launch.registerCoin({ ...rec, id: 'prelate', mint: m2, holderPool: sol.poolKeyFor(m2).publicKey.toBase58(), creatorKey: sol.coinKeyFor(m2).publicKey.toBase58(), message: undefined, status: 'sent', sig: 'y', sentAt: Date.now() })
    check('PRE-ROOT: a pre-ROOT launch that lands AFTER ROOT was set joins ROOT at once', late.parent === R.mint && late.level === 1 && late.root === false)
    const pin = M.parentFromMetadata({ gachapad: { parent: null, level: 1 } })
    check('PRE-ROOT: the metadata pin {parent:null, level:1} reads as a pre-ROOT kid, not a ROOT', pin?.preRoot === true && pin.level === 1 && pin.parent === null && M.parentFromMetadata({ gachapad: { parent: null, level: 0 } })?.level === 0)
  } finally { registry.setRootMint(savedRoot) }
})

await block('#1 ROOT reset / adopt vs in-flight launches', async () => {
  const savedRoot = registry.rootMint()
  const c = use(fakeConn())
  const R = addCoin({ symbol: 'RRESET' })
  registry.setRootMint(R.mint)
  const w1 = Keypair.generate()
  const p1 = await launch.prepareLaunch(prepBody(R.mint, { wallet: w1.publicKey.toBase58() }))
  const e1 = await rejects(async () => launch.resetRoot())
  check('#1 reset-root refuses while a child is PREPARED under ROOT', e1?.code === 409 && registry.rootMint() === R.mint, e1?.message)
  const pRec = store.preparedStore.get()[p1.id]
  store.preparedStore.update(all => { delete all[p1.id] })
  store.launchesStore.update(all => { all.r1sent = { ...pRec, message: undefined, status: 'sent', sig: 'x', sentAt: Date.now() } })
  const e2 = await rejects(async () => launch.resetRoot())
  check('#1 reset-root refuses while a child launch is journaled (sent)', e2?.code === 409 && registry.rootMint() === R.mint, e2?.message)
  store.launchesStore.update(all => { delete all.r1sent })
  // a reset DURING a prepare's slow part (build/simulate): the parent is re-checked right before the record is written
  c.simulateTransaction = async () => { try { launch.resetRoot() } catch {} return { value: { err: null, logs: [], unitsConsumed: 1 } } }
  const before = Object.keys(store.preparedStore.get()).length
  const e3 = await rejects(() => launch.prepareLaunch(prepBody(R.mint)))
  check('#1 a ROOT reset while a prepare builds → that prepare is refused and nothing is stored', !!e3 && registry.rootMint() === '' && Object.keys(store.preparedStore.get()).length === before, e3?.message)
  // submit re-validates the parent
  const R3 = addCoin({ symbol: 'RSUB' })
  registry.setRootMint(R3.mint)
  const c3 = use(fakeConn())
  const w3 = Keypair.generate()
  const p3 = await launch.prepareLaunch(prepBody(R3.mint, { wallet: w3.publicKey.toBase58() }))
  registry.setRootMint(R.mint) // ROOT moved on under this prepare (the old code only checked registered kids)
  const tx3 = VersionedTransaction.deserialize(Buffer.from(p3.tx, 'base64')); tx3.sign([w3])
  const e4 = await rejects(() => launch.submitLaunch(p3.id, Buffer.from(tx3.serialize()).toString('base64')))
  check('#1 submit refuses a child whose parent is no longer under ROOT (nothing relayed)', e4?.code === 409 && c3.sent.length === 0 && !store.launchesStore.get()[p3.id], e4?.message)
  store.preparedStore.update(all => { delete all[p3.id] })
  // adoptRoot: a ROOT launch in flight, an already-registered mint, a ROOT set while it read the chain
  registry.setRootMint('')
  store.preparedStore.update(all => { all.rootfly = { id: 'rootfly', root: true, mint: wallet(), expiresAt: Date.now() + 60_000, parent: null } })
  const ext = wallet()
  c3.accounts.set(pump.bondingCurvePda(new PublicKey(ext)).toBase58(), await curveAccount({ creator: wallet() }))
  const e5 = await rejects(() => launch.adoptRoot(ext))
  check('#1 adopt-root refuses while a ROOT launch is prepared / in flight', e5?.code === 409, e5?.message)
  store.preparedStore.update(all => { delete all.rootfly })
  const kidR = addCoin({ symbol: 'KIDRR', parent: R3.mint })
  c3.accounts.set(pump.bondingCurvePda(new PublicKey(kidR.mint)).toBase58(), await curveAccount({ creator: wallet() }))
  const e6 = await rejects(() => launch.adoptRoot(kidR.mint))
  check('#1 adopt-root never overwrites a registered coin', e6?.code === 409 && registry.coinRec(kidR.mint).parent === R3.mint, e6?.message)
  const other = wallet()
  c3.getAccountInfo = async k => { registry.setRootMint(other); return c3.accounts.get(String(k)) ?? null } // ROOT gets set while adopt awaits the chain
  const e7 = await rejects(() => launch.adoptRoot(ext))
  check('#1 adopt-root re-checks ROOT after its chain reads (no second level-0 ROOT)', e7?.code === 409 && registry.rootMint() === other && !registry.coinRec(ext), e7?.message)
  // a ROOT launch that lands while another ROOT is set is registered HIDDEN (no public children under it)
  const stray = wallet()
  const rec = launch.registerCoin({ id: 'stray', mint: stray, wallet: wallet(), parent: null, level: 0, root: true, hidden: false, symbol: 'STRAY', name: 'Stray', uri: 'u', holderPool: sol.poolKeyFor(stray).publicKey.toBase58(), parentPool: null, creatorKey: sol.coinKeyFor(stray).publicKey.toBase58(), sig: null, buyLamports: '0' })
  check('#1 a stray ROOT launch (ROOT already set) registers hidden, ROOT unchanged', rec.hidden === true && registry.rootMint() === other && !registry.isVisible(stray))
  // an orphan pinned under a RETIRED root is not auto-adopted under it
  registry.patchCoin(R3.mint, { hidden: true, root: false, retiredAt: Date.now() })
  const e8 = (() => { try { launch.adoptWithPin(wallet(), { name: 'o', symbol: 'ORPH', uri: 'u' }, { gachapad: { parent: R3.mint, level: 1, launcher: wallet() } }); return null } catch (e) { return e } })()
  check('#1 adopt refuses an orphan whose pinned parent was retired as ROOT', e8?.code === 409, e8?.message)
  registry.setRootMint(savedRoot)
})

await block('#2/#16 the global prepare token is only spent by a validated, funded prepare', async () => {
  const c = use(fakeConn())
  let gates = 0
  const gate = () => { gates++ }
  await rejects(() => launch.prepareLaunch({}, { gate }))
  await rejects(() => launch.prepareLaunch(prepBody(registry.rootMint(), { image: 'data:image/png;base64,AAAA' }), { gate }))
  await rejects(() => launch.prepareLaunch(prepBody(wallet()), { gate }))
  const poor = wallet(); c.balances.set(poor, 1000)
  await rejects(() => launch.prepareLaunch(prepBody(registry.rootMint(), { wallet: poor }), { gate }))
  check('#2 empty / invalid / unfunded prepares never reach the global gate', gates === 0)
  const imgs = filesIn(join(config.dataDir, 'img')), metas = filesIn(join(config.dataDir, 'meta'))
  const eg = await rejects(() => launch.prepareLaunch(prepBody(registry.rootMint()), { gate: () => { gates++; throw Object.assign(new Error('busy'), { code: 429 }) } }))
  check('#2 a valid prepare reaches the gate, and a gate refusal writes nothing to disk', gates === 1 && eg?.code === 429 && filesIn(join(config.dataDir, 'img')) === imgs && filesIn(join(config.dataDir, 'meta')) === metas)
  const w = new Map(), g = new Map()
  const steps = [{ map: w, key: 'W', cap: 2, rate: 0, msg: 'wallet' }, { map: g, key: 'all', cap: 5, rate: 0, msg: 'global' }]
  guard.takeTokens(steps); guard.takeTokens(steps)
  const r3 = guard.takeTokens(steps)
  check('#2 a wallet at its own limit is refused BEFORE it can spend a global token', r3?.msg === 'wallet' && g.get('all').t === 3)
})

await block('#3/#21 metadata URI on an owned domain; IP-bound hosts block launches', async () => {
  use(fakeConn())
  const m = wallet()
  const pm = await ipfs.pinMetadata({ name: 'A', symbol: 'AA', mint: m, img: ipfs.parseImage(PNG), parent: null, level: 0, launcher: wallet() }, { offline: true })
  check('#3 self-hosted metadata URI is under SITE_URL, never the engine host (PUBLIC_URL)', pm.uri === `${config.siteUrl}/m/${m}.json` && pm.image.startsWith(`${config.siteUrl}/m/`), pm.uri)
  const saved = { site: config.siteUrl, meta: config.metaBaseUrl, jwt: config.pinataJwt }
  config.siteUrl = 'https://gachapad.203-0-113-9.sslip.io'; config.metaBaseUrl = ''
  check('#3 launches (ROOT too) are blocked while metadata would live on an IP-bound host without IPFS', /metadata/.test(launch.launchBlocker() || '') && /metadata/.test(launch.launchBlocker({ root: true }) || ''), launch.launchBlocker())
  config.siteUrl = 'https://203.0.113.9'
  check('#3 …a raw IP too', /metadata/.test(launch.launchBlocker({ root: true }) || ''))
  config.pinataJwt = 'jwt'
  check('#3 …but not with IPFS pinning configured', !/metadata/.test(launch.launchBlocker({ root: true }) || ''))
  Object.assign(config, { siteUrl: saved.site, metaBaseUrl: saved.meta, pinataJwt: saved.jwt })
  const json = await ipfs.fetchMetadata(`https://gachapad.198-51-100-7.sslip.io/m/${m}.json`, m)
  check('#3 our own metadata is read from disk even under an OLD host (a box move), so orphans stay adoptable', json?.gachapad?.level === 0 && json.ca === m)
})

await block('#4 an RPC error is never read as "the launch did not land"', async () => {
  const c = use(fakeConn())
  const m = wallet()
  mkdirSync(join(config.dataDir, 'meta'), { recursive: true })
  const metaFile = join(config.dataDir, 'meta', `${m}.json`)
  writeFileSync(metaFile, JSON.stringify({ gachapad: { parent: registry.rootMint(), level: 1, launcher: wallet() } }))
  store.preparedStore.update(all => { all.p4 = { id: 'p4', status: 'prepared', mint: m, wallet: wallet(), parent: registry.rootMint(), level: 1, root: false, hidden: false, expiresAt: Date.now() - 700_000, createdAt: Date.now() - 800_000, symbol: 'P4', name: 'P4', uri: 'u', creatorKey: sol.coinKeyFor(m).publicKey.toBase58(), holderPool: sol.poolKeyFor(m).publicKey.toBase58(), parentPool: sol.poolKeyFor(registry.rootMint()).publicKey.toBase58(), message: '', lastValidBlockHeight: 150, alts: [] } })
  c.height = 151 // the finalized chain is past the blockhash's last valid height
  const gma = c.getMultipleAccountsInfo
  c.getMultipleAccountsInfo = async () => { throw new Error('429 Too Many Requests') }
  launch._clearBackoffs()
  await launch.sweepPrepared()
  check('#4 an unreadable curve keeps the prepared record and its metadata JSON', !!store.preparedStore.get().p4 && existsSync(metaFile))
  c.getMultipleAccountsInfo = gma
  launch._clearBackoffs()
  await launch.sweepPrepared()
  check('#4 …a successful read that shows no curve drops it (and cleans its files)', !store.preparedStore.get().p4 && !existsSync(metaFile))
  // advanceLaunch: a verdict of 'failed' for the signature, but the curve read errors → stays 'sent', files kept
  const m2 = wallet(), f2 = join(config.dataDir, 'meta', `${m2}.json`)
  writeFileSync(f2, '{}')
  store.launchesStore.update(all => { all.l4 = { id: 'l4', status: 'sent', mint: m2, sig: 'SIGL4', raw: null, lastValidBlockHeight: 150, sentAt: Date.now() - 200_000, creatorKey: sol.coinKeyFor(m2).publicKey.toBase58(), wallet: wallet(), parent: registry.rootMint(), symbol: 'L4' } })
  c.statuses.set('SIGL4', { confirmationStatus: 'finalized', err: { InstructionError: [0, 'x'] } })
  c.getMultipleAccountsInfo = async () => { throw new Error('fetch failed') }
  const v = await launch.advanceLaunch('l4')
  check('#4 advanceLaunch: an unreadable curve after a failed verdict keeps the launch sent and its files', v?.status === 'sent' && existsSync(f2), JSON.stringify(v))
  c.getMultipleAccountsInfo = gma
  store.launchesStore.update(all => { delete all.l4 })
})

await block('#5/#23 the public prepare cannot set hidden', async () => {
  use(fakeConn())
  const p = await launch.prepareLaunch(prepBody(registry.rootMint(), { hidden: true }))
  check('#5 a public prepare with hidden:true is NOT hidden', store.preparedStore.get()[p.id]?.hidden === false)
  const a = await launch.prepareLaunch(prepBody(registry.rootMint()), { admin: true })
  const b = await launch.prepareLaunch(prepBody(registry.rootMint(), { hidden: false }), { admin: true })
  check('#5 admin test launches: hidden by default, visible on request', store.preparedStore.get()[a.id]?.hidden === true && store.preparedStore.get()[b.id]?.hidden === false)
  store.preparedStore.update(all => { delete all[p.id]; delete all[a.id]; delete all[b.id] })
})

/** A locked, unswept coin whose coin key + pre-lock creator vault hold SOL on the fake chain. */
async function unsweptCoin(c, { vault = 15_000_000n, keyBal = 4_600_000, lockedAgo = 0 } = {}) {
  const k = addCoin({ symbol: 'SWEEP', parent: registry.rootMint() })
  registry.patchCoin(k.mint, { swept: false, sharing: { ...k.sharing, at: Date.now() - lockedAgo } })
  const ck = sol.coinKeyFor(k.mint).publicKey.toBase58(), cfg = pump.feeSharingConfigPda(new PublicKey(k.mint)).toBase58()
  c.accounts.set(pump.bondingCurvePda(new PublicKey(k.mint)).toBase58(), await curveAccount({ creator: cfg }))
  c.accounts.set(cfg, await sharingAccount(k.mint, k.shares))
  c.accounts.set(pump.creatorVaultPda(new PublicKey(ck)).toBase58(), sysAcct(Number(RENT0 + vault)))
  c.balances.set(ck, keyBal)
  for (const s of k.shares) c.accounts.set(s.address, sysAcct(5_000_000))
  return { k, ck }
}
const hasPumpIx = b64 => { const tx = txFromB64(b64); const keys = tx.message.staticAccountKeys.map(x => x.toBase58()); return tx.message.compiledInstructions.some(ix => keys[ix.programIdIndex] === psdk.PUMP_PROGRAM_ID.toBase58()) }

await block('#6 a transient error in the collect pass never marks the coin swept', async () => {
  const c = use(fakeConn()); c.autoConfirm = true
  const { k, ck } = await unsweptCoin(c)
  lamportChain(c, ck) // a sweep is marked swept only when the chain shows the key emptied: the fake chain must move lamports
  const sim = c.simulateTransaction
  let n = 0
  c.simulateTransaction = async (tx, cfg) => { if (n++ === 0) { c.simulations++; throw new Error('429 Too Many Requests') } return sim(tx, cfg) }
  await launch.finalizeCoin(k.mint)
  check('#6 after a failed collect pass the coin is NOT swept (the pre-lock vault still holds fees)', registry.coinRec(k.mint).swept === false && c.sent.every(b => !hasPumpIx(b)))
  launch._clearBackoffs()
  await launch.finalizeCoin(k.mint)
  check('#6 …the next pass collects the vault (pump collect ix) and only then marks it swept', registry.coinRec(k.mint).swept === true && c.sent.some(hasPumpIx))
})

await block('#7 a locked coin is never marked swept by the clock alone', async () => {
  const c = use(fakeConn()); c.autoConfirm = true
  const { k, ck } = await unsweptCoin(c, { vault: 20_000_000n, keyBal: 6_000_000, lockedAgo: 25 * 3_600_000 })
  lamportChain(c, ck)
  launch._clearBackoffs()
  await launch.finishCoins()
  check('#7 a coin locked 25 h ago with SOL left is SWEPT (a tx collects + splits it), not given up on', registry.coinRec(k.mint).swept === true && c.sent.some(hasPumpIx))
  const c2 = use(fakeConn())
  const { k: k2 } = await unsweptCoin(c2, { lockedAgo: 25 * 3_600_000 })
  killMod.kill('t7')
  launch._clearBackoffs()
  await launch.finishCoins()
  killMod.unkill()
  check('#7 while killed nothing is sent and the coin stays unswept (a kill never counts toward giving up)', registry.coinRec(k2.mint).swept === false && c2.sent.length === 0)
})

await block('#8/#27 the burn wallet must be neither the engine nor the protocol wallet', async () => {
  const saved = { burn: config.burnPrivateKey, proto: config.protocolWallet }
  config.burnPrivateKey = config.enginePrivateKey
  check('#8 lock refused when BURN_PRIVATE_KEY is the engine key', /burn/i.test(launch.lockBlocker() || '') && /burn/i.test(launch.launchBlocker({ root: true }) || ''))
  config.burnPrivateKey = saved.burn
  config.protocolWallet = B
  check('#8 lock refused when PROTOCOL_WALLET is the burn wallet', /burn/i.test(launch.lockBlocker() || ''))
  Object.assign(config, { burnPrivateKey: saved.burn, protocolWallet: saved.proto })
  check('#8 keyConflicts (boot) names both mistakes', M.keyConflicts({ engine: E, burn: E, protocol: P }).length === 1 && M.keyConflicts({ engine: E, burn: B, protocol: B }).length === 1 && M.keyConflicts({ engine: E, burn: B, protocol: P }).length === 0)
  check('#8 a sane engine still locks', launch.lockBlocker() === null)
})

await block('#9 fee totals book every distribution from the chain (third-party cranks too)', async () => {
  const c = use(fakeConn())
  const parent = addCoin({ symbol: 'IDXP' })
  const kid = addCoin({ symbol: 'IDXK', parent: parent.mint })
  const cfg = pump.feeSharingConfigPda(new PublicKey(kid.mint))
  const sharing = { address: cfg, config: { shareholders: kid.shares.map(s => ({ address: new PublicKey(s.address), shareBps: s.shareBps })) } }
  const third = Keypair.generate().publicKey
  const ixs = await pump.distributeIxs({ mint: kid.mint, sharing, graduated: false, payer: third })
  const msg = new TransactionMessage({ payerKey: third, recentBlockhash: bs58.encode(randomBytes(32)), instructions: ixs }).compileToV0Message()
  // a real distribution: the 20M the shareholders receive LEAVE the config's creator vault in the same tx
  const deltas = new Map([[kid.shares[0].address, 8_000_000], [kid.shares[1].address, 8_000_000], [B, 2_000_000], [P, 2_000_000], [pump.creatorVaultPda(cfg).toBase58(), -20_000_000]])
  const keys = msg.staticAccountKeys.map(k => k.toBase58())
  const pre = keys.map(() => 100_000_000), post = keys.map((k, i) => 100_000_000 + (deltas.get(k) || 0) - (i === 0 ? 5000 : 0))
  const tpSig = bs58.encode(randomBytes(64))
  c.txMeta.set(tpSig, { meta: { err: null, fee: 5000, preBalances: pre, postBalances: post, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [] }, transaction: { message: msg } })
  const junk = bs58.encode(randomBytes(64))
  c.txMeta.set(junk, { meta: { err: null, fee: 5000, preBalances: [1, 1], postBalances: [1, 1], loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [] }, transaction: { message: new TransactionMessage({ payerKey: third, recentBlockhash: bs58.encode(randomBytes(32)), instructions: [sol.transferIx(third, P, 1n)] }).compileToV0Message() } })
  let list = [{ signature: 'OLDEST', err: null }]
  c.getSignaturesForAddress = async (addr, o = {}) => { if (String(addr) !== P) return []; const i = o.until ? list.findIndex(s => s.signature === o.until) : -1; return (i >= 0 ? list.slice(0, i) : list).slice(0, o.limit || 1000) }
  registry.setLive(kid.mint, { pendingLamports: '20000000', vaultLamports: String(RENT0 + 20_000_000n) })
  const gen0 = registry.view(registry.coinRec(kid.mint)).fees.generatedSol
  store.patchState({ distIndexUntil: '' })
  await dist.indexDistributions({ force: true })
  check('#9 the first index pass only sets a cursor (no history backfill)', store.readState().distIndexUntil === 'OLDEST' && store.mintLedger(kid.mint).cranks === 0)
  list = [{ signature: junk, err: null }, { signature: tpSig, err: null }, { signature: 'OLDEST', err: null }] // newest first
  registry.setLive(kid.mint, { pendingLamports: '0', vaultLamports: String(RENT0) }) // someone else cranked the vault
  check('#9 generatedSol never drops when a third party drains the pending fees', registry.view(registry.coinRec(kid.mint)).fees.generatedSol >= gen0 - 1e-12, `${gen0}`)
  await dist.indexDistributions({ force: true })
  const led = store.mintLedger(kid.mint)
  check('#9 a third-party crank is booked from its measured deltas', led.distributedLamports === '20000000' && led.toParentLamports === '8000000' && led.toLauncherLamports === '8000000' && led.toBurnLamports === '2000000' && store.readState().distIndexUntil === junk)
  await dist.indexDistributions({ force: true })
  check('#9 …exactly once (idempotent per signature)', store.mintLedger(kid.mint).cranks === 1 && registry.view(registry.coinRec(kid.mint)).fees.generatedSol >= 0.02 - 1e-12)
  // mainnet carries version-1 txs this client cannot decode: skipped, never a stall; a transient error keeps progress
  list = [{ signature: 'AFTERV1', err: null }, { signature: 'V1SIG', err: null }, ...list]
  const gt = c.getTransaction
  c.getTransaction = async s => { if (s === 'V1SIG') throw new Error('failed to get transaction: Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1'); if (s === 'AFTERV1') throw new Error('fetch failed'); return gt(s) }
  await dist.indexDistributions({ force: true })
  check('#9 a version-1 tx is skipped and a transient error keeps the progress made (cursor on the v1 sig)', store.readState().distIndexUntil === 'V1SIG', store.readState().distIndexUntil)
  c.getTransaction = gt
})

await block('#10 the crank decides on a LIVE vault read, and resets the AMM figure after a crank', async () => {
  const c = use(fakeConn()); c.autoConfirm = true
  const kid = addCoin({ symbol: 'AMMK', parent: registry.rootMint() })
  const cfg = pump.feeSharingConfigPda(new PublicKey(kid.mint)).toBase58()
  c.accounts.set(cfg, await sharingAccount(kid.mint, kid.shares))
  for (const s of kid.shares) c.accounts.set(s.address, sysAcct(5_000_000))
  c.accounts.set(pump.creatorVaultPda(new PublicKey(cfg)).toBase58(), sysAcct(Number(RENT0)))
  c.balances.set(E, 1_000_000_000)
  registry.setLive(kid.mint, { vaultLamports: String(RENT0 + 20_000_000n), graduated: true, ammAtaExists: true, ammVaultLamports: '400000000', sharingOk: true }) // STALE: the chain vault is empty
  const n0 = await dist.distributeDue({ force: true, only: kid.mint })
  check('#10 a stale "0.4 SOL waiting" figure never pays for a crank the chain says is empty', n0 === 0 && c.sent.length === 0)
  c.accounts.set(pump.creatorVaultPda(new PublicKey(cfg)).toBase58(), sysAcct(Number(RENT0 + 20_000_000n)))
  check('#10 …and the skipped pass wrote the chain figure back (no stale 0.4 SOL left in the view)', registry.liveOf(kid.mint).ammVaultLamports === '0' && registry.liveOf(kid.mint).vaultLamports === String(RENT0))
  registry.setLive(kid.mint, { vaultLamports: String(RENT0 + 20_000_000n) }) // the next refresh sees fees arrive
  let sentTx = null
  c.onSend = tx => { sentTx = tx }
  c.getTransaction = async () => ({ meta: { fee: 5000, preBalances: sentTx.message.staticAccountKeys.map(() => 1), postBalances: sentTx.message.staticAccountKeys.map(() => 1), loadedAddresses: { writable: [], readonly: [] } }, transaction: { message: sentTx.message } })
  const n1 = await dist.distributeDue({ force: true, only: kid.mint })
  check('#10 …a real vault is cranked, and afterwards the AMM figure reads 0', n1 === 1 && registry.liveOf(kid.mint).ammVaultLamports === '0')
})

await block('#11 a lagging RPC node is never a verdict against a payee', async () => {
  const parent = addCoin({ symbol: 'BHNF' })
  const poolW = sol.poolKeyFor(parent.mint).publicKey.toBase58()
  const pool = { parentMint: parent.mint, symbol: 'BHNF', poolWallet: poolW }
  const mk = n => { const id = store.newId(6), items = Array.from({ length: n }, () => ({ wallet: wallet(), lamports: 3_000_000n, weight: 1n })); store.roundsStore.update(s => { s.rounds.push({ id, parentMint: parent.mint, pool: poolW, closedAt: Date.now(), lines: items.map(i => ({ wallet: i.wallet, weight: '1', lamports: '3000000', status: 'pending' })), status: 'paying', sigs: [] }) }); return { id, items } }
  const st = (id, w) => rounds.roundById(id).lines.find(l => l.wallet === w)?.status
  const fast = { settle: { deadlineMs: 300, pollMs: 20 } }
  let c = use(fakeConn()), seen = null
  c.simulateTransaction = async (tx, cfg) => { seen = cfg; return { value: { err: 'BlockhashNotFound', logs: [] } } }
  const r1 = mk(3)
  const res = await paysol.payPoolShares(pool, r1.items, { roundId: r1.id, ...fast })
  check('#11 BlockhashNotFound refuses NOBODY: the pass stops, every line stays pending', res.halted && res.refused.length === 0 && r1.items.every(i => st(r1.id, i.wallet) === 'pending') && c.sent.length === 0, JSON.stringify(res, (k, v) => (typeof v === 'bigint' ? String(v) : v)))
  check('#11 the payout simulation carries minContextSlot = the build slot', seen?.minContextSlot === c.slot)
  c = use(fakeConn())
  c.simulateTransaction = async () => ({ value: { err: { InstructionError: [2, { Custom: 1 }] }, logs: ['Transfer: insufficient lamports'] } })
  const r2 = mk(2)
  const res2 = await paysol.payPoolShares(pool, r2.items, { roundId: r2.id, ...fast })
  check('#11 an insufficient-lamports transfer (the POOL is short) refuses nobody', res2.refused.length === 0 && r2.items.every(i => st(r2.id, i.wallet) === 'pending'))
  c = use(fakeConn()); c.autoConfirm = true
  const r3 = mk(3), bad = r3.items[2].wallet
  c.simulateTransaction = async tx => { const i = tx.message.staticAccountKeys.findIndex(k => k.toBase58() === bad); return { value: { err: i >= 0 ? { InsufficientFundsForRent: { account_index: i } } : null, logs: [] } } }
  const res3 = await paysol.payPoolShares(pool, r3.items, { roundId: r3.id, ...fast })
  check('#11 a payee that would be left under rent IS refused (singly); the others are paid', res3.refused.length === 1 && res3.refused[0] === bad && res3.paid.length === 2 && st(r3.id, bad) === 'refused')
})

/** The burn wallet + ROOT on the fake chain: ROOT is a Token-2022 pump curve coin; pump Global/FeeConfig encoded. */
async function burnChain({ bal = 1_000_000_000 } = {}) {
  const c = primePump(use(fakeConn())); c.autoConfirm = true
  const root = registry.rootMint()
  c.accounts.set(root, mintAccount())
  c.accounts.set(pump.bondingCurvePda(new PublicKey(root)).toBase58(), await curveAccount({ creator: wallet() }))
  c.balances.set(B, bal)
  const ata = getAssociatedTokenAddressSync(new PublicKey(root), BURN.publicKey, false, T22).toBase58()
  c.getTokenAccountBalance = async () => { throw new Error('no account') }
  // the simulation reports the burn wallet's post state: it spent ≤ what it asked, and got ROOT
  c.simulateTransaction = async (tx, cfg) => { c.simulations++; const addrs = cfg?.accounts?.addresses || []; return { value: { err: null, logs: [], unitsConsumed: 1, accounts: addrs.map(a => (a === B ? { lamports: 10_000_000, owner: SystemProgram.programId.toBase58(), data: ['', 'base64'], executable: false, rentEpoch: 0 } : a === ata ? { lamports: 2_074_080, owner: T22.toBase58(), data: [tokenAcct(root, B, 10n ** 14n).data.toString('base64'), 'base64'], executable: false, rentEpoch: 0 } : null)) } } }
  return { c, root, ata }
}
const allowedBurnPrograms = new Set(['ComputeBudget111111111111111111111111111111', psdk.PUMP_PROGRAM_ID.toBase58(), 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', T22.toBase58(), '11111111111111111111111111111111'])

await block('#12 the burner builds its ROOT buy itself and never signs third-party bytes', async () => {
  const saved = config.burnLive; config.burnLive = true
  const realFetch = globalThis.fetch, fetched = []
  globalThis.fetch = async u => { fetched.push(String(u)); throw new Error('no network in tests') }
  try {
    const { c } = await burnChain()
    store.burnsStore.update(s => { s.pending = null })
    await burner.crankBurner()
    const swaps = c.sent.map(txFromB64).filter(tx => tx.message.staticAccountKeys[0].equals(BURN.publicKey))
    const progs = swaps.flatMap(tx => tx.message.compiledInstructions.map(ix => tx.message.staticAccountKeys[ix.programIdIndex].toBase58()))
    check('#12 no HTTP call to Jupiter (or anyone): the swap is built locally', fetched.length === 0, fetched.join())
    check('#12 the swap sent is a pump buy signed by the burn wallet alone, touching only allowed programs', swaps.length >= 1 && swaps.every(tx => tx.message.header.numRequiredSignatures === 1) && progs.includes(psdk.PUMP_PROGRAM_ID.toBase58()) && progs.every(p => allowedBurnPrograms.has(p)), progs.join())
    check('#12 it was simulated (post-state checked) before the first broadcast', c.simulations >= 1 && store.burnsStore.get().lastSwap?.status === 'confirmed')
    const attacker = Keypair.generate().publicKey
    const drain = new VersionedTransaction(new TransactionMessage({ payerKey: BURN.publicKey, recentBlockhash: bs58.encode(randomBytes(32)), instructions: [SystemProgram.transfer({ fromPubkey: BURN.publicKey, toPubkey: attacker, lamports: 999_000_000 })] }).compileToV0Message())
    check('#12 assertBurnTx refuses a drain tx (transfer to a stranger)', throws(() => burner.assertBurnTx(drain, BURN.publicKey)))
  } finally { globalThis.fetch = realFetch; config.burnLive = saved }
})

await block('#15 the burner re-reads its balance after settling, simulates, and backs off after a failure', async () => {
  const saved = config.burnLive; config.burnLive = true
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('no network in tests') }
  try {
    const { c } = await burnChain()
    // a swap journaled by an earlier tick that lands while this tick settles it
    const prev = new VersionedTransaction(new TransactionMessage({ payerKey: BURN.publicKey, recentBlockhash: bs58.encode(randomBytes(32)), instructions: [sol.transferIx(BURN.publicKey, BURN.publicKey, 1n)] }).compileToV0Message()); prev.sign([BURN])
    const prevSig = sol.sigOf(prev)
    store.burnsStore.update(s => { s.pending = { sig: prevSig, raw: Buffer.from(prev.serialize()).toString('base64'), lastValidBlockHeight: 150, spendLamports: '990000000', at: Date.now() } })
    c.onSend = tx => { if (sol.sigOf(tx) === prevSig) c.balances.set(B, 9_950_000) }
    burner._resetBackoff()
    const sims = c.simulations
    await burner.crankBurner()
    const second = c.sent.map(txFromB64).filter(tx => sol.sigOf(tx) !== prevSig && tx.message.compiledInstructions.length > 3)
    check('#15 a swap that lands during settlement is never followed by a second swap from the stale balance', second.length === 0 && c.simulations === sims && store.burnsStore.get().lastSwap?.sig === prevSig, `sent ${c.sent.length}`)
    // a simulation refusal: nothing journaled, nothing sent
    const { c: c2 } = await burnChain()
    c2.simulateTransaction = async () => ({ value: { err: { InstructionError: [2, { Custom: 1 }] }, logs: [] } })
    burner._resetBackoff()
    await burner.crankBurner()
    check('#15 a swap the simulation refuses is never journaled nor sent', c2.sent.length === 0 && !store.burnsStore.get().pending)
    // a swap that lands FAILED → the next tick does not rebuild at once (backoff)
    const { c: c3 } = await burnChain()
    c3.autoConfirm = false
    c3.getSignatureStatuses = async sigs => ({ context: { slot: c3.slot }, value: sigs.map(s => (c3.sentSigs.has(s) ? { confirmationStatus: 'confirmed', err: { InstructionError: [3, 'x'] } } : null)) })
    burner._resetBackoff()
    await burner.crankBurner()
    const afterFail = c3.sent.length
    await burner.crankBurner()
    check('#15 after a failed swap the burner backs off (no second doomed swap on the next tick)', store.burnsStore.get().lastSwap?.status === 'failed' && c3.sent.length === afterFail)
  } finally { globalThis.fetch = realFetch; config.burnLive = saved; burner._resetBackoff() }
})

/** ROOT paired with CARDS on the fake chain: stage 1 = a (mocked) Jupiter SOL→CARDS swap, stage 2 = pump buy_v2 built locally. */
async function quotedBurnChain({ jupMin = 490_000_000n, quoteLeftBps = 300n } = {}) {
  const { setSolUsd } = await import('./price.js')
  const { JUPITER_V6 } = await import('./swapcheck.js')
  setSolUsd(100)
  const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), CARDS = 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp'
  const R = addCoin({ symbol: 'GACHAPADQ' }); registry.setRootMint(R.mint)
  const root = R.mint
  const c = primePump(use(fakeConn())); c.autoConfirm = true
  c.accounts.set(root, mintAccount())
  c.accounts.set(CARDS, { ...mintAccount(), owner: TOKEN })
  c.accounts.set(pump.bondingCurvePda(new PublicKey(root)).toBase58(), await curveAccount({ creator: wallet(), quoteMint: CARDS, vq: '6000000000' }))
  c.balances.set(B, 1_000_000_000)
  const qAta = getAssociatedTokenAddressSync(new PublicKey(CARDS), BURN.publicKey, false, TOKEN).toBase58()
  const rAta = getAssociatedTokenAddressSync(new PublicKey(root), BURN.publicKey, false, T22).toBase58()
  const held = new Map(), calls = []
  const GOT = 495_000_000n
  c.getTokenAccountBalance = async k => { const a = String(k); if (!held.has(a)) throw new Error('no account'); return { value: { amount: String(held.get(a)) } } }
  const progsOf = tx => tx.message.compiledInstructions.map(ix => tx.message.staticAccountKeys[ix.programIdIndex].toBase58())
  const acct = (a, amount) => { const t = tokenAcct(a === qAta ? CARDS : root, B, amount); return { ...t, data: [t.data.toString('base64'), 'base64'] } }
  c.simulateTransaction = async (tx, cfg) => {
    c.simulations++
    const jup = progsOf(tx).includes(JUPITER_V6), bal = await c.getBalance(B)
    return { value: { err: null, logs: [], unitsConsumed: 1, accounts: (cfg?.accounts?.addresses || []).map(a => (a === B ? { lamports: jup ? bal - 993_000_000 : bal - 3_000_000, owner: SystemProgram.programId.toBase58(), data: ['', 'base64'], executable: false, rentEpoch: 0 } : a === qAta ? acct(a, jup ? GOT : (GOT * quoteLeftBps) / 10_000n) : a === rAta ? acct(a, 9n * 10n ** 14n) : null)) } }
  }
  c.onSend = tx => {
    const p = progsOf(tx)
    if (p.includes(JUPITER_V6)) { c.balances.set(B, 7_000_000); held.set(qAta, GOT); c.accounts.set(qAta, tokenAcct(CARDS, B, GOT)) }
    else if (p.includes(psdk.PUMP_PROGRAM_ID.toBase58())) { held.set(qAta, 0n); held.set(rAta, 5n * 10n ** 14n) }
  }
  globalThis.fetch = async u => {
    const s = String(u); calls.push(s)
    const J = v => ({ ok: true, status: 200, json: async () => v })
    if (s.includes('dexscreener')) return J({ pairs: [{ baseToken: { address: CARDS }, priceUsd: '0.2', liquidity: { usd: 1e6 } }] })
    if (s.includes('/quote?')) {
      const q = new URL(s).searchParams
      if (q.get('inputMint') === CARDS) return J({ outAmount: String((BigInt(q.get('amount')) * 2_000_000n) / 1_000_000n) }) // 1 CARDS = 0.002 SOL
      return J({ outAmount: String(GOT), otherAmountThreshold: String(jupMin) })
    }
    if (s.endsWith('/swap')) {
      const ix = new TransactionInstruction({ programId: new PublicKey(JUPITER_V6), keys: [{ pubkey: BURN.publicKey, isSigner: true, isWritable: true }, { pubkey: new PublicKey(qAta), isSigner: false, isWritable: true }], data: Buffer.from([7, 7, 7]) })
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: BURN.publicKey, recentBlockhash: bs58.encode(randomBytes(32)), instructions: [ix] }).compileToV0Message())
      return J({ swapTransaction: Buffer.from(tx.serialize()).toString('base64'), lastValidBlockHeight: 150 })
    }
    throw new Error('no network in tests')
  }
  store.burnsStore.update(s => { s.pending = null; s.carryLamports = '0' })
  burner._resetBackoff()
  return { c, root, qAta, rAta, calls, progsOf, JUPITER_V6 }
}

await block('#Q $GACHA on CARDS: the burner goes SOL → CARDS → $GACHA in two journaled, simulated stages, then burns', async () => {
  const saved = config.burnLive, savedRoot = registry.rootMint(), realFetch = globalThis.fetch
  config.burnLive = true
  try {
    const { c, progsOf, JUPITER_V6, calls } = await quotedBurnChain()
    const spentBefore = BigInt(store.burnsStore.get().totalSpentLamports || '0'), doneBefore = store.burnsStore.get().done.length
    await burner.crankBurner()
    const txs = c.sent.map(txFromB64)
    const [s1, s2, burnTx] = txs
    check('#Q three txs: the CARDS buy, the $GACHA buy, the burn', txs.length === 3, `sent ${txs.length} · ${burner.burnerStatus().lastError}`)
    check('#Q stage 1 is ONE Jupiter route signed by the burn wallet alone', !!s1 && s1.message.header.numRequiredSignatures === 1 && s1.message.staticAccountKeys[0].equals(BURN.publicKey) && progsOf(s1).filter(p => p === JUPITER_V6).length === 1)
    check('#Q stage 2 is a pump buy built HERE, touching only allowed programs', !!s2 && progsOf(s2).includes(psdk.PUMP_PROGRAM_ID.toBase58()) && progsOf(s2).every(p => allowedBurnPrograms.has(p)), s2 && progsOf(s2).join())
    check('#Q only ONE swap was built by a third party (stage 1)', calls.filter(u => u.endsWith('/swap')).length === 1)
    check('#Q the burn is a burnChecked of ROOT', !!burnTx && progsOf(burnTx).includes(T22.toBase58()))
    const st = store.burnsStore.get()
    check('#Q the SOL is counted once (stage 1), carried onto the burn record, then reset', BigInt(st.totalSpentLamports) - spentBefore === 990_000_000n && st.carryLamports === '0' && st.done.length === doneBefore + 1 && Math.abs(st.done.at(-1).spentSol - 0.99) < 1e-9, JSON.stringify({ total: st.totalSpentLamports, carry: st.carryLamports, last: st.done.at(-1) }))
    check('#Q both stages settled confirmed, nothing left pending', !st.pending && st.lastSwap?.stage === 'quote' && st.lastSwap.status === 'confirmed' && st.lastRootBuy?.status === 'confirmed')
  } finally { globalThis.fetch = realFetch; config.burnLive = saved; registry.setRootMint(savedRoot); burner._resetBackoff() }
})

await block('#Q a CARDS quote far below the market, or a $GACHA buy that would overspend CARDS, is never sent', async () => {
  const saved = config.burnLive, savedRoot = registry.rootMint(), realFetch = globalThis.fetch
  config.burnLive = true
  try {
    const a = await quotedBurnChain({ jupMin: 380_000_000n }) // fair = 495 CARDS; the floor is (0.95 - 0.03) x fair
    await burner.crankBurner()
    check('#Q a Jupiter minimum 23% under the market: no swap built, nothing journaled, nothing sent', a.c.sent.length === 0 && !a.calls.some(u => u.endsWith('/swap')) && !store.burnsStore.get().pending && /too far below/.test(burner.burnerStatus().lastError || ''), burner.burnerStatus().lastError)
    const b = await quotedBurnChain({ quoteLeftBps: 0n }) // the simulated buy_v2 empties the CARDS account: more than max-in
    await burner.crankBurner()
    const progs = b.c.sent.map(txFromB64).map(b.progsOf)
    check('#Q a stage-2 simulation spending more CARDS than allowed: stage 1 lands, stage 2 is never sent', progs.length === 1 && progs[0].includes(b.JUPITER_V6) && /quote, more than/.test(burner.burnerStatus().lastError || ''), `${progs.length} · ${burner.burnerStatus().lastError}`)
  } finally { globalThis.fetch = realFetch; config.burnLive = saved; registry.setRootMint(savedRoot); burner._resetBackoff() }
})

await block('#13/#18 quotes: SOL ↔ a GACHAPAD coin only, and a flood costs O(coins) RPC, not O(requests)', async () => {
  const realFetch = globalThis.fetch, fetched = []
  globalThis.fetch = async u => { fetched.push(String(u)); throw new Error('no network in tests') }
  try {
    const c = primePump(use(fakeConn()))
    const kid = addCoin({ symbol: 'QTE', parent: registry.rootMint() })
    c.accounts.set(kid.mint, mintAccount())
    c.accounts.set(pump.bondingCurvePda(new PublicKey(kid.mint)).toBase58(), await curveAccount({ creator: wallet() }))
    const e1 = await rejects(() => trades.quote({ input: wallet(), output: kid.mint, amount: '1000' }))
    const e2 = await rejects(() => trades.quote({ input: 'SOL', output: wallet(), amount: '1000' }))
    check('#13 mint→mint and non-GACHAPAD mints are refused without touching Jupiter', e1?.code === 400 && (e2?.code === 404 || e2?.code === 400) && fetched.length === 0, `${e1?.message} | ${e2?.message}`)
    let calls = 0
    const g1 = c.getAccountInfo, g2 = c.getMultipleAccountsInfo
    c.getAccountInfo = async k => { calls++; return g1(k) }
    c.getMultipleAccountsInfo = async k => { calls++; return g2(k) }
    for (let i = 0; i < 40; i++) await trades.quote({ input: 'SOL', output: kid.mint, amount: String(1_000_000 + i * 7919) })
    check('#13 40 quotes of one coin with 40 different amounts cost a handful of RPC calls (cached state)', calls <= 8, `${calls} calls`)
  } finally { globalThis.fetch = realFetch }
})

await block('#14 a wallet-modified swap keeps its expiry and its trade event', async () => {
  use(fakeConn())
  const user = Keypair.generate()
  const bh = bs58.encode(randomBytes(32))
  const core = [sol.transferIx(user.publicKey, Keypair.generate().publicKey, 5n)]
  const built = new VersionedTransaction(new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: bh, instructions: [...sol.budgetIxs(200_000), ...core] }).compileToV0Message())
  const kid = registry.coins()[Object.keys(registry.coins()).find(m => registry.coinRec(m).level === 1)]
  trades.rememberBuilt(built, { lastValidBlockHeight: 1000, mint: kid.mint, side: 'buy', route: 'curve', amount: '5', outAmount: '9', wallet: user.publicKey.toBase58() })
  const guardIx = new TransactionInstruction({ programId: new PublicKey(M.LIGHTHOUSE_PROGRAM), keys: [{ pubkey: user.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([1, 2, 3]) })
  const signed = new VersionedTransaction(new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: bh, instructions: [guardIx, ...sol.budgetIxs(200_000), ...core] }).compileToV0Message()); signed.sign([user])
  const { sig } = await trades.relay(Buffer.from(signed.serialize()).toString('base64'), { send: false })
  const r = store.relaysStore.get().find(x => x.sig === sig)
  check('#14 a Lighthouse-augmented swap is recognized as ours: expiry + mint journaled (so "dead" and the trade event work)', r?.kind === 'swap' && r.lastValidBlockHeight === 1000 && r.mint === kid.mint)
})

await block('#17 coin views are O(N): a burn booked never makes a full view pass quadratic', async () => {
  const N = 2000, mints = Array.from({ length: N }, () => wallet())
  store.coinsStore.update(all => { for (const m of mints) all[m] = { mint: m, symbol: 'PERF', name: 'Perf', parent: null, level: 0, root: false, creator: wallet(), shares: [], createdAt: Date.now() - 2 * 86_400_000, hidden: false, external: false, sharing: null, swept: true } })
  const savedBurn = store.burnsStore.get().totalBurnedRaw
  store.burnsStore.update(s => { s.totalBurnedRaw = '1000000000000' })
  store.bookDistribution(mints[0], 'perf-sig', { toBurn: 5_000_000n })
  const t0 = performance.now()
  const views = registry.allRecs().map(registry.view)
  const dt = performance.now() - t0
  check(`#17 a full view pass over ${N}+ coins with a burn booked is fast (${dt.toFixed(0)} ms)`, dt < 400 && views.length >= N)
  check('#17 the burn attribution still sums to the burn total', Math.abs(views.reduce((s, v) => s + v.burnedRootUi, 0) - registry.totalBurnedUi()) < 1e-6)
  store.coinsStore.update(all => { for (const m of mints) delete all[m] })
  store.burnsStore.update(s => { s.totalBurnedRaw = savedBurn })
})

await block('#19 rounds: no perpetual rounds for empty pools, lean snapshots, batched bookings, bounded history', async () => {
  const savedMin = config.holderMinTokens; config.holderMinTokens = 10_000 // the inherited SOL rounds (unused by GACHAPAD) were written for a 10k floor
  try {
  const c = use(fakeConn()); c.autoConfirm = true
  const parent = addCoin({ symbol: 'LEANP' })
  addCoin({ symbol: 'LEANK', parent: parent.mint })
  c.accounts.set(parent.mint, { lamports: 1, owner: T22, executable: false, data: Buffer.alloc(82), rentEpoch: 0 })
  const slice = (o, amt) => ({ account: { data: Buffer.concat([new PublicKey(o).toBuffer(), Buffer.from(new BigUint64Array([amt]).buffer)]) } })
  let gpa = 0
  c.getProgramAccounts = async () => { gpa++; return c.gpa }
  registry.setLive(parent.mint, { poolLamports: '0' })
  const r0 = await rounds.roundStep(parent.mint)
  check('#19 a parent whose pool cannot pay opens NO round (no snapshot, nothing stored)', !!r0.note && gpa === 0 && !rounds.rounds().some(r => r.parentMint === parent.mint))
  const big = wallet(), dust = wallet()
  c.gpa = [slice(big, 50_000n * 1_000_000n), slice(dust, 5n * 1_000_000n)]
  registry.setLive(parent.mint, { poolLamports: '2000000000' })
  const r1 = await rounds.roundStep(parent.mint)
  const open = rounds.roundById(r1.opened)
  check('#19 a funded pool opens a round; its stored snapshot drops dust holders (lossless: dust is never paid)', !!open && open.openSnapshot[big] && !(dust in open.openSnapshot), JSON.stringify(r1))
  c.balances.set(parent.holderPool, Number(RENT0)) // the pool emptied during the window
  const cl = await rounds.roundStep(parent.mint, { force: true })
  check('#19 a close whose budget is ≤ 0 opens no next round', cl.status === 'skipped' && !rounds.rounds().some(r => r.parentMint === parent.mint && r.status === 'open'), JSON.stringify(cl))
  // 12 payees in one confirmed batch → ONE ledger write, not twelve
  const poolW = parent.holderPool
  const id = store.newId(6), items = Array.from({ length: 12 }, () => ({ wallet: wallet(), lamports: 3_000_000n, weight: 1n }))
  store.roundsStore.update(s => { s.rounds.push({ id, parentMint: parent.mint, pool: poolW, closedAt: Date.now(), lines: items.map(i => ({ wallet: i.wallet, weight: '1', lamports: '3000000', status: 'pending' })), status: 'paying', sigs: [] }) })
  c.balances.set(poolW, 2_000_000_000)
  const origSet = store.ledgerStore.set
  let writes = 0
  store.ledgerStore.set = v => { writes++; return origSet(v) }
  try { await paysol.payPoolShares({ parentMint: parent.mint, symbol: 'LEANP', poolWallet: poolW }, items, { roundId: id, settle: { deadlineMs: 300, pollMs: 20 } }) } finally { store.ledgerStore.set = origSet }
  check('#19 a confirmed 12-payee batch books every payee in ONE ledger write', writes === 1 && store.poolLedger(parent.mint).paidCount === 12, `${writes} writes`)
  // settled rounds beyond the newest KEEP keep their totals but drop their lines
  const settled = Array.from({ length: rounds.KEEP_LINES + 5 }, (_, i) => ({ id: `old${i}`, parentMint: parent.mint, status: 'done', closedAt: i, lines: [{ wallet: wallet(), lamports: '1000', weight: '1', status: 'paid' }], sigs: [] }))
  const out = rounds.compactRounds({ rounds: settled })
  const firstOld = out.rounds[0]
  check('#19 compactRounds: old settled rounds keep paid totals, drop lines; the newest keep them', !firstOld.lines.length && firstOld.linesDropped && rounds.roundView(firstOld).paidSol === 1e-6 && rounds.roundView(firstOld).wallets === 1 && out.rounds[out.rounds.length - 1].lines.length === 1)
  } finally { config.holderMinTokens = savedMin }
})

await block('#20/#25 the data dir is tagged with the engine flavour', async () => {
  check('#20 identity: another engine flavour refuses', /engine/.test(String(guard.identityDecision({ chainId: 'solana-mainnet', treasury: 'A', factories: [], engine: 'meteora-dbc' }, { chainId: 'solana-mainnet', treasury: 'A', factories: [], engine: 'pump.fun' }))))
  check('#20 identity: an untagged dir of this engine is tagged (update), a tagged one is ok', guard.identityDecision({ chainId: 'solana-mainnet', treasury: 'A', factories: [] }, { chainId: 'solana-mainnet', treasury: 'A', factories: [], engine: 'pump.fun' }) === 'update' && guard.identityDecision({ chainId: 'solana-mainnet', treasury: 'A', factories: [], engine: 'pump.fun' }, { chainId: 'solana-mainnet', treasury: 'A', factories: [], engine: 'pump.fun' }) === 'ok')
  const deploy = readFileSync(new URL('./DEPLOY.md', import.meta.url), 'utf-8')
  check('#20 DEPLOY.md documents the GACHAPAD money flags (all off until proven)', /RIP_LIVE/.test(deploy) && /CONVERT_LIVE/.test(deploy) && /DELIVER_LIVE/.test(deploy))
})

await block('#22 the rate limiter runs before any body parser; big bodies only on prepare', async () => {
  const src = readFileSync(new URL('./index.js', import.meta.url), 'utf-8')
  check('#22 no global 6 MB JSON parser', !/app\.use\(express\.json\(\{ limit: '6mb' \}\)\)/.test(src))
})

await block('#24 an underfunded canary payer reads "unknown", never "pump changed"', async () => {
  const v1 = canary.canaryVerdict({ ok: false, err: { InsufficientFundsForRent: { account_index: 0 } }, logs: [] }, 'ok')
  const v2 = canary.canaryVerdict({ ok: false, err: { InstructionError: [3, { Custom: 1 }] }, logs: ['Transfer: insufficient lamports 9715320, need 10500000'] }, 'ok')
  const v3 = canary.canaryVerdict({ ok: false, err: { InstructionError: [2, { Custom: 6000 }] }, logs: ['AnchorError'] }, 'ok')
  const v4 = canary.canaryVerdict({ ok: true, unitsConsumed: 1, bytes: 1 }, 'failing')
  check('#24 InsufficientFundsForRent on the payer → unknown', v1.status === 'unknown')
  check('#24 system "insufficient lamports" (Custom:1) → unknown', v2.status === 'unknown')
  check('#24 a real program error → failing', v3.status === 'failing')
  check('#24 a success clears failing', v4.status === 'ok')
})

await block('#26 ROOT_MINT must match the registered ROOT', async () => {
  const saved = { cfg: config.rootMint, st: registry.rootMint(), live: config.burnLive }
  const X = wallet()
  config.rootMint = X
  check('#26 ROOT_MINT ≠ the registered ROOT → a boot problem', /ROOT_MINT/.test(registry.rootPinProblem() || ''))
  registry.setRootMint('')
  check('#26 a pinned ROOT that is not registered is not a boot problem (it can still be adopted)', registry.rootPinProblem() === null)
  check('#26 …but launches stay closed until it is', /not registered/.test(launch.launchBlocker() || ''), launch.launchBlocker())
  config.burnLive = true
  const c = use(fakeConn())
  await burner.crankBurner()
  check('#26 the burner never buys an unregistered ROOT', c.sent.length === 0 && /ROOT/.test(burner.burnerStatus().lastError || ''))
  config.burnLive = saved.live
  c.accounts.set(pump.bondingCurvePda(new PublicKey(X)).toBase58(), await curveAccount({ creator: wallet() }))
  const r = await launch.adoptRoot(X)
  check('#26 adopt-root accepts exactly the pinned mint', r?.mint === X && store.readState().rootMint === X && registry.rootPinProblem() === null)
  registry.patchCoin(X, { hidden: true, root: false, retiredAt: Date.now() })
  config.rootMint = saved.cfg
  registry.setRootMint(saved.st)
})

await block('#28 .env values: quotes + trailing comment; CANARY_PAYER and JUPITER_BASE validated', async () => {
  const e = parseEnv('B="true" # on\nC=\'5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9\' # payer\nD=plain # c\nE="a#b"')
  check('#28 a quoted value keeps no quotes when a comment follows', e.B === 'true' && e.C === '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9' && e.D === 'plain' && e.E === 'a#b', JSON.stringify(e))
  check('#28 a CANARY_PAYER that is not an address is a config problem', configProblems({ ...config, canaryPayer: '"5tz"' }).some(m => /CANARY_PAYER/.test(m)))
  check('#28 a JUPITER_BASE that is not an http(s) URL is a config problem', configProblems({ ...config, jupiterBase: '"https://lite-api.jup.ag/swap/v1"' }).some(m => /JUPITER_BASE/.test(m)))
})

await block('#29 relay tracking never overlaps itself', async () => {
  const c = use(fakeConn())
  let calls = 0
  c.getSignatureStatuses = async sigs => { calls++; await new Promise(r => setTimeout(r, 150)); return { context: { slot: c.slot }, value: sigs.map(() => null) } }
  const list = store.relaysStore.get()
  list.push({ sig: bs58.encode(randomBytes(64)), at: Date.now(), lastValidBlockHeight: null, kind: 'swap', mint: null })
  await Promise.all([trades.trackRelays(), trades.trackRelays(), trades.trackRelays()])
  const pending = list.filter(r => r.kind === 'swap' && !r.done && Date.now() - r.at < 600_000).length
  // one pass = ONE batched status read per 256 pending relays (review 2 #9: no longer one read per relay, capped at 50)
  check('#29 three overlapping ticks make ONE pass of status reads', calls === Math.max(1, Math.ceil(pending / 256)), `${calls} calls for ${pending} relays`)
})

/* ---------------- review 2 (money-path adversarial review): one block per confirmed finding ---------------- */

const b64 = tx => Buffer.from(tx.serialize()).toString('base64')
const preflightRefusal = () => new SendTransactionError({ action: 'simulate', signature: '', transactionMessage: 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.', logs: [] })

await block('R2#1 failed launches are rechecked in batches on a schedule; a dead blockhash is never relayed', async () => {
  const c = use(fakeConn()); c.autoConfirm = true; c.balance = 0 // nothing unrelated finishes with a big fake balance
  // other in-flight journals from earlier blocks would settle (slowly) in this pass: set them aside
  const others = Object.fromEntries(Object.entries(store.launchesStore.get()).filter(([, l]) => l.status === 'sent' || l.status === 'created'))
  store.launchesStore.update(all => { for (const k of Object.keys(others)) delete all[k] })
  const pdas = new Set(), ids = []
  store.launchesStore.update(all => {
    for (let i = 0; i < 50; i++) {
      const m = wallet(), id = `rf${i}`
      ids.push(id); pdas.add(pump.bondingCurvePda(new PublicKey(m)).toBase58())
      all[id] = { id, status: 'failed', error: 'the transaction expired before it landed', mint: m, sig: null, raw: null, sentAt: Date.now() - 60_000, creatorKey: sol.coinKeyFor(m).publicKey.toBase58(), wallet: wallet(), parent: registry.rootMint(), level: 1, symbol: 'RF' }
    }
  })
  let calls = 0, keys = 0
  const gma = c.getMultipleAccountsInfo
  c.getMultipleAccountsInfo = async ks => { const mine = ks.filter(k => pdas.has(String(k))).length; if (mine) { calls++; keys += mine } return gma(ks) }
  const realNow = Date.now
  try {
    launch._clearBackoffs()
    await launch.advanceLaunches()
    const p1 = { calls, keys }
    await launch.advanceLaunches()
    check('R2#1 50 failed launches cost ONE batched curve read in a pass (not one read each)', p1.calls === 1 && p1.keys === 50, JSON.stringify(p1))
    check('R2#1 …and no read on the very next tick (the recheck is scheduled, not immediate)', calls === p1.calls, `${calls - p1.calls} more reads`)
    Date.now = () => realNow() + 3 * 60_000
    await launch.advanceLaunches()
    const p3 = calls
    await launch.advanceLaunches()
    check('R2#1 …due again minutes later (one batched read), then not on the next tick', p3 === p1.calls + 1 && calls === p3, `${p3} / ${calls}`)
    check('R2#1 (setup) the failed launches are on the recheck schedule', ids.every(id => launch._recheckScheduled(id)))
    Date.now = () => realNow() + 25 * 3_600_000
    await launch.advanceLaunches()
    check('R2#1 a failed launch past its 24 h recheck window is dropped from the schedule (the maps stay bounded)', ids.every(id => !launch._recheckScheduled(id)))
  } finally { Date.now = realNow; launch._clearBackoffs() }
  check('R2#1 the rechecked launches stay failed (no curve on-chain)', ids.every(id => store.launchesStore.get()[id]?.status === 'failed'))
  store.launchesStore.update(all => { for (const id of ids) delete all[id]; Object.assign(all, others) })
  // a signed launch whose blockhash is (about to be) dead can never land: refused before it is journaled or relayed
  const c2 = use(fakeConn())
  const w = Keypair.generate()
  const p = await launch.prepareLaunch(prepBody(registry.rootMint(), { wallet: w.publicKey.toBase58() }))
  const tx = VersionedTransaction.deserialize(Buffer.from(p.tx, 'base64')); tx.sign([w])
  c2.height = 145 // lastValidBlockHeight 150: inside the safety margin
  const e = await rejects(() => launch.submitLaunch(p.id, b64(tx)))
  check('R2#1 submit refuses a launch whose blockhash is about to die (410): nothing journaled, nothing sent', e?.code === 410 && !store.launchesStore.get()[p.id] && c2.sent.length === 0, e?.message)
  store.preparedStore.update(all => { delete all[p.id] })
})

await block('R2#2 adopt: a fee-shared coin is ours only when OUR coin key is its sharing admin', async () => {
  const c = use(fakeConn())
  const X = wallet(), cfgX = pump.feeSharingConfigPda(new PublicKey(X)).toBase58()
  c.accounts.set(pump.bondingCurvePda(new PublicKey(X)).toBase58(), await curveAccount({ creator: cfgX }))
  c.accounts.set(cfgX, await sharingAccount(X, [{ address: wallet(), shareBps: 10_000 }], wallet())) // someone else locked it
  const e1 = await rejects(() => launch.adoptOrphan(X))
  check('R2#2 a foreign coin whose fee sharing someone else set up is refused (400) before its metadata is read', e1?.code === 400 && /not created under/.test(e1.message) && !registry.coinRec(X), `${e1?.code} ${e1?.message}`)
  const Y = wallet(), cfgY = pump.feeSharingConfigPda(new PublicKey(Y)).toBase58()
  c.accounts.set(pump.bondingCurvePda(new PublicKey(Y)).toBase58(), await curveAccount({ creator: cfgY }))
  c.accounts.set(cfgY, await sharingAccount(Y, [{ address: wallet(), shareBps: 10_000 }], sol.coinKeyFor(Y).publicKey.toBase58()))
  const e2 = await rejects(() => launch.adoptOrphan(Y))
  check('R2#2 …a coin whose sharing admin IS our coin key passes the ownership check (it then needs its metadata)', e2?.code === 502 && /metadata/.test(e2.message), `${e2?.code} ${e2?.message}`)
})

await block('R2#3 setting ROOT is idempotent: a crash between the coin write and the ROOT write is repaired on retry', async () => {
  const saved = registry.rootMint()
  const stateFile = store.stateStore.file()
  const failStateWrites = () => store.setWriteGuard(f => { if (f === stateFile) throw new Error('ENOSPC (simulated)') })
  try {
    registry.setRootMint('')
    const m = wallet()
    const l = { id: 'rootidem', mint: m, wallet: wallet(), parent: null, level: 0, root: true, hidden: false, symbol: 'RIDEM', name: 'Ridem', uri: 'u', holderPool: sol.poolKeyFor(m).publicKey.toBase58(), parentPool: null, creatorKey: sol.coinKeyFor(m).publicKey.toBase58(), sig: null, buyLamports: '0' }
    failStateWrites()
    let threw = false
    try { launch.registerCoin(l) } catch { threw = true } finally { store.setWriteGuard(null) }
    check('R2#3 (setup) the ROOT write failed after the coin write', threw && registry.coinRec(m)?.root === true && registry.rootMint() === '')
    launch.registerCoin(l) // the next settle of the same (still 'sent') ROOT journal
    check('R2#3 the retry of registerCoin sets ROOT', registry.rootMint() === m, registry.rootMint())
    registry.patchCoin(m, { hidden: true, root: false, retiredAt: Date.now() }); registry.setRootMint('')
    // adopt-root: the same crash between its coin write and its ROOT write
    const c = use(fakeConn())
    const X = wallet()
    c.accounts.set(pump.bondingCurvePda(new PublicKey(X)).toBase58(), await curveAccount({ creator: wallet() }))
    failStateWrites()
    const e1 = await rejects(() => launch.adoptRoot(X))
    store.setWriteGuard(null)
    check('R2#3 (setup) adopt-root registered the coin but could not set ROOT', !!e1 && registry.coinRec(X)?.root === true && registry.rootMint() === '')
    registry.patchCoin(X, { note: 'kept' })
    const e2 = await rejects(() => launch.adoptRoot(X))
    check('R2#3 re-running adopt-root sets ROOT (it answered 409 before) and never rewrites the record', !e2 && registry.rootMint() === X && registry.coinRec(X).note === 'kept', e2?.message)
    registry.patchCoin(X, { hidden: true, root: false, retiredAt: Date.now() })
  } finally { store.setWriteGuard(null); registry.setRootMint(saved) }
})

/** Lamports move on this fake chain like on the real one for a sweep: the fee payer pays the fee (a payer that cannot
 *  is AccountNotFound), system transfers move lamports (never below 0), pump's collect moves the old vault above rent
 *  into the coin key. `amm: true` adds the PumpSwap leg: the associated-token program's (idempotent) create charges its
 *  PAYER the rent of a 165-byte token account, and pump_amm's collect_coin_creator_fee moves the old AMM vault ATA's
 *  WSOL into the coin key's own WSOL account (which must exist by then). (TOKENKEG / ATA_RENT are defined at the top of
 *  the review-fix section: this function is hoisted and used before this line runs.) */
function lamportChain(c, ck, { amm = false } = {}) {
  const vault = pump.creatorVaultPda(new PublicKey(ck)).toBase58()
  const ammVault = pump.vaultAccounts(ck).ammVaultAta.toBase58(), keyWsol = pump.coinKeyWsolAta(ck).toBase58()
  const get = (m, a) => (m.has(a) ? m.get(a) : c.balances.has(a) ? c.balances.get(a) : c.accounts.get(a)?.lamports ?? 0)
  const amountOf = (t, a) => (t.has(a) ? t.get(a) : c.accounts.get(a)?.data?.length >= 72 ? Number(Buffer.from(c.accounts.get(a).data).readBigUInt64LE(64)) : 0)
  const run = tx => {
    const keys = tx.message.staticAccountKeys.map(k => k.toBase58()), m = new Map(), t = new Map()
    const fee = Number(sol.txFeeLamports(250_000, tx.message.header.numRequiredSignatures))
    if (get(m, keys[0]) < fee) return { err: 'AccountNotFound' }
    m.set(keys[0], get(m, keys[0]) - fee)
    for (const [i, ix] of tx.message.compiledInstructions.entries()) {
      const prog = keys[ix.programIdIndex], d = Buffer.from(ix.data)
      if (prog === psdk.PUMP_PROGRAM_ID.toBase58()) { const extra = get(m, vault) - Number(RENT0); if (extra > 0) { m.set(vault, Number(RENT0)); m.set(ck, get(m, ck) + extra) } }
      if (prog === '11111111111111111111111111111111' && d.readUInt32LE(0) === 2) {
        const lam = Number(d.readBigUInt64LE(4)), from = keys[ix.accountKeyIndexes[0]], to = keys[ix.accountKeyIndexes[1]]
        if (get(m, from) < lam) return { err: { InstructionError: [i, { Custom: 1 }] } }
        m.set(from, get(m, from) - lam); m.set(to, get(m, to) + lam)
      }
      if (amm && prog === 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL') {
        const payer = keys[ix.accountKeyIndexes[0]], ata = keys[ix.accountKeyIndexes[1]]
        if (get(m, ata) === 0) {
          if (get(m, payer) < ATA_RENT) return { err: { InstructionError: [i, { Custom: 1 }] } } // "Transfer: insufficient lamports"
          m.set(payer, get(m, payer) - ATA_RENT); m.set(ata, ATA_RENT)
        }
      }
      if (amm && prog === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') {
        if (get(m, keyWsol) === 0) return { err: { InstructionError: [i, { Custom: 3012 }] } } // AccountNotInitialized
        const a = amountOf(t, ammVault)
        if (a > 0) { m.set(ammVault, get(m, ammVault) - a); m.set(keyWsol, get(m, keyWsol) + a); t.set(ammVault, 0) }
      }
      // SPL Token closeAccount (a WSOL account unwraps: every lamport goes to the destination)
      if (prog === TOKENKEG && d[0] === 9) {
        const from = keys[ix.accountKeyIndexes[0]], to = keys[ix.accountKeyIndexes[1]]
        m.set(to, get(m, to) + get(m, from)); m.set(from, 0)
      }
    }
    return { m, t }
  }
  const applied = new Set()
  // like a real RPC: `accounts` asked for → their post-state (null for an account left at 0 lamports)
  c.simulateTransaction = async (tx, cfg) => { c.simulations++; const r = run(tx); const addrs = cfg?.accounts?.addresses || []; return { value: { err: r.err || null, logs: [], ...(addrs.length && !r.err ? { accounts: addrs.map(a => { const l = get(r.m, a); return l > 0 ? { lamports: l, owner: SystemProgram.programId.toBase58(), data: ['', 'base64'], executable: false, rentEpoch: 0 } : null }) } : {}) } } }
  c.onSend = (tx, s) => {
    if (applied.has(s)) return
    applied.add(s)
    const r = run(tx)
    if (r.m) for (const [a, v] of r.m) { if (c.accounts.has(a)) c.accounts.set(a, { ...c.accounts.get(a), lamports: v }); else c.balances.set(a, v) }
    if (r.t) for (const [a, amt] of r.t) { const acc = c.accounts.get(a); if (acc) { const d = Buffer.from(acc.data); d.writeBigUInt64LE(BigInt(amt), 64); c.accounts.set(a, { ...acc, data: d }) } }
  }
  return vault
}
/** The coin key's OLD PumpSwap creator-vault ATA (WSOL, legacy token program) holding `amount` on the fake chain. */
function ammVaultOf(c, ck, amount) {
  const a = pump.vaultAccounts(ck).ammVaultAta.toBase58()
  const d = Buffer.alloc(165); pump.NATIVE_MINT.toBuffer().copy(d, 0); d.writeBigUInt64LE(BigInt(amount), 64); d[108] = 1
  c.accounts.set(a, { lamports: ATA_RENT + Number(amount), owner: new PublicKey(TOKENKEG), executable: false, data: d, rentEpoch: 0 })
  return a
}
const ammAmount = (c, a) => Number(Buffer.from(c.accounts.get(a).data).readBigUInt64LE(64))
const graduatedCurve = async mint => ({ at: pump.bondingCurvePda(new PublicKey(mint)).toBase58(), acct: await curveAccount({ creator: pump.feeSharingConfigPda(new PublicKey(mint)).toBase58(), complete: true, vt: '0', vq: '0', realTokens: '0' }) })

await block('R2#4 a failed collect pass never drains the coin key; a key that cannot pay its fee is still swept', async () => {
  const c = use(fakeConn()); c.autoConfirm = true
  const { k, ck } = await unsweptCoin(c)
  const vault = lamportChain(c, ck)
  const sim = c.simulateTransaction
  let n = 0
  c.simulateTransaction = async (tx, cfg) => { if (n++ === 0) throw new Error('429 Too Many Requests'); return sim(tx, cfg) }
  launch._clearBackoffs()
  await launch.finalizeCoin(k.mint)
  check('R2#4 after a failed collect pass the coin key keeps its SOL (no key-only drain while the old vault holds fees)', c.balances.get(ck) === 4_600_000 && c.sent.length === 0, `key ${c.balances.get(ck)}, sent ${c.sent.length}`)
  await launch.finalizeCoin(k.mint)
  check('R2#4 …the next pass collects the old vault and sweeps it: coin swept, vault back at rent', registry.coinRec(k.mint).swept === true && c.accounts.get(vault).lamports === Number(RENT0), `swept ${registry.coinRec(k.mint).swept}, vault ${c.accounts.get(vault).lamports}`)
  // a coin key already at 0 lamports (drained by an older build) while its old vault holds fees
  const c2 = use(fakeConn()); c2.autoConfirm = true
  const { k: k2, ck: ck2 } = await unsweptCoin(c2, { keyBal: 0 })
  const vault2 = lamportChain(c2, ck2)
  c2.balances.set(E, 1_000_000_000)
  await launch.finalizeCoin(k2.mint)
  check('R2#4 a 0-lamport coin key with fees in its old vault is swept (the engine pays that fee; the key signs its transfers)', registry.coinRec(k2.mint).swept === true && c2.accounts.get(vault2).lamports === Number(RENT0) && c2.balances.get(ck2) === 0, `swept ${registry.coinRec(k2.mint).swept}, vault ${c2.accounts.get(vault2).lamports}, key ${c2.balances.get(ck2)}`)
})

await block('R2#5 the fee index books at most what left the coin\'s own fee vault in that tx', async () => {
  const c = use(fakeConn())
  const kid = addCoin({ symbol: 'FAKEF', parent: registry.rootMint() })
  const L = kid.shares.find(s => s.role === 'creator').address
  const cfg = pump.feeSharingConfigPda(new PublicKey(kid.mint)), vault = pump.creatorVaultPda(cfg).toBase58()
  const sharing = { address: cfg, config: { shareholders: kid.shares.map(s => ({ address: new PublicKey(s.address), shareBps: s.shareBps })) } }
  const L2 = Keypair.generate().publicKey
  const mkTx = async deltas => {
    const ixs = [...await pump.distributeIxs({ mint: kid.mint, sharing, graduated: false, payer: L2 }), sol.transferIx(L2, L, 1_000_000_000_000n)]
    const msg = new TransactionMessage({ payerKey: L2, recentBlockhash: bs58.encode(randomBytes(32)), instructions: ixs }).compileToV0Message()
    const keys = msg.staticAccountKeys.map(k => k.toBase58())
    const big = 2_000_000_000_000
    const pre = keys.map(() => big), post = keys.map((k, i) => big + (deltas.get(k) || 0) + (k === L ? 1_000_000_000_000 : 0) - (i === 0 ? 1_000_000_000_000 + 5000 : 0))
    const s = bs58.encode(randomBytes(64))
    c.txMeta.set(s, { meta: { err: null, fee: 5000, preBalances: pre, postBalances: post, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [] }, transaction: { message: msg } })
    return s
  }
  const s1 = await mkTx(new Map()) // pump's distribute moved nothing (below its minimum) + 1000 SOL from the launcher's other wallet
  const s2 = await mkTx(new Map([[kid.shares[0].address, 8_000_000], [kid.shares[1].address, 8_000_000], [B, 2_000_000], [P, 2_000_000], [vault, -20_000_000]]))
  let list = [{ signature: 'R2F0', err: null }]
  c.getSignaturesForAddress = async (addr, o = {}) => { if (String(addr) !== P) return []; const i = o.until ? list.findIndex(s => s.signature === o.until) : -1; return (i >= 0 ? list.slice(0, i) : list).slice(0, o.limit || 1000) }
  store.patchState({ distIndexUntil: 'R2F0' })
  list = [{ signature: s1, err: null }, { signature: 'R2F0', err: null }]
  await dist.indexDistributions({ force: true })
  const led = store.mintLedger(kid.mint)
  check('R2#5 a no-op distribute + a 1000 SOL transfer to the launcher books NOTHING and emits no payout event', led.distributedLamports === '0' && led.toLauncherLamports === '0' && led.cranks === 0 && !store.eventsStore.get().some(e => e.id === `dist:${s1}`), JSON.stringify(led))
  list = [{ signature: s2, err: null }, ...list]
  await dist.indexDistributions({ force: true })
  const led2 = store.mintLedger(kid.mint)
  check('R2#5 real fees + the same extra transfer: only the shares of the 20M that left the vault are booked', led2.distributedLamports === '20000000' && led2.toLauncherLamports === '8000000' && led2.toParentLamports === '8000000' && led2.toBurnLamports === '2000000' && led2.toProtocolLamports === '2000000', JSON.stringify(led2))
  // pump floors every share and pays the rounding remainder to ONE shareholder (mainnet 4RsMS55z…: +2 on the 7000 bps
  // share): a real distribution of 10,000,009 → floors 4,000,003 / 4,000,003 / 1,000,000 / 1,000,000 + remainder 3
  const real = new Map([[kid.shares[0].address, 4_000_003n], [kid.shares[1].address, 4_000_006n], [B, 1_000_000n], [P, 1_000_000n]])
  const by = dist.cappedByRole(kid.shares, real, 10_000_009n)
  check('R2#5 a real distribution whose rounding remainder went to one shareholder is booked in full (never under-booked)', by.toLauncher === 4_000_003n && by.toParent === 4_000_006n && by.toBurn === 1_000_000n && by.toProtocol === 1_000_000n, JSON.stringify(by, (k, v) => (typeof v === 'bigint' ? String(v) : v)))
  const extra = new Map([...real, [kid.shares[0].address, 4_000_003n + 1_000_000_000n]])
  const by2 = dist.cappedByRole(kid.shares, extra, 10_000_009n)
  check('R2#5 …while an extra transfer on top gains at most the remainder, and never pushes the total past the drop', by2.toLauncher - 4_000_003n <= 3n && by2.toLauncher + by2.toParent + by2.toBurn + by2.toProtocol <= 10_000_009n)
})

await block('R2#6 the crank pass cap counts ATTEMPTS, and a crank that did not land ends the pass', async () => {
  const ready = async c => {
    const kid = addCoin({ symbol: 'CAPK', parent: registry.rootMint() })
    const cfg = pump.feeSharingConfigPda(new PublicKey(kid.mint)).toBase58()
    c.accounts.set(cfg, await sharingAccount(kid.mint, kid.shares))
    for (const s of kid.shares) c.accounts.set(s.address, sysAcct(5_000_000))
    c.accounts.set(pump.creatorVaultPda(new PublicKey(cfg)).toBase58(), sysAcct(Number(RENT0 + 20_000_000n)))
    registry.setLive(kid.mint, { vaultLamports: String(RENT0 + 20_000_000n), graduated: false, sharingOk: true, ammAtaExists: false })
    return kid
  }
  const attemptsOn = (c, mints) => new Set(c.sent.map(txFromB64).filter(t => t.message.staticAccountKeys.some(k => mints.has(k.toBase58()))).map(t => sol.sigOf(t))).size
  const c = use(fakeConn()); c.balances.set(E, 1_000_000_000)
  const kids = []
  for (let i = 0; i < 10; i++) kids.push(await ready(c))
  c.getSignatureStatuses = async sigs => ({ context: { slot: c.slot }, value: sigs.map(s => (c.sentSigs.has(s) ? { confirmationStatus: 'confirmed', err: { InstructionError: [1, { Custom: 1 }] } } : null)) })
  await dist.distributeDue()
  const a1 = attemptsOn(c, new Set(kids.map(k => k.mint)))
  check('R2#6 10 due coins whose cranks all fail → at most 8 attempts in one pass', a1 >= 1 && a1 <= 8, `${a1} attempts`)
  // cranks that do not land (congestion, a dropping RPC): each costs ~85 s of proof — the pass stops at the first
  const c2 = use(fakeConn()); c2.balances.set(E, 1_000_000_000); c2.height = 200
  const k1 = await ready(c2), k2 = await ready(c2)
  const t0 = Date.now()
  await dist.distributeDue()
  const a2 = attemptsOn(c2, new Set([k1.mint, k2.mint]))
  check('R2#6 a crank that provably did not land ends the pass (one attempt, not one per due coin)', a2 === 1, `${a2} attempts in ${Date.now() - t0} ms`)
})

await block('R2#7 /tx/status says "dead" only on proof from a caught-up node, seen twice seconds apart', async () => {
  const c = use(fakeConn())
  c.height = 200 // the finalized height is past lastValidBlockHeight + 40
  const sig = bs58.encode(randomBytes(64))
  c.statusSlot = 130 // the status lookup is answered by a node far behind the finalized slot
  const lag = await sol.sigStatus(sig, 150, c)
  check('R2#7 a null lookup from a lagging node is never "dead"', lag === 'pending', lag)
  c.statusSlot = null
  const first = await sol.sigStatus(sig, 150, c)
  const realNow = Date.now
  let second
  try { Date.now = () => realNow() + 3000; second = await sol.sigStatus(sig, 150, c) } finally { Date.now = realNow }
  check('R2#7 a caught-up null lookup reads "pending" the first time, "dead" when seen again seconds later', first === 'pending' && second === 'dead', `${first} / ${second}`)
})

await block('R2#8 /tx/send: a send whose fate is unknown answers with the sig, never "send failed"', async () => {
  const c = use(fakeConn())
  const user = Keypair.generate()
  const mk = () => { const t = new VersionedTransaction(new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: bs58.encode(randomBytes(32)), instructions: [sol.transferIx(user.publicKey, Keypair.generate().publicKey, 5n)] }).compileToV0Message()); t.sign([user]); return t }
  const t1 = mk()
  c.sendRawTransaction = async () => { throw new Error('The operation was aborted due to timeout') }
  const r1 = await trades.relay(b64(t1)).catch(e => e)
  check('R2#8 a timed-out send returns { sig, status: "unknown" } (the site then polls it)', r1?.sig === sol.sigOf(t1) && r1.status === 'unknown', r1?.message)
  const t2 = mk()
  c.sendRawTransaction = async () => { throw new Error('502 Bad Gateway: upstream connect error') }
  const r2 = await trades.relay(b64(t2)).catch(e => e)
  check('R2#8 …a 5xx from the RPC too', r2?.sig === sol.sigOf(t2) && r2.status === 'unknown', r2?.message)
  const t3 = mk()
  c.sendRawTransaction = async () => { throw preflightRefusal() }
  const e3 = await rejects(() => trades.relay(b64(t3)))
  check('R2#8 a preflight refusal is still an error (nothing was forwarded)', e3?.code === 502 && /send failed/.test(e3.message), e3?.message)
})

await block('R2#9 swaps refused at preflight are never tracked; pending junk cannot hide a real trade', async () => {
  const c = use(fakeConn())
  const kid = addCoin({ symbol: 'TAPE', parent: registry.rootMint() })
  const user = Keypair.generate(), bh = bs58.encode(randomBytes(32))
  const build = n => new VersionedTransaction(new TransactionMessage({ payerKey: user.publicKey, recentBlockhash: bh, instructions: [...sol.budgetIxs(200_000), sol.transferIx(user.publicKey, Keypair.generate().publicKey, BigInt(n))] }).compileToV0Message())
  const info = { lastValidBlockHeight: 1000, mint: kid.mint, side: 'buy', route: 'curve', amount: '5', outAmount: '9', wallet: user.publicKey.toBase58() }
  const real = build(1); trades.rememberBuilt(real, info); real.sign([user])
  await trades.relay(b64(real), { send: false })
  c.sendRawTransaction = async () => { throw preflightRefusal() }
  const junk = []
  for (let i = 0; i < 60; i++) { const t = build(100 + i); trades.rememberBuilt(t, info); t.sign([user]); junk.push(sol.sigOf(t)); await trades.relay(b64(t)).catch(() => {}) }
  const rel = store.relaysStore.get()
  check('R2#9 a swap refused at preflight is journaled as rejected, never left pending', junk.every(s => rel.find(r => r.sig === s)?.done === 'rejected'))
  c.statuses.set(sol.sigOf(real), { confirmationStatus: 'confirmed', err: null })
  await trades.trackRelays()
  check('R2#9 a real landed swap still gets its trade event behind 60 newer relays', store.eventsStore.get().some(e => e.id === `trade:${sol.sigOf(real)}`))
})

await block('R2#10 earned.json is bounded: slim rows, a few per wallet, LRU-capped wallets, lifetime totals kept', async () => {
  const saved = store.earnedStore.get()
  try {
    store.earnedStore.set({})
    const parent = registry.rootMint(), w0 = wallet()
    const row = (w, i) => ({ key: `s${i}:${w}`, parentMint: parent, symbol: 'R', lamports: 1000, sig: `s${i}`, at: i, roundId: 'r' })
    for (let i = 0; i < 30; i++) store.noteEarned(w0, row(w0, i))
    store.noteEarned(w0, row(w0, 29)) // a replayed booking
    const e0 = store.earnedStore.get()[w0]
    check('R2#10 a wallet keeps at most MAX_EARNED_ROWS slim rows (no repeated key) and its lifetime total; a replay is ignored', store.MAX_EARNED_ROWS <= 25 && e0.rows.length === store.MAX_EARNED_ROWS && e0.rows.every(r => !('key' in r)) && e0.lamports === '30000' && e0.byParent?.[parent] === '30000', JSON.stringify({ n: e0.rows.length, l: e0.lamports, bp: e0.byParent }))
    for (let i = 0; i < store.MAX_EARNED_WALLETS + 25; i++) { const w = wallet(); store.noteEarned(w, row(w, 0)) }
    const e = store.earnedStore.get()
    const n = Object.keys(e).filter(k => k !== '_meta').length
    check('R2#10 the wallet count is capped; the least recently paid wallet goes first', n === store.MAX_EARNED_WALLETS && !e[w0], `${n} wallets`)
    check('R2#10 holders-paid still counts the evicted wallets', store.holdersPaidCount(() => true) === store.MAX_EARNED_WALLETS + 26, String(store.holdersPaidCount(() => true)))
  } finally { store.earnedStore.set(saved) }
})

await block('R2#11/#15 the lock writes only the split this engine plans NOW; a burn-less split is impossible', async () => {
  const saved = config.burnPrivateKey
  const B2 = Keypair.generate()
  try {
    // (b) no burn key: a landed launch is not registered with the burn 10% folded into protocol — it waits
    config.burnPrivateKey = ''
    const m = wallet()
    const l = { id: 'nb1', mint: m, wallet: wallet(), parent: registry.rootMint(), level: 1, root: false, hidden: false, symbol: 'NOBRN', name: 'Nb', uri: 'u', holderPool: sol.poolKeyFor(m).publicKey.toBase58(), parentPool: sol.poolKeyFor(registry.rootMint()).publicKey.toBase58(), creatorKey: sol.coinKeyFor(m).publicKey.toBase58(), sig: null, buyLamports: '0' }
    const e1 = (() => { try { launch.registerCoin(l); return null } catch (e) { return e } })()
    check('R2#11 with no burn key a landed launch is not registered with a burn-less split (it waits)', !!e1 && !registry.coinRec(m), e1 ? e1.message : JSON.stringify(registry.coinRec(m)?.shares))
    check('R2#11 …and a ROOT split without the burn wallet is refused too', throws(() => M.rootShareholdersFor(config.rootShares, { burn: '', protocol: P, holders: wallet(), creator: wallet() })))
    // the relay of a prepared launch is refused while the engine could not lock it
    config.burnPrivateKey = saved
    const cs = use(fakeConn())
    const w = Keypair.generate()
    const p = await launch.prepareLaunch(prepBody(registry.rootMint(), { wallet: w.publicKey.toBase58() }))
    const tx = VersionedTransaction.deserialize(Buffer.from(p.tx, 'base64')); tx.sign([w])
    config.burnPrivateKey = ''
    const e2 = await rejects(() => launch.submitLaunch(p.id, b64(tx)))
    config.burnPrivateKey = saved
    check('R2#11 submit refuses a relay while the engine could not lock it (503): nothing journaled or sent', e2?.code === 503 && !store.launchesStore.get()[p.id] && cs.sent.length === 0, e2?.message)
    store.preparedStore.update(all => { delete all[p.id] })
    const rec = launch.registerCoin(l)
    check('R2#11 once the burn key is back the launch registers with the burn wallet', rec.shares.some(s => s.role === 'burn' && s.address === B))
    // (a) the burn key rotated between registration and lock (a kill during a key leak): never lock the OLD wallet
    const c = use(fakeConn()); c.autoConfirm = true
    c.accounts.set(pump.bondingCurvePda(new PublicKey(m)).toBase58(), await curveAccount({ creator: rec.creatorKey }))
    c.balances.set(rec.creatorKey, 0)
    config.burnPrivateKey = bs58.encode(B2.secretKey)
    launch._clearBackoffs()
    await launch.finalizeCoin(m)
    check('R2#15 a split recorded under the OLD burn wallet is never locked: nothing sent, the coin is flagged', c.sent.length === 0 && !registry.coinRec(m).sharing && !!registry.coinRec(m).sharesProblem, JSON.stringify({ sent: c.sent.length, sharing: !!registry.coinRec(m).sharing }))
    const r = await launch.replanShares(m)
    const now = registry.coinRec(m).shares
    check('R2#15 the admin re-plan moves the split to the current wallets (roles and bps kept)', r?.after && now.find(s => s.role === 'burn')?.address === B2.publicKey.toBase58() && now.map(s => `${s.role}:${s.shareBps}`).join() === rec.shares.map(s => `${s.role}:${s.shareBps}`).join() && !registry.coinRec(m).sharesProblem)
    await launch.finalizeCoin(m)
    const lockTx = c.sent.map(txFromB64).find(t => t.message.staticAccountKeys[0].toBase58() === rec.creatorKey)
    const bytes = lockTx ? Buffer.from(lockTx.message.serialize()) : Buffer.alloc(0)
    check('R2#15 …and the lock then names the NEW burn wallet, never the old one', !!registry.coinRec(m).sharing?.address && bytes.includes(B2.publicKey.toBuffer()) && !bytes.includes(BURN.publicKey.toBuffer()))
  } finally { config.burnPrivateKey = saved }
})

await block('R2#16 a failing canary verdict survives a restart and an RPC error; only a success clears it', async () => {
  const savedCanary = launch.canaryStatus()
  try {
    launch.setCanary({ status: 'failing', detail: 'a pump program change (test)' })
    const L2 = await import('./launch.js?restart=canary1') // a fresh module over the same data dir = a restarted engine
    check('R2#16 after a restart the canary still reads failing and launches stay paused', L2.canaryStatus().status === 'failing' && /pump changed/.test(L2.launchBlocker({ root: true }) || ''), JSON.stringify(L2.canaryStatus()))
    launch._forgetCanary()
    const c = use(fakeConn()); c.getBalance = async () => { throw new Error('429 Too Many Requests') }
    await canary.runCanary()
    check('R2#16 an RPC error right after the restart keeps it failing', launch.canaryStatus().status === 'failing', launch.canaryStatus().status)
    launch.setCanary({ status: 'ok', detail: 'simulated OK (test)' })
    const L3 = await import('./launch.js?restart=canary2')
    check('R2#16 a successful simulation clears it for good', L3.canaryStatus().status !== 'failing' && !/pump changed/.test(L3.launchBlocker({ root: true }) || ''))
  } finally { launch.setCanary({ status: savedCanary.status === 'failing' ? 'unknown' : savedCanary.status, detail: savedCanary.detail }) }
})

/* ---------------- review 3: one block per confirmed finding ---------------- */

const feeProgId = psdk.PUMP_FEE_PROGRAM_ID.toBase58()
const touchesFees = b => { const tx = txFromB64(b); const keys = tx.message.staticAccountKeys.map(x => x.toBase58()); return tx.message.compiledInstructions.some(ix => keys[ix.programIdIndex] === feeProgId) }
/** The system transfers of a sent tx: [{ from, to, lamports }]. */
const transfersOf = b => { const tx = txFromB64(b); const keys = tx.message.staticAccountKeys.map(k => k.toBase58()); return tx.message.compiledInstructions.filter(ix => keys[ix.programIdIndex] === '11111111111111111111111111111111' && Buffer.from(ix.data).readUInt32LE(0) === 2).map(ix => ({ from: keys[ix.accountKeyIndexes[0]], to: keys[ix.accountKeyIndexes[1]], lamports: Buffer.from(ix.data).readBigUInt64LE(4) })) }
const preparedRec = (id, m, extra = {}) => ({ id, status: 'prepared', mint: m, wallet: wallet(), parent: registry.rootMint(), level: 1, root: false, hidden: false, expiresAt: Date.now() - 700_000, createdAt: Date.now() - 800_000, symbol: 'LATE', name: 'Late', uri: `${config.siteUrl}/m/${m}.json`, image: '', socials: {}, buyLamports: '0', fundLamports: '12500000', creatorKey: sol.coinKeyFor(m).publicKey.toBase58(), holderPool: sol.poolKeyFor(m).publicKey.toBase58(), parentPool: sol.poolKeyFor(registry.rootMint()).publicKey.toBase58(), message: '', lastValidBlockHeight: 250, builtSlot: 4000, alts: [], ...extra })

await block('R3#1 a never-submitted presigned launch is forgotten only on chain proof that its blockhash is dead', async () => {
  const c = use(fakeConn())
  mkdirSync(join(config.dataDir, 'meta'), { recursive: true })
  const m = wallet(), launcher = wallet()
  const metaFile = join(config.dataDir, 'meta', `${m}.json`)
  writeFileSync(metaFile, JSON.stringify(ipfs.metaJson({ name: 'Late', symbol: 'LATE', mint: m, parent: registry.rootMint(), level: 1, launcher })))
  store.preparedStore.update(all => { all.late1 = preparedRec('late1', m, { wallet: launcher }) })
  // the cluster halted: 700 s of wall clock, but the finalized height (100) is still below lastValidBlockHeight (250)
  c.height = 100
  launch._clearBackoffs()
  await launch.sweepPrepared()
  check('R3#1 a halted chain: the prepared record and its self-hosted metadata are KEPT past the 10-minute mark', !!store.preparedStore.get().late1 && existsSync(metaFile))
  check('R3#1 …so the ROOT reset guard still counts it as in flight', M.launchesInFlight(Object.values(store.preparedStore.get()), {}, l => l.id === 'late1').length === 1)
  // the cluster restarts and the presigned tx lands late: adopted under the persisted parent
  c.accounts.set(pump.bondingCurvePda(new PublicKey(m)).toBase58(), await curveAccount({ creator: sol.coinKeyFor(m).publicKey.toBase58() }))
  launch._clearBackoffs()
  await launch.sweepPrepared()
  const adopted = store.launchesStore.get().late1
  check('R3#1 the late landing is adopted from the kept record (its pinned metadata still there)', adopted?.status === 'sent' && adopted.parent === registry.rootMint() && adopted.wallet === launcher && !store.preparedStore.get().late1 && existsSync(metaFile))
  store.launchesStore.update(all => { delete all.late1 })
  // past the height, but the "no curve" proof must come from a node at or past the finalized slot
  const m2 = wallet(), meta2 = join(config.dataDir, 'meta', `${m2}.json`)
  writeFileSync(meta2, '{}')
  store.preparedStore.update(all => { all.late2 = preparedRec('late2', m2) })
  c.height = 300; c.slot = 6000
  const gma = c.getMultipleAccountsInfo
  let nodeSlot = 5500 // a lagging node: it answers plain reads, refuses a minContextSlot it has not reached
  c.getMultipleAccountsInfo = async (keys, cfg) => { if (cfg?.minContextSlot && cfg.minContextSlot > nodeSlot) throw new Error('Minimum context slot has not been reached'); return gma(keys, cfg) }
  launch._clearBackoffs()
  await launch.sweepPrepared()
  check('R3#1 a "no curve" read from a node behind the finalized slot proves nothing: kept', !!store.preparedStore.get().late2 && existsSync(meta2))
  nodeSlot = 7000
  launch._clearBackoffs()
  await launch.sweepPrepared()
  check('R3#1 finalized height past lastValidBlockHeight + a caught-up "no curve" read: dropped, files cleaned', !store.preparedStore.get().late2 && !existsSync(meta2))
  // a record without its lastValidBlockHeight can never be proven dead: never dropped on the clock
  const m3 = wallet()
  store.preparedStore.update(all => { all.late3 = preparedRec('late3', m3, { lastValidBlockHeight: null }) })
  launch._clearBackoffs()
  await launch.sweepPrepared()
  check('R3#1 a record with no lastValidBlockHeight is never dropped on the clock', !!store.preparedStore.get().late3)
  store.preparedStore.update(all => { delete all.late3 })
  c.getMultipleAccountsInfo = gma
  launch._clearBackoffs()
})

await block('R3#2 a coin recorded as locked never runs a second lock; an undecodable config is never created over', async () => {
  const c = use(fakeConn()); c.autoConfirm = true
  const { k, ck } = await unsweptCoin(c)
  lamportChain(c, ck)
  c.accounts.delete(pump.feeSharingConfigPda(new PublicKey(k.mint)).toBase58()) // a lagging node: the config read is empty
  launch._clearBackoffs()
  await launch.finalizeCoin(k.mint)
  check('R3#2 a locked, unswept coin whose config read comes back empty sends NO second lock', !c.sent.some(touchesFees), `${c.sent.filter(touchesFees).length} lock tx(s)`)
  check('R3#2 …and its sweep still runs (collected, swept)', registry.coinRec(k.mint).swept === true && c.sent.some(hasPumpIx))
  // a config that EXISTS but this SDK cannot decode (a pump-fees layout change): never created over, flagged
  const k2 = addCoin({ symbol: 'UNDEC', parent: registry.rootMint(), locked: false })
  const ck2 = sol.coinKeyFor(k2.mint).publicKey.toBase58()
  c.accounts.set(pump.bondingCurvePda(new PublicKey(k2.mint)).toBase58(), await curveAccount({ creator: ck2 }))
  c.accounts.set(pump.feeSharingConfigPda(new PublicKey(k2.mint)).toBase58(), { lamports: 5_852_160, owner: psdk.PUMP_FEE_PROGRAM_ID, executable: false, data: Buffer.alloc(1024, 7), rentEpoch: 0 })
  c.balances.set(ck2, 12_500_000)
  const n0 = c.sent.length
  await launch.finalizeCoin(k2.mint)
  check('R3#2 an undecodable existing config: nothing sent, the coin is not recorded locked', c.sent.length === n0 && !registry.coinRec(k2.mint).sharing)
  check('R3#2 …and it is flagged (lockProblem → /health "lock")', !!registry.coinRec(k2.mint).lockProblem, JSON.stringify(registry.coinRec(k2.mint).lockProblem))
  const e = await rejects(() => pump.readSharingConfig(k2.mint))
  check('R3#2 readSharingConfig: undecodable → throws, absent → null', !!e && (await pump.readSharingConfig(wallet())) === null)
  const e2 = await rejects(() => launch.replanShares(k2.mint))
  check('R3#2 …and a re-plan over an undecodable config is refused', e2?.code === 502 || e2?.code === 409, `${e2?.code} ${e2?.message}`)
})

await block('R3#3 a sweep marks the coin swept only when the chain shows its key (and old vault) emptied', async () => {
  // (a) a lagging vault read under-counts the pre-lock fees: the simulation's post-state tops the pot up
  const c = use(fakeConn()); c.autoConfirm = true
  const { k, ck } = await unsweptCoin(c, { vault: 15_000_000n, keyBal: 4_600_000 })
  const vault = lamportChain(c, ck)
  const gma = c.getMultipleAccountsInfo
  c.getMultipleAccountsInfo = async (keys, cfg) => (await gma(keys, cfg)).map((x, i) => (String(keys[i]) === vault && !cfg?.minContextSlot ? sysAcct(Number(RENT0 + 1_000_000n)) : x))
  launch._clearBackoffs()
  await launch.finalizeCoin(k.mint)
  check('R3#3 a stale vault read: the key still ends at dust, the old vault at rent, and only then is the coin swept', registry.coinRec(k.mint).swept === true && (c.balances.get(ck) ?? 0) <= 100_000 && c.accounts.get(vault).lamports === Number(RENT0), `swept ${registry.coinRec(k.mint).swept}, key ${c.balances.get(ck)}, vault ${c.accounts.get(vault).lamports}`)
  // (b) drift the simulation could not see (it landed on a different state): not swept until a pass empties the key
  const c2 = use(fakeConn()); c2.autoConfirm = true
  const { k: k2, ck: ck2 } = await unsweptCoin(c2, { vault: 15_000_000n, keyBal: 4_600_000 })
  const vault2 = lamportChain(c2, ck2)
  const apply = c2.onSend
  let bumped = false
  c2.onSend = (tx, s) => { if (!bumped) { bumped = true; const v = c2.accounts.get(vault2); c2.accounts.set(vault2, { ...v, lamports: v.lamports + 5_000_000 }) } apply(tx, s) }
  launch._clearBackoffs()
  await launch.finalizeCoin(k2.mint)
  check('R3#3 the key ends above dust after a confirmed sweep: the coin is NOT marked swept', registry.coinRec(k2.mint).swept === false && c2.balances.get(ck2) > 100_000, `swept ${registry.coinRec(k2.mint).swept}, key ${c2.balances.get(ck2)}`)
  launch._clearBackoffs()
  await launch.finalizeCoin(k2.mint)
  check('R3#3 …the next pass sweeps the remainder by shares, then marks it swept', registry.coinRec(k2.mint).swept === true && (c2.balances.get(ck2) ?? 0) <= 100_000, `swept ${registry.coinRec(k2.mint).swept}, key ${c2.balances.get(ck2)}`)
  // (c) someone ran pump_amm's permissionless collect into the coin key's own WSOL account: counted and unwrapped
  const c3 = use(fakeConn()); c3.autoConfirm = true
  const { k: k3, ck: ck3 } = await unsweptCoin(c3, { vault: 0n, keyBal: 4_600_000 })
  lamportChain(c3, ck3)
  const { getAssociatedTokenAddressSync: ata, TOKEN_PROGRAM_ID: TOKEN, NATIVE_MINT: WSOLM } = require('@solana/spl-token')
  const keyWsol = ata(WSOLM, new PublicKey(ck3), true, TOKEN).toBase58()
  const wsolData = Buffer.alloc(165); WSOLM.toBuffer().copy(wsolData, 0); new PublicKey(ck3).toBuffer().copy(wsolData, 32); wsolData.writeBigUInt64LE(3_000_000n, 64); wsolData[108] = 1
  c3.accounts.set(keyWsol, { lamports: 5_039_280, owner: TOKEN, executable: false, data: wsolData, rentEpoch: 0 })
  launch._clearBackoffs()
  await launch.finalizeCoin(k3.mint)
  check('R3#3 WSOL a third party collected into the coin key is unwrapped and swept (never stranded behind swept:true)', registry.coinRec(k3.mint).swept === true && c3.accounts.get(keyWsol).lamports === 0 && (c3.balances.get(ck3) ?? 0) <= 100_000, `swept ${registry.coinRec(k3.mint).swept}, wsol ${c3.accounts.get(keyWsol).lamports}, key ${c3.balances.get(ck3)}`)
  // (d) right after the lock, the sweep never reads or simulates a state from before the lock landed
  const c4 = use(fakeConn())
  const kid = addCoin({ symbol: 'ANCH', parent: registry.rootMint(), locked: false })
  c4.accounts.set(pump.bondingCurvePda(new PublicKey(kid.mint)).toBase58(), await curveAccount({ creator: kid.creatorKey }))
  c4.accounts.set(kid.holderPool, sysAcct(5_000_000)) // the coin's pack pool exists: no seed read in the lock
  c4.balances.set(kid.creatorKey, 12_500_000)
  c4.getSignatureStatuses = async sigs => ({ context: { slot: 9000 }, value: sigs.map(s => (c4.sentSigs.has(s) ? { confirmationStatus: 'confirmed', err: null, slot: 8888 } : null)) })
  const reads = [], sims = []
  const gb = c4.getBalance, st = c4.simulateTransaction
  c4.getBalance = async (key, cfg) => { if (String(key) === kid.creatorKey) reads.push(cfg?.minContextSlot ?? null); return gb(key, cfg) }
  c4.simulateTransaction = async (tx, cfg) => { sims.push(cfg?.minContextSlot ?? null); return st(tx, cfg) }
  launch._clearBackoffs()
  await launch.finalizeCoin(kid.mint)
  check('R3#3 the lock records the slot it landed in', registry.coinRec(kid.mint).sharing?.slot === 8888, JSON.stringify(registry.coinRec(kid.mint).sharing?.slot))
  check('R3#3 …and the sweep after it reads the key and simulates at or after that slot (never a pre-lock state)', reads.length >= 1 && reads.every(x => x >= 8888) && sims.length >= 2 && sims.slice(1).every(x => x >= 8888), `reads ${reads.join()} · sims ${sims.join()}`)
})

await block('R3#4 the lock seeds only what the coin key can afford; a lock that keeps failing is flagged', async () => {
  const savedSeed = config.poolSeedSol
  try {
    const c = use(fakeConn()); c.autoConfirm = true
    const parent = addCoin({ symbol: 'SEEDP', parent: registry.rootMint() }) // a new parent: its holder pool does not exist yet
    const lockKid = async (bal, symbol) => {
      const kid = addCoin({ symbol, parent: parent.mint, locked: false })
      c.accounts.set(pump.bondingCurvePda(new PublicKey(kid.mint)).toBase58(), await curveAccount({ creator: kid.creatorKey }))
      c.balances.set(kid.creatorKey, bal)
      launch._clearBackoffs()
      await launch.finalizeCoin(kid.mint)
      const lockTx = c.sent.find(b => txFromB64(b).message.staticAccountKeys[0].toBase58() === kid.creatorKey && touchesFees(b))
      return { kid, lockTx, seed: lockTx ? transfersOf(lockTx).filter(t => t.to === kid.holderPool).reduce((a, t) => a + t.lamports, 0n) : null } // GACHAPAD: the coin's own pack pool
    }
    config.poolSeedSol = 0.008 // raised by the operator AFTER this coin key was funded with SETUP 0.0105 + seed 0.002
    const afford = 12_500_000n - sol.txFeeLamports(400_000) - RENT0 * 9n - RENT0 // config rent = rent(1024 B) = 9 × rent(0)
    const a = await lockKid(12_500_000, 'SEEDA')
    check('R3#4 the seed never exceeds what the key holds beyond the config rent, the lock fee and rent(0)', !!a.lockTx && a.seed > 0n && a.seed <= afford && a.seed >= RENT0, `seed ${a.seed}, afford ${afford}`)
    // GACHAPAD: every kid seeds its OWN pool (a fresh one each time)
    const b = await lockKid(6_700_000, 'SEEDB')
    check('R3#4 a key too poor for a rent-exempt seed locks WITHOUT a seed (the distribute minimum just waits)', !!b.lockTx && b.seed === 0n && !!registry.coinRec(b.kid.mint).sharing?.address, `seed ${b.seed}`)
    // a lock whose simulation keeps failing is recorded and, after 10 minutes, raises /health 'lock'
    c.simErr = { InstructionError: [2, { Custom: 1 }] }
    const f = await lockKid(12_500_000, 'SEEDF')
    c.simErr = null
    const rec = registry.coinRec(f.kid.mint)
    check('R3#4 a failing lock simulation: nothing sent, the coin carries lockProblem', !f.lockTx && !rec.sharing && !!rec.lockProblem?.reason, JSON.stringify(rec.lockProblem))
    check('R3#4 lockFailing: not at once, yes after 10 minutes', launch.lockFailing(rec, Date.now()) === false && launch.lockFailing(rec, Date.now() + 11 * 60_000) === true)
    launch._clearBackoffs()
    await launch.finalizeCoin(f.kid.mint)
    check('R3#4 …a lock that then succeeds clears it', !!registry.coinRec(f.kid.mint).sharing?.address && !registry.coinRec(f.kid.mint).lockProblem)
  } finally { config.poolSeedSol = savedSeed }
})

/** A fetched distribute tx on the fake chain: the 20M that left the coin's config vault paid 8/8/2/2 to its shares. */
function distTxMeta(kid, msg) {
  const cfg = pump.feeSharingConfigPda(new PublicKey(kid.mint))
  const deltas = new Map([[kid.shares[0].address, 8_000_000], [kid.shares[1].address, 8_000_000], [B, 2_000_000], [P, 2_000_000], [pump.creatorVaultPda(cfg).toBase58(), -20_000_000]])
  const keys = msg.staticAccountKeys.map(k => k.toBase58())
  const pre = keys.map(() => 100_000_000), post = keys.map((k, i) => 100_000_000 + (deltas.get(k) || 0) - (i === 0 ? 5000 : 0))
  return { meta: { err: null, fee: 5000, preBalances: pre, postBalances: post, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [] }, transaction: { message: msg } }
}
function indexOver(c, sigs) {
  const list = [...sigs.map(s => ({ signature: s, err: null })), { signature: 'R3ANCHOR', err: null }]
  c.getSignaturesForAddress = async (addr, o = {}) => { if (String(addr) !== P) return []; const i = o.until ? list.findIndex(s => s.signature === o.until) : -1; return (i >= 0 ? list.slice(0, i) : list).slice(0, o.limit || 1000) }
  store.patchState({ distIndexUntil: 'R3ANCHOR' })
}

await block('R3#5 the fee index books a third-party distribute_creator_fees_v2 on a SOL coin like V1', async () => {
  const c = use(fakeConn())
  const kid = addCoin({ symbol: 'IDXV2', parent: registry.rootMint() })
  const cfg = pump.feeSharingConfigPda(new PublicKey(kid.mint))
  const sharingConfig = { shareholders: kid.shares.map(s => ({ address: new PublicKey(s.address), shareBps: s.shareBps })) }
  const third = Keypair.generate().publicKey
  const ix = await pump.PUMP_SDK.distributeCreatorFeesV2({ mint: new PublicKey(kid.mint), sharingConfig, sharingConfigAddress: cfg, quoteMint: pump.NATIVE_MINT, payer: third })
  const msg = new TransactionMessage({ payerKey: third, recentBlockhash: bs58.encode(randomBytes(32)), instructions: [ix] }).compileToV0Message()
  const sig = bs58.encode(randomBytes(64))
  c.txMeta.set(sig, distTxMeta(kid, msg))
  check('R3#5 distributedMint recognises the V2 instruction (mint at account 1, payer at 0)', dist.distributedMint(c.txMeta.get(sig)) === kid.mint)
  indexOver(c, [sig])
  await dist.indexDistributions({ force: true })
  const led = store.mintLedger(kid.mint)
  check('R3#5 a V2 crank is booked from its measured deltas (capped by the vault drop)', led.distributedLamports === '20000000' && led.toParentLamports === '8000000' && led.toLauncherLamports === '8000000' && led.cranks === 1, JSON.stringify(led))
})

await block('R5 pump.fun creator-fee bucket (2026-10): sweep_creator_fee goes first and the bucket counts as fees', async () => {
  const c = use(fakeConn())
  const kid = addCoin({ symbol: 'SWEEP', parent: registry.rootMint() })
  const m = new PublicKey(kid.mint)
  const data = Buffer.alloc(141); data.writeBigUInt64LE(12345n, pump.CURVE_CREATOR_FEE_AT)
  check('R5 the curve bucket is read at its IDL offset (125); older/short curves read 0', pump.curveCreatorFeeBucket(data) === 12345n && pump.curveCreatorFeeBucket(Buffer.alloc(125)) === 0n && pump.curveCreatorFeeBucket(null) === 0n)
  const cfg = pump.feeSharingConfigPda(m), payer = Keypair.generate().publicKey
  const sw = pump.sweepCreatorFeeIx({ payer, mint: kid.mint, creator: cfg })
  check('R5 sweep_creator_fee: pump program, IDL discriminator, 13 accounts, payer signs, curve + creator vault writable', sw.programId.equals(pump.PUMP_PROGRAM_ID) && sw.data.equals(pump.SWEEP_CREATOR_FEE_DISC) && sw.keys.length === 13 && sw.keys[0].isSigner && sw.keys[0].pubkey.equals(payer) && sw.keys[2].pubkey.equals(m) && sw.keys[7].pubkey.equals(pump.bondingCurvePda(m)) && sw.keys[7].isWritable && sw.keys[9].pubkey.equals(pump.creatorVaultPda(cfg)) && sw.keys[9].isWritable)
  // a crank that swept 5M off the curve's bucket and distributed 25M: the vault's NET drop is only 20M
  const sharingConfig = { shareholders: kid.shares.map(s => ({ address: new PublicKey(s.address), shareBps: s.shareBps })) }
  const dix = await pump.PUMP_SDK.distributeCreatorFees({ mint: m, sharingConfig, sharingConfigAddress: cfg })
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: bs58.encode(randomBytes(32)), instructions: [sw, dix] }).compileToV0Message()
  const deltas = new Map([[kid.shares[0].address, 10_000_000], [kid.shares[1].address, 10_000_000], [B, 2_500_000], [P, 2_500_000], [pump.creatorVaultPda(cfg).toBase58(), -20_000_000], [pump.bondingCurvePda(m).toBase58(), -5_000_000]])
  const keys = msg.staticAccountKeys.map(k => k.toBase58())
  const pre = keys.map(() => 100_000_000), post = keys.map((k, i) => 100_000_000 + (deltas.get(k) || 0) - (i === 0 ? 5000 : 0))
  const tx = { meta: { err: null, fee: 5000, preBalances: pre, postBalances: post, loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [] }, transaction: { message: msg } }
  check('R5 sweepsCurveOf sees a sweep of this coin only', dist.sweepsCurveOf(tx, kid.mint) && !dist.sweepsCurveOf(tx, Keypair.generate().publicKey.toBase58()))
  check('R5 the drop includes what the sweep took off the curve (25M, not the vault\'s net 20M)', dist.vaultDropOf(tx, kid.mint) === 25_000_000n, String(dist.vaultDropOf(tx, kid.mint)))
  const sig = bs58.encode(randomBytes(64))
  c.txMeta.set(sig, tx)
  indexOver(c, [sig])
  await dist.indexDistributions({ force: true })
  const led = store.mintLedger(kid.mint)
  check('R5 the fee index books the whole 25M of a sweep + distribute crank', led.distributedLamports === '25000000' && led.toParentLamports === '10000000' && led.cranks === 1, JSON.stringify(led))
})

await block('R3#6 the fee index reads version-1 transactions instead of skipping them', async () => {
  const c = use(fakeConn())
  const kid = addCoin({ symbol: 'IDXT1', parent: registry.rootMint() })
  const cfg = pump.feeSharingConfigPda(new PublicKey(kid.mint))
  const sharing = { address: cfg, config: { shareholders: kid.shares.map(s => ({ address: new PublicKey(s.address), shareBps: s.shareBps })) } }
  const third = Keypair.generate().publicKey
  const v0 = new TransactionMessage({ payerKey: third, recentBlockhash: bs58.encode(randomBytes(32)), instructions: await pump.distributeIxs({ mint: kid.mint, sharing, graduated: false, payer: third }) }).compileToV0Message()
  const { MessageV1 } = await import('@solana/web3.js')
  const v1 = new MessageV1({ header: v0.header, staticAccountKeys: v0.staticAccountKeys, recentBlockhash: v0.recentBlockhash, compiledInstructions: v0.compiledInstructions })
  const sig = bs58.encode(randomBytes(64))
  const fetched = { ...distTxMeta(kid, v1), version: 1 }
  const gt = c.getTransaction
  c.getTransaction = async (s, o = {}) => {
    if (s !== sig) return gt(s, o)
    if (!((o.maxSupportedTransactionVersion ?? -1) >= 1)) throw new Error('failed to get transaction: Transaction version (1) is not supported by the requesting client. Please try the request again with the following configuration parameter: "maxSupportedTransactionVersion": 1')
    return fetched
  }
  indexOver(c, [sig])
  await dist.indexDistributions({ force: true })
  const led = store.mintLedger(kid.mint)
  check('R3#6 a third-party distribute sent as a version-1 tx is booked', led.distributedLamports === '20000000' && led.toParentLamports === '8000000' && led.cranks === 1, JSON.stringify(led))
  c.getTransaction = gt
})

await block('R3#7 rounds: a pool whose budget can never pay anyone (5% cap < MIN_PAYOUT) keeps no round open', async () => {
  const c = use(fakeConn()); c.autoConfirm = true
  const parent = addCoin({ symbol: 'FLOORP' })
  addCoin({ symbol: 'FLOORK', parent: parent.mint })
  c.accounts.set(parent.mint, { lamports: 1, owner: T22, executable: false, data: Buffer.alloc(82), rentEpoch: 0 })
  const slice = (o, amt) => ({ account: { data: Buffer.concat([new PublicKey(o).toBuffer(), Buffer.from(new BigUint64Array([amt]).buffer)]) } })
  const holders = Array.from({ length: 30 }, () => wallet())
  c.gpa = holders.map(h => slice(h, 100_000n * 1_000_000n))
  for (const h of holders) c.accounts.set(h, sysAcct(1_000_000))
  let gpa = 0
  const g0 = c.getProgramAccounts
  c.getProgramAccounts = async (...a) => { gpa++; return g0(...a) }
  const floor = (sol.toLamports(config.minPayoutSol) * 10_000n + BigInt(config.maxWalletShareBps) - 1n) / BigInt(config.maxWalletShareBps)
  const pool = paysol.poolReserveLamports() + paysol.roundFeeLamports(30) + 15_000_000n // budget 0.015 SOL < the 0.02 SOL floor
  registry.setLive(parent.mint, { poolLamports: String(pool) }); c.balances.set(parent.holderPool, Number(pool))
  check('R3#7 (setup) the payable floor is 0.02 SOL at the defaults', floor === 20_000_000n, String(floor))
  const r0 = await rounds.roundStep(parent.mint)
  check('R3#7 a pool below reserve + fee + the payable floor opens no round (no snapshot)', !!r0.note && gpa === 0 && !rounds.rounds().some(r => r.parentMint === parent.mint), JSON.stringify(r0))
  const o = await rounds.roundStep(parent.mint, { force: true }) // an open round (the admin's, or opened before the pool drained)
  const cl = await rounds.roundStep(parent.mint, { force: true })
  check('R3#7 its close is skipped and leaves NO round open (no stored snapshot, no hourly repeat)', !!o.opened && cl.status === 'skipped' && !rounds.rounds().some(r => r.parentMint === parent.mint && r.status === 'open'), JSON.stringify(cl))
  // (R4#5: past a WHOLE round's worst-case fees, not one tx's — its close can then always pay or chain the next round)
  const pool2 = paysol.poolReserveLamports() + paysol.roundFeeLamports(config.maxRecipients) + floor + 1n
  registry.setLive(parent.mint, { poolLamports: String(pool2) }); c.balances.set(parent.holderPool, Number(pool2))
  const r1 = await rounds.roundStep(parent.mint)
  check('R3#7 once fees lift the pool past the floor a round opens again', !!r1.opened, JSON.stringify(r1))
})

await block('R3#8 /img: one download per mint at a time, bounded bytes, a persisted negative for an oversize logo', async () => {
  const { createServer } = await import('http')
  const images = await import('./images.js')
  const BIG = 10 * 1024 * 1024
  const small = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9])
  const hits = { big: 0, chunked: 0, small: 0, slow: 0 }
  let inFlight = 0, maxInFlight = 0, chunkedFinished = false
  const server = createServer((req, res) => {
    if (req.url === '/big.png') { hits.big++; res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(BIG) }); res.end(Buffer.alloc(BIG, 1)); return }
    if (req.url === '/chunked.png') {
      hits.chunked++
      res.writeHead(200, { 'content-type': 'image/png' }) // no content-length: only a byte counter can stop it
      let sent = 0
      const pump1 = () => { while (sent < BIG) { sent += 65_536; if (!res.write(Buffer.alloc(65_536, 2))) { res.once('drain', pump1); return } } res.end() }
      res.on('finish', () => { chunkedFinished = true })
      pump1(); return
    }
    if (req.url === '/small.png') { hits.small++; setTimeout(() => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(small) }, 100); return }
    if (req.url.startsWith('/slow')) { hits.slow++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); setTimeout(() => { inFlight--; res.writeHead(200, { 'content-type': 'image/png' }); res.end(small) }, 250); return }
    res.writeHead(404); res.end()
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const m1 = wallet()
    const r1 = await Promise.all(Array.from({ length: 30 }, () => images.cacheLogo(m1, `${base}/big.png`)))
    check('R3#8 30 concurrent requests for one oversize logo → ONE origin download, nothing cached', hits.big === 1 && r1.every(x => x === false) && !images.hasLogo(m1), `${hits.big} downloads`)
    const fresh = await import('./images.js?restart=img1') // a restarted engine: the in-memory negative cache is empty
    await fresh.cacheLogo(m1, `${base}/big.png`)
    check('R3#8 an oversize logo stays refused across a restart (persisted negative): no new download', hits.big === 1, `${hits.big} downloads`)
    const m2 = wallet()
    const r2 = await images.cacheLogo(m2, `${base}/chunked.png`)
    await new Promise(r => setTimeout(r, 200))
    check('R3#8 an oversize body without content-length is cut off by a byte counter (never read whole)', r2 === false && !chunkedFinished && !images.hasLogo(m2))
    const m3 = wallet()
    const r3 = await Promise.all(Array.from({ length: 20 }, () => images.cacheLogo(m3, `${base}/small.png`)))
    check('R3#8 20 concurrent requests for a fine logo share one download and cache it', hits.small === 1 && r3.every(x => x === true) && images.hasLogo(m3), `${hits.small} downloads`)
    await Promise.all(Array.from({ length: 6 }, (_, i) => images.cacheLogo(wallet(), `${base}/slow${i}.png`)))
    check('R3#8 logo downloads across mints are capped (at most 2 at once)', maxInFlight <= 2 && hits.slow >= 1, `max ${maxInFlight} at once`)
  } finally { await new Promise(r => server.close(r)) }
})

await block('R3#9 DEV_SEED can never write fake coins into a live engine', async () => {
  check('R3#9 production refuses DEV_SEED', configProblems({ ...config, devSeed: true, offline: false }, { NODE_ENV: 'production', ENGINE_FRESH: '1' }, () => false).some(m => /DEV_SEED/.test(m)))
  const seed = await import('./seed.js')
  const before = JSON.stringify(Object.keys(registry.coins()))
  const saved = config.offline
  let r
  config.offline = false
  try { r = seed.seedDev() } finally { config.offline = saved }
  check('R3#9 seedDev refuses unless DEV_OFFLINE (no chain, no keys)', r === false && JSON.stringify(Object.keys(registry.coins())) === before)
})

await block('R4#1 /m + /img serve only a registered, prepared or journaled mint; a moderated hide withdraws it', async () => {
  use(fakeConn())
  const acc = m => launch.publicFileAccess(m)
  const vis = addCoin({ symbol: 'FILEV', parent: registry.rootMint() })
  check('R4#1 a registered, visible coin: public (CDN-cacheable)', acc(vis.mint) === 'public', String(acc(vis.mint)))
  check('R4#1 an unknown mint (a dead prepare\'s leftovers, anyone\'s upload): nothing is served', acc(wallet()) === null)
  const p = await launch.prepareLaunch(prepBody(registry.rootMint()))
  check('R4#1 a live prepare: served, never CDN-cached', acc(p.mint) === 'private', String(acc(p.mint)))
  const jm = wallet() // journaled, not registered yet: pump.fun's indexer reads the JSON seconds after the create lands
  store.launchesStore.update(all => { all.r4journal = { id: 'r4journal', mint: jm, status: 'sent', symbol: 'JRNL' } })
  check('R4#1 a journaled launch not registered yet: served, never CDN-cached', acc(jm) === 'private', String(acc(jm)))
  const kid = addCoin({ symbol: 'FILEK', parent: vis.mint })
  registry.setHidden(vis.mint, true)
  check('R4#1 a PUBLIC launch the admin hid (moderation): nothing is served', acc(vis.mint) === null, String(acc(vis.mint)))
  check('R4#1 a coin under a hidden parent (not hidden itself): its permanent URI still resolves, never CDN-cached', acc(kid.mint) === 'private', String(acc(kid.mint)))
  const m = wallet()
  const l = { id: 'r4adm', mint: m, wallet: wallet(), parent: registry.rootMint(), level: 1, root: false, admin: true, hidden: true, symbol: 'ADMT', name: 'Admin Test', uri: 'u', holderPool: sol.poolKeyFor(m).publicKey.toBase58(), parentPool: sol.poolKeyFor(registry.rootMint()).publicKey.toBase58(), creatorKey: sol.coinKeyFor(m).publicKey.toBase58(), sig: null, buyLamports: '0' }
  launch.registerCoin(l)
  check('R4#1 an admin (test) launch is registered as such', registry.coinRec(m)?.adminLaunch === true)
  check('R4#1 a hidden ADMIN test launch: still served (its on-chain URI must resolve for when it is unhidden), never CDN-cached', acc(m) === 'private', String(acc(m)))
  registry.setHidden(vis.mint, false)
  store.preparedStore.update(all => { delete all[p.id] })
  store.launchesStore.update(all => { delete all.r4journal })
})

await block('R4#2 a coin key that cannot pay its temporary WSOL account rent still collects its old AMM fees', async () => {
  const fee2 = Number(sol.txFeeLamports(250_000, 2))
  const sharesSum = (c, k) => k.shares.reduce((a, s) => a + (c.accounts.get(s.address)?.lamports ?? 0), 0)
  const graduate = async (c, k) => { const g = await graduatedCurve(k.mint); c.accounts.set(g.at, g.acct) }
  // (a) the key at 0 (an earlier sweep emptied it), its curve vault at rent, its OLD AMM vault holding 21.37M WSOL
  const c = use(fakeConn()); c.autoConfirm = true
  const { k, ck } = await unsweptCoin(c, { vault: 0n, keyBal: 0 })
  await graduate(c, k)
  const amm = ammVaultOf(c, ck, 21_377_282n)
  lamportChain(c, ck, { amm: true })
  c.balances.set(E, 1_000_000_000)
  const before = sharesSum(c, k)
  launch._clearBackoffs()
  await launch.finalizeCoin(k.mint)
  check('R4#2 a 0-lamport key with only old AMM fees is swept: the engine fronts the WSOL account rent and gets it all back', registry.coinRec(k.mint).swept === true && ammAmount(c, amm) === 0 && (c.balances.get(ck) ?? 0) === 0 && c.balances.get(E) === 1_000_000_000 - fee2 && sharesSum(c, k) - before === 21_377_282, `swept ${registry.coinRec(k.mint).swept}, amm ${ammAmount(c, amm)}, key ${c.balances.get(ck)}, engine ${1_000_000_000 - (c.balances.get(E) ?? 0)} spent, shares +${sharesSum(c, k) - before}`)
  // (b) a key that holds one fee but less than that rent (the key-pays path had the same hole)
  const c2 = use(fakeConn()); c2.autoConfirm = true
  const { k: k2, ck: ck2 } = await unsweptCoin(c2, { vault: 0n, keyBal: 500_000 })
  await graduate(c2, k2)
  const amm2 = ammVaultOf(c2, ck2, 21_377_282n)
  lamportChain(c2, ck2, { amm: true })
  c2.balances.set(E, 1_000_000_000)
  const before2 = sharesSum(c2, k2)
  launch._clearBackoffs()
  await launch.finalizeCoin(k2.mint)
  check('R4#2 a key holding one fee but less than the WSOL account rent is swept too (key 500k + AMM → shares)', registry.coinRec(k2.mint).swept === true && ammAmount(c2, amm2) === 0 && (c2.balances.get(ck2) ?? 0) === 0 && sharesSum(c2, k2) - before2 === 21_377_282 + 500_000, `swept ${registry.coinRec(k2.mint).swept}, amm ${ammAmount(c2, amm2)}, key ${c2.balances.get(ck2)}, shares +${sharesSum(c2, k2) - before2}`)
  // (c) the griefing path end to end: WSOL donated into the old AMM vault right after an emptying sweep landed
  const c3 = use(fakeConn()); c3.autoConfirm = true
  const { k: k3, ck: ck3 } = await unsweptCoin(c3, { vault: 10_000_000n, keyBal: 4_600_000 })
  await graduate(c3, k3)
  const amm3 = ammVaultOf(c3, ck3, 5_000_000n)
  lamportChain(c3, ck3, { amm: true })
  c3.balances.set(E, 1_000_000_000)
  const apply = c3.onSend
  let donated = false
  c3.onSend = (tx, s) => { apply(tx, s); if (!donated) { donated = true; const a = c3.accounts.get(amm3); const d = Buffer.from(a.data); d.writeBigUInt64LE(150_000n, 64); c3.accounts.set(amm3, { ...a, lamports: a.lamports + 150_000, data: d }) } }
  launch._clearBackoffs()
  await launch.finalizeCoin(k3.mint)
  const firstPass = { swept: registry.coinRec(k3.mint).swept, key: c3.balances.get(ck3) ?? 0, sigs: txFromB64(c3.sent[0] || c3.sent.at(-1)).message.header.numRequiredSignatures }
  check('R4#2 (c) a key rich enough pays its own WSOL rent: ONE signer, the engine is not in the tx; a donation after it keeps the coin unswept', firstPass.swept === false && firstPass.key === 0 && c3.sent.length === 1 && firstPass.sigs === 1, JSON.stringify(firstPass))
  launch._clearBackoffs()
  await launch.finalizeCoin(k3.mint)
  check('R4#2 (c) …the next pass (key at 0, only the donated AMM WSOL left) sweeps it: the coin is never stuck unswept', registry.coinRec(k3.mint).swept === true && ammAmount(c3, amm3) === 0 && (c3.balances.get(ck3) ?? 0) === 0 && c3.balances.get(E) === 1_000_000_000 - fee2, `swept ${registry.coinRec(k3.mint).swept}, amm ${ammAmount(c3, amm3)}, key ${c3.balances.get(ck3)}, engine −${1_000_000_000 - (c3.balances.get(E) ?? 0)}`)
})

await block('R4#3 the sweep\'s AMM leg and its "emptied" check follow the ANCHORED vault read, never an unanchored curve read', async () => {
  // the coin graduated before its lock; the curve read answers "not graduated" (a lagging node) — or nothing at all
  for (const variant of ['a lagging curve read', 'an unreadable curve']) {
    const c = use(fakeConn()); c.autoConfirm = true
    const { k, ck } = await unsweptCoin(c, { vault: 10_000_000n, keyBal: 4_600_000 }) // its curve decodes as NOT complete
    if (variant === 'an unreadable curve') c.accounts.delete(pump.bondingCurvePda(new PublicKey(k.mint)).toBase58())
    const amm = ammVaultOf(c, ck, 200_000_000n)
    lamportChain(c, ck, { amm: true })
    launch._clearBackoffs()
    await launch.finalizeCoin(k.mint)
    check(`R4#3 (${variant}) the old PumpSwap fees are collected and split before the coin is marked swept`, ammAmount(c, amm) === 0 && registry.coinRec(k.mint).swept === true && (c.balances.get(ck) ?? 0) <= 100_000, `amm ${ammAmount(c, amm)}, swept ${registry.coinRec(k.mint).swept}, key ${c.balances.get(ck)}`)
  }
})

await block('R4#4 a payout batch PROVEN not landed is rebuilt next pass (its lines stay pending), never written off', async () => {
  const parent = addCoin({ symbol: 'NLP' })
  const poolW = sol.poolKeyFor(parent.mint).publicKey.toBase58()
  const pool = { parentMint: parent.mint, symbol: 'NLP', poolWallet: poolW }
  const settle = { deadlineMs: 300, pollMs: 20 }
  const mk = n => {
    const id = store.newId(6), items = Array.from({ length: n }, () => ({ wallet: wallet(), lamports: 3_000_000n, weight: 1n }))
    store.roundsStore.update(s => { s.rounds.push({ id, parentMint: parent.mint, parentSymbol: 'NLP', pool: poolW, openedAt: Date.now() - 1000, closedAt: Date.now(), budgetLamports: '0', lines: items.map(i => ({ wallet: i.wallet, weight: '1', lamports: String(i.lamports), sig: null, status: 'pending' })), status: 'paying', sigs: [] }) })
    return { id, items }
  }
  const tally = id => rounds.roundById(id).lines.reduce((a, l) => ({ ...a, [l.status]: (a[l.status] || 0) + 1 }), {})
  // a round of 24: the first batch is dropped (the finalized chain passes its last valid height; nobody knows the sig)
  const r = mk(24)
  let c = use(fakeConn()); c.height = 999
  await rounds.payRound(rounds.roundById(r.id), { settle })
  const t1 = tally(r.id)
  check('R4#4 a dropped batch: its 12 lines stay PENDING (nothing moved, safe to rebuild), no intent left, the pass halted', t1.pending === 24 && !t1.failed && store.readPendingIntents(poolW).length === 0 && c.sent.length === 1 && rounds.roundById(r.id).status === 'paying', JSON.stringify(t1))
  c = use(fakeConn()); c.autoConfirm = true
  await rounds.payRound(rounds.roundById(r.id), { settle })
  const counts = new Map()
  for (const b of c.sent) for (const to of transfersIn(b)) counts.set(to, (counts.get(to) || 0) + 1)
  check('R4#4 …the chain recovers: the next pass rebuilds them with a fresh blockhash, all 24 paid exactly once, round done', tally(r.id).paid === 24 && rounds.roundById(r.id).status === 'done' && r.items.every(i => counts.get(i.wallet) === 1), JSON.stringify(tally(r.id)))
  // a line that keeps not landing is written off after 3 proofs (the round's 2-window expiry still bounds the rest)
  const r2 = mk(1)
  c = use(fakeConn()); c.height = 999
  await paysol.payPoolShares(pool, r2.items, { roundId: r2.id, settle })
  const l1 = rounds.roundById(r2.id).lines[0]
  await paysol.payPoolShares(pool, r2.items, { roundId: r2.id, settle })
  await paysol.payPoolShares(pool, r2.items, { roundId: r2.id, settle })
  const l3 = rounds.roundById(r2.id).lines[0]
  check('R4#4 a line proven not landed 3 times is marked failed (its SOL stays in the pool); before that it stays pending', l1.status === 'pending' && l1.notLanded === 1 && l3.status === 'failed' && l3.notLanded === 3 && c.sent.length === 3, `${l1.status}/${l1.notLanded} → ${l3.status}/${l3.notLanded}`)
  // the boot recovery path settles a journaled intent the same way
  const r3 = mk(2)
  store.appendPendingIntent({ roundId: r3.id, parentMint: parent.mint, parentSymbol: 'NLP', from: poolW, time: Date.now(), items: r3.items.map(i => ({ wallet: i.wallet, lamports: i.lamports.toString(), weight: '1' })), sig: bs58.encode(randomBytes(64)), raw: null, lastValidBlockHeight: 150, builtSlot: 5000 })
  c = use(fakeConn()); c.height = 999
  const done = await paysol.resolvePendingIntents({ poolWallet: poolW, deadlineMs: 300, settle: { pollMs: 20 } })
  check('R4#4 a journaled intent recovered as not-landed puts its lines back to pending (rebuilt by the next pass)', done && tally(r3.id).pending === 2 && rounds.roundById(r3.id).lines.every(l => l.notLanded === 1), JSON.stringify(tally(r3.id)))
})

await block('R4#5 rounds: a pool between one tx fee and a whole round\'s fees never cycles open → skipped → open', async () => {
  const c = use(fakeConn()); c.autoConfirm = true
  const parent = addCoin({ symbol: 'BANDP' })
  addCoin({ symbol: 'BANDK', parent: parent.mint })
  c.accounts.set(parent.mint, { lamports: 1, owner: T22, executable: false, data: Buffer.alloc(82), rentEpoch: 0 })
  const slice = (o, amt) => ({ account: { data: Buffer.concat([new PublicKey(o).toBuffer(), Buffer.from(new BigUint64Array([amt]).buffer)]) } })
  const holders = Array.from({ length: 30 }, () => wallet())
  c.gpa = holders.map(h => slice(h, 100_000n * 1_000_000n))
  for (const h of holders) c.accounts.set(h, sysAcct(1_000_000))
  let gpa = 0
  const g0 = c.getProgramAccounts
  c.getProgramAccounts = async (...a) => { gpa++; return g0(...a) }
  // inside (reserve + fee(1) + floor, reserve + fee(30) + floor): its close could never pay anyone
  const pool = paysol.poolReserveLamports() + paysol.roundFeeLamports(1) + rounds.roundFloorLamports() + 5_000n
  registry.setLive(parent.mint, { poolLamports: String(pool) }); c.balances.set(parent.holderPool, Number(pool))
  const r0 = await rounds.roundStep(parent.mint)
  check('R4#5 no round opens (no holder snapshot) for a pool whose close could never pay anyone', !!r0.note && gpa === 0 && !rounds.rounds().some(r => r.parentMint === parent.mint), JSON.stringify(r0))
  const o = await rounds.roundStep(parent.mint, { force: true }) // an admin's forced round
  const cl = await rounds.roundStep(parent.mint, { force: true })
  const again = await rounds.roundStep(parent.mint)
  check('R4#5 …a skipped close is not followed by a reopen on the next tick', !!o.opened && cl.status === 'skipped' && !!again.note && gpa === 2 && !rounds.rounds().some(r => r.parentMint === parent.mint && r.status === 'open'), `${JSON.stringify(cl)} · ${JSON.stringify(again)} · gPA ${gpa}`)
})

await block('R4#6 only our own HTTP errors set the status: an RPC error or a timeout is a logged JSON 500', async () => {
  const { errorHandler, http: httpErr, isHttp } = await import('./httperr.js')
  const express = (await import('express')).default
  const { SolanaJSONRPCError } = await import('@solana/web3.js')
  const logged = []
  const app = express()
  app.get('/timeout', (req, res, next) => next(new DOMException('The operation was aborted due to timeout', 'TimeoutError')))
  app.get('/rpc', (req, res, next) => next(new SolanaJSONRPCError({ code: -32005, message: 'Node is behind by 42 slots' }, 'failed to get signature status')))
  app.get('/ours', (req, res, next) => next(httpErr('parent moved', 409)))
  app.get('/busy', (req, res, next) => next(httpErr('slow down', 429, { retryAfter: 7 })))
  app.use(errorHandler({ log: (...a) => logged.push(a.map(String).join(' ')) }))
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
  try {
    const at = p => fetch(`http://127.0.0.1:${server.address().port}${p}`)
    const [t, rpc, ours, busy] = await Promise.all(['/timeout', '/rpc', '/ours', '/busy'].map(at))
    const jt = await t.json().catch(() => null), jr = await rpc.json().catch(() => null), jo = await ours.json().catch(() => null)
    check('R4#6 a fetch timeout (DOMException, code 23) → 500 JSON, not an HTML page', t.status === 500 && /json/.test(t.headers.get('content-type') || '') && jt?.error === 'internal error', `${t.status} ${t.headers.get('content-type')}`)
    check('R4#6 a JSON-RPC error (code -32005) → 500 JSON', rpc.status === 500 && /json/.test(rpc.headers.get('content-type') || '') && jr?.error === 'internal error', `${rpc.status} ${rpc.headers.get('content-type')}`)
    check('R4#6 …and the operator log carries both causes', logged.some(l => /aborted due to timeout/.test(l)) && logged.some(l => /Node is behind/.test(l)), logged.join(' | ').slice(0, 300))
    check('R4#6 our own errors keep their status, message and Retry-After', ours.status === 409 && jo?.error === 'parent moved' && busy.status === 429 && busy.headers.get('retry-after') === '7')
  } finally { await new Promise(r => server.close(r)) }
  // prepareLaunch: an RPC error while building is wrapped (502 "could not build the launch"), never rethrown raw
  const c = use(fakeConn())
  c.getLatestBlockhashAndContext = async () => { throw new SolanaJSONRPCError({ code: -32005, message: 'Node is behind by 42 slots' }, 'failed to get recent blockhash') }
  const e = await rejects(() => launch.prepareLaunch(prepBody(registry.rootMint())))
  check('R4#6 an RPC error while a launch builds → a tagged 502 "could not build the launch: …"', !!e && isHttp(e) && e.code === 502 && /could not build the launch/.test(e.message), `${e?.code} ${e?.message}`)
})

await block('R4#7 a launch id named like an Object.prototype member is unknown (404), never a bogus 200', async () => {
  use(fakeConn())
  const bad = []
  for (const k of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
    const e = await rejects(() => launch.submitLaunch(k, 'x'))
    if (e?.code !== 404 || launch.getLaunch(k) !== null) bad.push(`${k}: submit ${e ? e.code : 'resolved'}, view ${JSON.stringify(launch.getLaunch(k))}`)
  }
  check('R4#7 submit / view of a prototype-named id → 404 / null', !bad.length, bad.join(' | '))
  check('R4#7 the registry never answers for a prototype name either', registry.coinRec('constructor') === null && registry.coinRec('__proto__') === null && registry.coinRec('toString') === null)
})

await block('R4#10 a round\'s budget and each batch\'s funding check read the pool at or after its last payout\'s slot', async () => {
  const parent = addCoin({ symbol: 'LAGP' })
  addCoin({ symbol: 'LAGK', parent: parent.mint })
  const poolW = parent.holderPool
  const c = use(fakeConn())
  c.accounts.set(parent.mint, { lamports: 1, owner: T22, executable: false, data: Buffer.alloc(82), rentEpoch: 0 })
  const slice = (o, amt) => ({ account: { data: Buffer.concat([new PublicKey(o).toBuffer(), Buffer.from(new BigUint64Array([amt]).buffer)]) } })
  const holders = Array.from({ length: 30 }, () => wallet())
  c.gpa = holders.map(h => slice(h, 100_000n * 1_000_000n))
  for (const h of holders) c.accounts.set(h, sysAcct(1_000_000))
  const START = 2_000_000_000
  let fresh = START
  const reads = []
  // a load-balanced RPC with a lagging node: a plain read still sees the pool BEFORE this round's payouts landed
  c.getBalance = async (k, cfg) => { if (String(k) !== poolW) return c.balance; const at = cfg?.minContextSlot ?? null; reads.push(at); return at != null && at >= 8888 ? fresh : START }
  c.onSend = tx => { const keys = tx.message.staticAccountKeys.map(x => x.toBase58()); for (const ix of tx.message.compiledInstructions) { const d = Buffer.from(ix.data); if (keys[ix.programIdIndex] === '11111111111111111111111111111111' && d.readUInt32LE(0) === 2 && keys[ix.accountKeyIndexes[0]] === poolW) fresh -= Number(d.readBigUInt64LE(4)) } }
  c.getSignatureStatuses = async sigs => ({ context: { slot: 9000 }, value: sigs.map(s => (c.sentSigs.has(s) ? { confirmationStatus: 'confirmed', err: null, slot: 8888 } : null)) })
  const settle = { deadlineMs: 300, pollMs: 20 }
  registry.setLive(parent.mint, { poolLamports: String(START) })
  const o1 = await rounds.roundStep(parent.mint, { force: true })
  await rounds.roundStep(parent.mint, { force: true, settle })
  const r1 = rounds.roundById(o1.opened)
  check('R4#10 (setup) round 1 paid its 30 holders in 3 batches', r1.status === 'done' && r1.lines.every(l => l.status === 'paid') && c.sent.length === 3, `${r1.status} ${c.sent.length}`)
  check('R4#10 the pool\'s last payout slot is recorded with the booking', Number(store.poolLedger(parent.mint).lastPaidSlot) === 8888, String(store.poolLedger(parent.mint).lastPaidSlot))
  check('R4#10 each batch after the first reads the pool at or after the previous batch\'s slot', reads.length >= 4 && reads.slice(-2).every(x => x >= 8888), reads.join())
  const n = c.sent.length
  await rounds.roundStep(parent.mint, { force: true, settle }) // round 2 closes seconds later
  const r2 = rounds.rounds().filter(r => r.parentMint === parent.mint && r.id !== r1.id && r.closedAt).pop()
  check('R4#10 round 2\'s budget is the pool AFTER round 1 (never the SOL it already paid): nothing is paid twice', !!r2 && BigInt(r2.poolLamports) === BigInt(fresh) && r2.status === 'skipped' && c.sent.length === n && reads.at(-1) >= 8888, `${r2?.status} pool ${r2?.poolLamports} vs ${fresh}, sent ${c.sent.length - n}, read at ${reads.at(-1)}`)
})

config.metaSelfHost = savedMetaSelfHost

/* ------------------------------------------------------------------ */
section('the HTTP API (dev engine in a child process): hidden coins, shapes')
{
  const dir = mkdtempSync(join(tmpdir(), 'gachapad-api-'))
  const port = 39_000 + Math.floor(Math.random() * 1000)
  // R4#1: a live prepare on disk before boot (its self-hosted metadata must be served while it may still land)
  const PREP_MINT = wallet()
  writeFileSync(join(dir, 'prepared.json'), JSON.stringify({ r4prep: { id: 'r4prep', status: 'prepared', mint: PREP_MINT, wallet: wallet(), parent: null, level: 1, root: false, admin: false, hidden: false, expiresAt: Date.now() + 100_000, createdAt: Date.now(), symbol: 'PREP', name: 'Prep' } }))
  mkdirSync(join(dir, 'meta'), { recursive: true })
  writeFileSync(join(dir, 'meta', `${PREP_MINT}.json`), JSON.stringify({ name: 'Prep', symbol: 'PREP' }))
  const child = spawn(process.execPath, ['index.js'], { env: { ...process.env, ENGINE_NO_DOTENV: '1', DATA_DIR: dir, PORT: String(port), DEV_OFFLINE: 'true', DEV_SEED: 'true', RPC_URL: '', ENGINE_PRIVATE_KEY: '', BURN_PRIVATE_KEY: '', PROTOCOL_WALLET: '', ADMIN_SECRET: 'b'.repeat(40), TRUST_PROXY: 'true' }, stdio: 'ignore' })
  const get = async p => { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers } }
  let up = false
  for (let i = 0; i < 60 && !up; i++) { await new Promise(r => setTimeout(r, 150)); try { up = (await get('/health')).status === 200 } catch {} }
  try {
    check('the dev engine boots offline and answers /health', up)
    const all = (await get('/coins?limit=100')).body
    const tree = (await get('/tree')).body
    const stats = (await get('/stats')).body
    const allState = (await (await fetch(`http://127.0.0.1:${port}/admin/state`, { headers: { 'x-admin-secret': 'b'.repeat(40) } })).json())
    const hidden = allState.coins.filter(c => c.hidden).map(c => c.mint)
    check('the seed has a hidden admin test coin', hidden.length >= 1)
    check('/coins never lists a hidden coin', all.items.length === all.total && !all.items.some(c => hidden.includes(c.mint)))
    check('/tree never shows a hidden coin', !tree.nodes.some(n => hidden.includes(n.mint)))
    check('/stats totals exclude hidden coins', stats.totals.coins === all.total)
    const health0 = (await get('/health')).body
    check('R4#9 /health.coins counts visible coins only (= /stats.totals.coins; a hidden rehearsal coin is not revealed)', health0?.coins === stats.totals.coins, `${health0?.coins} vs ${stats.totals.coins}`)
    // R4#7: a prototype-named launch id is a 404 and never flushes the public caches
    await get('/coins?limit=7')
    const warm = await get('/coins?limit=7')
    const proto = await fetch(`http://127.0.0.1:${port}/launch/submit`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.1' }, body: JSON.stringify({ id: 'constructor', signedTx: 'x' }) })
    const cold = await get('/coins?limit=7')
    check('R4#7 POST /launch/submit {id:"constructor"} → 404, and the /coins micro-cache is untouched', proto.status === 404 && warm.headers.get('x-cache') === 'hit' && cold.headers.get('x-cache') === 'hit', `${proto.status} · ${warm.headers.get('x-cache')} → ${cold.headers.get('x-cache')}`)
    check('R4#7 GET /launch/constructor → 404', (await get('/launch/constructor')).status === 404)
    check('/coin/<hidden> is 404', (await get(`/coin/${hidden[0]}`)).status === 404)
    check('/feed never carries a hidden coin’s events', !(await get('/feed?limit=200')).body.some(e => hidden.includes(e.mint)))
    const feedAll = (await get('/feed?limit=200')).body
    const noTrades = (await get('/feed?limit=12&type=launch,lock,distribute,round,payout,burn,graduate')).body
    const onlyTrades = (await get('/feed?limit=5&type=trade')).body
    check('/feed?type= takes a comma list: every non-trade type → no trades, full page', feedAll.some(e => e.type === 'trade') && noTrades.length === Math.min(12, feedAll.filter(e => e.type !== 'trade').length) && !noTrades.some(e => e.type === 'trade'))
    check('/feed?type=trade still filters to one type', onlyTrades.length > 0 && onlyTrades.every(e => e.type === 'trade'))
    const byProgress = (await get('/coins?sort=progress&limit=100')).body.items
    const firstCurve = byProgress.findIndex(x => !x.curve.graduated)
    check('/coins?sort=progress: graduated first, then curve progress descending', byProgress.slice(0, firstCurve).every(x => x.curve.graduated) && byProgress.slice(firstCurve).every((x, i, a) => !x.curve.graduated && (i === 0 || a[i - 1].curve.progress >= x.curve.progress)))
    const pend = all.items.find(x => x.sharing.status === 'pending')
    check('a pending coin: no config yet, shareholders = the PLANNED split (4 roles, 10000 bps), not revoked', !!pend && pend.sharing.config === null && pend.sharing.locked === false && pend.sharing.adminRevoked === false && pend.sharing.readBack === false && all.items.filter(x => x.sharing.status === 'locked').every(x => x.sharing.readBack === true) && pend.sharing.shareholders.map(s => s.role).join() === 'creator,parentHolders,burn,protocol' && pend.sharing.shareholders.reduce((a, s) => a + s.bps, 0) === 10_000)
    check('Coin.fees.toLauncherSol (measured launcher share) is a number on every coin', all.items.every(x => typeof x.fees.toLauncherSol === 'number'))
    const c = all.items.find(x => x.level === 2) || all.items.find(x => x.level === 1) // GACHAPAD seed: every coin sits under ROOT
    const one = (await get(`/coin/${c.mint}`)).body
    const keys = ['mint', 'symbol', 'name', 'description', 'logo', 'socials', 'parent', 'parentSymbol', 'level', 'kids', 'creator', 'createdAt', 'launchTx', 'pumpUrl', 'priceSol', 'priceUsd', 'mcapSol', 'mcapUsd', 'curve', 'vol24hUsd', 'vol1hUsd', 'trades24h', 'holders', 'sharing', 'fees', 'pool', 'burnedRootUi']
    check('Coin has every API.md field', keys.every(k => k in one.coin), keys.filter(k => !(k in one.coin)).join())
    check('Coin.sharing / fees / pool / curve shapes', ['config', 'locked', 'status', 'shareholders', 'adminRevoked'].every(k => k in one.coin.sharing) && ['generatedSol', 'distributedSol', 'pendingSol', 'toParentHoldersSol', 'creatorFeeBps'].every(k => k in one.coin.fees) && ['address', 'balanceSol', 'paidToHoldersSol', 'lastRoundAt', 'nextRoundAt'].every(k => k in one.coin.pool) && ['progress', 'graduated', 'realSol', 'ammPool'].every(k => k in one.coin.curve))
    check('/coin/:mint → coin, parents up to ROOT, kids, events, holdersTop, packs, pulls', one.parents.length === c.level && one.parents[one.parents.length - 1].level === 0 && Array.isArray(one.kids) && Array.isArray(one.events) && Array.isArray(one.holdersTop) && Array.isArray(one.pulls) && !!one.packs)
    check('shareholders carry roles (creator/parentHolders/burn/protocol) and bps sum 10000', one.coin.sharing.shareholders.map(s => s.role).join() === 'creator,parentHolders,burn,protocol' && one.coin.sharing.shareholders.reduce((a, s) => a + s.bps, 0) === 10_000)
    check('/stats shape: engine.live / split / canary / wallets / balances', stats.engine.split.parentHolders === 8000 && 'canary' in stats.engine && 'wallets' in stats.engine && 'balances' in stats.engine && stats.engine.maxDepth === 1 && stats.engine.rootSplit.burn === 8000)
    const rs = (await get('/rounds?limit=100')).body
    check('/rounds → Round[] with API.md fields', Array.isArray(rs) && rs.length > 0 && ['id', 'parentMint', 'parentSymbol', 'openedAt', 'closedAt', 'budgetSol', 'paidSol', 'wallets', 'status', 'sigs'].every(k => k in rs[0]))
    const done = rs.find(r => r.status === 'done')
    const detail = (await get(`/round/${done.id}`)).body
    check('/round/:id → lines [{wallet, weightUi, lamports, sig, status}]', Array.isArray(detail.lines) && ['wallet', 'weightUi', 'lamports', 'sig', 'status'].every(k => k in detail.lines[0]) && typeof detail.lines[0].lamports === 'string' && typeof detail.lines[0].weightUi === 'number')
    const burns = (await get('/burns?limit=3')).body
    check('/burns → [{at, amountUi, amountUsd, spentSol, sig, swapSig}]', burns.length === 3 && ['at', 'amountUi', 'amountUsd', 'spentSol', 'sig', 'swapSig'].every(k => k in burns[0]))
    const lm = (await get('/launch-meta')).body
    check('/launch-meta shape', ['enabled', 'blocker', 'setupSol', 'maxDepth', 'tickers', 'firstBuyMaxSol', 'presign'].every(k => k in lm) && lm.presign === true && lm.enabled === false)
    const qc = all.items.find(x => !x.curve.graduated && x.priceSol > 0)
    const qt = (await get(`/quote?input=SOL&output=${qc.mint}&amount=500000000&slippageBps=100`)).body
    const expectOut = 0.5 / qc.priceSol * (1 - 0.0125) * 1e6
    check('/quote (offline) → API.md shape at the coin’s own price', qt.route === 'curve' && typeof qt.outAmount === 'string' && typeof qt.minOut === 'string' && BigInt(qt.minOut) <= BigInt(qt.outAmount) && Math.abs(Number(qt.outAmount) / expectOut - 1) < 1e-6 && typeof qt.priceImpactPct === 'number' && qt.feeBps === 125)
    const w = (await get(`/wallet/${detail.lines[0].wallet}`)).body
    check('/wallet/:address → launched, earnedAsHolderSol, earned[], earnedAsCreatorSol', Array.isArray(w.launched) && w.earnedAsHolderSol > 0 && w.earned[0].roundId && 'earnedAsCreatorSol' in w)
    const cached = await get('/coins?limit=100')
    check('lists are micro-cached (X-Cache)', cached.headers.get('x-cache') === 'hit')
    check('/admin/* refuses without the secret', (await fetch(`http://127.0.0.1:${port}/admin/state`)).status === 401)
    const hideR = await fetch(`http://127.0.0.1:${port}/admin/hide`, { method: 'POST', headers: { 'x-admin-secret': 'b'.repeat(40), 'content-type': 'application/json' }, body: JSON.stringify({ mint: c.mint, hidden: true }) })
    check('POST /admin/hide hides a coin at once (404 + gone from lists)', hideR.status === 200 && (await get(`/coin/${c.mint}`)).status === 404 && !(await get('/coins?limit=100')).body.items.some(x => x.mint === c.mint))
    // #2/#16: empty prepares from many IPs never drain the global bucket (TRUST_PROXY=true: one hop, X-Forwarded-For = the client)
    const postAs = (ip, p, body, raw = null) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: raw ?? JSON.stringify(body) })
    for (let i = 0; i < 25; i++) await Promise.all(Array.from({ length: 6 }, () => postAs(`10.1.${i}.1`, '/launch/prepare', {})))
    const fresh = await postAs('10.2.0.1', '/launch/prepare', { wallet: wallet(), parent: all.items[0].mint, name: 'Real', symbol: 'REAL', image: PNG })
    check('#2 150 empty prepares from 25 IPs never lock out a new launcher (no global 429)', fresh.status !== 429, String(fresh.status))
    // #22: the rate limiter answers BEFORE any JSON is parsed
    for (let i = 0; i < 32; i++) await postAs('10.3.0.1', '/nope', {})
    const mal = await postAs('10.3.0.1', '/nope', null, '{bad json')
    check('#22 a rate-limited IP gets 429 even for a malformed body (the limiter runs before the parser)', mal.status === 429, String(mal.status))
    const bigBody = await postAs('10.3.0.2', '/tx/send', null, JSON.stringify({ signedTx: 'x'.repeat(200_000) }))
    check('#22 a 200 KB body is refused on a route that never needs it (413)', bigBody.status === 413, String(bigBody.status))
    // #13/#18: /quote and /tx/status have their own tight per-IP buckets
    const getAs = (ip, p) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { 'x-forwarded-for': ip } })
    const qs = await Promise.all(Array.from({ length: 45 }, () => getAs('10.4.0.1', `/quote?input=SOL&output=${qc.mint}&amount=1000`)))
    const ss = await Promise.all(Array.from({ length: 75 }, () => getAs('10.4.0.2', `/tx/status/${bs58.encode(randomBytes(64))}`)))
    check('#13 /quote and /tx/status are rate-limited per IP well below the generic GET limit', qs.some(r => r.status === 429) && ss.some(r => r.status === 429) && qs.filter(r => r.status === 200).length >= 20)
    // R2#12: case / trailing-slash variants of /launch/prepare never reach the handler around its per-IP limiter
    const variants = []
    for (const p of ['/LAUNCH/prepare', '/launch/prepare/', '/Launch/Prepare/']) for (let i = 0; i < 4; i++) variants.push((await postAs('10.6.0.1', p, { wallet: wallet(), parent: all.items[0].mint, name: 'V', symbol: 'VAR', image: PNG })).status)
    check('R2#12 /LAUNCH/prepare, /launch/prepare/ … never reach the prepare handler (404), so its limiter cannot be skipped', variants.every(s => s === 404), variants.join())
    // R2#13: every visitor behind one Vercel egress IP shares req.ip: a flood of /m/ misses must not 429 the permanent metadata URIs
    const metaMint = all.items.find(x => x.level === 1 && x.mint !== c.mint).mint // a registered, visible coin (R4#1)
    mkdirSync(join(dir, 'meta'), { recursive: true })
    writeFileSync(join(dir, 'meta', `${metaMint}.json`), JSON.stringify({ name: 'Meta', symbol: 'META' }))
    const flood = []
    for (let b = 0; b < 10; b++) flood.push(...(await Promise.all(Array.from({ length: 100 }, () => getAs('10.7.0.1', `/m/${wallet()}.json`)))).map(r => r.status))
    const metaR = await getAs('10.7.0.1', `/m/${metaMint}.json`)
    check('R2#13 1000 /m/ misses from one (egress) IP never turn the metadata URIs into 429s', flood.every(s => s === 404) && metaR.status === 200, `${flood.filter(s => s === 429).length} × 429, then ${metaR.status}`)
    check('R2#13 an existing /m/ file is CDN-cacheable for a year (immutable), so Vercel serves it', /s-maxage=31536000/.test(metaR.headers.get('cdn-cache-control') || '') && /immutable/.test(metaR.headers.get('vercel-cdn-cache-control') || ''), metaR.headers.get('cdn-cache-control'))
    // R2#14: /health is exempt from the limiter, so it must be cheap: computed at most about once a second
    const hs = await Promise.all(Array.from({ length: 30 }, () => get('/health')))
    const ups = new Set(hs.map(h => h.body?.uptime))
    check('R2#14 a burst of /health requests shares one computed result', hs.every(h => h.status === 200) && ups.size <= 2, `${ups.size} distinct results`)
    // R4#8: the /health + /events exemption is GET-only: a POST flood there is limited per IP like any other path
    const evPosts = [], hPosts = []
    for (let i = 0; i < 40; i++) evPosts.push((await postAs('10.8.0.1', '/events', { pad: 'y'.repeat(2000) })).status)
    for (let i = 0; i < 40; i++) hPosts.push((await postAs('10.8.0.2', '/health', null, '{bad')).status)
    check('R4#8 POST /events and POST /health are rate-limited per IP (429 before any body is parsed)', evPosts.filter(s => s === 429).length >= 5 && hPosts.filter(s => s === 429).length >= 5 && hPosts.at(-1) === 429, `/events ${evPosts.filter(s => s === 429).length} × 429 · /health ${hPosts.filter(s => s === 429).length} × 429`)
    check('R4#8 …while GET /health from that same IP stays exempt', (await getAs('10.8.0.2', '/health')).status === 200)
    // R4#1: /m + /img serve only what the engine stands behind; only a registered, visible coin is CDN-cacheable
    const PNGBYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const cdn = r => `${r.headers.get('cdn-cache-control')} | ${r.headers.get('vercel-cdn-cache-control')}`
    const noStore = r => /no-store/.test(r.headers.get('cdn-cache-control') || '') && /no-store/.test(r.headers.get('vercel-cdn-cache-control') || '') && !/immutable|s-maxage/.test(cdn(r))
    mkdirSync(join(dir, 'img'), { recursive: true })
    const orphan = wallet()
    writeFileSync(join(dir, 'meta', `${orphan}.json`), JSON.stringify({ name: 'Spam', description: 'anyone\'s upload' }))
    writeFileSync(join(dir, 'meta', `${orphan}.png`), PNGBYTES); writeFileSync(join(dir, 'img', `${orphan}.png`), PNGBYTES)
    const [oj, op, oi] = await Promise.all([getAs('10.7.1.1', `/m/${orphan}.json`), getAs('10.7.1.1', `/m/${orphan}.png`), getAs('10.7.1.1', `/img/${orphan}`)])
    check('R4#1 files of a mint that is not a coin, a prepare or a journal are never served (404, no-store)', [oj, op, oi].every(r => r.status === 404 && noStore(r)), [oj, op, oi].map(r => `${r.status} ${cdn(r)}`).join(' / '))
    const pj = await getAs('10.7.1.1', `/m/${PREP_MINT}.json`)
    check('R4#1 a live prepare\'s metadata is served (it may land any second) but never CDN-cached', pj.status === 200 && noStore(pj), `${pj.status} ${cdn(pj)}`)
    writeFileSync(join(dir, 'meta', `${hidden[0]}.json`), JSON.stringify({ name: 'Admin Test' })); writeFileSync(join(dir, 'img', `${hidden[0]}.png`), PNGBYTES)
    const [hj, hi] = await Promise.all([getAs('10.7.1.1', `/m/${hidden[0]}.json`), getAs('10.7.1.1', `/img/${hidden[0]}`)])
    check('R4#1 a hidden ADMIN test coin: its permanent metadata URI resolves (never CDN-cached); the site logo proxy is 404', hj.status === 200 && noStore(hj) && hi.status === 404 && noStore(hi), `${hj.status} ${cdn(hj)} · img ${hi.status}`)
    const mod = (await get('/coins?limit=100')).body.items.find(x => x.level >= 1 && x.mint !== metaMint) // still visible now
    writeFileSync(join(dir, 'meta', `${mod.mint}.json`), JSON.stringify({ name: 'Abuse' })); writeFileSync(join(dir, 'img', `${mod.mint}.png`), PNGBYTES)
    const [bj, bi] = await Promise.all([getAs('10.7.1.1', `/m/${mod.mint}.json`), getAs('10.7.1.1', `/img/${mod.mint}`)])
    check('R4#1 a visible coin\'s files are CDN-cacheable (metadata immutable, logo a day)', bj.status === 200 && /immutable/.test(bj.headers.get('vercel-cdn-cache-control') || '') && bi.status === 200 && /s-maxage=86400/.test(bi.headers.get('cdn-cache-control') || ''), `${bj.status} ${cdn(bj)} · ${bi.status} ${cdn(bi)}`)
    const hideMod = await fetch(`http://127.0.0.1:${port}/admin/hide`, { method: 'POST', headers: { 'x-admin-secret': 'b'.repeat(40), 'content-type': 'application/json' }, body: JSON.stringify({ mint: mod.mint, hidden: true }) })
    const hb = await hideMod.json()
    const [aj, ai] = await Promise.all([getAs('10.7.1.1', `/m/${mod.mint}.json`), getAs('10.7.1.1', `/img/${mod.mint}`)])
    check('R4#1 hiding a PUBLIC launch (moderation) withdraws its /m and /img at once (404, no-store)', hideMod.status === 200 && aj.status === 404 && noStore(aj) && ai.status === 404 && noStore(ai), `${aj.status} ${cdn(aj)} · ${ai.status}`)
    check('R4#1 …and the hide answer names the CDN copies to purge', Array.isArray(hb.purge) && hb.purge.some(u => u.endsWith(`/m/${mod.mint}.json`)) && hb.purge.some(u => u.endsWith(`/img/${mod.mint}`)), JSON.stringify(hb))
  } finally {
    const gone = new Promise(r => child.once('exit', r))
    child.kill()
    await Promise.race([gone, new Promise(r => setTimeout(r, 3000))])
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
