/** Decode the site's WOFF cmap using its own Unicode glyph names, never a fixed substitution table. */
export async function shixisengFont(buffer: ArrayBuffer): Promise<Record<string, string>> {
  const file = new DataView(buffer)
  if (file.byteLength > 262144 || file.byteLength < 44 || file.getUint32(0) !== 0x774f4646)
    throw new Error('font_contract_changed')
  const tables = new Map<string, DataView>()
  const count = file.getUint16(12)
  if (count > 64 || 44 + count * 20 > file.byteLength) throw new Error('font_contract_changed')
  for (let i = 0; i < count; i++) {
    const offset = 44 + i * 20
    const name = String.fromCharCode(...new Uint8Array(buffer, offset, 4))
    if (!['cmap', 'post'].includes(name)) continue
    const start = file.getUint32(offset + 4),
      size = file.getUint32(offset + 8),
      length = file.getUint32(offset + 12)
    if (length > 262144 || start + size > file.byteLength) throw new Error('font_contract_changed')
    const bytes = buffer.slice(start, start + size)
    let raw = bytes
    if (size !== length) {
      const reader = new Blob([bytes])
        .stream()
        .pipeThrough(new DecompressionStream('deflate'))
        .getReader()
      const output = new Uint8Array(length)
      let written = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (written + value.length > length) throw new Error('font_contract_changed')
          output.set(value, written)
          written += value.length
        }
      } finally {
        await reader.cancel()
      }
      if (written !== length) throw new Error('font_contract_changed')
      raw = output.buffer
    }
    if (raw.byteLength !== length) throw new Error('font_contract_changed')
    tables.set(name, new DataView(raw))
  }
  const post = tables.get('post'),
    cmap = tables.get('cmap')
  if (!post || !cmap || post.getUint32(0) !== 0x00020000) throw new Error('font_contract_changed')
  const glyphs = post.getUint16(32)
  if (glyphs > 4096) throw new Error('font_contract_changed')
  const names: string[] = []
  for (let p = 34 + glyphs * 2; p < post.byteLength; ) {
    const size = post.getUint8(p++)
    names.push(String.fromCharCode(...new Uint8Array(post.buffer, post.byteOffset + p, size)))
    p += size
  }
  const result: Record<string, string> = {}
  const assign = (code: number, glyph: number) => {
    if (code < 0xe000 || code > 0xf8ff || glyph >= glyphs) return
    const name = names[post.getUint16(34 + glyph * 2) - 258]
    const hex = /^uni([\da-f]{2,6})$/i.exec(name ?? '')?.[1]
    if (!hex) return
    const original = parseInt(hex, 16)
    if (original > 0x10ffff || (original >= 0xe000 && original <= 0xf8ff)) return
    result[String.fromCodePoint(code)] = String.fromCodePoint(original)
  }
  for (let i = 0; i < cmap.getUint16(2); i++) {
    const start = cmap.getUint32(4 + i * 8 + 4)
    const format = cmap.getUint16(start)
    if (format === 4) {
      const segments = cmap.getUint16(start + 6) / 2
      if (segments > 4096) throw new Error('font_contract_changed')
      const ends = start + 14,
        starts = ends + 2 * segments + 2
      const deltas = starts + 2 * segments,
        ranges = deltas + 2 * segments
      for (let n = 0; n < segments; n++) {
        const low = cmap.getUint16(starts + n * 2),
          high = cmap.getUint16(ends + n * 2)
        const delta = cmap.getInt16(deltas + n * 2),
          range = cmap.getUint16(ranges + n * 2)
        for (let code = Math.max(low, 0xe000); code <= Math.min(high, 0xf8ff); code++) {
          const glyph = range ? cmap.getUint16(ranges + n * 2 + range + 2 * (code - low)) : code
          assign(code, range && !glyph ? 0 : (glyph + delta) & 0xffff)
        }
      }
    } else if (format === 12) {
      const groups = cmap.getUint32(start + 12)
      if (groups > 4096) throw new Error('font_contract_changed')
      for (let n = 0; n < groups; n++) {
        const pos = start + 16 + n * 12
        const low = cmap.getUint32(pos),
          high = cmap.getUint32(pos + 4),
          glyph = cmap.getUint32(pos + 8)
        for (let code = Math.max(low, 0xe000); code <= Math.min(high, 0xf8ff); code++)
          assign(code, glyph + code - low)
      }
    }
  }
  if (!Object.keys(result).length) throw new Error('font_contract_changed')
  return result
}
