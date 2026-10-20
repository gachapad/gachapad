// GACHAPAD pack-machine tests (draw rules, pack tx check, swap tx check, card transfer). `node test-packs.js`. No RPC, no keys, no network.
import assert from 'assert'
import { Keypair, Transaction, TransactionInstruction, PublicKey, ComputeBudgetProgram, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js'
import { TOKEN_PROGRAM_ID, NATIVE_MINT, getAssociatedTokenAddressSync, createTransferCheckedInstruction, createTransferInstruction, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, createCloseAccountInstruction } from '@solana/spl-token'
import { addSample, averages, capWeights, entriesHash, drawSeed, pickWinner, chanceOf, splitClaim } from './draw.js'
import { assertPackTx, usdcAta, usdcRaw, USDC_MINT, MEMO_PROGRAM, shapeNft } from './cc.js'
import { decodeAssetHead, transferIx, MPL_CORE_PROGRAM } from './core.js'
import { assertSwapTx, JUPITER_V6 } from './swapcheck.js'
import { decodeMetadata, transferPnftIx, metadataPda, editionPda, tokenRecordPda, TOKEN_METADATA_PROGRAM, AUTH_RULES_PROGRAM } from './pnft.js'

let n = 0
const test = (name, fn) => { try { fn(); n++; console.log(`  ✓ ${name}`) } catch (e) { console.error(`  ✗ ${name}\n    ${e.stack}`); process.exitCode = 1 } }
const T = x => BigInt(Math.round(x * 1e6)) // tokens → raw (6 dec)

console.log('round sums + averages')
test('average over readings; a missed reading counts as 0', () => {
  const sums = {}
  addSample(sums, new Map([['A', T(100)], ['B', T(50)]]))
  addSample(sums, new Map([['A', T(100)]]))                  // B sold
  addSample(sums, new Map([['A', T(100)], ['C', T(900)]]))   // C bought just before the draw
  const avg = averages(sums, 3)
  assert.deepStrictEqual(avg.map(e => [e.wallet, e.weight]), [['A', T(100)], ['B', T(50) / 3n], ['C', T(300)]])
})
test('ineligible owners never enter; zero balances ignored', () => {
  const sums = addSample({}, new Map([['A', T(1)], ['POOL', T(1e6)], ['Z', 0n]]), { isEligibleOwner: o => o !== 'POOL' })
  assert.deepStrictEqual(Object.keys(sums), ['A'])
})
test('min hold filter + sorted by wallet', () => {
  const avg = averages({ z: T(10).toString(), a: T(5).toString(), m: T(1).toString() }, 1, { minRaw: T(5) })
  assert.deepStrictEqual(avg.map(e => e.wallet), ['a', 'z'])
})
test('no readings → nobody', () => { assert.deepStrictEqual(averages({ a: '5' }, 0), []) })

console.log('cap')
test('a whale is clipped to the cap of the uncapped total', () => {
  const entries = [{ wallet: 'whale', weight: 1_000_000n }, ...Array.from({ length: 30 }, (_, i) => ({ wallet: `w${i}`, weight: 1000n }))]
  const c = capWeights(entries, 1000)
  assert.strictEqual(c.find(e => e.wallet === 'whale').weight, (1_030_000n * 1000n) / 10_000n)
  assert.ok(c.filter(e => e.wallet !== 'whale').every(e => e.weight === 1000n))
})
test('few entrants: weights stay pro-rata (no one-ticket-per-wallet), splitting gains nothing', () => {
  const e = [{ wallet: 'a', weight: 50_000_000n }, { wallet: 'b', weight: 300_000n }, { wallet: 'c', weight: 200_000n }, { wallet: 'd', weight: 100_000n }]
  const c = capWeights(e, 1000)
  assert.ok(chanceOf(c, 'd') < 0.05, `minnow chance ${chanceOf(c, 'd')}`)
  // the same 100k split into 10 wallets of 10k is no better than one wallet
  const split = capWeights([...e.filter(x => x.wallet !== 'd'), ...Array.from({ length: 10 }, (_, i) => ({ wallet: `d${i}`, weight: 10_000n }))], 1000)
  const splitChance = split.filter(x => x.wallet.startsWith('d')).reduce((a, x) => a + chanceOf(split, x.wallet), 0)
  assert.ok(Math.abs(splitChance - chanceOf(c, 'd')) < 0.001)
})
test('cap 10000 changes nothing', () => {
  const e = [{ wallet: 'a', weight: 9n }, { wallet: 'b', weight: 1n }]
  assert.deepStrictEqual(capWeights(e, 10_000), e)
})

console.log('draw')
const E = [{ wallet: 'a', weight: 1n }, { wallet: 'b', weight: 2n }, { wallet: 'c', weight: 7n }]
test('pick walks the sorted entries by weight', () => {
  const at = r => pickWinner(E, r.toString(16).padStart(2, '0')).wallet
  assert.strictEqual(at(0), 'a'); assert.strictEqual(at(1), 'b'); assert.strictEqual(at(2), 'b'); assert.strictEqual(at(3), 'c'); assert.strictEqual(at(9), 'c'); assert.strictEqual(at(10), 'a') // 10 mod 10 = 0
})
test('seed is deterministic and binds blockhash, id and entries', () => {
  const h = entriesHash(E)
  const s1 = drawSeed({ blockhash: 'X', drawId: 'p1', hash: h })
  assert.strictEqual(s1, drawSeed({ blockhash: 'X', drawId: 'p1', hash: h }))
  assert.notStrictEqual(s1, drawSeed({ blockhash: 'Y', drawId: 'p1', hash: h }))
  assert.notStrictEqual(s1, drawSeed({ blockhash: 'X', drawId: 'p2', hash: h }))
  assert.notStrictEqual(h, entriesHash([...E, { wallet: 'd', weight: 1n }]))
})
test('frequencies follow the weights', () => {
  const hits = { a: 0, b: 0, c: 0 }
  for (let i = 0; i < 20_000; i++) hits[pickWinner(E, drawSeed({ blockhash: `bh${i}`, drawId: 'p', hash: 'h' })).wallet]++
  assert.ok(Math.abs(hits.a / 20_000 - 0.1) < 0.015 && Math.abs(hits.c / 20_000 - 0.7) < 0.015, JSON.stringify(hits))
})
test('nobody → null', () => { assert.strictEqual(pickWinner([], 'ff'), null) })

console.log('split')
test('exact, dust to the packs', () => {
  const p = splitClaim(1_000_000_007n, { burnBps: 1000, opsBps: 500 })
  assert.strictEqual(p.packs + p.burn + p.ops, 1_000_000_007n)
  assert.strictEqual(p.burn, 100_000_000n); assert.strictEqual(p.ops, 50_000_000n)
})

console.log('pack tx check (the only third-party bytes the vault ever signs)')
const vault = Keypair.generate(), gacha = Keypair.generate(), dest = Keypair.generate().publicKey
const memo = 'cc-3fc19bcf-27ce-4db3-a7a0-e54ce8176192'
function packTx({ amount = usdcRaw(50), extra = [], memoText = `${memo}:open`, from = usdcAta(vault.publicKey), authority = vault.publicKey, payer = gacha, sign = true, fifth = null } = {}) {
  const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 80_000 }))
  tx.add(new TransactionInstruction({ programId: new PublicKey(MEMO_PROGRAM), keys: [], data: Buffer.from(memoText) }))
  const t = createTransferCheckedInstruction(from, new PublicKey(USDC_MINT), dest, authority, amount, 6)
  if (fifth) t.keys.push({ pubkey: fifth, isSigner: true, isWritable: false })
  tx.add(t)
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }))
  for (const ix of extra) tx.add(ix)
  if (sign) tx.partialSign(payer)
  return Transaction.from(tx.serialize({ requireAllSignatures: false }))
}
const ok = { treasury: vault.publicKey, priceRaw: usdcRaw(50), memo }
test('the real shape passes', () => { assert.strictEqual(assertPackTx(packTx(), ok).destination, dest.toBase58()) })
test('their real 5-account shape (authority repeated) passes', () => { assert.ok(assertPackTx(packTx({ fifth: vault.publicKey }), ok)) })
test('a 5th account that is not the vault', () => assert.throws(() => assertPackTx(packTx({ fifth: Keypair.generate().publicKey }), ok), /accounts|signers/))
test('wrong amount', () => assert.throws(() => assertPackTx(packTx({ amount: usdcRaw(51) }), ok), /amount/))
test('vault as fee payer', () => assert.throws(() => assertPackTx(packTx({ payer: vault }), ok), /fee payer|signers/))
test('fee payer did not sign', () => assert.throws(() => assertPackTx(packTx({ sign: false }), ok), /not signed/))
test('a second transfer', () => assert.throws(() => assertPackTx(packTx({ extra: [createTransferCheckedInstruction(usdcAta(vault.publicKey), new PublicKey(USDC_MINT), dest, vault.publicKey, usdcRaw(50), 6)] }), ok), /transfers/))
test('a plain Transfer (no mint check)', () => assert.throws(() => assertPackTx(packTx({ extra: [createTransferInstruction(usdcAta(vault.publicKey), dest, vault.publicKey, 1n)] }), ok), /TransferChecked/))
test('a SOL transfer out of the vault', () => assert.throws(() => assertPackTx(packTx({ extra: [SystemProgram.transfer({ fromPubkey: vault.publicKey, toPubkey: dest, lamports: 1 })] }), ok), /writes to the treasury|not allowed/))
test('a card transfer smuggled in', () => assert.throws(() => assertPackTx(packTx({ extra: [transferIx({ asset: Keypair.generate().publicKey, owner: vault.publicKey, to: dest })] }), ok), /writes to the treasury|not allowed/))
test('memo mismatch', () => assert.throws(() => assertPackTx(packTx({ memoText: 'cc-other:open' }), ok), /memo/))
test('from someone else\'s account', () => assert.throws(() => assertPackTx(packTx({ from: Keypair.generate().publicKey }), ok), /not from the treasury/))
test('price above the ceiling', () => assert.throws(() => assertPackTx(packTx({ amount: usdcRaw(5000) }), { ...ok, priceRaw: usdcRaw(5000) }), /ceiling/))
test('price above the configured max', () => assert.throws(() => assertPackTx(packTx({ amount: usdcRaw(150) }), { ...ok, priceRaw: usdcRaw(150), maxRaw: usdcRaw(100) }), /ceiling/))

