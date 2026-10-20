import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Background renders live in public/bg (hero.jpg, section.jpg, token.jpg, optional .webp twins).
// The manifest is built at dev/build time so the site never requests a file that is not there
// (no 404s in the console) and gets a cache-busting version from the file's mtime.
function bgManifest() {
  try {
    const dir = join(process.cwd(), 'public', 'bg')
    return Object.fromEntries(
      readdirSync(dir)
        .filter(f => /\.(jpe?g|png|webp|avif)$/i.test(f))
        .map(f => [f, Math.floor(statSync(join(dir, f)).mtimeMs / 1000)]),
    )
  } catch { return {} }
}

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: { port: 5207, strictPort: true },
  define: { __BG_FILES__: JSON.stringify(bgManifest()) },
  build: {
    rollupOptions: {
      output: {
        // web3.js is only needed to sign; keep it out of the first paint.
        manualChunks: id => (id.includes('@solana/web3.js') ? 'web3' : undefined),
      },
    },
  },
})
