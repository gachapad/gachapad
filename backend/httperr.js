// HTTP errors meant for the caller, and the ONE error handler that turns any thrown error into a JSON answer.
//
// Only an error built by http() here (tagged `expose: true`, an integer 400-599 `code`) sets the response status and
// shows its message. A library error that merely CARRIES an integer `code` — a web3.js SolanaJSONRPCError (-32005,
// "node is behind"), a fetch timeout's DOMException (TimeoutError, code 23) — is an internal failure: a JSON 500
// whose cause is logged for the operator (never `res.status(23)`, which throws inside Express and answers with an
// HTML page while the cause is lost).

/** An error whose message and status (400-599) are meant for the caller. `extra`: e.g. { retryAfter } (seconds). */
export const http = (message, code = 400, extra = {}) => Object.assign(new Error(message), { code, expose: true, ...extra })
/** Was this built by http()? (a status we chose and a message written for the caller) */
export const isHttp = e => !!e && e.expose === true && Number.isInteger(e.code) && e.code >= 400 && e.code <= 599
const httpStatus = s => (Number.isInteger(s) && s >= 400 && s <= 599 ? s : null)

/**
 * Express error handler. Our http() errors → their status + message (+ Retry-After). body-parser / Express errors carry
 * their own `status` (413, 400 …) and a message meant for the caller. Anything else → 500 'internal error', logged.
 * `bigBody`: the routes whose body limit is 6 MB (the 413 message names the image limit there).
 */
export function errorHandler({ bigBody = new Set(), log = console.error } = {}) {
  return (err, req, res, next) => { // eslint-disable-line no-unused-vars
    const ours = isHttp(err)
    const status = ours ? err.code : httpStatus(err?.status) || httpStatus(err?.statusCode) || 500
    if (status >= 500 && !ours) log('[http]', req.method, req.path, err?.stack || err?.message || String(err))
    if (res.headersSent) return res.destroy()
    const msg = err?.type === 'entity.too.large' ? (bigBody.has(req.path) ? 'request too large (image max 4 MB)' : 'request too large') : err?.type === 'entity.parse.failed' ? 'invalid JSON body' : ours || status < 500 ? String(err?.message || 'error') : 'internal error'
    if (ours && err.retryAfter) res.set('retry-after', String(err.retryAfter))
    res.status(status).json({ error: msg })
  }
}