console.log('swap tx check (the only third-party bytes the fees wallet signs)')
const fees = Keypair.generate()
const wsol = getAssociatedTokenAddressSync(NATIVE_MINT, fees.publicKey, false, TOKEN_PROGRAM_ID)
function swapTx(extra = [], { jup = 1 } = {}) {
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
    createAssociatedTokenAccountIdempotentInstruction(fees.publicKey, wsol, fees.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: fees.publicKey, toPubkey: wsol, lamports: 1000 }),
    createSyncNativeInstruction(wsol),
    ...Array.from({ length: jup }, () => new TransactionInstruction({ programId: new PublicKey(JUPITER_V6), keys: [{ pubkey: fees.publicKey, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3]) })),
    createCloseAccountInstruction(wsol, fees.publicKey, fees.publicKey),
    ...extra,
  ]
  const msg = new TransactionMessage({ payerKey: fees.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58(), instructions: ixs }).compileToV0Message()
  return new VersionedTransaction(msg)
}
test('a Jupiter-shaped swap passes', () => { assert.ok(assertSwapTx(swapTx(), fees.publicKey)) })
test('a SOL transfer elsewhere', () => assert.throws(() => assertSwapTx(swapTx([SystemProgram.transfer({ fromPubkey: fees.publicKey, toPubkey: dest, lamports: 1 })]), fees.publicKey), /System/))
test('an unknown program', () => assert.throws(() => assertSwapTx(swapTx([new TransactionInstruction({ programId: new PublicKey(MPL_CORE_PROGRAM), keys: [], data: Buffer.from([14, 0]) })]), fees.publicKey), /not allowed/))
test('two Jupiter routes', () => assert.throws(() => assertSwapTx(swapTx([], { jup: 2 }), fees.publicKey), /expected 1/))

