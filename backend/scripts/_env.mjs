// Shared setup for the mainnet DRY RUNS (simulations only — nothing is ever signed with a real key or sent).
// Forces ENGINE_NO_DOTENV=1, a throwaway DATA_DIR and throwaway engine/burn/protocol keys, and picks the RPC:
// RPC_URL from the environment, else backend/.env.prod's RPC_URL (read here, NEVER printed), else the public RPC.
import { Keypair, Connection } from '@solana/web3.js'
import bs58 from 'bs58'
import { mkdtempSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com'

function prodRpc() {
  const f = resolve(HERE, '..', '.env.prod')
  if (!existsSync(f)) return ''
  for (const line of readFileSync(f, 'utf-8').split(/\r?\n/)) { const m = /^\s*RPC_URL\s*=\s*"?([^"\s#]+)"?/.exec(line); if (m) return m[1] }
  return ''
}

/** Pick a working RPC (label only is printed). */
export async function pickRpc() {
  const candidates = [[process.env.RPC_URL, 'RPC_URL from the environment'], [prodRpc(), 'RPC_URL from .env.prod (hidden)'], [PUBLIC_RPC, 'the public mainnet RPC']].filter(([u]) => u)
  for (const [url, label] of candidates) {
    try { await new Connection(url, 'confirmed').getSlot(); return { url, label } } catch {}
  }
  throw new Error('no working RPC')
}

/** Throwaway engine + burn + protocol keys and a temp data dir. Call BEFORE importing any engine module. */
export async function dryEnv(extra = {}) {
  const { url, label } = await pickRpc()
  process.env.ENGINE_NO_DOTENV = '1'
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gachapad-dryrun-'))
  const engine = Keypair.generate(), burn = Keypair.generate(), protocol = Keypair.generate()
  process.env.ENGINE_PRIVATE_KEY = bs58.encode(engine.secretKey)
  process.env.BURN_PRIVATE_KEY = bs58.encode(burn.secretKey)
  process.env.PROTOCOL_WALLET = protocol.publicKey.toBase58()
  process.env.RPC_URL = url
  process.env.SITE_URL = 'https://www.gachapad.tech'
  process.env.PUBLIC_URL = 'https://engine.example.com'
  for (const [k, v] of Object.entries(extra)) process.env[k] = v
  console.log(`[dryrun] RPC: ${label} · throwaway keys · data ${process.env.DATA_DIR} · NOTHING IS SENT`)
  return { engine, burn, protocol, rpcLabel: label }
}
