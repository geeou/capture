// CAPTURE — naval system: water navigation, transport boats (amphibious landings), sea trade.
// Owner: naval/nukes agent.
//
// Navigation: water is split into 4-connected components once at install. Routes are found with a
// two-level A*: a coarse A* on S×S cells gives a corridor, then a fine 8-connected A* (no corner
// cutting) inside that corridor, then string-pulling with an exact grid line-of-sight. Every segment
// of a stored route only touches water tiles, so a boat's rounded position is always water.
// Routes are cached (LRU) by (start water tile, end water tile).
import type { Game } from './game';
import { WATER, type PlayerId, type Structure, type Tile, type Unit } from './types';

// ── tuning ──────────────────────────────────────────────────────────────────
/** Tiles per tick. */
export const BOAT_SPEED = 1.2;
export const TRADE_SPEED = 1.5;
/** Smallest landing force. */
export const MIN_BOAT_TROOPS = 50;
/** Transports at sea per player: BASE_BOATS + 1 per finished port. */
export const BASE_BOATS = 3;
export const MAX_TRADE_SHIPS = 150;
export const TRADE_PER_PORT = 2;
/** A port tries to send a trade ship every 15–25 s. */
const TRADE_INTERVAL_MIN = 150;
const TRADE_INTERVAL_VAR = 100;
/** Each port is looked at once every PORT_SCAN_PERIOD ticks (staggered). */
const PORT_SCAN_PERIOD = 20;
/** Uncached route searches allowed per tick for trade (transports are user/AI driven and always served). */
const TRADE_PATHS_PER_TICK = 1;
const TRADE_PAY_MIN = 40;
const TRADE_PAY_MAX = 250;
/** Max tiles of the initial beachhead (landing tile included). */
const BEACH_TILES = 7;
/** Beachhead price multiplier vs. the defender's troop density (amphibious assaults are costly). */
const AMPHIBIOUS = 1.5;
const PLAN_CACHE_TICKS = 10;
const COAST_CACHE_TICKS = 10;
const ROUTE_CACHE_SIZE = 8000;
/** Unclaimed-land landing search radius around the clicked tile. */
const FREE_LAND_SEARCH_R = 150;

// ── small binary min-heap on typed arrays ─────────────────────────────────────
class Heap {
  k = new Float64Array(4096);
  v = new Int32Array(4096);
  n = 0;
  clear(): void { this.n = 0; }
  push(key: number, val: number): void {
    if (this.n === this.k.length) {
      const k2 = new Float64Array(this.n * 2); k2.set(this.k); this.k = k2;
      const v2 = new Int32Array(this.n * 2); v2.set(this.v); this.v = v2;
    }
    const K = this.k, V = this.v;
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p]; V[i] = V[p]; i = p;
    }
    K[i] = key; V[i] = val;
  }
  /** Pops the min value (call only when n > 0). */
  pop(): number {
    const K = this.k, V = this.v;
    const top = V[0];
    const n = --this.n;
    if (n > 0) {
      const key = K[n], val = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c]; V[i] = V[c]; i = c;
      }
      K[i] = key; V[i] = val;
    }
    return top;
  }
}

const SQ2 = Math.SQRT2;
const DX8 = [1, -1, 0, 0, 1, 1, -1, -1];
const DY8 = [0, 0, 1, -1, 1, -1, 1, -1];

/** Water connectivity + route finding. Exposed on game.ext.naval.nav for the AI. */
export class WaterNav {
  readonly W: number;
  readonly H: number;
  readonly N: number;
  private readonly t: Uint8Array;
  /** Water component id per tile (0 = land, 1.. = component). 4-connected. */
  readonly comp: Int32Array;
  /** Tile count of each component (index = id). */
  readonly compSize: number[] = [0];
  /** Coarse cell size in tiles. */
  readonly S: number;
  readonly CW: number;
  readonly CH: number;
  /** Coarse node per water tile (0 = land): a 4-connected piece of water inside one S×S cell. */
  readonly sub: Int32Array;
  /** Coarse graph: nodes that touch (4-adjacent tiles across a cell edge). */
  private readonly adj: number[][] = [[]];
  private readonly nodeX: number[] = [0];
  private readonly nodeY: number[] = [0];