console.log('core')
test('decode an asset head (collection)', () => {
  const owner = Keypair.generate().publicKey, coll = Keypair.generate().publicKey
  const d = Buffer.concat([Buffer.from([1]), owner.toBuffer(), Buffer.from([2]), coll.toBuffer(), Buffer.alloc(20)])
  assert.deepStrictEqual(decodeAssetHead(d), { owner: owner.toBase58(), collection: coll.toBase58(), updateAuthority: null })
  assert.strictEqual(decodeAssetHead(Buffer.from([2, 1, 2])), null)
})
test('transfer ix: TransferV1, 7 accounts, owner signs', () => {
  const ix = transferIx({ asset: dest, collection: dest, owner: vault.publicKey, to: fees.publicKey })
  assert.deepStrictEqual([...ix.data], [14, 0])
  assert.strictEqual(ix.keys.length, 7)
  assert.ok(ix.keys[2].isSigner && ix.keys[3].isSigner && !ix.keys[4].isSigner)
})

console.log('card shape')
test('nftWon → card', () => {
  const c = shapeNft({ id: 'X', content: { links: { image: 'img' }, files: [{ uri: 'f' }, { uri: 'b' }], metadata: { name: '2025 #142 Zorua PSA 9', attributes: [{ trait_type: 'Card Name', value: 'Zorua' }, { trait_type: 'Insured Value', value: '42' }, { trait_type: 'Grading Company', value: 'PSA' }, { trait_type: 'The Grade', value: 'MINT 9' }] } }, grouping: [{ group_key: 'collection', group_value: 'C' }] })
  assert.strictEqual(c.cardName, 'Zorua'); assert.strictEqual(c.valueUsd, 42); assert.strictEqual(c.grade, 'MINT 9'); assert.strictEqual(c.back, 'b'); assert.strictEqual(c.collection, 'C')
})

