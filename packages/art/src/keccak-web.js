// Keccak-256, standalone, for the browser.
//
// The web preview must derive traits exactly as the chain does, and the chain
// uses keccak. apps/web ships as plain ES modules with no bundler, so it
// cannot import @noble/hashes — hence this. It is asserted byte-identical to
// @noble/hashes over random inputs in packages/art/test/keccak.test.ts; if it
// ever drifts, the preview silently shows different players than it mints,
// which is precisely the class of bug this phase exists to remove.
const RC = [
  0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000,
  0x80008000, 0x80000000, 0x0000808b, 0x00000000, 0x80000001, 0x00000000,
  0x80008081, 0x80000000, 0x00008009, 0x80000000, 0x0000008a, 0x00000000,
  0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
  0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000,
  0x00008003, 0x80000000, 0x00008002, 0x80000000, 0x00000080, 0x80000000,
  0x0000800a, 0x00000000, 0x8000000a, 0x80000000, 0x80008081, 0x80000000,
  0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000,
];
// Rho offsets IN PI-WALK ORDER: r(t) = (t+1)(t+2)/2 mod 64. The familiar
// [0,1,62,28,...] table is indexed by LANE POSITION instead, and silently
// produces a wrong-but-plausible permutation if used with the pi walk.
const ROT = Array.from({ length: 24 }, (_, t) => (((t + 1) * (t + 2)) / 2) % 64);

function keccakF(s) {
  const B = new Uint32Array(50);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      let lo = 0, hi = 0;
      for (let y = 0; y < 5; y++) { lo ^= s[2 * (x + 5 * y)]; hi ^= s[2 * (x + 5 * y) + 1]; }
      B[2 * x] = lo; B[2 * x + 1] = hi;
    }
    for (let x = 0; x < 5; x++) {
      const nx = (x + 1) % 5, px = (x + 4) % 5;
      const rl = (B[2 * nx] << 1) | (B[2 * nx + 1] >>> 31);
      const rh = (B[2 * nx + 1] << 1) | (B[2 * nx] >>> 31);
      const dl = B[2 * px] ^ rl, dh = B[2 * px + 1] ^ rh;
      for (let y = 0; y < 5; y++) { s[2 * (x + 5 * y)] ^= dl; s[2 * (x + 5 * y) + 1] ^= dh; }
    }
    // rho + pi
    let lastLo = s[2], lastHi = s[3];   // lane 1
    for (let i = 0; i < 24; i++) {
      const j = PI[i], r = ROT[i];
      const tl = s[2 * j], th = s[2 * j + 1];
      let nl, nh;
      if (r < 32) {
        nl = (lastLo << r) | (lastHi >>> (32 - r));
        nh = (lastHi << r) | (lastLo >>> (32 - r));
      } else if (r === 32) { nl = lastHi; nh = lastLo; }
      else {
        const k = r - 32;
        nl = (lastHi << k) | (lastLo >>> (32 - k));
        nh = (lastLo << k) | (lastHi >>> (32 - k));
      }
      s[2 * j] = nl >>> 0; s[2 * j + 1] = nh >>> 0;
      lastLo = tl; lastHi = th;
    }
    // chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) { B[2 * x] = s[2 * (x + 5 * y)]; B[2 * x + 1] = s[2 * (x + 5 * y) + 1]; }
      for (let x = 0; x < 5; x++) {
        s[2 * (x + 5 * y)] ^= ~B[2 * ((x + 1) % 5)] & B[2 * ((x + 2) % 5)];
        s[2 * (x + 5 * y) + 1] ^= ~B[2 * ((x + 1) % 5) + 1] & B[2 * ((x + 2) % 5) + 1];
      }
    }
    // iota
    s[0] ^= RC[2 * round]; s[1] ^= RC[2 * round + 1];
  }
}
const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

/** @param {Uint8Array} msg @returns {Uint8Array} 32 bytes */
export function keccak256(msg) {
  const RATE = 136;
  const s = new Uint32Array(50);
  const padded = new Uint8Array(Math.ceil((msg.length + 1) / RATE) * RATE);
  padded.set(msg);
  padded[msg.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      const b = off + i * 8;
      s[2 * i] ^= padded[b] | (padded[b + 1] << 8) | (padded[b + 2] << 16) | (padded[b + 3] << 24);
      s[2 * i + 1] ^= padded[b + 4] | (padded[b + 5] << 8) | (padded[b + 6] << 16) | (padded[b + 7] << 24);
    }
    keccakF(s);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    const lo = s[2 * i], hi = s[2 * i + 1];
    for (let k = 0; k < 4; k++) out[i * 8 + k] = (lo >>> (8 * k)) & 0xff;
    for (let k = 0; k < 4; k++) out[i * 8 + 4 + k] = (hi >>> (8 * k)) & 0xff;
  }
  return out;
}