  private cache = new Map<number, number[] | null>();
  /** True when the last route() call had to search (cache miss). */
  lastMiss = false;

  // coarse buffers
  private cg: Float32Array;
  private cstamp: Uint32Array;
  private cclosed: Uint32Array;
  private cpar: Int32Array;
  private corr: Uint32Array;
  private cgen = 0;
  // fine buffers (lazy)
  private fg: Float32Array | null = null;
  private fstamp: Uint32Array | null = null;
  private fclosed: Uint32Array | null = null;
  private fpar: Int32Array | null = null;
  private fgen = 0;
  private heap = new Heap();

  constructor(W: number, H: number, terrain: Uint8Array) {
    this.W = W; this.H = H; this.N = W * H; this.t = terrain;
    const N = this.N;
    const comp = this.comp = new Int32Array(N);
    const queue = new Int32Array(N);
    let id = 0;
    for (let s = 0; s < N; s++) {
      if (terrain[s] !== WATER || comp[s] !== 0) continue;
      id++;
      let qh = 0, qt = 0, size = 0;
      queue[qt++] = s; comp[s] = id;
      while (qh < qt) {
        const i = queue[qh++]; size++;
        const x = i % W;
        if (x > 0 && terrain[i - 1] === WATER && comp[i - 1] === 0) { comp[i - 1] = id; queue[qt++] = i - 1; }
        if (x < W - 1 && terrain[i + 1] === WATER && comp[i + 1] === 0) { comp[i + 1] = id; queue[qt++] = i + 1; }
        if (i >= W && terrain[i - W] === WATER && comp[i - W] === 0) { comp[i - W] = id; queue[qt++] = i - W; }
        if (i < N - W && terrain[i + W] === WATER && comp[i + W] === 0) { comp[i + W] = id; queue[qt++] = i + W; }
      }
      this.compSize.push(size);
    }
    const S = this.S = W * H >= 400_000 ? 8 : 4;
    const CW = this.CW = Math.ceil(W / S), CH = this.CH = Math.ceil(H / S);
    // Coarse graph. Because a node is 4-connected and edges come from real tile adjacency,
    // any coarse path is guaranteed to contain a fine path: the fine search never falls back
    // to an unbounded flood.
    const sub = this.sub = new Int32Array(N);
    let nid = 0;
    for (let cy = 0; cy < CH; cy++) for (let cx = 0; cx < CW; cx++) {
      const x0 = cx * S, y0 = cy * S, x1 = Math.min(W, x0 + S), y1 = Math.min(H, y0 + S);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const s0 = y * W + x;
        if (comp[s0] === 0 || sub[s0] !== 0) continue;
        nid++;
        let qh = 0, qt = 0, sx = 0, sy = 0;
        queue[qt++] = s0; sub[s0] = nid;
        while (qh < qt) {
          const i = queue[qh++];
          const ix = i % W, iy = (i - ix) / W;
          sx += ix; sy += iy;
          if (ix > x0 && comp[i - 1] !== 0 && sub[i - 1] === 0) { sub[i - 1] = nid; queue[qt++] = i - 1; }
          if (ix < x1 - 1 && comp[i + 1] !== 0 && sub[i + 1] === 0) { sub[i + 1] = nid; queue[qt++] = i + 1; }
          if (iy > y0 && comp[i - W] !== 0 && sub[i - W] === 0) { sub[i - W] = nid; queue[qt++] = i - W; }
          if (iy < y1 - 1 && comp[i + W] !== 0 && sub[i + W] === 0) { sub[i + W] = nid; queue[qt++] = i + W; }
        }
        this.nodeX.push(sx / qt); this.nodeY.push(sy / qt); this.adj.push([]);
      }
    }
    const adj = this.adj;
    const link = (a: number, b: number) => {
      if (a === 0 || b === 0 || a === b) return;
      if (!adj[a].includes(b)) { adj[a].push(b); adj[b].push(a); }
    };
    for (let i = 0; i < N; i++) {
      const a = sub[i];
      if (a === 0) continue;
      if (i % W < W - 1) link(a, sub[i + 1]);
      if (i < N - W) link(a, sub[i + W]);
    }
    const CN = nid + 1;
    this.cg = new Float32Array(CN);
    this.cstamp = new Uint32Array(CN);
    this.cclosed = new Uint32Array(CN);
    this.cpar = new Int32Array(CN);
    this.corr = new Uint32Array(CN);
  }

  /** Exact grid line of sight between tile centres: true if every tile the segment touches is water. */
  los(a: Tile, b: Tile): boolean {
    const W = this.W, t = this.t;
    let x = a % W, y = (a - x) / W;
    const x1 = b % W, y1 = (b - x1) / W;
    const dx = x1 - x, dy = y1 - y;
    const nx = Math.abs(dx), ny = Math.abs(dy);
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    let ix = 0, iy = 0;
    while (ix < nx || iy < ny) {
      const l = (1 + 2 * ix) * ny, r = (1 + 2 * iy) * nx;
      if (l === r) {
        // passes exactly through a corner: both side tiles must be water too
        if (t[y * W + x + sx] !== WATER || t[(y + sy) * W + x] !== WATER) return false;
        x += sx; y += sy; ix++; iy++;
      } else if (l < r) { x += sx; ix++; }
      else { y += sy; iy++; }
      if (t[y * W + x] !== WATER) return false;
    }
    return true;
  }

  /**
   * Route between two water tiles: smoothed waypoints (tile indices) from `a` to `b`, or null if
   * they are not connected. Cached.
   */
  route(a: Tile, b: Tile): number[] | null {
    this.lastMiss = false;
    const c = this.comp[a];
    if (!c || c !== this.comp[b]) return null;
    if (a === b) return [a];
    const key = a * this.N + b;
    const hit = this.cache.get(key);
    if (hit !== undefined) {
      this.cache.delete(key); this.cache.set(key, hit); // LRU touch
      return hit;
    }
    const rev = this.cache.get(b * this.N + a);
    if (rev) { const r = rev.slice().reverse(); this.cache.set(key, r); return r; }
    this.lastMiss = true;
    let raw: number[] | null = null;
    if (this.coarse(this.sub[a], this.sub[b])) raw = this.fine(c, a, b, true, 200_000);
    if (!raw) raw = this.fine(c, a, b, false, 2_000_000);
    const res = raw ? this.smooth(raw) : null;
    this.cache.set(key, res);
    if (this.cache.size > ROUTE_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as number);
    return res;
  }

  /** Coarse A* on the node graph; on success marks the path nodes and their neighbours in `corr`. */
  private coarse(s: number, e: number): boolean {
    const g = this.cg, st = this.cstamp, cl = this.cclosed, par = this.cpar;
    const X = this.nodeX, Y = this.nodeY, adj = this.adj;
    const gen = ++this.cgen;
    const h = this.heap; h.clear();
    const ex = X[e], ey = Y[e];
    st[s] = gen; g[s] = 0; par[s] = -1;
    h.push(Math.hypot(X[s] - ex, Y[s] - ey), s);
    let found = false;
    while (h.n > 0) {
      const cur = h.pop();
      if (cl[cur] === gen) continue;
      cl[cur] = gen;
      if (cur === e) { found = true; break; }
      const gc = g[cur], cx = X[cur], cy = Y[cur];
      const nb = adj[cur];
      for (let k = 0; k < nb.length; k++) {
        const n = nb[k];
        if (cl[n] === gen) continue;
        const ng = gc + Math.hypot(X[n] - cx, Y[n] - cy);
        if (st[n] === gen && g[n] <= ng) continue;
        st[n] = gen; g[n] = ng; par[n] = cur;
        h.push(ng + Math.hypot(X[n] - ex, Y[n] - ey), n);
      }
    }
    if (!found) return false;
    const corr = this.corr;
    for (let cur = e; cur >= 0; cur = par[cur]) {
      corr[cur] = gen;
      const nb = adj[cur];
      for (let k = 0; k < nb.length; k++) corr[nb[k]] = gen;
    }
    return true;
  }

  /** Fine 8-connected A* without corner cutting. Returns raw tile path a..b. */
  private fine(c: number, a: Tile, b: Tile, useCorr: boolean, budget: number): number[] | null {
    const W = this.W, H = this.H, N = this.N, comp = this.comp;
    if (!this.fg) {
      this.fg = new Float32Array(N); this.fstamp = new Uint32Array(N);
      this.fclosed = new Uint32Array(N); this.fpar = new Int32Array(N);
    }
    const g = this.fg!, st = this.fstamp!, cl = this.fclosed!, par = this.fpar!;
    const corr = this.corr, cgen = this.cgen, sub = this.sub;
    const gen = ++this.fgen;
    const h = this.heap; h.clear();
    const bx = b % W, by = (b - bx) / W;
    const WH = useCorr ? 1.4 : 1.15; // mildly greedy: fewer expansions, smoothing removes the kinks
    const heur = (x: number, y: number) => {
      const ax = Math.abs(x - bx), ay = Math.abs(y - by);
      return WH * (ax > ay ? ax + (SQ2 - 1) * ay : ay + (SQ2 - 1) * ax);
    };
    st[a] = gen; g[a] = 0; par[a] = -1;
    h.push(heur(a % W, (a / W) | 0), a);
    let found = false, expanded = 0;
    while (h.n > 0) {
      const cur = h.pop();
      if (cl[cur] === gen) continue;
      cl[cur] = gen;
      if (cur === b) { found = true; break; }
      if (++expanded > budget) break;
      const x = cur % W, y = (cur - x) / W, gc = g[cur];
      for (let d = 0; d < 8; d++) {
        const nx = x + DX8[d], ny = y + DY8[d];
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (comp[n] !== c || cl[n] === gen) continue;
        if (d >= 4 && (comp[y * W + nx] !== c || comp[ny * W + x] !== c)) continue; // no corner cutting
        if (useCorr && corr[sub[n]] !== cgen) continue;
        const ng = gc + (d < 4 ? 1 : SQ2);
        if (st[n] === gen && g[n] <= ng) continue;
        st[n] = gen; g[n] = ng; par[n] = cur;
        h.push(ng + heur(nx, ny), n);
      }
    }
    if (!found) return null;
    const out: number[] = [];
    for (let cur = b; cur >= 0; cur = par[cur]) out.push(cur);
    out.reverse();
    return out;
  }

  /** String pulling with exact LOS; waypoints at most 64 raw steps apart (bounds the cost). */
  private smooth(raw: number[]): number[] {
    const out = [raw[0]];
    let a = 0, k = 1;
    while (k < raw.length) {
      if (k - a <= 64 && this.los(raw[a], raw[k])) { k++; continue; }
      a = k - 1;
      out.push(raw[a]);
    }
    if (out[out.length - 1] !== raw[raw.length - 1]) out.push(raw[raw.length - 1]);
    return out;
  }
}

