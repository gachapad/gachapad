// Mainnet dry probe of one coin's pack machine keys. NOTHING is broadcast. `node scripts/probe-packs.mjs [mint]`
import { Keypair } from '@solana/web3.js'
process.env.ENGINE_NO_DOTENV = '1'
process.env.RPC_URL ||= process.argv[3] || ''
const { config } = await import('../config.js')
const sol = await import('../solana.js')
config.enginePrivateKey = config.enginePrivateKey || (await import('bs58')).default.encode(Keypair.generate().secretKey)
const mint = process.argv[2] || Keypair.generate().publicKey.toBase58()
const { buildPoolSwap, poolOf, vaultOf } = await import('../packs.js')
const { machine, generatePack, usdcAta } = await import('../cc.js')
const ok = (l, v) => console.log(`✓ ${l}${v !== undefined ? `: ${JSON.stringify(v)}` : ''}`)
const fail = (l, e) => { console.log(`✗ ${l}: ${String(e?.message || e).slice(0, 240)}`); process.exitCode = 1 }
ok('keys', { mint, pool: poolOf(mint), vault: vaultOf(mint), vaultUsdc: usdcAta(vaultOf(mint)).toBase58() })
try { const b = await buildPoolSwap(mint, 50_000_000n); ok('pool swap SOL→USDC into the vault passes assertSwapTx', { outUsdc: Number(b.outAmount) / 1e6 }) } catch (e) { fail('pool swap', e) }
try {
  const m = await machine(config.packCode)
  const v = sol.vaultKeyFor(mint)
  const p = await generatePack({ treasury: v.publicKey, code: m.code, priceUsdc: m.priceUsdc, maxUsdc: config.packMaxUsdc })
  p.tx.partialSign(v)
  p.tx.serialize({ requireAllSignatures: true, verifySignatures: true })
  const sim = await sol.getConnection().simulateTransaction(p.tx)
  ok('pack for the vault passes assertPackTx, signatures verify, simulated (NOT sent)', { err: sim.value.err })
} catch (e) { fail('pack', e) }
