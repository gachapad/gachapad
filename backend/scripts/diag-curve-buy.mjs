// Diagnose a SOL-curve buy: what the SDK quotes vs what the program charges, for buy (v1) and buy_v2. Simulation only.
//   node scripts/diag-curve-buy.mjs <mint> <fundedWallet> [lamports]
import { dryEnv } from './_env.mjs'
import { PublicKey } from '@solana/web3.js'
import { NATIVE_MINT } from '@solana/spl-token'
await dryEnv()
const sol = await import('../solana.js')
const pump = await import('../pump.js')
const { createRequire } = await import('module')
const require = createRequire(import.meta.url)
const { PUMP_SDK, getBuyTokenAmountFromSolAmount, computeFeesBps } = require('@pump-fun/pump-sdk')
const BN = require('bn.js')
const [mint, user, lam = '20000000'] = process.argv.slice(2)
const { global, feeConfig } = await pump.ctx()
const m = new PublicKey(mint), who = new PublicKey(user)
const info = await sol.getConnection().getAccountInfo(m)
const tokenProgram = info.owner
const st = await pump.online().fetchBuyState(m, who, tokenProgram)
const bc = st.bondingCurve
const fees = computeFeesBps({ global, feeConfig, mintSupply: bc.tokenTotalSupply, virtualQuoteReserves: bc.virtualQuoteReserves, virtualTokenReserves: bc.virtualTokenReserves, quoteMint: NATIVE_MINT })
console.log('fees bps', Object.fromEntries(Object.entries(fees).map(([k, v]) => [k, v?.toString?.()])), 'curve creatorFeeBps', bc.creatorFeeBps?.toString(), 'quoteMint', bc.quoteMint?.toBase58?.())
const L = BigInt(lam), slip = 300n
const solForMin = (L * 10_000n) / (10_000n + slip)
const minOut = BigInt(getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply: bc.tokenTotalSupply, bondingCurve: bc, amount: new BN(solForMin.toString()), quoteMint: NATIVE_MINT }).toString())
console.log('lamports', L, 'solForMin', solForMin, 'minOut', minOut)
for (const kind of ['v1', 'v2']) {
  try {
    const ixs = kind === 'v1'
      ? await PUMP_SDK.buyInstructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: bc, associatedUserAccountInfo: st.associatedUserAccountInfo, mint: m, user: who, amount: new BN(minOut.toString()), solAmount: new BN(solForMin.toString()), slippage: 3, tokenProgram })
      : await PUMP_SDK.buyV2Instructions({ global, bondingCurveAccountInfo: st.bondingCurveAccountInfo, bondingCurve: bc, associatedUserAccountInfo: st.associatedUserAccountInfo, mint: m, user: who, amount: new BN(minOut.toString()), quoteAmount: new BN(solForMin.toString()), slippage: 3, tokenProgram, quoteTokenProgram: st.quoteTokenProgram })
    const built = await sol.buildTx({ payer: who, instructions: ixs, signers: [], units: 300_000 })
    await sol.simulate(built.tx)
    console.log(kind, 'SIMULATED OK')
  } catch (e) { console.log(kind, 'FAILED', String(e.message).match(/Left: \d+|Right: \d+|Error Code: \w+/g)?.join(' ') || String(e.message).slice(0, 300)) }
}
process.exit(0)