/** Sum of segment lengths of a waypoint route, in tiles. */
function routeLength(W: number, path: number[]): number {
  let len = 0;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    len += Math.hypot((a % W) - (b % W), ((a / W) | 0) - ((b / W) | 0));
  }
  return len;
}

interface CoastInfo { tick: number; byComp: Map<number, Tile[]> }
interface BoatPlan { depart: Tile; land: Tile; startW: Tile; endW: Tile; comp: number }
interface PortState { next: number; out: number; comps: number[] }

export function installNaval(game: Game): void {
  const W = game.W, N = game.N, terrain = game.terrain, owner = game.owner;
  const nav = new WaterNav(W, game.H, terrain);
  const comp = nav.comp;

  const transports: Unit[] = [];
  const trades: Unit[] = [];
  const boatsAtSea = new Map<PlayerId, number>();
  const ports: Structure[] = [];
  let portCursor = 0;
  let tradePathsThisTick = 0;

  const coastCache = new Map<PlayerId, CoastInfo>();
  const planCache = new Map<number, BoatPlan | string>();
  let planCacheTick = -1e9;

  game.ext.naval = {
    nav,
    /** Water component of a coast/land tile's neighbours, e.g. for AI "can I reach X by sea". */
    waterCompsOf: (i: Tile) => waterComps(i),
    boatsAtSea: (p: PlayerId) => boatsAtSea.get(p) ?? 0,
    maxBoats: (p: PlayerId) => maxBoats(p),
    tradeShips: () => trades.length,
  };

  // ── helpers ──────────────────────────────────────────────────────────────
  const tmpComps: number[] = [];
  /** Distinct water components 4-adjacent to tile i (reuses a shared array). */
  function waterComps(i: Tile): number[] {
    tmpComps.length = 0;
    const x = i % W;
    const add = (n: Tile) => { const c = comp[n]; if (c && !tmpComps.includes(c)) tmpComps.push(c); };
    if (x > 0) add(i - 1);
    if (x < W - 1) add(i + 1);
    if (i >= W) add(i - W);
    if (i < N - W) add(i + W);
    return tmpComps;
  }
  /** Water neighbour of coast tile `i` in component c closest to tile `toward`. */
  function waterNeighbor(i: Tile, c: number, toward: Tile): Tile {
    const x = i % W, tx = toward % W, ty = (toward / W) | 0, y = (i / W) | 0;
    let best = -1, bd = Infinity;
    const test = (n: Tile, nx: number, ny: number) => {
      if (comp[n] !== c) return;
      const d = (nx - tx) ** 2 + (ny - ty) ** 2;
      if (d < bd) { bd = d; best = n; }
    };
    if (x > 0) test(i - 1, x - 1, y);
    if (x < W - 1) test(i + 1, x + 1, y);
    if (i >= W) test(i - W, x, y - 1);
    if (i < N - W) test(i + W, x, y + 1);
    return best;
  }
  function coastOf(p: PlayerId): CoastInfo {
    let info = coastCache.get(p);
    if (info && game.tick - info.tick < COAST_CACHE_TICKS) return info;
    const byComp = new Map<number, Tile[]>();
    for (const i of game.players[p].border) {
      if (!game.isCoast(i)) continue;
      for (const c of waterComps(i)) {
        let arr = byComp.get(c);
        if (!arr) { arr = []; byComp.set(c, arr); }
        arr.push(i);
      }
    }
    info = { tick: game.tick, byComp };
    coastCache.set(p, info);
    return info;
  }
  function maxBoats(p: PlayerId): number {
    let n = BASE_BOATS;
    for (const s of ports) if (s.owner === p && s.readyTick <= game.tick) n++;
    return n;
  }
  const d2 = (a: Tile, b: Tile) => {
    const ax = a % W, bx = b % W;
    return (ax - bx) ** 2 + (((a - ax) / W) - ((b - bx) / W)) ** 2;
  };

  /** Landing + departure for p → targetTile, or an Italian reason. */
  function makePlan(p: PlayerId, target: Tile): BoatPlan | string {
    const pc = coastOf(p).byComp;
    if (pc.size === 0) return 'Non hai coste';
    const o = owner[target];
    let land = -1, landComp = 0, bd = Infinity;
    if (o !== 0) {
      for (const [c, tiles] of coastOf(o).byComp) {
        if (!pc.has(c)) continue;
        for (const i of tiles) {
          const d = d2(i, target);
          if (d < bd) { bd = d; land = i; landComp = c; }
        }
      }
    } else {
      // nearest unclaimed coast tile (ring search, Chebyshev rings, best Euclid inside the first hit ring)
      const tx = target % W, ty = (target / W) | 0;
      for (let r = 0; r <= FREE_LAND_SEARCH_R && land < 0; r++) {
        for (let dy = -r; dy <= r; dy++) {
          const y = ty + dy;
          if (y < 0 || y >= game.H) continue;
          const step = (dy === -r || dy === r) ? 1 : 2 * r;
          for (let dx = -r; dx <= r; dx += step || 1) {
            const x = tx + dx;
            if (x < 0 || x >= W) continue;
            const i = y * W + x;
            if (terrain[i] === WATER || owner[i] !== 0) continue;
            for (const c of waterComps(i)) {
              if (!pc.has(c)) continue;
              const d = dx * dx + dy * dy;
              if (d < bd) { bd = d; land = i; landComp = c; }
            }
          }
        }
      }
    }
    if (land < 0) return 'Nessuna costa raggiungibile';
    let depart = -1; bd = Infinity;
    for (const i of pc.get(landComp)!) {
      const d = d2(i, land);
      if (d < bd) { bd = d; depart = i; }
    }
    const startW = waterNeighbor(depart, landComp, land);
    const endW = waterNeighbor(land, landComp, depart);
    if (startW < 0 || endW < 0) return 'Nessuna costa raggiungibile';
    return { depart, land, startW, endW, comp: landComp };
  }
  function planFor(p: PlayerId, target: Tile): BoatPlan | string {
    if (game.tick - planCacheTick >= PLAN_CACHE_TICKS) { planCache.clear(); planCacheTick = game.tick; }
    const key = p * N + target;
    let r = planCache.get(key);
    if (r === undefined) { r = makePlan(p, target); planCache.set(key, r); }
    return r;
  }

  function canBoat(p: PlayerId, target: Tile): string | null {
    const pl = game.players[p];
    if (!pl || !pl.alive) return 'Non sei in gioco';
    if (!Number.isInteger(target) || target < 0 || target >= N) return 'Bersaglio non valido';
    if (terrain[target] === WATER) return 'Scegli una terra';
    const o = owner[target];
    if (o === p) return 'È già tuo';
    if (game.areAllied(p, o)) return 'È un tuo alleato';
    if ((boatsAtSea.get(p) ?? 0) >= maxBoats(p)) return 'Troppe navi in mare';
    if (pl.troops < MIN_BOAT_TROOPS) return 'Truppe insufficienti';
    const plan = planFor(p, target);
    return typeof plan === 'string' ? plan : null;
  }

  function sendBoat(p: PlayerId, target: Tile, troops: number): boolean {
    if (canBoat(p, target) !== null) return false;
    const pl = game.players[p];
    troops = Math.floor(Math.min(troops, pl.troops));
    if (!(troops >= MIN_BOAT_TROOPS)) return false;
    let plan = planFor(p, target);
    if (typeof plan === 'string') return false;
    // cached plan may be a few ticks stale: re-check ownership, recompute if needed
    if (owner[plan.depart] !== p || owner[plan.land] === p || game.areAllied(p, owner[plan.land])) {
      coastCache.delete(p);
      plan = makePlan(p, target);
      if (typeof plan === 'string') return false;
      planCache.set(p * N + target, plan);
    }
    const path = nav.route(plan.startW, plan.endW);
    if (!path) return false;
    pl.troops -= troops;
    const u = game.addUnit('transport', p, plan.depart, plan.land, troops);
    u.x = plan.startW % W; u.y = (plan.startW / W) | 0;
    u.ext.path = path;
    u.ext.pathIndex = 1;
    u.ext.speed = BOAT_SPEED;
    u.ext.target = target;
    u.ext.length = routeLength(W, path);
    transports.push(u);
    boatsAtSea.set(p, (boatsAtSea.get(p) ?? 0) + 1);
    game.emit({ type: 'boatLaunched', unit: u });
    const o = owner[plan.land];
    if (o) game.msg(`⚓ Sbarco in arrivo da ${pl.name}`, 'warn', o, plan.land % W, (plan.land / W) | 0);
    return true;
  }

  /** Moves a unit along ext.path; true when it reached the last waypoint. */
  function advance(u: Unit, speed: number): boolean {
    const path = u.ext.path as number[];
    let k = u.ext.pathIndex as number, s = speed, x = u.x, y = u.y;
    while (s > 1e-9 && k < path.length) {
      const t = path[k], tx = t % W, ty = (t - tx) / W;
      const dx = tx - x, dy = ty - y, d = Math.sqrt(dx * dx + dy * dy);
      if (d <= s) { x = tx; y = ty; s -= d; k++; }
      else { x += (dx / d) * s; y += (dy / d) * s; s = 0; }
    }
    u.x = x; u.y = y; u.ext.pathIndex = k;
    return k >= path.length;
  }

  const beach: Tile[] = [];
  function land(u: Unit): void {
    const p = u.owner, pl = game.players[p], L = u.toTile, o = owner[L];
    const lx = L % W, ly = (L / W) | 0;
    if (o === p || game.areAllied(p, o)) {
      pl.troops += u.troops;
      game.emit({ type: 'boatLanded', owner: p, tile: L, troops: u.troops });
      return;
    }
    // beachhead: landing tile + connected tiles of the same owner, paid like a (costly) land assault
    const def = game.players[o];
    const density = o ? def.troops / Math.max(1, def.tiles) : 0;
    beach.length = 0; beach.push(L);
    for (let k = 0; k < beach.length && beach.length < BEACH_TILES; k++) {
      game.forNeighbors(beach[k], n => {
        if (beach.length < BEACH_TILES && terrain[n] !== WATER && owner[n] === o && !beach.includes(n)) beach.push(n);
      });
    }
    let troops = u.troops, taken = 0;
    for (const i of beach) {
      const cost = (o ? Math.max(2, density * AMPHIBIOUS) * game.q.defenseAt(i) : 1.5) * (game.fallout[i] ? 3 : 1);
      if (troops < cost) break;
      troops -= cost;
      if (o) def.troops = Math.max(0, def.troops - density * 0.5);
      game.setOwner(i, p);
      taken++;
    }
    if (taken === 0) {
      if (o) def.troops = Math.max(0, def.troops - u.troops * 0.3);
      game.emit({ type: 'boatLanded', owner: p, tile: L, troops: 0 });
      game.msg(`⚓ Sbarco respinto${o ? ' da ' + def.name : ''}`, 'warn', p, lx, ly);
      if (o) game.msg(`⚓ Respinto lo sbarco di ${pl.name}`, 'good', o, lx, ly);
      return;
    }
    troops = Math.floor(troops);
    game.emit({ type: 'boatLanded', owner: p, tile: L, troops });
    if (o) game.msg(`⚓ ${pl.name} è sbarcato sulle nostre coste`, 'danger', o, lx, ly);
    if (troops > 0) {
      pl.troops += troops;
      // hand-off to the land engine; if it refuses, the troops simply stay home
      if (!o || game.players[o].alive) game.cmd.attack(p, o, troops);
    }
  }

  // ── trade ────────────────────────────────────────────────────────────────
  function portState(s: Structure): PortState {
    let st = s.ext.naval as PortState | undefined;
    if (!st) {
      st = { next: game.tick + TRADE_INTERVAL_MIN + Math.floor(game.rng() * TRADE_INTERVAL_VAR), out: 0, comps: [...waterComps(s.tile)] };
      s.ext.naval = st;
    }
    return st;
  }
  const embargoed = (a: PlayerId, b: PlayerId) =>
    a !== b && (game.players[a].embargoes.has(b) || game.players[b].embargoes.has(a));

  const foreign: Structure[] = [];
  const own: Structure[] = [];
  function tryTrade(s: Structure, st: PortState): void {
    if (trades.length >= MAX_TRADE_SHIPS || st.out >= TRADE_PER_PORT || st.comps.length === 0) {
      st.next = game.tick + 50; return;
    }
    foreign.length = 0; own.length = 0;
    const so = s.owner;
    const samples = Math.min(ports.length, 16);
    for (let k = 0; k < samples; k++) {
      const d = ports.length <= 16 ? ports[k] : ports[Math.floor(game.rng() * ports.length)];
      if (d === s || d.readyTick > game.tick || !game.players[d.owner].alive) continue;
      if (embargoed(so, d.owner)) continue;
      const dst = portState(d);
      let shared = false;
      for (const c of dst.comps) if (st.comps.includes(c)) { shared = true; break; }
      if (!shared) continue;
      if (d.owner === so) { if (!own.includes(d)) own.push(d); }
      else if (!foreign.includes(d)) foreign.push(d);
    }
    const pool = foreign.length ? foreign : own;
    if (!pool.length) { st.next = game.tick + TRADE_INTERVAL_MIN; return; }
    if (tradePathsThisTick >= TRADE_PATHS_PER_TICK) return; // retry on next visit
    const d = pool[Math.floor(game.rng() * pool.length)];
    let c = 0;
    for (const cc of portState(d).comps) if (st.comps.includes(cc)) { c = cc; break; }
    const a = waterNeighbor(s.tile, c, d.tile), b = waterNeighbor(d.tile, c, s.tile);
    const path = a >= 0 && b >= 0 ? nav.route(a, b) : null;
    if (nav.lastMiss) tradePathsThisTick++;
    st.next = game.tick + TRADE_INTERVAL_MIN + Math.floor(game.rng() * TRADE_INTERVAL_VAR);
    if (!path || path.length < 2) return;
    const u = game.addUnit('trade', so, s.tile, d.tile, 0);
    u.x = a % W; u.y = (a / W) | 0;
    u.ext.path = path;
    u.ext.pathIndex = 1;
    u.ext.speed = TRADE_SPEED;
    u.ext.length = routeLength(W, path);
    u.ext.srcPort = s;
    u.ext.dstPort = d;
    st.out++;
    trades.push(u);
  }
  function tradePay(len: number): number {
    const full = Math.max(150, W * 0.5);
    return Math.round(TRADE_PAY_MIN + (TRADE_PAY_MAX - TRADE_PAY_MIN) * Math.min(1, len / full));
  }
  function arriveTrade(u: Unit): void {
    const d = u.ext.dstPort as Structure, so = u.owner, dO = d.owner;
    if (!game.players[so].alive || !game.players[dO].alive || embargoed(so, dO)) return;
    const pay = tradePay(u.ext.length as number);
    if (so === dO) game.players[so].gold += Math.round(pay * 0.5);
    else { game.players[so].gold += pay; game.players[dO].gold += pay; }
  }
  function endTrade(u: Unit, k: number): void {
    const st = (u.ext.srcPort as Structure).ext.naval as PortState | undefined;
    if (st && st.out > 0) st.out--;
    if (u.alive) game.removeUnit(u);
    trades[k] = trades[trades.length - 1]; trades.pop();
  }

  // ── events ───────────────────────────────────────────────────────────────
  for (const s of game.structures) if (s.type === 'port') ports.push(s);
  game.on(ev => {
    if (ev.type === 'structureBuilt' && ev.structure.type === 'port') ports.push(ev.structure);
    else if (ev.type === 'structureDestroyed' && ev.structure.type === 'port') {
      const k = ports.indexOf(ev.structure);
      if (k >= 0) { ports[k] = ports[ports.length - 1]; ports.pop(); }
    } else if (ev.type === 'playerDied') {
      for (const u of transports) if (u.owner === ev.id) game.removeUnit(u);
      for (const u of trades) if (u.owner === ev.id) game.removeUnit(u);
      coastCache.delete(ev.id);
    }
  });

  // ── tick ─────────────────────────────────────────────────────────────────
  game.systems.push({
    name: 'naval',
    tick() {
      // transports
      for (let k = transports.length - 1; k >= 0; k--) {
        const u = transports[k];
        let done = !u.alive || !game.players[u.owner].alive;
        if (!done && advance(u, BOAT_SPEED)) { land(u); done = true; }
        if (done) {
          if (u.alive) game.removeUnit(u);
          boatsAtSea.set(u.owner, Math.max(0, (boatsAtSea.get(u.owner) ?? 1) - 1));
          transports[k] = transports[transports.length - 1]; transports.pop();
        }
      }
      // trade ships
      for (let k = trades.length - 1; k >= 0; k--) {
        const u = trades[k];
        const d = u.ext.dstPort as Structure;
        if (!u.alive || !game.players[u.owner].alive || game.structureAt.get(d.tile) !== d) { endTrade(u, k); continue; }
        if (advance(u, TRADE_SPEED)) { arriveTrade(u); endTrade(u, k); }
      }
      // ports: staggered slice
      if (game.tick % 3 === 0) tradePathsThisTick = 0;
      const n = ports.length;
      if (n) {
        let m = Math.ceil(n / PORT_SCAN_PERIOD);
        while (m-- > 0) {
          if (portCursor >= ports.length) portCursor = 0;
          const s = ports[portCursor++];
          if (s.readyTick > game.tick || !game.players[s.owner].alive) continue;
          const st = portState(s);
          if (st.next <= game.tick) tryTrade(s, st);
        }
      }
    },
  });

  game.q.canBoat = canBoat;
  game.cmd.sendBoat = sendBoat;
}
