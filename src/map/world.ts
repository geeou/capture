// Real-world map: Natural Earth countries (world-atlas 50m) → Miller projection → scanline raster.
import { feature } from 'topojson-client';
import { HILLS, MOUNTAIN, PLAINS, WATER, type MapData, type NationSeed } from '../sim/types';
import { ValueNoise, quantile } from './noise';
import { fillRings, fillSmallWater, line4, removeSmallLand } from './raster';
import { ITALIAN_NAMES, LAKES, RANGES, STRAITS } from './worldData';

export const WORLD_W = 1600;
/** Latitude crop: north tip of Greenland .. just below Cape Horn (Antarctica dropped). */
const LAT_N = 83.7;
const LAT_S = -56.2;
const DEG = Math.PI / 180;

/** Miller cylindrical: y = 1.25·ln(tan(π/4 + 0.4φ)). */
const millerY = (latDeg: number) => 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * latDeg * DEG));
const millerLat = (y: number) => (2.5 * Math.atan(Math.exp(0.8 * y)) - 0.625 * Math.PI) / DEG;

const Y_N = millerY(LAT_N);
const Y_S = millerY(LAT_S);
export const WORLD_H = Math.round(WORLD_W * (Y_N - Y_S) / (2 * Math.PI));

/** Project lon/lat (degrees) to pixel coordinates (continuous; pixel centre = integer + 0.5). */
export function projectWorld(lon: number, lat: number): [number, number] {
  return [(lon + 180) / 360 * WORLD_W, (Y_N - millerY(lat)) / (2 * Math.PI) * WORLD_W];
}

/** Inverse projection of a pixel centre. */
export function unprojectWorld(px: number, py: number): [number, number] {
  return [px / WORLD_W * 360 - 180, millerLat(Y_N - py / WORLD_W * 2 * Math.PI)];
}

type Ring = [number, number][];

/** Project rings; lons are unwrapped so a ring crossing the antimeridian stays continuous. */
function projectRings(rings: Ring[], lonShift = 0): number[][] {
  return rings.map(r => {
    const out = new Array<number>(r.length * 2);
    let prev = r.length ? r[0][0] : 0;
    for (let k = 0; k < r.length; k++) {
      let lon = r[k][0];
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
      prev = lon;
      const [x, y] = projectWorld(lon + lonShift, Math.max(-89.9, Math.min(89.9, r[k][1])));
      out[2 * k] = x; out[2 * k + 1] = y;
    }
    return out;
  });
}

/** Rasterize a polygon (outer + holes), also wrapped copies when it spills past ±180°. */
function fillPolygon(poly: Ring[], W: number, H: number, plot: (y: number, x0: number, x1: number) => void): void {
  const base = projectRings(poly);
  let minX = Infinity, maxX = -Infinity;
  for (const r of base) for (let k = 0; k < r.length; k += 2) { if (r[k] < minX) minX = r[k]; if (r[k] > maxX) maxX = r[k]; }
  fillRings(base, W, H, plot);
  if (maxX > W) fillRings(projectRings(poly, -360), W, H, plot);
  if (minX < 0) fillRings(projectRings(poly, 360), W, H, plot);
}

let cached: Promise<MapData> | null = null;

export function loadWorldMap(): Promise<MapData> {
  if (!cached) cached = buildWorld();
  // hand out a fresh terrain copy each time (the game may mutate its own copy)
  return cached.then(m => ({ ...m, terrain: m.terrain.slice(), nations: m.nations.map(n => ({ ...n })) }));
}

