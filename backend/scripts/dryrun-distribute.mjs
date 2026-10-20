// Mainnet SIMULATION of the distribute crank on REAL fee-shared coins. Sends NOTHING.
// For each coin: read its sharing config + shareholders + creator vault, apply the crank rule (vault ≥ max(rent +
// COLLECT_MIN, pump's unfunded-shareholder minimum), executable shareholder → blocked), build exactly what
// distributeDue sends (graduated: transferCreatorFeesToPumpV2 first, only when the AMM vault ATA exists), simulate it,
// and read the simulated post-balances to show what WOULD be booked (measured deltas only; 0 → nothing). Real past
// distributions are parsed like the fee index does, checking each share fits its cap (bps share of the vaults' drop).
// Usage: node scripts/dryrun-distribute.mjs [mint ...]
import { dryEnv } from './_env.mjs'
import { PublicKey, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID } from '@solana/spl-token'

const mints = process.argv.slice(2).length ? process.argv.slice(2) : ['FcYypTE2bpEJ3XJrCv38V8DN9UYwm4C5DW2jVC5chE2k', '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump']
const payer = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9' // any funded wallet: it only pays the (simulated) fee
await dryEnv()
const { config } = await import('../config.js')
const sol = await import('../solana.js')
const pump = await import('../pump.js')
const M = await import('../math.js')
const conn = sol.getConnection()
const r0 = await sol.loadRent()
let ok = true