console.log('pNFT cards (Collector Crypt older collection)')
const metaBuf = ({ mint, ts = 4, collection = null, ruleSet = null, progConfig = true }) => {
  const parts = []
  const u8 = v => parts.push(Buffer.from([v]))
  const key = k => parts.push(new PublicKey(k).toBuffer())
  const str = (t, pad) => { const b = Buffer.alloc(pad); Buffer.from(t).copy(b); const l = Buffer.alloc(4); l.writeUInt32LE(pad); parts.push(l, b) }
  u8(4); key(Keypair.generate().publicKey); key(mint)
  str('2024 #129 Pecharunt', 32); str('CC', 10); str('https://x', 200)
  parts.push(Buffer.from([0x2c, 0x01]))                                           // seller fee
  u8(1); const n4 = Buffer.alloc(4); n4.writeUInt32LE(1); parts.push(n4, Keypair.generate().publicKey.toBuffer(), Buffer.from([1, 100])) // 1 creator
  u8(1); u8(1)                                                                     // primary sale, mutable
  u8(1); u8(254)                                                                   // edition nonce
  u8(1); u8(ts)                                                                    // token standard
  if (collection) { u8(1); u8(1); key(collection) } else u8(0)
  u8(0); u8(0)                                                                     // uses, collection details
  if (progConfig) { u8(1); u8(0); if (ruleSet) { u8(1); key(ruleSet) } else u8(0) }
  return Buffer.concat(parts)
}
test('decodeMetadata: pNFT with collection + rule set', () => {
  const mint = Keypair.generate().publicKey.toBase58(), col = Keypair.generate().publicKey.toBase58(), rs = Keypair.generate().publicKey.toBase58()
  const d = decodeMetadata(metaBuf({ mint, collection: col, ruleSet: rs }))
  assert.deepStrictEqual(d, { mint, tokenStandard: 4, collection: { verified: true, key: col }, ruleSet: rs })
})
test('decodeMetadata: no rule set / no programmable config / not metadata / cut short', () => {
  const mint = Keypair.generate().publicKey.toBase58()
  assert.strictEqual(decodeMetadata(metaBuf({ mint })).ruleSet, null)
  assert.strictEqual(decodeMetadata(metaBuf({ mint, progConfig: false })).ruleSet, null)
  assert.strictEqual(decodeMetadata(Buffer.from([1, 2, 3])), null)
  assert.strictEqual(decodeMetadata(metaBuf({ mint }).subarray(0, 120)), null)
})
test('transferPnftIx: Token Metadata Transfer V1 of 1, the vault signs + pays, the rule set passed', () => {
  const mint = Keypair.generate().publicKey, owner = Keypair.generate().publicKey, to = Keypair.generate().publicKey, ta = Keypair.generate().publicKey, rs = Keypair.generate().publicKey
  const ix = transferPnftIx({ mint, tokenAccount: ta, owner, to, ruleSet: rs })
  const dest = getAssociatedTokenAddressSync(mint, to, false, TOKEN_PROGRAM_ID)
  assert.strictEqual(ix.programId.toBase58(), TOKEN_METADATA_PROGRAM)
  assert.deepStrictEqual([...ix.data], [49, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0])
  const k = ix.keys.map(x => x.pubkey.toBase58())
  assert.strictEqual(k.length, 17)
  assert.deepStrictEqual(k.slice(0, 9), [ta, owner, dest, to, mint, metadataPda(mint), editionPda(mint), tokenRecordPda(mint, ta), tokenRecordPda(mint, dest)].map(String))
  assert.deepStrictEqual(ix.keys.filter(x => x.isSigner).map(x => x.pubkey.toBase58()), [owner.toBase58(), owner.toBase58()])
  assert.deepStrictEqual(k.slice(15), [AUTH_RULES_PROGRAM, rs.toBase58()])
  assert.ok(ix.keys[0].isWritable && ix.keys[2].isWritable && !ix.keys[3].isWritable)
  const none = transferPnftIx({ mint, tokenAccount: ta, owner, to })
  assert.deepStrictEqual(none.keys.slice(15).map(x => x.pubkey.toBase58()), [TOKEN_METADATA_PROGRAM, TOKEN_METADATA_PROGRAM])
})

console.log(`\n${n} passed${process.exitCode ? ', some FAILED' : ''}`)