async function buildWorld(): Promise<MapData> {
  const mod: any = await import('world-atlas/countries-50m.json');
  const topo: any = mod.default ?? mod;
  const fc: any = feature(topo, topo.objects.countries);
  const W = WORLD_W, H = WORLD_H, N = W * H;

  // ── 1. rasterize countries (cid = index+1 into `countries`)
  const cid = new Int16Array(N);
  const countries: string[] = [];
  for (const f of fc.features) {
    const name: string = f.properties?.name ?? '';
    const g = f.geometry;
    if (!g || name === 'Antarctica') continue;
    const polys: Ring[][] = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    countries.push(name);
    const id = countries.length;
    for (const poly of polys) {
      fillPolygon(poly, W, H, (y, x0, x1) => { cid.fill(id, y * W + x0, y * W + x1 + 1); });
    }
  }
  const terrain = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (cid[i]) terrain[i] = PLAINS;

  // ── 2. big lakes, then straits
  for (const lake of LAKES) {
    fillPolygon([lake], W, H, (y, x0, x1) => {
      for (let x = x0; x <= x1; x++) { terrain[y * W + x] = WATER; cid[y * W + x] = 0; }
    });
  }
  const strait = new Uint8Array(N);
  for (const s of STRAITS) {
    for (let k = 0; k + 1 < s.pts.length; k++) {
      const [ax, ay] = projectWorld(s.pts[k][0], s.pts[k][1]);
      const [bx, by] = projectWorld(s.pts[k + 1][0], s.pts[k + 1][1]);
      line4(ax - 0.5, ay - 0.5, bx - 0.5, by - 0.5, (x, y) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return;
        const i = y * W + x;
        terrain[i] = WATER; cid[i] = 0; strait[i] = 1;
      });
    }
  }

  // ── 3. clean-up: specks and 1–2 tile puddles
  removeSmallLand(terrain, W, H, 6);
  fillSmallWater(terrain, W, H, 2, strait);
  for (let i = 0; i < N; i++) if (terrain[i] === WATER) cid[i] = 0;

  // ── 4. relief from hand-drawn ranges + noise
  applyRelief(terrain, W, H);

  // ── 5. nation seeds
  const nations = placeSeeds(terrain, cid, countries, W, H);

  return { name: 'Mondo', width: W, height: H, terrain, nations };
}

function applyRelief(terrain: Uint8Array, W: number, H: number): void {
  const N = W * H;
  const lonOf = new Float32Array(W), latOf = new Float32Array(H), cosOf = new Float32Array(H);
  for (let x = 0; x < W; x++) lonOf[x] = unprojectWorld(x + 0.5, 0)[0];
  for (let y = 0; y < H; y++) { latOf[y] = unprojectWorld(0, y + 0.5)[1]; cosOf[y] = Math.cos(latOf[y] * DEG); }
  const nz = new ValueNoise(1234), nz2 = new ValueNoise(98765);
  const field = new Float32Array(N);

  for (const r of RANGES) {
    const pts = r.pts.length === 1 ? [r.pts[0], r.pts[0]] : r.pts;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
      const wMax = r.w * 2.6;
      const latLo = Math.min(ay, by) - wMax, latHi = Math.max(ay, by) + wMax;
      const cosMin = Math.max(0.15, Math.cos(Math.max(Math.abs(latLo), Math.abs(latHi)) * DEG));
      const lonLo = Math.min(ax, bx) - wMax / cosMin, lonHi = Math.max(ax, bx) + wMax / cosMin;
      const [px0, py0] = projectWorld(lonLo, Math.min(LAT_N, latHi));
      const [px1, py1] = projectWorld(lonHi, Math.max(LAT_S, latLo));
      const x0 = Math.max(0, Math.floor(px0)), x1 = Math.min(W - 1, Math.ceil(px1));
      const y0 = Math.max(0, Math.floor(py0)), y1 = Math.min(H - 1, Math.ceil(py1));
      for (let y = y0; y <= y1; y++) {
        const lat = latOf[y], c = cosOf[y];
        // segment in local equirectangular degrees around this row
        const sx = (bx - ax) * c, sy = by - ay;
        const len2 = sx * sx + sy * sy;
        for (let x = x0; x <= x1; x++) {
          const i = y * W + x;
          if (terrain[i] === WATER) continue;
          const qx = (lonOf[x] - ax) * c, qy = lat - ay;
          let t = len2 > 0 ? (qx * sx + qy * sy) / len2 : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = qx - t * sx, dy = qy - t * sy;
          const d = Math.sqrt(dx * dx + dy * dy);
          // noisy width → natural, lumpy edges
          const w = r.w * (0.9 + 0.6 * nz.fbm(x / 14, y / 14, 4));
          if (d >= w * 1.9) continue;
          const u = d / w;
          const v = r.h * Math.exp(-1.6 * u * u);
          if (v > field[i]) field[i] = v;
        }
      }
    }
  }

  const land = new Uint8Array(N);
  const elev = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (terrain[i] === WATER) continue;
    land[i] = 1;
    const n1 = nz2.fbm(x / 6, y / 6, 4);
    const rg = nz2.ridged(x / 14 + 50, y / 14, 3);
    const n2 = nz.fbm(x / 55 + 100, y / 55, 4);
    const f = field[i];
    elev[i] = f * (0.5 + 0.55 * n1) * (0.6 + 0.7 * rg) + 0.06 * Math.max(0, n2 - 0.25) + 0.02 * n1;
  }
  const tMount = quantile(elev, 1 - 0.065, land);
  const tHill = quantile(elev, 1 - 0.065 - 0.15, land);
  for (let i = 0; i < N; i++) {
    if (!land[i]) continue;
    terrain[i] = elev[i] >= tMount ? MOUNTAIN : elev[i] >= tHill ? HILLS : PLAINS;
  }
}

