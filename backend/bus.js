import { EventEmitter } from 'node:events'
import { appendEvent } from './store.js'

// In-process event bus: producers (launch, lock, distribute, round, payout, burn, graduate, trade) record an
// Event (API.md) and the SSE layer (index.js /events) broadcasts it. No external deps.
export const bus = new EventEmitter()
bus.setMaxListeners(0)
/** Record + broadcast one Event. Idempotent per ev.id. Never throws. */
export function emitEvent(ev) {
  try { const rec = appendEvent(ev); if (rec) bus.emit('event', rec); return rec } catch (e) { console.error('[bus] event write failed:', e.message); return null }
}
