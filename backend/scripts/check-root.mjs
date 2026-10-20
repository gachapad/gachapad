// Read-only: a ROOT candidate's pump curve (quote, creator, progress) + metadata.
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
const HERE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.env.ENGINE_NO_DOTENV = '1'
process.env.RPC_URL = /^RPC_URL=(.*)$/m.exec(readFileSync(resolve(HERE, '.env.prod'), 'utf-8'))[1]
const { readCurves } = await import('../pump.js')
const { getConnection, pk } = await import('../solana.js')
const { getTokenMetadata, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token')
const mint = process.argv[2]
const f = (await readCurves([mint])).get(mint)
console.log(JSON.stringify(f, null, 1))
const md = await getTokenMetadata(getConnection(), pk(mint), 'confirmed', TOKEN_2022_PROGRAM_ID).catch(e => String(e))
console.log('name', md?.name, 'symbol', md?.symbol, 'uri', md?.uri)
process.exit(0)
