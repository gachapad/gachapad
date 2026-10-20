// Find live (not complete) pump.fun curves quoted in a token (default USDC) and their mints — for testing the
// token-quoted burn path before a CARDS curve exists. Read-only.
//   node scripts/find-quoted-curve.mjs [quoteMint]
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.env.ENGINE_NO_DOTENV = '1'
const prod = readFileSync(resolve(HERE, '.env.prod'), 'utf-8')
const RPC = /^RPC_URL=(.*)$/m.exec(prod)[1]
process.env.RPC_URL = RPC
const { PublicKey } = await import('@solana/web3.js')
const { bondingCurvePda } = await import('@pump-fun/pump-sdk')
const QUOTE = process.argv[2] || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
const rpc = async (method, params) => { const r = await fetch(RPC, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error)); return j.result }

const res = await rpc('getProgramAccountsV2', [PUMP, { encoding: 'base64', limit: 200, filters: [{ memcmp: { offset: 83, bytes: QUOTE } }] }])
const accts = res.accounts || res
const live = []
for (const a of accts) {
  const d = Buffer.from(a.account.data[0], 'base64')
  if (d[48] === 1) continue // complete
  live.push({ curve: a.pubkey, realQuote: d.readBigUInt64LE(32), vq: d.readBigUInt64LE(16) })
}
console.log(`${accts.length} curves quoted in ${QUOTE}, ${live.length} live`)
live.sort((a, b) => (b.realQuote > a.realQuote ? 1 : -1))
for (const c of live.slice(0, 5)) {
  const sigs = await rpc('getSignaturesForAddress', [c.curve, { limit: 3 }])
  let mint = null
  for (const s of sigs) {
    const tx = await rpc('getTransaction', [s.signature, { maxSupportedTransactionVersion: 0, encoding: 'json' }])
    const keys = [...tx.transaction.message.accountKeys, ...(tx.meta.loadedAddresses?.writable || []), ...(tx.meta.loadedAddresses?.readonly || [])]
    mint = keys.find(k => { try { return bondingCurvePda(new PublicKey(k)).toBase58() === c.curve } catch { return false } })
    if (mint) break
  }
  console.log(`curve ${c.curve} · real quote ${Number(c.realQuote) / 1e6} · mint ${mint}`)
}
