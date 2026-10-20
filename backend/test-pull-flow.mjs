// The pull state machine end to end against a FAKE chain: quote → submit → burned → frozen → drawn, plus the money
// cases the adversarial review raised: one pull in flight per machine, a replayed / stale burn, a lapsed quote's
// cooldown, a lagging RPC (unseen, never voided early), and a crash between the two draw writes.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.ENGINE_NO_DOTENV = '1'
const dir = mkdtempSync(join(tmpdir(), 'gpump-pulls-'))
process.env.DATA_DIR = dir
process.env.PULLS_LIVE = 'true'
process.env.DELIVER_LIVE = 'false'
process.env.RPC_URL = 'http://fake.invalid'
process.env.DRAW_DELAY_SLOTS = '40'

const { Keypair, VersionedTransaction } = await import('@solana/web3.js')
const bs58 = (await import('bs58')).default
const { config, WSOL } = await import('./config.js')
const sol = await import('./solana.js')
const reg = await import('./registry.js')
const { ripsStore } = await import('./packs.js')
const P = await import('./pulls.js')
const { setSolUsd } = await import('./price.js')
const { TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token')
config.enginePrivateKey = bs58.encode(Keypair.generate().secretKey)

let pass = 0, fail = 0
const check = (name, ok) => { if (ok) pass++; else { fail++; console.log(`  ✗ ${name}`) } }
const throwsLike = async (fn, re) => { try { await fn(); return false } catch (e) { return re.test(String(e.message)) } }

/* ---- the fake chain ---- */
const chain = { height: 1000, slot: 5000, finSlot: 5000, blockhashN: 0, txs: new Map(), statuses: new Map(), balance: 10n ** 15n }
const fake = {
  getLatestBlockhashAndContext: async () => ({ context: { slot: chain.slot }, value: { blockhash: bs58.encode(Buffer.alloc(32, ++chain.blockhashN)), lastValidBlockHeight: chain.height + 150 } }),
  simulateTransaction: async () => ({ value: { err: null, logs: [] } }),
  getAccountInfo: async () => ({ owner: TOKEN_2022_PROGRAM_ID, data: Buffer.alloc(0), lamports: 1 }),
  getTokenAccountBalance: async () => ({ value: { amount: chain.balance.toString() } }),
  sendRawTransaction: async () => 'sent',
  getParsedTransaction: async sig => chain.txs.get(sig) || null,
  getSignatureStatuses: async sigs => ({ value: sigs.map(s => chain.statuses.get(s) || null) }),
  getBlockHeight: async () => chain.height,
  getSlot: async c => (c === 'finalized' ? chain.finSlot : chain.slot),
  getBlocks: async (a, b) => { const out = []; for (let s = a; s <= b; s++) out.push(s); return out },
  getBlock: async s => ({ blockhash: bs58.encode(Buffer.alloc(32, s % 251)) }),
}
sol.setConnection(fake)
setSolUsd(200)

/* ---- one coin with a machine of three cards ---- */
const wallet = Keypair.generate()
const mint = Keypair.generate().publicKey.toBase58()
reg.putCoin({ mint, symbol: 'TEST', name: 'Test', level: 1, parent: null, root: false, preRoot: true, packCode: 'pokemon_25', sharing: { address: Keypair.generate().publicKey.toBase58(), shareholders: [] }, holderPool: Keypair.generate().publicKey.toBase58(), createdAt: Date.now(), hidden: false })
const now = Date.now()
reg.setLive(mint, { priceSol: 0.00000002, priceSrc: 'curve', refreshedAt: now, quoteMint: WSOL })
P.setSamples(mint, Array.from({ length: 10 }, (_, i) => ({ at: now - 590_000 + i * 60_000, priceSol: 0.00000002 })))
const card = (n, v) => ({ id: Keypair.generate().publicKey.toBase58(), name: `Card ${n}`, valueUsd: v })
ripsStore.set({ rips: [1, 2, 3].map(n => ({ id: `p${n}`, n, mint, symbol: 'TEST', status: 'stock', card: card(n, [10, 20, 30][n - 1]), at: now })) })
check('coin is a visible pack coin', reg.isVisible(mint))

/* ---- 1. quote, and the machine lock ---- */
const q1 = await P.preparePull({ mint, wallet: wallet.publicKey.toBase58() })
check('quote priced on the average card + 10%', q1.priceUsd === 22 && q1.cards === 3)
check('quote tokens = $22 at $0.000004 (lowest reading)', BigInt(q1.tokens) === P.tokensFor(22, 0.00000002 * 200))
const other = Keypair.generate().publicKey.toBase58()
check('a second quote on the same machine is refused while one is in flight', await throwsLike(() => P.preparePull({ mint, wallet: other }), /someone is pulling/))

/* ---- 2. submit: only the quote's own bytes ---- */
const signed = VersionedTransaction.deserialize(Buffer.from(q1.tx, 'base64')); signed.sign([wallet])
const raw = Buffer.from(signed.serialize()).toString('base64')
const sig = bs58.encode(signed.signatures[0])
const rec1 = P.pullById(q1.id)
const forged = await P.preparePull.length // (keep linter quiet)
void forged
const s1 = await P.submitPull(q1.id, { tx: raw })
check('submit relays and marks sent', s1.status === 'sent' && s1.sig === sig)

/* ---- 3. the finalized burn is read back ---- */
const parsedBurn = ({ amount = q1.tokens, bh = rec1.blockhash, memo = rec1.memo, err = null } = {}) => ({
  slot: 5010,
  meta: { err, preTokenBalances: [{ mint, owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: (10n ** 15n).toString() } }], postTokenBalances: [{ mint, owner: wallet.publicKey.toBase58(), uiTokenAmount: { amount: (10n ** 15n - BigInt(amount)).toString() } }] },
  transaction: { message: { recentBlockhash: bh, accountKeys: [{ pubkey: wallet.publicKey.toBase58(), signer: true }], instructions: [
    { program: 'spl-token-2022', parsed: { type: 'burnChecked', info: { mint, authority: wallet.publicKey.toBase58(), tokenAmount: { amount: String(amount) } } } },
    { program: 'spl-memo', programId: P.MEMO_PROGRAM, parsed: memo },
  ] } },
})
chain.txs.set(sig, parsedBurn())
await P.pullsTick()
let p1 = P.pullById(q1.id)
check('burn verified and the machine frozen on the quoted list', p1.status === 'burned' && p1.freeze?.list.join() === 'p1,p2,p3' && p1.freeze.seedSlot === chain.slot + 40)
await P.pullsTick()
check('no draw before the seed slot is finalized', !P.pullById(q1.id).draw)
chain.finSlot = chain.slot + 60
await P.pullsTick()
p1 = P.pullById(q1.id)
const won = ripsStore.get().rips.find(r => r.id === p1.ripId)
check('drawn: one card assigned, the rip names the pull', p1.status === 'drawn' && won?.status === 'pulled' && won.pullId === q1.id)
const seed = P.pullSeed({ blockhash: p1.draw.blockhash, pullId: p1.id, sig, hash: p1.freeze.hash })
check('the pick recomputes from the public record', P.pickCard(p1.freeze.list, seed).ripId === p1.ripId)
check('the machine unlocks once drawn', P.activeOf(mint).length === 0)

