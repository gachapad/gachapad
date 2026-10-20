// Pure tests for pulls.js: pricing, the frozen list, the card pick, and the burn check.
process.env.ENGINE_NO_DOTENV = '1'
const { stockAverageUsd, pullPriceUsd, tokensFor, quotePriceSol, freezeList, pullSeed, pickCard, verifyBurnTx, memoFor, MEMO_PROGRAM } = await import('./pulls.js')

let pass = 0, fail = 0
const check = (name, ok) => { if (ok) pass++; else { fail++; console.log(`  ✗ ${name}`) } }

// ---- pricing ----
check('average ignores nothing, uses fallback for unvalued cards', stockAverageUsd([{ card: { valueUsd: 20 } }, { card: { valueUsd: 40 } }, { card: {} }], 30) === 30)
check('average of an empty machine is null', stockAverageUsd([], 25) === null)
check('price = avg × 1.10, rounded UP to the cent', pullPriceUsd(27.441, 1000) === 30.19)
check('no price without a positive average', pullPriceUsd(0) === null && pullPriceUsd(null) === null)
check('tokens round UP', tokensFor(30, 0.00003, 6) === 1_000_000_000_000n)
check('tokens: a fraction of a raw unit still costs a whole one', tokensFor(1, 3, 6) === 333_334n)
check('tokens null on a zero price', tokensFor(30, 0) === null)
const now = 1_000_000_000
const S = vals => vals.map((p, i) => ({ at: now - 560_000 + i * Math.floor(560_000 / Math.max(1, vals.length - 1)), priceSol: p }))
check('quote price = min(spot, every reading)', quotePriceSol(2, S([1, 3, 2]), { now, windowMs: 600_000, minSamples: 3 }) === 1)
check('a pump held for the whole window never beats the lowest reading', quotePriceSol(5, S([1, 5, 5, 5]), { now, windowMs: 600_000, minSamples: 3 }) === 1)
check('readings must cover most of the window (fresh boot waits)', quotePriceSol(1, [{ at: now - 60_000, priceSol: 1 }, { at: now - 30_000, priceSol: 1 }, { at: now - 1000, priceSol: 1 }], { now, windowMs: 600_000, minSamples: 3 }) === null)
check('a dumped spot is used when it is lower', quotePriceSol(0.5, S([1, 1, 1]), { now, windowMs: 600_000, minSamples: 3 }) === 0.5)
check('too few readings → no quote', quotePriceSol(1, S([1, 1]), { now, windowMs: 600_000, minSamples: 3 }) === null)
check('readings outside the window do not count', quotePriceSol(1, [{ at: now - 700_000, priceSol: 0.1 }, ...S([1, 1, 1])], { now, windowMs: 600_000, minSamples: 3 }) === 1)
check('pumping the spot never lowers the token count', tokensFor(30, quotePriceSol(10, S([1, 1, 1]), { now, windowMs: 600_000, minSamples: 3 })) === tokensFor(30, 1))

// ---- frozen list + pick ----
const stock = [{ id: 'p10' }, { id: 'p2' }, { id: 'p33' }]
const f1 = freezeList(stock), f2 = freezeList([...stock].reverse())
check('frozen list sorted by pack number', f1.list.join(',') === 'p2,p10,p33')
check('frozen hash independent of input order', f1.hash === f2.hash)
check('a different list hashes differently', freezeList([{ id: 'p2' }]).hash !== f1.hash)
const seed = pullSeed({ blockhash: 'BH', pullId: 'abc', sig: 'SIG', hash: f1.hash })
check('seed is deterministic', seed === pullSeed({ blockhash: 'BH', pullId: 'abc', sig: 'SIG', hash: f1.hash }))
check('seed changes with the blockhash', seed !== pullSeed({ blockhash: 'BH2', pullId: 'abc', sig: 'SIG', hash: f1.hash }))
const pick = pickCard(f1.list, seed)
check('pick = list[seed mod n]', pick.ripId === f1.list[Number(BigInt('0x' + seed) % 3n)] && pick.n === 3)
check('pick from nothing is null', pickCard([], seed) === null)
// distribution sanity: 3000 seeds over 3 cards land roughly evenly
const counts = [0, 0, 0]
for (let i = 0; i < 3000; i++) counts[pickCard(f1.list, pullSeed({ blockhash: `b${i}`, pullId: 'x', sig: 's', hash: 'h' })).index]++
check('picks are roughly uniform', counts.every(c => c > 850 && c < 1150))

