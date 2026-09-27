/**
 * Streaming SHA-256 (FIPS 180-4 §6.2), dependency-free so the browser can hash
 * a local file chunk by chunk without uploading it. Any chunk sizes are
 * accepted; whole 64-byte blocks are compressed straight from the caller's
 * bytes, only a partial tail is copied.
 */

/** First 32 bits of the fractional parts of the cube roots of the first 64 primes (§4.2.2). */
const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Initial hash value (§5.3.3). */
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

export interface Sha256 {
  update(bytes: Uint8Array): void;
  /** Lowercase hex digest. Finalizes the hash; later calls return the same value. */
  digest(): string;
}

export function createSha256(): Sha256 {
  const H = new Int32Array(H0);
  const W = new Int32Array(64);
  const tail = new Uint8Array(64);
  let tailLen = 0;
  let total = 0;
  let result: string | null = null;

  const compress = (p: Uint8Array, off: number): void => {
    for (let t = 0, j = off; t < 16; t++, j += 4) {
      W[t] = (p[j]! << 24) | (p[j + 1]! << 16) | (p[j + 2]! << 8) | p[j + 3]!;
    }
    for (let t = 16; t < 64; t++) {
      const x = W[t - 15]!;
      const y = W[t - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) | 0;
    }
    let a = H[0]!;
    let b = H[1]!;
    let c = H[2]!;
    let d = H[3]!;
    let e = H[4]!;
    let f = H[5]!;
    let g = H[6]!;
    let h = H[7]!;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t]! + W[t]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + S0 + maj) | 0;
    }
    H[0] = (H[0]! + a) | 0;
    H[1] = (H[1]! + b) | 0;
    H[2] = (H[2]! + c) | 0;
    H[3] = (H[3]! + d) | 0;
    H[4] = (H[4]! + e) | 0;
    H[5] = (H[5]! + f) | 0;
    H[6] = (H[6]! + g) | 0;
    H[7] = (H[7]! + h) | 0;
  };

  return {
    update(bytes: Uint8Array): void {
      if (result !== null) throw new Error('sha256: update() after digest()');
      total += bytes.length;
      let i = 0;
      if (tailLen > 0) {
        i = Math.min(64 - tailLen, bytes.length);
        tail.set(bytes.subarray(0, i), tailLen);
        tailLen += i;
        if (tailLen < 64) return;
        compress(tail, 0);
        tailLen = 0;
      }
      for (; i + 64 <= bytes.length; i += 64) compress(bytes, i);
      if (i < bytes.length) {
        tail.set(bytes.subarray(i), 0);
        tailLen = bytes.length - i;
      }
    },

    digest(): string {
      if (result !== null) return result;
      // Padding (§5.1.1): 0x80, zeros, then the message length in bits as 64-bit big-endian.
      tail.fill(0, tailLen);
      tail[tailLen] = 0x80;
      if (tailLen >= 56) {
        compress(tail, 0);
        tail.fill(0);
      }
      const hi = Math.floor(total / 0x20000000);
      const lo = (total % 0x20000000) * 8;
      for (let k = 0; k < 4; k++) {
        tail[56 + k] = (hi >>> (24 - 8 * k)) & 0xff;
        tail[60 + k] = (lo >>> (24 - 8 * k)) & 0xff;
      }
      compress(tail, 0);
      let hex = '';
      for (let k = 0; k < 8; k++) hex += (H[k]! >>> 0).toString(16).padStart(8, '0');
      result = hex;
      return hex;
    },
  };
}
