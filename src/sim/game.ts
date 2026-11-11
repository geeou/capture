// CAPTURE — core game state. Owned by the core: system modules must NOT edit this file.
import {
  WATER, WIN_SHARE,
  type Attack, type AllianceRequest, type Commands, type Difficulty, type GameEvent, type MapData,
  type Player, type PlayerId, type PlayerKind, type Queries, type Structure, type StructureType,
  type System, type Tile, type Unit, type UnitType,
} from './types';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Game {
  readonly map: MapData;
  readonly W: number;
  readonly H: number;
  /** W * H */
  readonly N: number;
  /** Terrain code per tile (WATER/PLAINS/HILLS/MOUNTAIN). Read-only. */
  readonly terrain: Uint8Array;
  /** Owner id per tile (0 = nobody). NEVER write directly: use setOwner(). */
  readonly owner: Uint16Array;
  /** Radioactive fallout per tile, 0..255 (0 = clean). Written by nukes.ts (call markChanged), read by attacks/render. */
  readonly fallout: Uint8Array;
  /** Count of non-water tiles. */
  readonly landTiles: number;

  /** players[id]. Index 0 is a dummy "nobody" entry (alive=false) so lookups never crash. */
  players: Player[] = [];
  /** 0 when there is no human player. */
  humanId: PlayerId = 0;
  difficulty: Difficulty = 'normal';
  tick = 0;
  over = false;
  winner: PlayerId = 0;

  structures: Structure[] = [];
  structureAt = new Map<Tile, Structure>();
  units: Unit[] = [];
  /** Managed by attacks.ts. */
  attacks: Attack[] = [];
  /** Pending alliance proposals. Managed by diplomacy.ts. */
  allianceRequests: AllianceRequest[] = [];

  systems: System[] = [];
  /** Deterministic RNG, 0..1. Use this, never Math.random, inside the sim. */
  rng: () => number;
  /** Free-form per-system global state, namespaced (ext.naval, ext.ai…). */
  ext: Record<string, any> = {};

  /** When true, every tile whose colour may have changed is pushed to `changed` (renderer drains it). */
  trackChanges = false;
  changed: Tile[] = [];

  cmd: Commands = {
    attack: () => false,
    retreat: () => false,
    build: () => false,
    sendBoat: () => false,
    launchNuke: () => false,
    proposeAlliance: () => false,
    respondAlliance: () => false,
    breakAlliance: () => false,
    setEmbargo: () => false,
    donate: () => false,
  };

  q: Queries = {
    maxTroops: () => 0,
    troopRate: () => 0,
    goldRate: () => 0,
    buildCost: () => Infinity,
    canBuild: () => 'Non disponibile',
    defenseAt: () => 1,
    canBoat: () => 'Non disponibile',
    nukeCost: () => Infinity,
    canNuke: () => 'Non disponibile',
    nukeRadius: () => 0,
    relation: () => 0,
  };

  private listeners: ((ev: GameEvent) => void)[] = [];
  private nextId = 1;
  private deadQueue: [PlayerId, PlayerId][] = [];
  private neighborCache = new Map<PlayerId, { tick: number; map: Map<PlayerId, number> }>();

  constructor(map: MapData, seed = 1) {
    this.map = map;
    this.W = map.width;
    this.H = map.height;
    this.N = this.W * this.H;
    this.terrain = map.terrain;
    this.owner = new Uint16Array(this.N);
    this.fallout = new Uint8Array(this.N);
    let land = 0;
    for (let i = 0; i < this.N; i++) if (this.terrain[i] !== WATER) land++;
    this.landTiles = land;
    this.rng = mulberry32(seed);
    this.players.push(this.makePlayer(0, '—', 'tribe', 0x000000, 0, 0));
    this.players[0].alive = false;
  }

  // ── ids / events ───────────────────────────────────────────────────────────
  newId(): number { return this.nextId++; }
  on(fn: (ev: GameEvent) => void): void { this.listeners.push(fn); }
  emit(ev: GameEvent): void { for (const fn of this.listeners) fn(ev); }
  /** Convenience for log lines. */
  msg(text: string, level: 'info' | 'good' | 'warn' | 'danger' = 'info', to?: PlayerId, x?: number, y?: number): void {
    this.emit({ type: 'message', text, level, to, x, y });
  }

  // ── geometry helpers ───────────────────────────────────────────────────────
  idx(x: number, y: number): Tile { return y * this.W + x; }
  xOf(i: Tile): number { return i % this.W; }
  yOf(i: Tile): number { return (i / this.W) | 0; }
  inBounds(x: number, y: number): boolean { return x >= 0 && y >= 0 && x < this.W && y < this.H; }
  isLand(i: Tile): boolean { return this.terrain[i] !== WATER; }
  isWater(i: Tile): boolean { return this.terrain[i] === WATER; }
  /** Calls fn for each in-bounds 4-neighbour. */
  forNeighbors(i: Tile, fn: (n: Tile) => void): void {
    const W = this.W, x = i % W;
    if (x > 0) fn(i - 1);
    if (x < W - 1) fn(i + 1);
    if (i >= W) fn(i - W);
    if (i < this.N - W) fn(i + W);
  }
  /** Land tile touching water. */
  isCoast(i: Tile): boolean {
    if (this.terrain[i] === WATER) return false;
    const W = this.W, x = i % W, t = this.terrain;
    return (x > 0 && t[i - 1] === WATER) || (x < W - 1 && t[i + 1] === WATER) ||
      (i >= W && t[i - W] === WATER) || (i < this.N - W && t[i + W] === WATER);
  }
  /** Nearest land tile to (x,y) within maxR, or -1. */
  nearestLand(x: number, y: number, maxR = 60): Tile {
    x = Math.round(x); y = Math.round(y);
    if (this.inBounds(x, y) && this.isLand(this.idx(x, y))) return this.idx(x, y);
    for (let r = 1; r <= maxR; r++) {
      let best = -1, bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx, ny = y + dy;
        if (!this.inBounds(nx, ny)) continue;
        const i = this.idx(nx, ny);
        if (this.terrain[i] === WATER) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  // ── players ────────────────────────────────────────────────────────────────
  private makePlayer(id: PlayerId, name: string, kind: PlayerKind, color: number, x: number, y: number): Player {
    return {
      id, name, kind, color, alive: true, troops: 0, gold: 0, tiles: 0, sumX: 0, sumY: 0,
      border: new Set(), spawnX: x, spawnY: y, allies: new Set(), embargoes: new Set(), traitorUntil: 0, ext: {},
    };
  }
  /** Creates a player and claims a small disc of free land around (x,y). Returns null if no free land there. */
  addPlayer(name: string, kind: PlayerKind, color: number, x: number, y: number, radius: number, troops: number): Player | null {
    const center = this.nearestLand(x, y, 40);
    if (center < 0 || this.owner[center] !== 0) return null;
    const cx = this.xOf(center), cy = this.yOf(center);
    const p = this.makePlayer(this.players.length, name, kind, color, cx, cy);
    p.troops = troops;
    this.players.push(p);
    this.claimDisc(p.id, cx, cy, radius);
    return p;
  }
  /** Claims unowned land within radius of (cx,cy). Returns number of tiles claimed. */
  claimDisc(id: PlayerId, cx: number, cy: number, radius: number): number {
    let n = 0;
    const r2 = radius * radius + 0.5;
    for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx, y = cy + dy;
      if (!this.inBounds(x, y)) continue;
      const i = this.idx(x, y);
      if (this.terrain[i] === WATER || this.owner[i] !== 0) continue;
      this.setOwner(i, id);
      n++;
    }
    return n;
  }
  get human(): Player | null { return this.humanId ? this.players[this.humanId] : null; }
  /** Living players (excludes the dummy 0). */
  alivePlayers(): Player[] { return this.players.filter(p => p.alive); }
  areAllied(a: PlayerId, b: PlayerId): boolean { return a !== 0 && b !== 0 && this.players[a].allies.has(b); }
  /** Share of all land owned, 0..1. */
  share(p: PlayerId): number { return this.players[p].tiles / this.landTiles; }

  // ── territory ──────────────────────────────────────────────────────────────
  /**
   * The ONLY way to change tile ownership. Keeps tile counts, centroids, border sets,
   * structures (captured, or destroyed when `to` is 0) and the renderer's dirty list in sync.
   */
  setOwner(i: Tile, to: PlayerId): void {
    const from = this.owner[i];
    if (from === to) return;
    const W = this.W, x = i % W, y = (i / W) | 0;
    if (from) {
      const p = this.players[from];
      p.tiles--; p.sumX -= x; p.sumY -= y; p.border.delete(i);
      if (p.tiles === 0) this.deadQueue.push([from, to]);
    }
    this.owner[i] = to;
    if (to) { const p = this.players[to]; p.tiles++; p.sumX += x; p.sumY += y; }
    const s = this.structureAt.get(i);
    if (s) {
      if (to) { const prev = s.owner; s.owner = to; this.emit({ type: 'structureCaptured', structure: s, previousOwner: prev }); }
      else this.removeStructure(s);
    }
    this.refreshBorder(i);
    if (x > 0) this.refreshBorder(i - 1);
    if (x < W - 1) this.refreshBorder(i + 1);
    if (i >= W) this.refreshBorder(i - W);
    if (i < this.N - W) this.refreshBorder(i + W);
    if (this.trackChanges) this.changed.push(i);
  }
  private refreshBorder(i: Tile): void {
    const o = this.owner[i];
    if (!o) return;
    const W = this.W, x = i % W, ow = this.owner;
    const b = (x > 0 && ow[i - 1] !== o) || (x < W - 1 && ow[i + 1] !== o) ||
      (i >= W && ow[i - W] !== o) || (i < this.N - W && ow[i + W] !== o);
    const set = this.players[o].border;
    if (b) set.add(i); else set.delete(i);
  }
  /** Tell the renderer a tile needs repainting for a reason other than ownership (e.g. fallout). */
  markChanged(i: Tile): void { if (this.trackChanges) this.changed.push(i); }

  /**
   * Who touches player `id` by land: Map<neighbourId, shared-border tile count>.
   * Key 0 = unclaimed land. Cached for 5 ticks. Do not mutate the returned map.
   */
  neighborsOf(id: PlayerId): Map<PlayerId, number> {
    const c = this.neighborCache.get(id);
    if (c && this.tick - c.tick < 5) return c.map;
    const m = new Map<PlayerId, number>();
    const W = this.W, N = this.N, ow = this.owner, t = this.terrain;
    const see = (n: Tile) => { if (t[n] !== WATER && ow[n] !== id) m.set(ow[n], (m.get(ow[n]) ?? 0) + 1); };
    for (const i of this.players[id].border) {
      const x = i % W;
      if (x > 0) see(i - 1);
      if (x < W - 1) see(i + 1);
      if (i >= W) see(i - W);
      if (i < N - W) see(i + W);
    }
    this.neighborCache.set(id, { tick: this.tick, map: m });
    return m;
  }
  sharesBorder(a: PlayerId, b: PlayerId): boolean { return this.neighborsOf(a).has(b); }

  // ── structures ─────────────────────────────────────────────────────────────
  addStructure(type: StructureType, owner: PlayerId, tile: Tile, buildTicks = 0): Structure {
    const s: Structure = {
      id: this.newId(), type, owner, tile, x: this.xOf(tile), y: this.yOf(tile),
      builtTick: this.tick, readyTick: this.tick + buildTicks, cooldownUntil: 0, ext: {},
    };
    this.structures.push(s);
    this.structureAt.set(tile, s);
    this.emit({ type: 'structureBuilt', structure: s });
    return s;
  }
  removeStructure(s: Structure): void {
    const k = this.structures.indexOf(s);
    if (k < 0) return;
    this.structures.splice(k, 1);
    this.structureAt.delete(s.tile);
    this.emit({ type: 'structureDestroyed', structure: s });
  }
  /** Finished (active) structures of a player, optionally of one type. */
  structuresOf(owner: PlayerId, type?: StructureType, includeUnfinished = false): Structure[] {
    return this.structures.filter(s => s.owner === owner && (!type || s.type === type) && (includeUnfinished || s.readyTick <= this.tick));
  }
  countStructures(owner: PlayerId, type: StructureType): number {
    let n = 0;
    for (const s of this.structures) if (s.owner === owner && s.type === type) n++;
    return n;
  }

  // ── units ──────────────────────────────────────────────────────────────────
  addUnit(type: UnitType, owner: PlayerId, fromTile: Tile, toTile: Tile, troops = 0): Unit {
    const u: Unit = {
      id: this.newId(), type, owner, x: this.xOf(fromTile), y: this.yOf(fromTile),
      fromTile, toTile, troops, alive: true, ext: {},
    };
    this.units.push(u);
    return u;
  }
  /** Marks a unit dead; it is dropped from game.units at the end of the tick. */
  removeUnit(u: Unit): void { u.alive = false; }

  // ── main loop ──────────────────────────────────────────────────────────────
  /** Advance the simulation by one tick. */
  step(): void {
    if (this.over) return;
    this.tick++;
    for (const s of this.systems) s.tick();
    // eliminations
    if (this.deadQueue.length) {
      const q = this.deadQueue; this.deadQueue = [];
      for (const [id, by] of q) {
        const p = this.players[id];
        if (!p.alive || p.tiles > 0) continue;
        p.alive = false;
        if (by && this.players[by].alive) this.players[by].gold += p.gold;
        p.gold = 0; p.troops = 0;
        for (const a of p.allies) this.players[a].allies.delete(id);
        p.allies.clear();
        this.emit({ type: 'playerDied', id, by });
      }
    }
    if (this.units.some(u => !u.alive)) this.units = this.units.filter(u => u.alive);
    if (this.tick % 10 === 0) this.checkWin();
    if (!this.trackChanges && this.changed.length) this.changed.length = 0;
  }
  private checkWin(): void {
    const need = this.landTiles * WIN_SHARE;
    let aliveCount = 0, last = 0;
    for (let id = 1; id < this.players.length; id++) {
      const p = this.players[id];
      if (!p.alive) continue;
      aliveCount++; last = id;
      if (p.tiles >= need) { this.finish(id); return; }
    }
    if (aliveCount === 1) this.finish(last);
  }
  private finish(id: PlayerId): void {
    this.over = true;
    this.winner = id;
    this.emit({ type: 'win', id });
  }
}
