// Boot the engine for site development: .env.dev (else .env.dev.example), DATA_DIR data-dev, offline (no chain, no
// keys), seeded with ROOT + coins, machines, cards, pulls and events.
//   node scripts/dev-engine.mjs            → http://localhost:3071
//   node scripts/dev-engine.mjs --reset    → wipe data-dev first (fresh seed)
import { rmSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
process.env.ENGINE_ENV_FILE = existsSync(resolve(root, '.env.dev')) ? '.env.dev' : '.env.dev.example'
if (process.argv.includes('--reset') && existsSync(resolve(root, 'data-dev'))) { rmSync(resolve(root, 'data-dev'), { recursive: true, force: true }); console.log('[dev] data-dev wiped') }
await import('../index.js')
