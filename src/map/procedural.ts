// Procedural worlds: warped continents + archipelagos, ridged-noise mountain chains, blue-noise nation seeds.
import { HILLS, MOUNTAIN, PLAINS, WATER, type MapData, type NationSeed } from '../sim/types';
import { ValueNoise, mulberry32, quantile } from './noise';
import { components, distanceInside, fillSmallWater, removeSmallLand } from './raster';

export interface ProceduralOptions { width?: number; height?: number }

const MARGIN = 7;

interface Blob { x: number; y: number; rx: number; ry: number; cos: number; sin: number; amp: number }

/** Mix seed and attempt into a new 32-bit seed. */
function mix(a: number, b: number): number {
  let h = (a ^ Math.imul(b + 0x7f4a7c15, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

interface Shape { terrain: Uint8Array; score: number; ok: boolean }

function shapeLand(seed: number, W: number, H: number): Shape {
  const rng = mulberry32(seed);
  const N = W * H;
  const S = Math.min(W, H); // size reference
  const warpN = new ValueNoise(seed + 1), detailN = new ValueNoise(seed + 2), ridgeN = new ValueNoise(seed + 3), maskN = new ValueNoise(seed + 4);

  // ── continents: 3–5 big ellipses spread with a minimum spacing
  const blobs: Blob[] = [];
  const nCont = 3 + ((rng() * 3) | 0);
  const centres: [number, number][] = [];
  for (let tries = 0; centres.length < nCont && tries < 500; tries++) {
    const x = W * (0.14 + 0.72 * rng()), y = H * (0.2 + 0.6 * rng());
    const minD = S * (tries < 300 ? 0.5 : 0.36);
    if (centres.every(([cx, cy]) => Math.hypot(cx - x, cy - y) > minD)) centres.push([x, y]);
  }
  for (const [x, y] of centres) {
    const r = S * (0.17 + 0.11 * rng());
    const e = 0.6 + 0.6 * rng();
    const a = rng() * Math.PI;
    blobs.push({ x, y, rx: r * Math.sqrt(1 / e) * 1.15, ry: r * Math.sqrt(e), cos: Math.cos(a), sin: Math.sin(a), amp: 1 });
    // satellite lobes make the outline less elliptical
    const lobes = 2 + ((rng() * 4) | 0);
    for (let k = 0; k < lobes; k++) {
      const ang = rng() * Math.PI * 2, dist = r * (0.55 + 0.4 * rng());
      const rr = r * (0.35 + 0.3 * rng()), b = rng() * Math.PI;
      blobs.push({ x: x + Math.cos(ang) * dist, y: y + Math.sin(ang) * dist, rx: rr * 1.3, ry: rr * 0.8, cos: Math.cos(b), sin: Math.sin(b), amp: 0.9 });
    }
  }
  // ── archipelagos: clusters of small islands
  const nArch = 4 + ((rng() * 5) | 0);
  for (let a = 0; a < nArch; a++) {
    const cx = W * (0.08 + 0.84 * rng()), cy = H * (0.1 + 0.8 * rng());
    const spread = S * (0.06 + 0.08 * rng());
    const isl = 4 + ((rng() * 8) | 0);
    for (let k = 0; k < isl; k++) {
      const rr = S * (0.018 + 0.035 * rng()), b = rng() * Math.PI;
      blobs.push({
        x: cx + (rng() * 2 - 1) * spread * 1.5, y: cy + (rng() * 2 - 1) * spread,
        rx: rr * 1.4, ry: rr, cos: Math.cos(b), sin: Math.sin(b), amp: 1,
      });
    }
  }

  // ── height field: max of blob falloffs, domain-warped, plus fBm detail
  const field = new Float32Array(N);
  const warpAmp = S * 0.11;
  const ws = 1 / (S * 0.22), ds = 1 / (S * 0.11);
  const band = S * 0.07;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const qx = warpN.fbm(x * ws, y * ws, 4), qy = warpN.fbm(x * ws + 5.2, y * ws + 1.3, 4);
      const wx = x + warpAmp * qx * 2, wy = y + warpAmp * qy * 2;
      let base = -0.6;
      for (let b = 0; b < blobs.length; b++) {
        const B = blobs[b];
        const dx = wx - B.x, dy = wy - B.y;
        const reach = (B.rx > B.ry ? B.rx : B.ry) * 1.8;
        if (dx > reach || dx < -reach || dy > reach || dy < -reach) continue;
        const u = (dx * B.cos + dy * B.sin) / B.rx, v = (-dx * B.sin + dy * B.cos) / B.ry;
        const val = B.amp * (1 - Math.sqrt(u * u + v * v));
        if (val > base) base = val;
      }
      let f = base + 0.42 * detailN.fbm(wx * ds, wy * ds, 5, 2, 0.55) + 0.14 * detailN.fbm(x / 7 + 77, y / 7, 3);
      const edge = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (edge < band) f -= (1 - edge / band) * 1.2;
      field[y * W + x] = f;
    }
  }

  const landFrac = 0.33 + 0.05 * rng();
  const thr = quantile(field, 1 - landFrac, null);
  const terrain = new Uint8Array(N);
  for (let y = MARGIN; y < H - MARGIN; y++) for (let x = MARGIN; x < W - MARGIN; x++) {
    const i = y * W + x;
    if (field[i] >= thr) terrain[i] = PLAINS;
  }
  removeSmallLand(terrain, W, H, 6);
  fillSmallWater(terrain, W, H, 4);

  // ── relief: ridged noise chains, stronger inland and in "orogenic" zones
  const coast = distanceInside(W, H, i => terrain[i] !== WATER);
  const elev = new Float32Array(N);
  const land = new Uint8Array(N);
  const rs = 1 / (S * 0.16), ms = 1 / (S * 0.3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (terrain[i] === WATER) continue;
    land[i] = 1;
    // crest lines where a smooth fBm crosses zero → long thin chains
    const n = ridgeN.fbm(x * rs, y * rs, 4, 2, 0.45);
    const c = 1 - Math.abs(n) * 2.2;
    const crest = c > 0 ? c * c * c * c : 0;
    let m = maskN.fbm(x * ms, y * ms, 3) * 0.9 + 0.5; // which chains are tall
    m = m < 0 ? 0 : m > 1 ? 1 : m;
    const inland = Math.min(1, coast[i] / 25);
    const rough = detailN.fbm(x / 10 + 31, y / 10, 3);
    elev[i] = crest * (0.15 + 0.85 * m) * (0.6 + 0.4 * inland) * (0.8 + 0.4 * rough) + 0.025 * rough;
  }
  const tMount = quantile(elev, 1 - 0.065, land);
  const tHill = quantile(elev, 1 - 0.065 - 0.15, land);
  let landN = 0;
  for (let i = 0; i < N; i++) {
    if (!land[i]) continue;
    landN++;
    terrain[i] = elev[i] >= tMount ? MOUNTAIN : elev[i] >= tHill ? HILLS : PLAINS;
  }

  // ── playability check
  const { sizes } = components(W, H, i => terrain[i] !== WATER);
  const masses = sizes.slice(1).sort((a, b) => b - a);
  const share = (k: number) => (masses[k] ?? 0) / landN;
  const top4 = share(0) + share(1) + share(2) + share(3);
  const frac = landN / N;
  const ok = share(1) >= 0.12 && share(0) <= 0.62 && top4 >= 0.75 && frac >= 0.3 && frac <= 0.4;
  // fallback score if no attempt passes: prefer two big balanced continents
  const score = Math.min(share(1), 0.25) * 4 + Math.min(top4, 0.85) - Math.max(0, share(0) - 0.6) * 2;
  return { terrain, score, ok };
}

// ── names ───────────────────────────────────────────────────────────────────
const PRE = ['Val', 'Mont', 'Castel', 'Roc', 'Pian', 'Borg', 'Fior', 'Ser', 'Lun', 'Cal', 'Bel', 'Ar', 'Tor', 'Mar', 'Ves',
  'Cor', 'Sal', 'Alt', 'Brun', 'Dor', 'Gal', 'Lev', 'Nov', 'Ost', 'Pal', 'Rav', 'Sol', 'Ter', 'Ul', 'Ven', 'Zar', 'Camp',
  'Mir', 'Fal', 'Ner', 'Or', 'Pell', 'Tren', 'Vol', 'Ard', 'Cel', 'Lam', 'Mag', 'Ped', 'Sab', 'Tav', 'Bram', 'Cast', 'Fer',
  'Gran', 'Lor', 'Mel', 'Por', 'Riv', 'Sil', 'Tar', 'Vel', 'Ald', 'Bor', 'Cin', 'Fen', 'Ian', 'Lig', 'Mod', 'Pis', 'Sen'];
const MID = ['', '', '', 'a', 'e', 'i', 'o', 'an', 'er', 'ol', 'ar', 'en', 'is', 'or', 'ad', 'ic', 'ev', 'al'];
const SUF = ['ia', 'ona', 'enza', 'aglia', 'ano', 'ena', 'ora', 'esia', 'ina', 'etta', 'ura', 'ante', 'ezia', 'oria', 'avia',
  'era', 'enna', 'iana', 'olo', 'ezzo', 'asca', 'ago', 'ello', 'ida', 'ombra', 'unia', 'ara', 'egna', 'isia', 'occa'];
const TITLES = ['Regno di ', 'Ducato di ', 'Marca di ', 'Contea di ', 'Principato di ', 'Repubblica di ', 'Granducato di '];

function makeName(rng: () => number, used: Set<string>): string {
  for (let tries = 0; tries < 200; tries++) {
    const p = PRE[(rng() * PRE.length) | 0];
    let m = MID[(rng() * MID.length) | 0];
    let s = SUF[(rng() * SUF.length) | 0];
    const vowel = (c: string) => 'aeiou'.includes(c);
    if (m && vowel(m[0]) && vowel(p[p.length - 1])) m = m.slice(1);
    const stem = p + m;
    if (vowel(stem[stem.length - 1]) && vowel(s[0])) s = s.slice(1);
    if (!vowel(stem[stem.length - 1]) && !vowel(s[0]) && stem[stem.length - 1] !== s[0]) s = 'a' + s;
    let name = stem + s;
    if (name.length > 12 || name.length < 5) continue;
    if (rng() < 0.12) name = TITLES[(rng() * TITLES.length) | 0] + name;
    if (used.has(name)) continue;
    used.add(name);
    return name;
  }
  const fallback = `Terra ${used.size + 1}`;
  used.add(fallback);
  return fallback;
}

function placeSeeds(terrain: Uint8Array, W: number, H: number, rng: () => number): NationSeed[] {
  const coast = distanceInside(W, H, i => terrain[i] !== WATER);
  const inner: number[] = [], all: number[] = [];
  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i] === WATER) continue;
    all.push(i);
    if (coast[i] >= 4 && terrain[i] !== MOUNTAIN) inner.push(i);
  }
  const TARGET = 140, MIN_D = 28, K = 24;
  const pool = inner.length > 2000 ? inner : all;
  const xs: number[] = [], ys: number[] = [];
  const nearest2 = (x: number, y: number) => {
    let best = Infinity;
    for (let k = 0; k < xs.length; k++) {
      const d = (xs[k] - x) ** 2 + (ys[k] - y) ** 2;
      if (d < best) best = d;
    }
    return best;
  };
  let misses = 0;
  while (xs.length < TARGET && misses < 40) {
    // Mitchell's best candidate: take the candidate farthest from all existing seeds
    let bx = -1, by = -1, bd = -1;
    for (let c = 0; c < K; c++) {
      const i = pool[(rng() * pool.length) | 0];
      const x = i % W, y = (i / W) | 0;
      const d = nearest2(x, y);
      if (d > bd) { bd = d; bx = x; by = y; }
    }
    if (bd < MIN_D * MIN_D) { misses++; continue; }
    xs.push(bx); ys.push(by);
  }
  const used = new Set<string>();
  return xs.map((x, k) => ({ name: makeName(rng, used), x, y: ys[k], strength: Math.round((0.3 + 0.7 * rng()) * 1000) / 1000 }));
}

export function generateMap(seed: number, opts: ProceduralOptions = {}): MapData {
  const W = Math.max(200, Math.round(opts.width ?? 1400));
  const H = Math.max(150, Math.round(opts.height ?? 800));
  const s0 = seed >>> 0;
  let best: Shape | null = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    const sh = shapeLand(mix(s0, attempt), W, H);
    if (!best || sh.score > best.score) best = sh;
    if (sh.ok) { best = sh; break; }
  }
  const terrain = best!.terrain;
  const nations = placeSeeds(terrain, W, H, mulberry32(mix(s0, 0xabcdef)));
  return { name: `Mondo casuale #${seed}`, width: W, height: H, terrain, nations };
}