// ---- the burn check ----
const W = 'WaLLet1111111111111111111111111111111111111', M = 'MinT11111111111111111111111111111111111111', memo = memoFor('q1')
const okTx = (o = {}) => ({
  slot: 100,
  meta: { err: o.err ?? null, preTokenBalances: [{ mint: M, owner: W, uiTokenAmount: { amount: String(o.pre ?? 5_000_000) } }], postTokenBalances: [{ mint: M, owner: W, uiTokenAmount: { amount: String(o.post ?? 3_000_000) } }] },
  transaction: { message: {
    recentBlockhash: o.bh || 'BHQ',
    accountKeys: [{ pubkey: o.signer || W, signer: true, writable: true }],
    instructions: o.ixs || [
      { program: o.prog || 'spl-token-2022', programId: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', parsed: { type: 'burnChecked', info: { account: 'ATA', mint: o.mint || M, authority: o.auth || W, tokenAmount: { amount: String(o.amount ?? 2_000_000) } } } },
      { program: 'spl-memo', programId: MEMO_PROGRAM, parsed: o.memo ?? memo },
    ],
  } },
})
const want = { wallet: W, mint: M, minRaw: '2000000', memo, blockhash: 'BHQ' }
check('a matching burn passes', verifyBurnTx(okTx(), want).ok)
check('legacy spl-token burn passes too', verifyBurnTx(okTx({ prog: 'spl-token' }), want).ok)
check('a failed tx is refused (and marked failed)', (r => !r.ok && r.failed)(verifyBurnTx(okTx({ err: { InstructionError: [0, 'x'] } }), want)))
check('wrong memo refused', !verifyBurnTx(okTx({ memo: memoFor('other') }), want).ok)
check('less than the quote refused', !verifyBurnTx(okTx({ amount: 1_999_999, post: 3_000_001 }), want).ok)
check('another mint refused', !verifyBurnTx(okTx({ mint: 'Other1111111111111111111111111111111111111' }), want).ok)
check('another authority refused', !verifyBurnTx(okTx({ auth: 'Other1111111111111111111111111111111111111' }), want).ok)
check('balance that did not fall refused', !verifyBurnTx(okTx({ post: 5_000_000 }), want).ok)
check('not signed by the wallet refused', !verifyBurnTx(okTx({ signer: 'Someone11111111111111111111111111111111111' }), { ...want }).ok || false)
check('a CPI-only burn (inner instruction) is not counted', !verifyBurnTx(okTx({ ixs: [{ program: 'spl-memo', programId: MEMO_PROGRAM, parsed: memo }] }), want).ok)
check('null tx → not found', verifyBurnTx(null, want).reason === 'not found')
check('a burn on another blockhash (stale / replayed quote) is refused', !verifyBurnTx(okTx({ bh: 'OTHER' }), want).ok)
check('two gachapad memos in one tx are refused (one burn, one pull)', !verifyBurnTx(okTx({ ixs: [
  { program: 'spl-token-2022', parsed: { type: 'burnChecked', info: { mint: M, authority: W, tokenAmount: { amount: '4000000' } } } },
  { program: 'spl-memo', programId: MEMO_PROGRAM, parsed: memo },
  { program: 'spl-memo', programId: MEMO_PROGRAM, parsed: memoFor('q2') },
] , post: 1_000_000 }), want).ok)
check('an unrelated extra memo is fine', verifyBurnTx(okTx({ ixs: [
  { program: 'spl-token-2022', parsed: { type: 'burnChecked', info: { mint: M, authority: W, tokenAmount: { amount: '2000000' } } } },
  { program: 'spl-memo', programId: MEMO_PROGRAM, parsed: memo },
  { program: 'spl-memo', programId: MEMO_PROGRAM, parsed: 'hello' },
] }), want).ok)
check('two burns in one tx add up', verifyBurnTx(okTx({ ixs: [
  { program: 'spl-token-2022', parsed: { type: 'burn', info: { mint: M, authority: W, amount: '1000000' } } },
  { program: 'spl-token-2022', parsed: { type: 'burnChecked', info: { mint: M, authority: W, tokenAmount: { amount: '1000000' } } } },
  { program: 'spl-memo', programId: MEMO_PROGRAM, parsed: memo },
] }), want).ok)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
