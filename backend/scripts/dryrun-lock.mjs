// Mainnet SIMULATION of the fee LOCK + the SWEEP against a REAL pump.fun coin whose creator has not set fee sharing
// yet. Sends NOTHING (sigVerify off: the curve's real creator stands in for our coin key without its key).
//   [1] the lock exactly as finalizeCoin builds it: seed the parent pool + createFeeSharingConfig + updateFeeShares
//       with our 4 shareholders [launcher 4000, pool(parent) 4000, burn 1000, protocol 1000] — none of them exist yet
//   [2] the sweep with the ENGINE paying the fee (the recovery path of a coin key holding less than one fee): collect the
//       creator's pre-lock vault + transfers by shares (sub-rent parts to missing accounts folded into the parent-pool
//       part), the coin key ending at 0
//   [3] lock + sweep in ONE simulated tx with the COIN KEY as fee payer, its fee taken from the pot (proves the collect
//       still works AFTER the lock and the key ends at exactly 0), when it fits
//   [4] a GRADUATED coin's creator emptied to 0 lamports while its OLD PumpSwap vault still holds WSOL: the engine's
//       sweep shape (launch.sweepInstructions) with the engine FRONTING the key's temporary WSOL-account rent and taking
//       it back in the same tx — and the old shape without the front, which must FAIL ("insufficient lamports")
// Usage: node scripts/dryrun-lock.mjs [mint] [rich-wallet] [graduated-mint]
import { dryEnv } from './_env.mjs'
import { Keypair, PublicKey, TransactionMessage, VersionedTransaction, SystemProgram } from '@solana/web3.js'

const mint = process.argv[2] || '4PNvMjVryqeii3tKoRJPFTa4Pda5TXjuzfBfHF3ppump'
const rich = process.argv[3] || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const gradMint = process.argv[4] || 'SYLxv8TvHf5uAzAFhnTvyoYyxAuGYpjN3qYVWE6pump'
await dryEnv()
const { config } = await import('../config.js')
const sol = await import('../solana.js')
const pump = await import('../pump.js')
const M = await import('../math.js')
const launch = await import('../launch.js')
const conn = sol.getConnection()
const r0 = await sol.loadRent()

const curve = (await pump.readCurves([mint])).get(mint)
if (!curve) { console.error('no curve for that mint'); process.exit(1) }
if (await pump.readSharingConfig(mint)) { console.error('this coin already has a sharing config: pick another (the lock is one-shot)'); process.exit(1) }
const creator = curve.creator
const vault = (await pump.readVaults([creator])).get(creator)
const creatorBal = await sol.balanceOf(creator)
console.log(`coin ${mint} · graduated ${curve.graduated} · creator ${creator} (holds ${sol.sol(creatorBal)} SOL) · pre-lock creator vault ${sol.sol(vault.curve)} SOL above rent`)

const parentMint = Keypair.generate().publicKey.toBase58() // a stand-in parent: its holder pool does not exist yet
const parentPool = sol.poolKeyFor(parentMint).publicKey.toBase58()
const launcher = Keypair.generate().publicKey.toBase58()
const shareholders = M.shareholdersFor({ launcher, parentPool, burn: sol.burnAddress(), protocol: sol.protocolAddress(), split: config.split })
console.log(`shareholders: ${shareholders.map(s => `${s.role} ${s.shareBps} ${s.address}`).join(' | ')}`)

let lastPost = null
async function sim(label, instructions, { payer = rich, alts = [], units = 400_000, watch = [] } = {}) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed')
  const msg = new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: [...sol.budgetIxs(units), ...instructions] }).compileToV0Message(alts)
  const tx = new VersionedTransaction(msg)
  let bytes
  try { bytes = tx.serialize().length } catch (e) { console.log(`\n${label}: does not serialize (${e.message})`); return null }
  if (bytes > 1232) { console.log(`\n${label}: ${bytes} bytes — over 1232, not simulated`); return null }
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', ...(watch.length ? { accounts: { encoding: 'base64', addresses: watch } } : {}) })
  lastPost = r.value.accounts || null
  console.log(`\n${label}: ${r.value.err ? 'FAILED ' + JSON.stringify(r.value.err) : 'OK'} · ${r.value.unitsConsumed} CU · ${bytes} bytes`)
  if (r.value.err) console.log((r.value.logs || []).slice(-10).join('\n'))
  return !r.value.err
}

