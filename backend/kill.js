// The kill switch: a file (DATA_DIR/KILL) or the persisted flag. Every money loop checks it RIGHT BEFORE every
// send (not only at loop start); a send already broadcast finishes its settle (a journal is never left half done),
// nothing new starts. No clean shutdown needed: `touch data/KILL` works even when the HTTP server is wedged.
import { existsSync, writeFileSync, unlinkSync } from 'fs'
import { config } from './config.js'
import { readState, patchState, ensureDir } from './store.js'

export const isKilled = () => existsSync(config.killFile) || !!readState().killed
export function kill(reason = 'admin') { ensureDir(); writeFileSync(config.killFile, `${new Date().toISOString()} ${reason}\n`); patchState({ killed: true, killedAt: Date.now(), killReason: reason }) }
export function unkill() { try { unlinkSync(config.killFile) } catch {} patchState({ killed: false, unkilledAt: Date.now() }) }