for (const mint of mints) {
  console.log(`\n=== ${mint}`)
  try {
    const sharing = await pump.readSharingConfig(mint)
    if (!sharing) { console.log('no sharing config: not a fee-shared coin'); ok = false; continue }
    const curve = (await pump.readCurves([mint])).get(mint)
    const v = (await pump.readDistributable([mint])).get(mint)
    const cfgPda = sharing.address.toBase58()
    const graduated = !!curve?.graduated
    let pool = null
    if (graduated) pool = (await pump.readAmmPools([mint])).get(mint)
    const shareholders = sharing.config.shareholders.map(s => ({ address: s.address.toBase58(), shareBps: Number(s.shareBps) }))
    const kinds = await sol.walletKinds(shareholders.map(s => s.address))
    const lamportsOf = new Map([...kinds].map(([a, k]) => [a, k.lamports]))
    const executable = new Set([...kinds].filter(([, k]) => k.executable).map(([a]) => a))
    console.log(`graduated ${graduated} · curve.creator == config ${curve?.creator === cfgPda}${pool ? ` · pool.coinCreator == config ${pool.coinCreator === cfgPda} · pool ${pool.pool}` : ''} · adminRevoked ${sharing.config.adminRevoked}`)
    console.log(`shareholders: ${shareholders.map(s => `${s.shareBps} ${s.address.slice(0, 6)}… (${sol.sol(lamportsOf.get(s.address) || 0n)} SOL${executable.has(s.address) ? ', EXECUTABLE' : ''})`).join(' | ')}`)
    const vault = v.vaultLamports + (graduated && v.ammAtaExists ? v.amm : 0n)
    const d = M.crankDecision({ vaultLamports: vault, rent0: r0, collectMinLamports: sol.toLamports(config.collectMinSol), shareholders, lamportsOf, executable })
    console.log(`vault ${sol.sol(v.vaultLamports)} SOL (curve) + ${sol.sol(v.amm)} SOL (AMM WSOL, ATA exists ${v.ammAtaExists}) · pump minimum for these shareholders ${sol.sol(M.distributeMinimum(shareholders, lamportsOf, r0))} SOL · crank now: ${d.crank}${d.reason ? ` (${d.reason})` : ''}`)
    const ixs = await pump.distributeIxs({ mint, sharing, graduated, ammAtaExists: v.ammAtaExists, payer })
    const { blockhash } = await conn.getLatestBlockhash('confirmed')
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: new PublicKey(payer), recentBlockhash: blockhash, instructions: [...sol.budgetIxs(200_000), ...ixs] }).compileToV0Message())
    // the coin's own fee vaults (pump creator vault of the config + the AMM WSOL ATA): the fee index caps by their drop
    const va = pump.vaultAccounts(sharing.address)
    const vaultKeys = [va.curveVault.toBase58(), va.ammVaultAta.toBase58()]
    const vaultPre = (await sol.accountInfos(vaultKeys)).map(i => BigInt(i?.lamports ?? 0))
    const watch = [...shareholders.map(s => s.address), ...vaultKeys]
    const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: watch } })
    console.log(`simulate [${graduated && v.ammAtaExists ? 'transferCreatorFeesToPumpV2 + ' : ''}distributeCreatorFees]: ${r.value.err ? 'FAILED ' + JSON.stringify(r.value.err) : 'OK'} · ${r.value.unitsConsumed} CU · ${tx.serialize().length} bytes · 6052: ${M.is6052({ simErr: r.value.err, logs: r.value.logs })}`)
    if (r.value.err) { ok = false; console.log((r.value.logs || []).slice(-8).join('\n')); continue }
    const noop = (r.value.logs || []).find(l => /Insufficient fees|Minimum vault balance/i.test(l))
    const deltas = new Map(shareholders.map((s, i) => [s.address, BigInt(r.value.accounts?.[i]?.lamports ?? 0) - (lamportsOf.get(s.address) || 0n)]))
    const total = [...deltas.values()].reduce((s, x) => s + (x > 0n ? x : 0n), 0n)
    const n = shareholders.length
    const drop = -vaultKeys.reduce((a, _k, j) => a + (BigInt(r.value.accounts?.[n + j]?.lamports ?? 0) - vaultPre[j]), 0n)
    const caps = (await import('../distribute.js')).shareCaps(drop, shareholders.map(s => s.shareBps))
    const within = shareholders.every((s, i) => (deltas.get(s.address) || 0n) <= caps[i])
    console.log(`simulated measured deltas: ${shareholders.map(s => `${s.shareBps}→${sol.sol(deltas.get(s.address))}`).join(' / ')} · total ${sol.sol(total)} SOL`)
    console.log(`the coin's fee vaults dropped ${sol.sol(drop)} SOL · every shareholder's delta within its bps share of that drop (the fee index cap): ${within}`)
    if (!within) ok = false
    console.log(total > 0n ? `→ distributeDue would BOOK exactly these ${sol.sol(total)} SOL` : `→ nothing moved${noop ? ` (pump: "${noop.replace(/^Program log: /, '')}")` : ''}: distributeDue would book NOTHING (an earlier engine booked an estimate here)`)
    // a third party may crank with distribute_creator_fees_v2 instead (it works on SOL coins): simulate that crank and
    // hand the fee index's parser the simulated result, shaped like a fetched tx — it must name the coin and book it
    {
      const dist = await import('../distribute.js')
      const P = new PublicKey(payer), m = new PublicKey(mint)
      const v2 = [...(graduated && v.ammAtaExists ? [await pump.PUMP_SDK.transferCreatorFeesToPumpV2({ payer: P, mint: m, quoteMint: pump.NATIVE_MINT, quoteTokenProgram: TOKEN_PROGRAM_ID })] : []), await pump.PUMP_SDK.distributeCreatorFeesV2({ mint: m, sharingConfig: sharing.config, sharingConfigAddress: sharing.address, quoteMint: pump.NATIVE_MINT, payer: P })]
      const tx2 = new VersionedTransaction(new TransactionMessage({ payerKey: P, recentBlockhash: blockhash, instructions: [...sol.budgetIxs(200_000), ...v2] }).compileToV0Message())
      const keys2 = tx2.message.staticAccountKeys.map(k => k.toBase58())
      const pre2 = (await sol.accountInfos(keys2)).map(i => i?.lamports ?? 0)
      const r2 = await conn.simulateTransaction(tx2, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed', accounts: { encoding: 'base64', addresses: keys2 } })
      if (r2.value.err) { ok = false; console.log(`simulate [${v2.length > 1 ? 'transferCreatorFeesToPumpV2 + ' : ''}distributeCreatorFeesV2]: FAILED ${JSON.stringify(r2.value.err)}`); continue }
      const fetched = { meta: { err: null, fee: 0, preBalances: pre2, postBalances: keys2.map((_k, i) => r2.value.accounts?.[i]?.lamports ?? 0), loadedAddresses: { writable: [], readonly: [] }, innerInstructions: [] }, transaction: { message: tx2.message } }
      const named = dist.distributedMint(fetched)
      const by = dist.cappedByRole(shareholders.map((s, i) => ({ ...s, role: ['creator', 'parentHolders', 'burn', 'protocol'][i] || 'protocol' })), sol.lamportDeltasOf(fetched, shareholders.map(s => s.address)), dist.vaultDropOf(fetched, mint))
      const booked = by.toParent + by.toLauncher + by.toBurn + by.toProtocol
      console.log(`simulate [${v2.length > 1 ? 'transferCreatorFeesToPumpV2 + ' : ''}distributeCreatorFeesV2] (a third party's crank): OK · the fee index parser names ${named === mint ? 'the coin ✓' : `${named} ✗`} · would book ${sol.sol(booked)} SOL`)
      if (named !== mint) ok = false
    }
  } catch (e) { ok = false; console.log(`ERROR ${e.message}`) }
}
// The fee index (distribute.js indexDistributions) parses REAL DistributeCreatorFees txs: find recent ones of the
// graduated coin through its sharing config PDA and check the parser names the right mint + measures the deltas.
for (const mint of mints) {
  console.log(`\n=== fee index parser on real mainnet distributions of ${mint}`)
  try {
    const dist = await import('../distribute.js')
    const cfg = pump.feeSharingConfigPda(new PublicKey(mint))
    const sharing = await pump.readSharingConfig(mint)
    const holders = sharing.config.shareholders.map(s => s.address.toBase58())
    // the smallest shareholder is touched mostly by distributions (a config PDA is also in every curve trade)
    const anchor = sharing.config.shareholders.reduce((a, s) => (Number(s.shareBps) < Number(a.shareBps) ? s : a)).address
    const sigs = [...(await conn.getSignaturesForAddress(anchor, { limit: 25 }, 'confirmed')), ...(await conn.getSignaturesForAddress(cfg, { limit: 25 }, 'confirmed'))].filter(s => !s.err)
    let found = 0
    let skipped = 0
    let v1 = 0
    for (const s of sigs) {
      let tx = null
      // exactly as the fee index asks: version-1 txs are decoded (web3.js MessageV1), newer versions skipped
      try { tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, commitment: 'confirmed' }) } catch (e) { if (/version.*not supported/i.test(e.message)) { skipped++; continue } throw e }
      if (!tx?.meta) continue
      if (tx.version === 1) { v1++; dist.distributedMint(tx); sol.lamportDeltasOf(tx, holders) } // must parse without throwing
      const m = dist.distributedMint(tx)
      if (!m) continue
      const d = sol.lamportDeltasOf(tx, holders)
      const total = [...d.values()].reduce((a, x) => a + (x > 0n ? x : 0n), 0n)
      // the fee index books each share at most its bps share of what left the coin's fee vaults: a REAL distribution
      // must fit inside that cap (else the index would under-book it)
      const drop = dist.vaultDropOf(tx, mint)
      const caps = dist.shareCaps(drop, sharing.config.shareholders.map(sh => Number(sh.shareBps)))
      const within = sharing.config.shareholders.every((sh, i) => (d.get(sh.address.toBase58()) || 0n) <= caps[i])
      console.log(`  ${s.signature.slice(0, 12)}… distributedMint = ${m === mint ? 'the coin ✓' : `${m} ✗`} · shareholder deltas ${sol.sol(total)} SOL · vault drop ${sol.sol(drop)} SOL · within the cap: ${within}`)
      if (m !== mint || !within) ok = false
      if (++found >= 2) break
    }
    if (v1) console.log(`  (${v1} version-1 tx(s) read and parsed, as the fee index does)`)
    if (skipped) console.log(`  (${skipped} tx(s) of a version this client cannot decode skipped, as the fee index skips them)`)
    if (!found) console.log('  (no distribution among the scanned signatures: nothing to parse — not a failure)')
  } catch (e) { ok = false; console.log(`  ERROR ${e.message}`) }
}
console.log(ok ? '\nALL SIMULATIONS OK — nothing was sent.' : '\nSOMETHING FAILED — read above.')
process.exit(ok ? 0 : 1)
