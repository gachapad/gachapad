// Freeze-at-purchase rules (packs.freezeRoundFor) against a throwaway data dir. `node test-freeze.mjs`.
import assert from 'assert'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
process.env.ENGINE_NO_DOTENV = '1'
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'gachapad-freeze-'))
const { config } = await import('./config.js')
const packs = await import('./packs.js')
let n = 0
const test = (name, fn) => { try { fn(); n++; console.log(`  ✓ ${name}`) } catch (e) { console.error(`  ✗ ${name}\n    ${e.stack}`); process.exitCode = 1 } }
const M1 = 'So11111111111111111111111111111111111111112', M2 = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const W = ['4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM']
const fill = (mint, samples, amounts) => packs.roundStore(mint).set({ id: 7, startedAt: Date.now(), samples, lastSampleAt: Date.now(), sums: Object.fromEntries(W.map((w, i) => [w, String(BigInt(amounts[i]) * 1_000_000n * BigInt(samples))])) })
console.log('freeze at purchase')
test('too few readings → no freeze, round untouched', () => {
  fill(M1, config.minRoundSamples - 1, [500_000, 200_000])
  assert.strictEqual(packs.freezeRoundFor('p1', M1), null)
  assert.strictEqual(packs.roundStore(M1).get().id, 7)
})
test('nobody above the minimum → no freeze', () => {
  fill(M1, 5, [10, 20])
  assert.strictEqual(packs.freezeRoundFor('p1', M1), null)
})
test('freezes the entries, writes the draw file, resets the round', () => {
  fill(M1, 5, [500_000, 200_000])
  const f = packs.freezeRoundFor('p1', M1)
  assert.ok(f && f.entrants === 2 && f.roundId === 7)
  assert.strictEqual(packs.readDrawEntries('p1').mint, M1)
  const r = packs.roundStore(M1).get()
  assert.ok(r.id === 8 && r.samples === 0)
})
test('the same id + mint reuses the file (idempotent)', () => {
  const f = packs.freezeRoundFor('p1', M1)
  assert.strictEqual(f.hash, packs.readDrawEntries('p1').hash)
  assert.strictEqual(packs.roundStore(M1).get().id, 8)
})
test('crash between file and reset: the reuse resets the round', () => {
  fill(M1, 5, [500_000, 200_000]) // round id 7 again, as if the reset never happened
  packs.freezeRoundFor('p1', M1)
  assert.strictEqual(packs.roundStore(M1).get().id, 8)
})
test('a file for ANOTHER mint under the same id is never used', () => {
  fill(M2, 4, [300_000, 400_000])
  const f = packs.freezeRoundFor('p1', M2)
  assert.ok(f && f.roundId === 7)
  assert.strictEqual(packs.readDrawEntries('p1').mint, M2)
})
console.log(`\n${n} passed${process.exitCode ? ', some FAILED' : ''}`)
