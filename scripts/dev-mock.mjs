// Starts Vite with the in-browser mock engine on. Works on Windows too (no shell env syntax).
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const vite = join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const port = process.env.PORT || '5198'
const child = spawn(process.execPath, [vite, '--port', port, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_MOCK: '1', VITE_API_URL: '' },
})
child.on('exit', code => process.exit(code ?? 0))
