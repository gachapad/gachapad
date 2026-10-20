// Mainnet SIMULATION of the token-quoted burn route ($GACHA on CARDS). Nothing is signed or sent.
//   stage 1: SOL → CARDS via Jupiter for OWNER1 (price floor + assertSwapTx + simulated post-state)
//   stage 2: quote token → a pump coin via buy_v2 on a live token-quoted curve for OWNER2 (assertBurnTx + simulated post-state)
// Until a CARDS curve exists, stage 2 runs on a USDC-quoted curve: the same buy_v2 code path.
//   node scripts/dryrun-quoted-burn.mjs [rootMint] [owner2]
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.env.ENGINE_NO_DOTENV = '1'
const prod = readFileSync(resolve(HERE, '.env.prod'), 'utf-8')
process.env.RPC_URL = /^RPC_URL=(.*)$/m.exec(prod)[1]
const { PublicKey } = await import('@solana/web3.js')
const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token')
const sol = await import('../solana.js')
const { solUsd } = await import('../price.js')
const burner = await import('../burner.js')
const { readCurves } = await import('../pump.js')

const CARDS = { mint: new PublicKey('CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp'), mintStr: 'CARDSccUMFKoPRZxt5vt3ksUbxEFEcnZ3H2pd3dKxYjp', program: TOKEN_PROGRAM_ID, decimals: 6 }
const OWNER1 = 'H1KtnL4R5KH4cMtNPSRRnpzFxF9rE3eWJ87htCu24PHu' // GACHAPAD engine wallet (has SOL)
const ROOT = process.argv[2] || '5iREpWmR9LG4oK7LqZhkB8j6fXFnUfRxAvqxxnGVpump' // a live USDC-quoted pump curve
const conn = sol.getConnection()
// a wallet that holds the quote token AND SOL for fees (simulation only: nobody signs); default = a large USDC holder
async function findHolder(quoteMint, curve) {
  // recent traders on the curve: fee payers that still hold >= 1 quote token and some SOL
  const sigs = await conn.getSignaturesForAddress(curve, { limit: 40 })
  for (const x of sigs) {
    const tx = await conn.getTransaction(x.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null)
    const payer = tx?.transaction.message.staticAccountKeys[0]
    if (!payer) continue
    const ata = getAssociatedTokenAddressSync(new PublicKey(quoteMint), payer, false, TOKEN_PROGRAM_ID)
    const q = await conn.getTokenAccountBalance(ata).then(b => BigInt(b.value.amount)).catch(() => 0n)
    if (q >= 1_000_000n && (await conn.getBalance(payer)) > 20_000_000) return payer.toBase58()
  }
  // else the quote token's largest holders (works for a small-supply token like CARDS)
  const big = await conn.getTokenLargestAccounts(new PublicKey(quoteMint), 'confirmed').catch(() => ({ value: [] }))
  for (const a of big.value.slice(0, 20)) {
    const owner = (await conn.getParsedAccountInfo(a.address)).value?.data?.parsed?.info?.owner
    if (owner && PublicKey.isOnCurve(new PublicKey(owner).toBytes()) && (await conn.getBalance(new PublicKey(owner))) > 20_000_000) return owner
  }
  throw new Error('no funded holder found')
}
const CAP = 1_000_000n // spend at most 1 whole quote token in the simulation
console.log(`SOL/USD ${await solUsd()} · CARDS/USD ${await burner.usdPriceOf(CARDS.mintStr)}`)

// ---- stage 1
{
  const bal = BigInt(await conn.getBalance(new PublicKey(OWNER1), 'confirmed'))
  const lamports = 50_000_000n
  const built = await burner.buildQuoteBuy({ owner: OWNER1, quote: CARDS, lamports })
  console.log(`stage 1 built: ${Number(lamports) / 1e9} SOL → ~${Number(built.quote.outAmount) / 1e6} CARDS (min ${Number(built.quote.minOut) / 1e6}); assertSwapTx ✓ price floor ✓`)
  const ata = getAssociatedTokenAddressSync(CARDS.mint, new PublicKey(OWNER1), false, CARDS.program).toBase58()
  const r = await burner.checkStageSimulation(built, { owner: OWNER1, balance: bal, solMax: lamports + 7_000_000n, outAta: ata })
  console.log(`stage 1 SIMULATED ✓ gains ${Number(r.gained) / 1e6} CARDS`)
}

// ---- stage 2
{
  const f = (await readCurves([ROOT])).get(ROOT)
  console.log(`root ${ROOT}: quote ${f.quoteMint} · graduated ${f.graduated} · price ${f.priceQuote} quote / ${f.priceSol} SOL`)
  const qi = await conn.getAccountInfo(new PublicKey(f.quoteMint))
  const quote = { mint: new PublicKey(f.quoteMint), mintStr: f.quoteMint, program: qi.owner, decimals: 6 }
  const OWNER2 = process.argv[3] || await findHolder(f.quoteMint, (await import('@pump-fun/pump-sdk')).bondingCurvePda(new PublicKey(ROOT)))
  const quoteAta = getAssociatedTokenAddressSync(quote.mint, new PublicKey(OWNER2), false, quote.program).toBase58()
  const bigHeld = BigInt((await conn.getTokenAccountBalance(new PublicKey(quoteAta), 'confirmed')).value.amount)
  const held = bigHeld < CAP ? bigHeld : CAP
  console.log(`stage 2 owner ${OWNER2}`)
  const mi = await conn.getAccountInfo(new PublicKey(ROOT))
  const rootProgram = mi.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID
  const rootAta = getAssociatedTokenAddressSync(new PublicKey(ROOT), new PublicKey(OWNER2), false, rootProgram).toBase58()
  const built = await burner.buildQuotedRootBuy({ owner: OWNER2, mint: ROOT, quote, quoteAmount: held })
  const progs = built.tx.message.compiledInstructions.map(ix => built.tx.message.staticAccountKeys[ix.programIdIndex].toBase58())
  console.log(`stage 2 built (${built.quote.route}): ${Number(held) / 1e6} quote → min ${built.quote.minOut} raw ROOT (max in ${built.maxIn}); programs ${[...new Set(progs)].join(', ')}; assertBurnTx ✓`)
  const bal = BigInt(await conn.getBalance(new PublicKey(OWNER2), 'confirmed'))
  const r = await burner.checkStageSimulation(built, { owner: OWNER2, balance: bal, solMax: sol.txFeeLamports(built.units) + 8_000_000n, inAta: quoteAta, maxIn: built.maxIn, outAta: rootAta })
  console.log(`stage 2 SIMULATED ✓ gains ${r.gained} raw ROOT`)
}
console.log('dry run only: nothing signed, nothing sent')
process.exit(0)
