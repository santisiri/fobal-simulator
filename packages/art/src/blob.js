// The blob format — the byte contract between the JS reference renderer and
// the Solidity composer. Both sides read THESE bytes; agreement is proven by
// the parity harness rather than assumed.
//
// One blob holds one class (all its parts), laid out for cheap EXTCODECOPY
// slicing from SSTORE2 storage:
//
//   [0]                    version (0x01)
//   [1]                    partCount N (uint8, <= 255)
//   [2 .. 2+2N)            uint16 BE offset of each part, from blob start
//   [...]                  parts, each: [rectCount:uint8][rect x 5 bytes]
//   rect                   [x+BIAS][y+BIAS][w][h][paletteSlot]
//
// Coordinates are biased because parts legitimately draw outside the 32x32
// frame — an afro starts above the canvas and a long hairstyle runs past the
// shoulder line. BIAS keeps every stored coordinate an unsigned byte, which
// is what makes the Solidity decode a shift rather than a branch.
export const BLOB_VERSION = 1;
export const BIAS = 32;

export function encodeClass(parts) {
  const bodies = parts.map((part) => {
    const rects = part.rects ?? [];
    if (rects.length > 255) throw new Error(`part ${part.name}: ${rects.length} rects exceeds 255`);
    const buf = [rects.length];
    for (const [x, y, w, h, slot] of rects) {
      const sx = x + BIAS, sy = y + BIAS;
      if (sx < 0 || sx > 255 || sy < 0 || sy > 255)
        throw new Error(`part ${part.name}: coordinate (${x},${y}) outside the biased byte range`);
      if (w < 1 || w > 255 || h < 1 || h > 255)
        throw new Error(`part ${part.name}: size ${w}x${h} outside 1..255`);
      if (slot < 0 || slot > 15) throw new Error(`part ${part.name}: palette slot ${slot} outside 0..15`);
      buf.push(sx, sy, w, h, slot);
    }
    return Uint8Array.from(buf);
  });

  const n = bodies.length;
  const headerLen = 2 + 2 * n;
  const offsets = [];
  let cursor = headerLen;
  for (const b of bodies) { offsets.push(cursor); cursor += b.length; }

  const out = new Uint8Array(cursor);
  out[0] = BLOB_VERSION;
  out[1] = n;
  offsets.forEach((off, i) => {
    if (off > 0xffff) throw new Error('blob exceeds uint16 offset space');
    out[2 + i * 2] = (off >> 8) & 0xff;
    out[3 + i * 2] = off & 0xff;
  });
  bodies.forEach((b, i) => out.set(b, offsets[i]));
  return out;
}

export function partCount(blob) {
  if (blob[0] !== BLOB_VERSION) throw new Error(`unknown blob version ${blob[0]}`);
  return blob[1];
}

/** Decode one part back to the rect list the renderer consumes. Mirrors the
 *  Solidity read exactly: header lookup, then a fixed-stride walk. */
export function decodePart(blob, index) {
  const n = partCount(blob);
  if (index >= n) throw new Error(`part ${index} out of range (${n})`);
  const off = (blob[2 + index * 2] << 8) | blob[3 + index * 2];
  const count = blob[off];
  const rects = [];
  for (let i = 0; i < count; i++) {
    const p = off + 1 + i * 5;
    rects.push([blob[p] - BIAS, blob[p + 1] - BIAS, blob[p + 2], blob[p + 3], blob[p + 4]]);
  }
  return rects;
}

export const toHex = (bytes) => '0x' + [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
