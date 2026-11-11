// Grid helpers shared by the world and procedural generators. Pure TS.
import { PLAINS, WATER } from '../sim/types';

/**
 * Even-odd scanline fill of a set of rings (each a flat [x0,y0,x1,y1,…] array in pixel
 * coords, closed implicitly). A pixel is inside when its centre is. Holes are respected
 * because all rings of the polygon are filled together with the even-odd rule.
 */
export function fillRings(rings: number[][], W: number, H: number, plot: (y: number, x0: number, x1: number) => void): void {
  let minY = Infinity, maxY = -Infinity;
  for (const r of rings) for (let k = 1; k < r.length; k += 2) {
    if (r[k] < minY) minY = r[k];
    if (r[k] > maxY) maxY = r[k];
  }
  const y0 = Math.max(0, Math.ceil(minY - 0.5));
  const y1 = Math.min(H - 1, Math.ceil(maxY - 0.5) - 1);
  if (y1 < y0) return;
  const rows: number[][] = new Array(y1 - y0 + 1);
  for (let i = 0; i < rows.length; i++) rows[i] = [];
  for (const r of rings) {
    const n = r.length >> 1;
    if (n < 3) continue;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      let ax = r[2 * i], ay = r[2 * i + 1], bx = r[2 * j], by = r[2 * j + 1];
      if (ay === by) continue;
      if (ay > by) { let t = ax; ax = bx; bx = t; t = ay; ay = by; by = t; }
      // rows whose centre yc = y + 0.5 satisfies ay <= yc < by
      const ra = Math.max(y0, Math.ceil(ay - 0.5));
      const rb = Math.min(y1, Math.ceil(by - 0.5) - 1);
      const slope = (bx - ax) / (by - ay);
      for (let y = ra; y <= rb; y++) rows[y - y0].push(ax + (y + 0.5 - ay) * slope);
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const xs = rows[i];
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(W - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
      if (xb >= xa) plot(y0 + i, xa, xb);
    }
  }
}

/** 4-connected components of cells where pred(i) is true. Returns labels (0 = not in set, 1..n) and sizes (index = label). */
export function components(W: number, H: number, pred: (i: number) => boolean): { labels: Int32Array; sizes: number[] } {
  const N = W * H;
  const labels = new Int32Array(N);
  const sizes: number[] = [0];
  const stack = new Int32Array(N);
  let next = 0;
  for (let s = 0; s < N; s++) {
    if (labels[s] || !pred(s)) continue;
    const id = ++next;
    let sp = 0, size = 0;
    stack[sp++] = s; labels[s] = id;
    while (sp) {
      const i = stack[--sp]; size++;
      const x = i % W;
      if (x > 0 && !labels[i - 1] && pred(i - 1)) { labels[i - 1] = id; stack[sp++] = i - 1; }
      if (x < W - 1 && !labels[i + 1] && pred(i + 1)) { labels[i + 1] = id; stack[sp++] = i + 1; }
      if (i >= W && !labels[i - W] && pred(i - W)) { labels[i - W] = id; stack[sp++] = i - W; }
      if (i < N - W && !labels[i + W] && pred(i + W)) { labels[i + W] = id; stack[sp++] = i + W; }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/** Turn land components smaller than minSize into water. Returns how many tiles changed. */
export function removeSmallLand(terrain: Uint8Array, W: number, H: number, minSize: number, keep?: Uint8Array): number {
  const { labels, sizes } = components(W, H, i => terrain[i] !== WATER);
  let n = 0;
  for (let i = 0; i < terrain.length; i++) {
    const l = labels[i];
    if (l && sizes[l] < minSize && !(keep && keep[i])) { terrain[i] = WATER; n++; }
  }
  return n;
}

/** Turn water components of at most maxSize tiles into plains. Returns how many tiles changed. */
export function fillSmallWater(terrain: Uint8Array, W: number, H: number, maxSize: number, keep?: Uint8Array): number {
  const { labels, sizes } = components(W, H, i => terrain[i] === WATER);
  let n = 0;
  for (let i = 0; i < terrain.length; i++) {
    const l = labels[i];
    if (l && sizes[l] <= maxSize && !(keep && keep[i])) { terrain[i] = PLAINS; n++; }
  }
  return n;
}

/**
 * Chamfer (3-4) distance, in tiles (approx Euclidean), from every cell where inside(i) to the
 * nearest cell where it is false (or the map edge). Outside cells get 0.
 */
export function distanceInside(W: number, H: number, inside: (i: number) => boolean): Float32Array {
  const N = W * H;
  const BIG = 1e9;
  const d = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = i % W, y = (i / W) | 0;
    d[i] = inside(i) ? (x === 0 || y === 0 || x === W - 1 || y === H - 1 ? 3 : BIG) : 0;
  }
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    let v = d[i];
    if (v === 0) continue;
    const a = d[i - 1] + 3, b = d[i - W] + 3, c = d[i - W - 1] + 4, e = d[i - W + 1] + 4;
    if (a < v) v = a; if (b < v) v = b; if (c < v) v = c; if (e < v) v = e;
    d[i] = v;
  }
  for (let y = H - 2; y >= 1; y--) for (let x = W - 2; x >= 1; x--) {
    const i = y * W + x;
    let v = d[i];
    if (v === 0) continue;
    const a = d[i + 1] + 3, b = d[i + W] + 3, c = d[i + W + 1] + 4, e = d[i + W - 1] + 4;
    if (a < v) v = a; if (b < v) v = b; if (c < v) v = c; if (e < v) v = e;
    d[i] = v;
  }
  for (let i = 0; i < N; i++) d[i] /= 3;
  return d;
}

/** Visit a 4-connected staircase line from (x0,y0) to (x1,y1). */
export function line4(x0: number, y0: number, x1: number, y1: number, visit: (x: number, y: number) => void): void {
  x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let x = x0, y = y0, ix = 0, iy = 0;
  visit(x, y);
  for (let k = 0; k < dx + dy; k++) {
    // one axis per step → 4-connected; advance the axis that lags behind the ideal line
    if ((ix + 0.5) / dx < (iy + 0.5) / dy) { x += sx; ix++; } else { y += sy; iy++; }
    visit(x, y);
  }
}