const fund = sol.toLamports(config.setupSol + config.poolSeedSol)
const fundIx = SystemProgram.transfer({ fromPubkey: new PublicKey(rich), toPubkey: new PublicKey(creator), lamports: fund })
const seedIx = sol.transferIx(creator, parentPool, sol.toLamports(config.poolSeedSol))
const lockIxs = await pump.sharingIxs({ creator, mint, graduated: !!curve.graduated, shareholders })
let ok = true
// [1] the lock, exactly our tx shape (the coin key pays + signs); the rich wallet only funds the stand-in creator
const cfgPda = pump.feeSharingConfigPda(new PublicKey(mint)).toBase58()
ok = (await sim('[1] lock: seed parent pool + createFeeSharingConfig + updateFeeShares(4, none exist)', [fundIx, seedIx, ...lockIxs], { watch: [creator, cfgPda, pump.bondingCurvePda(new PublicKey(mint)).toBase58()] })) && ok
const postLockBal = BigInt(lastPost?.[0]?.lamports ?? 0)
if (lastPost?.[1]) {
  const cfg = pump.PUMP_SDK.decodeSharingConfig({ ...lastPost[1], data: Buffer.from(lastPost[1].data[0], 'base64') })
  const bc = pump.decodeCurve({ ...lastPost[2], data: Buffer.from(lastPost[2].data[0], 'base64') })
  console.log(`    post-lock state: config rent ${lastPost[1].lamports} · adminRevoked ${cfg.adminRevoked} · shares ${cfg.shareholders.map(s => s.shareBps).join('/')} · curve.creator == config PDA: ${bc?.creator.toBase58() === cfgPda} · stand-in coin key left with ${sol.sol(postLockBal)} SOL`)
}
// [1b] the lock seed is sized from what the coin key HOLDS, not the live POOL_SEED_SOL: a key funded at prepare with the
// default SETUP + seed, then POOL_SEED_SOL raised 4x before its lock. The capped seed must lock and leave the key at
// exactly rent(0); the uncapped seed (the old behaviour) must fail. The stand-in creator pays the fee, as a coin key does.
{
  const fundDefault = sol.toLamports(config.setupSol + config.poolSeedSol)
  const topUp = fundDefault - creatorBal // the stand-in then holds exactly what a coin key holds after its launch
  if (topUp > 0n) {
    const raised = sol.toLamports(config.poolSeedSol * 4)
    const lockFee = sol.txFeeLamports(400_000, 2) // this stand-in tx has 2 signers: the rich funder + the creator (fee payer)
    const measuredRent = lastPost?.[1]?.lamports
    console.log(`    sharingConfigRent() = ${pump.sharingConfigRent()} · measured config rent ${measuredRent ?? '?'} → ${String(pump.sharingConfigRent()) === String(measuredRent) ? 'equal ✓' : 'DIFFERENT ✗'}`)
    if (measuredRent != null && String(pump.sharingConfigRent()) !== String(measuredRent)) ok = false
    const seed = M.lockSeedLamports({ want: raised, keyLamports: fundDefault, poolLamports: 0n, configRent: pump.sharingConfigRent(), lockFee, rent0: r0 })
    const fundTo = SystemProgram.transfer({ fromPubkey: new PublicKey(rich), toPubkey: new PublicKey(creator), lamports: topUp })
    ok = (await sim(`[1b] lock with the seed CAPPED to what the key holds (POOL_SEED_SOL raised to ${config.poolSeedSol * 4}: seed ${sol.sol(seed)} SOL)`, [fundTo, sol.transferIx(creator, parentPool, seed), ...lockIxs], { payer: creator, watch: [creator] })) && ok
    const left = BigInt(lastPost?.[0]?.lamports ?? -1)
    console.log(`    coin key left with ${left} lamports (rent(0) = ${r0}) → ${left === r0 ? 'exactly rent(0) ✓' : '✗'}`)
    if (left !== r0) ok = false
    const old = await sim(`[1c] the same lock with the UNCAPPED seed ${sol.sol(raised)} SOL (the old behaviour): expected to FAIL`, [fundTo, sol.transferIx(creator, parentPool, raised), ...lockIxs], { payer: creator })
    if (old !== false) { ok = false; console.log('    ✗ the uncapped seed did not fail: the cap is not what protects this lock') } else console.log('    fails as expected ✓')
  } else console.log('\n[1b] skipped: the stand-in creator already holds more than a coin key would')
}
// our real lock tx has the coin key as fee payer: measure that shape's size too
{
  const { blockhash } = await conn.getLatestBlockhash('confirmed')
  const own = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(creator), recentBlockhash: blockhash, instructions: [...sol.budgetIxs(400_000), seedIx, ...lockIxs] }).compileToV0Message())
  console.log(`    the engine's own lock tx (payer = coin key): ${own.serialize().length} / 1232 bytes, 1 signer`)
}
// [2] the sweep: collect + split, the coin key ending at 0 (pot = balance + claimable − the fee the KEY pays)
const units = 250_000
const lamportsOf = await sol.balancesOf(shareholders.map(s => s.address))
lamportsOf.set(parentPool, sol.toLamports(config.poolSeedSol)) // seeded by the lock
// the AMM leg exactly as the engine decides it: from the vault read (the old AMM vault ATA exists and holds WSOL)
const ammLeg = vault.ammAtaExists && vault.amm > 0n
const fromVault = vault.curve + (ammLeg ? vault.amm : 0n)
const collect = fromVault > 0n ? await pump.collectIxs(creator, ammLeg ? { graduated: true, ammAtaExists: true } : {}) : []
// [2] the ENGINE pays the fee, the coin key only signs its transfers — the recovery path for a key that holds less than
// one fee while its old vault holds fees (pump's collect is permissionless): pot = key balance + claimable, key ends at 0
const pot2 = creatorBal + fromVault
const alone = [...collect, ...M.sweepParts(pot2, shareholders, lamportsOf, r0, 'parentHolders').map(p => sol.transferIx(creator, p.address, p.lamports))]
ok = (await sim('[2] sweep with the ENGINE paying the fee (the key signs its transfers, ends at 0): collect + transfers by shares', alone, { units })) && ok
// [3] lock + sweep chained in one tx (the lock's state applied), with the COIN KEY as fee payer exactly like the engine:
// its fee is subtracted from the pot, so the key ends at exactly 0. A stand-in creator that cannot pay a fee at the
// start (the real coin key holds SETUP_SOL from the launch tx) falls back to the rich payer, said so below.
const fee3 = sol.txFeeLamports(400_000, 2) // two signers: the coin key (payer) + the rich wallet (the stand-in funding)
const keyPays = creatorBal >= fee3
const pot = postLockBal + fromVault - (keyPays ? fee3 : 0n)
const parts = M.sweepParts(pot, shareholders, lamportsOf, r0, 'parentHolders')
console.log(`\nsweep pot ${sol.sol(pot)} SOL → ${parts.map(p => `${p.role} ${sol.sol(p.lamports)}`).join(' / ')} (sub-rent parts to missing accounts folded: ${parts.length < shareholders.length || parts.some(p => p.role === 'parentHolders' && p.lamports > (pot * 4000n) / 10_000n)})`)
const sweepIxs = [...collect, ...parts.map(p => sol.transferIx(creator, p.address, p.lamports))]
const alts = await pump.loadAlts()
const both = await sim(`[3] lock + sweep in ONE simulated tx (collect after the lock, the key ends at 0; fee payer = ${keyPays ? 'the coin key' : 'the rich wallet — the stand-in creator holds less than one fee'})`, [fundIx, seedIx, ...lockIxs, ...sweepIxs], { alts, payer: keyPays ? creator : rich, watch: [creator] })
if (both) console.log(`    coin key after the sweep: ${lastPost?.[0]?.lamports ?? '?'} lamports`)
if (both != null) ok = both && ok
// the fold on its own: a pot too small to open the launcher's account folds that part into the parent pool
const tiny = M.sweepParts(1_200_000n, shareholders, lamportsOf, r0, 'parentHolders')
console.log(`fold check on a 0.0012 SOL pot: ${tiny.map(p => `${p.role} ${p.lamports}`).join(' / ')} (sum ${tiny.reduce((a, p) => a + p.lamports, 0n)})`)
// [4] the engine fronts the WSOL-account rent of a coin key at 0 whose OLD PumpSwap vault still holds fees
{
  const gCreator = (await pump.readCurves([gradMint])).get(gradMint)?.creator
  const gv = gCreator ? (await pump.readVaults([gCreator])).get(gCreator) : null
  if (!gv || !gv.ammAtaExists || gv.amm <= 0n) console.log(`\n[4] skipped: ${gradMint}'s creator has no WSOL in its old AMM vault right now`)
  else {
    const gBal = await sol.balanceOf(gCreator)
    const gWsol = pump.coinKeyWsolAta(gCreator).toBase58()
    const gCollect = await pump.collectIxs(gCreator, { graduated: true, ammAtaExists: true })
    // stage: the stand-in key ends at 0 and its curve vault at rent (an emptying sweep landed before the AMM WSOL arrived)
    const stage = [gCollect[0], sol.transferIx(gCreator, rich, gBal + gv.curve)]
    const gLamports = new Map(shareholders.map(s => [s.address, 1_000_000n])) // as if every shareholder exists
    const gParts = M.sweepParts(gv.amm, shareholders, gLamports, r0, 'parentHolders')
    const front = launch.wsolRentToFront({ collect: gCollect, keyWsol: gWsol, keyAtCreate: 0n, rent: pump.tokenAccountRent() })
    console.log(`\n[4] graduated ${gradMint}: creator ${gCreator} holds ${sol.sol(gBal)} SOL, old AMM vault ${sol.sol(gv.amm)} SOL of WSOL · the collect creates the key's WSOL account: ${front > 0n} · front ${front} lamports (tokenAccountRent)`)
    if (front > 0n) {
      const fixed = launch.sweepInstructions({ me: gCreator, engine: rich, collect: gCollect, front, keyWsol: gWsol, wsol: 0n, parts: gParts })
      const richBefore = await sol.balanceOf(rich)
      const f = await sim('[4] engine-pays sweep of a 0-lamport key with the engine FRONTING its WSOL-account rent (returned in the same tx)', [...stage, ...fixed], { units: 400_000, watch: [gCreator, gWsol, rich] })
      if (f) {
        const keyAfter = BigInt(lastPost?.[0]?.lamports ?? 0), wsolAfter = BigInt(lastPost?.[1]?.lamports ?? 0)
        // the stand-in engine: + what the staging moved to it (key balance + curve vault) − the fee (2 signers); the
        // fronted rent must come back exactly
        const want = richBefore + gBal + gv.curve - sol.txFeeLamports(400_000, 2), richAfter = BigInt(lastPost?.[2]?.lamports ?? -1)
        console.log(`    key after: ${keyAfter} lamports (must be 0) · its WSOL account: ${wsolAfter} lamports (${wsolAfter === 0n ? 'closed ✓' : 'still open ✗'}) · the engine stand-in got its front back: ${richAfter === want ? 'exactly ✓' : `✗ (${richAfter} vs ${want})`}`)
        if (keyAfter !== 0n || wsolAfter !== 0n || richAfter !== want) ok = false
      }
      ok = (f === true) && ok
      const old = await sim('[4b] the same sweep WITHOUT the front (the old shape): expected to FAIL', [...stage, ...launch.sweepInstructions({ me: gCreator, collect: gCollect, keyWsol: gWsol, wsol: 0n, parts: gParts })], { units: 400_000 })
      if (old !== false) { ok = false; console.log('    ✗ the old shape did not fail: the front is not what makes this sweep work') } else console.log('    fails as expected ✓')
    } else console.log('[4] the key\'s WSOL account already exists: no create, nothing to front (skipped)')
  }
}
console.log(ok ? '\nALL SIMULATIONS OK — nothing was sent.' : '\nSOMETHING FAILED — read the logs above.')
process.exit(ok ? 0 : 1)