/* ---- 4. a replayed / stale burn earns nothing ---- */
const q2 = await P.preparePull({ mint, wallet: wallet.publicKey.toBase58() })
check('the next quote is priced on what is left', q2.cards === 2)
const r2 = P.pullById(q2.id)
const t2 = VersionedTransaction.deserialize(Buffer.from(q2.tx, 'base64')); t2.sign([wallet])
const sig2 = bs58.encode(t2.signatures[0])
await P.submitPull(q2.id, { sig: sig2 })
chain.txs.set(sig2, parsedBurn({ bh: rec1.blockhash, memo: r2.memo, amount: q2.tokens })) // built on an OLD blockhash
await P.pullsTick()
check('a burn on another quote\'s blockhash is invalid', P.pullById(q2.id).status === 'invalid')
check('an invalid burn frees the machine', P.activeOf(mint).length === 0)

/* ---- 5. a lapsed quote: dropped, and the wallet cools down ---- */
const q3 = await P.preparePull({ mint, wallet: other })
chain.height += 200 // its blockhash dies, nothing was sent
await P.pullsTick()
check('a lapsed quote is dropped', !P.pullById(q3.id))
check('the lapsing wallet cools down on that machine', await throwsLike(() => P.preparePull({ mint, wallet: other }), /lapsed/))

/* ---- 6. a lagging RPC: unseen, machine freed, never voided early, honoured if it shows up ---- */
chain.slot = chain.finSlot + 100 // the confirmed tip runs ahead of finalized again
const q4 = await P.preparePull({ mint, wallet: wallet.publicKey.toBase58() })
const r4 = P.pullById(q4.id)
const t4 = VersionedTransaction.deserialize(Buffer.from(q4.tx, 'base64')); t4.sign([wallet])
const sig4 = bs58.encode(t4.signatures[0])
await P.submitPull(q4.id, { tx: Buffer.from(t4.serialize()).toString('base64') })
chain.height += 200
await P.pullsTick()
check('a burn no node shows after its blockhash died is unseen, not void', P.pullById(q4.id).status === 'unseen')
check('an unseen burn does not hold the machine', P.activeOf(mint).length === 0)
chain.txs.set(sig4, parsedBurn({ bh: r4.blockhash, memo: r4.memo, amount: q4.tokens }))
await P.pullsTick()
check('the late burn is honoured and frozen on the live stock', P.pullById(q4.id).status === 'burned' && P.pullById(q4.id).late && P.pullById(q4.id).freeze)

/* ---- 7. a crash between the rip write and the pull write is resumed, never re-picked ---- */
const p4 = P.pullById(q4.id)
const target = p4.freeze.list[0]
ripsStore.update(s => { const r = s.rips.find(x => x.id === target); r.status = 'pulled'; r.pullId = q4.id })
chain.finSlot = chain.slot + 60
await P.pullsTick()
const p4b = P.pullById(q4.id)
check('a half-written draw resumes on the same card', p4b.status === 'drawn' && p4b.ripId === target)
check('no other card was taken', ripsStore.get().rips.filter(r => r.pullId === q4.id).length === 1)

/* ---- 8. a failed burn (on-chain error) is void, nothing assigned ---- */
const left = ripsStore.get().rips.filter(r => r.status === 'stock').length
if (left) {
  const q5 = await P.preparePull({ mint, wallet: wallet.publicKey.toBase58() })
  const t5 = VersionedTransaction.deserialize(Buffer.from(q5.tx, 'base64')); t5.sign([wallet])
  const sig5 = bs58.encode(t5.signatures[0])
  await P.submitPull(q5.id, { sig: sig5 })
  chain.txs.set(sig5, parsedBurn({ bh: P.pullById(q5.id).blockhash, memo: P.pullById(q5.id).memo, err: { InstructionError: [2, 'x'] } }))
  await P.pullsTick()
  check('an on-chain failed burn is void', P.pullById(q5.id).status === 'void')
  check('stock untouched by a failed burn', ripsStore.get().rips.filter(r => r.status === 'stock').length === left)
}

rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
