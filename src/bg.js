// Background imagery slots. Files live in public/bg; vite.config.js injects the manifest at build time.
//   hero.jpg     2400×1350  the landing hero
//   section.jpg  2400×1200  subtle texture behind the pairing / fee sections
//   token.jpg    1600×1600  the token page core
// Missing file → null → the CSS gradient + grain fallback renders on its own.
const files = typeof __BG_FILES__ !== 'undefined' ? __BG_FILES__ : {}

function pick(name, ext) {
  const f = Object.keys(files).find(k => k.toLowerCase() === `${name}.${ext}`)
  return f ? `/bg/${f}?v=${files[f]}` : null
}

/** { jpg, webp } for a slot; both null when nothing is shipped. */
export function bgSrc(name) {
  return { jpg: pick(name, 'jpg') || pick(name, 'jpeg') || pick(name, 'png'), webp: pick(name, 'webp') || pick(name, 'avif') }
}
export const hasBg = name => { const s = bgSrc(name); return !!(s.jpg || s.webp) }