function placeSeeds(terrain: Uint8Array, cid: Int16Array, countries: string[], W: number, H: number): NationSeed[] {
  const N = W * H;
  // chamfer distance to the nearest tile that is not the same country (water, foreign land, map edge)
  const BIG = 1e9;
  const d = new Float32Array(N);
  for (let i = 0; i < N; i++) d[i] = cid[i] ? BIG : 0;
  const relax = (i: number, j: number, w: number, v: number) => {
    const cand = cid[j] === cid[i] ? d[j] + w : w;
    return cand < v ? cand : v;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!cid[i]) continue;
    let v = d[i];
    v = x > 0 ? relax(i, i - 1, 3, v) : Math.min(v, 3);
    if (y > 0) {
      v = relax(i, i - W, 3, v);
      if (x > 0) v = relax(i, i - W - 1, 4, v);
      if (x < W - 1) v = relax(i, i - W + 1, 4, v);
    } else v = Math.min(v, 3);
    d[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x;
    if (!cid[i]) continue;
    let v = d[i];
    v = x < W - 1 ? relax(i, i + 1, 3, v) : Math.min(v, 3);
    if (y < H - 1) {
      v = relax(i, i + W, 3, v);
      if (x < W - 1) v = relax(i, i + W + 1, 4, v);
      if (x > 0) v = relax(i, i + W - 1, 4, v);
    } else v = Math.min(v, 3);
    d[i] = v;
  }

  const C = countries.length + 1;
  const count = new Int32Array(C), best = new Int32Array(C).fill(-1), bestScore = new Float32Array(C).fill(-1);
  const area = new Float64Array(C);
  const areaW = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const lat = unprojectWorld(0, y + 0.5)[1] * DEG;
    areaW[y] = Math.cos(lat) * Math.cos(0.8 * lat); // true area per Miller pixel (relative)
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, c = cid[i];
    if (!c) continue;
    count[c]++; area[c] += areaW[y];
    const s = d[i] - (terrain[i] === MOUNTAIN ? 2 : 0);
    if (s > bestScore[c]) { bestScore[c] = s; best[c] = i; }
  }
  let maxArea = 0;
  for (let c = 1; c < C; c++) if (count[c] >= 120 && area[c] > maxArea) maxArea = area[c];
  const out: NationSeed[] = [];
  for (let c = 1; c < C; c++) {
    if (count[c] < 120 || best[c] < 0) continue;
    const en = countries[c - 1];
    out.push({
      name: ITALIAN_NAMES[en] ?? en,
      x: best[c] % W,
      y: (best[c] / W) | 0,
      strength: Math.round(Math.sqrt(area[c] / maxArea) * 1000) / 1000,
    });
  }
  out.sort((a, b) => b.strength - a.strength);
  return out;
}
