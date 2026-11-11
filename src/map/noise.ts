// Seeded value noise + fBm helpers. Pure TS, deterministic, no Math.random.
import { mulberry32 } from '../sim/game';

export { mulberry32 };

/** 2D value noise on a hashed lattice, smoothstep interpolation, output in [-1, 1]. */
export class ValueNoise {
  private perm: Uint16Array;
  private vals: Float32Array;

  constructor(seed: number) {
    const rng = mulberry32(seed ^ 0x9e3779b9);
    const p = new Uint16Array(512);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    for (let i = 0; i < 256; i++) p[i + 256] = p[i];
    this.perm = p;
    this.vals = new Float32Array(256);
    for (let i = 0; i < 256; i++) this.vals[i] = rng() * 2 - 1;
  }

  noise(x: number, y: number): number {
    const xf = Math.floor(x), yf = Math.floor(y);
    const xi = xf & 255, yi = yf & 255;
    const tx = x - xf, ty = y - yf;
    const u = tx * tx * (3 - 2 * tx), v = ty * ty * (3 - 2 * ty);
    const p = this.perm, vl = this.vals;
    const a = p[xi] + yi, b = p[xi + 1] + yi;
    const v00 = vl[p[a]], v01 = vl[p[a + 1]], v10 = vl[p[b]], v11 = vl[p[b + 1]];
    const x0 = v00 + (v10 - v00) * u;
    const x1 = v01 + (v11 - v01) * u;
    return x0 + (x1 - x0) * v;
  }

  /** Fractal sum, roughly in [-1, 1]. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let sum = 0, amp = 1, norm = 0, f = 1;
    for (let o = 0; o < octaves; o++) {
      // offset each octave to break lattice alignment
      sum += amp * this.noise(x * f + o * 17.31, y * f - o * 9.77);
      norm += amp; amp *= gain; f *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0, 1]: sharp crests where the base noise crosses zero. */
  ridged(x: number, y: number, octaves: number): number {
    let sum = 0, amp = 1, norm = 0, f = 1, w = 1;
    for (let o = 0; o < octaves; o++) {
      let r = 1 - Math.abs(this.noise(x * f + o * 31.7, y * f + o * 12.3));
      r *= r;
      r *= w;
      w = Math.min(1, r * 1.6);
      sum += r * amp; norm += amp; amp *= 0.5; f *= 2.03;
    }
    return sum / norm;
  }
}

/** Value at the given quantile (0..1) of the values selected by mask (mask null = all). */
export function quantile(values: Float32Array, q: number, mask: Uint8Array | null): number {
  let lo = Infinity, hi = -Infinity, n = 0;
  for (let i = 0; i < values.length; i++) {
    if (mask && !mask[i]) continue;
    const v = values[i];
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    n++;
  }
  if (n === 0 || hi <= lo) return lo;
  const BINS = 8192;
  const hist = new Uint32Array(BINS);
  const scale = (BINS - 1) / (hi - lo);
  for (let i = 0; i < values.length; i++) {
    if (mask && !mask[i]) continue;
    hist[((values[i] - lo) * scale) | 0]++;
  }
  const target = q * n;
  let acc = 0;
  for (let b = 0; b < BINS; b++) {
    acc += hist[b];
    if (acc >= target) return lo + (b + 1) / scale;
  }
  return hi;
}
