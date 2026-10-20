// Mainnet DRY RUN of the launch path. Sends NOTHING, uploads nothing (META_SELF_HOST), throwaway engine keys.
//   1. adopt a real pump coin as a stand-in ROOT (reads its curve + Token-2022 metadata: the /admin/root/adopt path)
//   2. prepareLaunch() under it for a FUNDED mainnet wallet (simulation does not verify signatures):
//      pump create_v2 (+ createV2AndBuy with the pump ALT) + transfer(launcher → coin key, SETUP+SEED),
//      built and SIMULATED against mainnet — with LAUNCH_PRESIGN=true (mint signs first) and =false (wallet first)
//   3. the submit-side checks on what prepare returned: byte identity / messageIsOurs, signer slots
// Usage: node scripts/dryrun-launch.mjs [funded-wallet] [firstBuySol] [stand-in-root-mint]
import { dryEnv } from './_env.mjs'

const wallet = process.argv[2] || '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9'
const buySol = Number(process.argv[3] ?? 0.1)
const rootStandIn = process.argv[4] || 'SYLxv8TvHf5uAzAFhnTvyoYyxAuGYpjN3qYVWE6pump'
await dryEnv({ LAUNCH_ENABLED: 'true', META_SELF_HOST: 'true' })

const { VersionedTransaction } = await import('@solana/web3.js')
const { config } = await import('../config.js')
const sol = await import('../solana.js')
const store = await import('../store.js')
const launch = await import('../launch.js')
const registry = await import('../registry.js')
const M = await import('../math.js')
store.loadAllStores()
console.log(`rent(0) read from the chain: ${await sol.loadRent()} lamports`)
const img = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7a6a5b00000000049454e44ae426082', 'hex').toString('base64')

const root = await launch.adoptRoot(rootStandIn)
console.log(`[0] stand-in ROOT adopted from chain: $${root.symbol} ${root.mint} (external creator: ${root.external}) → holder pool ${root.holderPool}`)
console.log(`    launch-meta:`, JSON.stringify(launch.launchMeta()))

let ok = true
for (const [presign, buy] of [[true, buySol], [true, 0], [false, buySol]]) {
  config.launchPresign = presign
  const t0 = Date.now()
  try {
    const p = await launch.prepareLaunch({ wallet, parent: root.mint, name: 'GACHAPAD Dry Run Kid Coin Thirty-2', symbol: 'DRYKID', description: 'a simulated launch, never sent', image: img, socials: { twitter: 'https://x.com/example', website: 'https://example.com' }, firstBuySol: buy })
    const raw = Buffer.from(p.tx, 'base64')
    const tx = VersionedTransaction.deserialize(raw)
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).map(k => k.toBase58())
    const filled = tx.signatures.map(s => !s.every(b => b === 0))
    const rec = store.preparedStore.get()[p.id]
    const identical = M.messageIsOurs(Buffer.from(rec.message, 'base64'), tx.message.serialize())
    console.log(`\n[${presign ? 'presign' : 'wallet-first'} · buy ${buy} SOL] prepare + mainnet SIMULATION OK in ${Date.now() - t0} ms — mint ${p.mint}`)
    console.log(`    size ${raw.length} / 1232 bytes · lookup tables ${tx.message.addressTableLookups.length} · signers [${signers.map((s, i) => `${i === 0 ? 'wallet' : s === p.mint ? 'mint' : s}:${filled[i] ? 'SIGNED' : 'empty'}`).join(', ')}]`)
    console.log(`    costs ${JSON.stringify(p.costs)} · coin key ${rec.creatorKey} · parent pool ${rec.parentPool} (= poolKeyFor(ROOT) ${rec.parentPool === sol.poolKeyFor(root.mint).publicKey.toBase58()})`)
    console.log(`    persisted prepared record holds the parent (${rec.parent === root.mint}) and no secret · submit-side messageIsOurs(identical) = ${identical}`)
    const mintSigned = filled[signers.indexOf(p.mint)]
    if (presign !== mintSigned || filled[0] || !identical || raw.length > 1232) { ok = false; console.log('    ✗ unexpected signer slots / size') }
  } catch (e) { ok = false; console.log(`\n[${presign ? 'presign' : 'wallet-first'} · buy ${buy}] FAILED: ${e.message}`) }
}
console.log(ok ? '\nDRY RUN OK — nothing was sent.' : '\nDRY RUN FAILED — read above.')
process.exit(ok ? 0 : 1)
