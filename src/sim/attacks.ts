// CAPTURE — land attacks and tile defence. Owner: land-war agent.
//
// Every attack keeps its own frontier as a min-heap of target tiles (typed arrays). A conquered tile pushes
// its target-owned neighbours with priority = parent + 1 + jitter + terrain/fallout penalty, i.e. a jittered
// Dijkstra flood from the starting border: the blob grows evenly, mountains and fallout lag behind.
//
//   tiles/tick = F · vmax · d/(d + d0) + 0.3        F = frontier size, d = troops / F,
//                                                   free land: vmax 0.06, d0 = 2·cost; players: vmax 0.05, d0 = 2·cost
//   cost/tile  = free land:  1.5 · terrain defence · fallout
//                player:    (1 + density · m) · defenseAt · fallout,  density = defender troops / tiles,
//                           m = clamp(0.6 + 0.4·sqrt(defenderTroops / attackTroops), 0.6, 1.6)
//                defender loses 0.75 · density per tile lost.
//   fallout multiplies cost by 1 + 8·fallout/255 and delays the tile in the flood.
import type { Game } from './game';
import { WATER, type Attack, type PlayerId, type Structure, type Tile } from './types';

export const ATK = {
  minTroops: 10,
  freeCost: 1.5,
  playerBase: 1.0,
  defLoss: 0.75,
  vmaxFree: 0.06,
  vmaxPlayer: 0.065,
  maxPerAttackTick: 400,
  maxPerTick: 4000,
  retreatKeep: 0.75,
  fortRange: 12,
  fortMul: 2.5,
  falloutCost: 8,
  /** Pocket capture: largest enclosed defender pocket swallowed wholesale. */
  pocketMax: 160,
  /** Tiny-player annexation threshold (tiles) when fully enclosed by one attacking player. */
  tinyMax: 40,
};

const TERRAIN_DEF = new Float32Array([1, 1, 1.5, 2.5]);
const TERRAIN_PRIO = new Float32Array([0, 0, 0.6, 1.6]);
/** Flood step = fixed + exponential(mean STEP_EXP): first-passage percolation grows round blobs, not diamonds. */
const STEP_FIXED = 0.6, STEP_EXP = 0.45;

/** Min-heap of (priority, tile) on typed arrays. */
class TileHeap {
  pr = new Float64Array(64);
  tl = new Int32Array(64);
  size = 0;
  push(p: number, t: number): void {
    if (this.size === this.pr.length) {
      const pr = new Float64Array(this.size * 2); pr.set(this.pr); this.pr = pr;
      const tl = new Int32Array(this.size * 2); tl.set(this.tl); this.tl = tl;
    }
    const pr = this.pr, tl = this.tl;
    let i = this.size++;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (pr[par] <= p) break;
      pr[i] = pr[par]; tl[i] = tl[par]; i = par;
    }
    pr[i] = p; tl[i] = t;
  }
  /** Pops the min; returns its tile (priority left in `lastP`). */
  lastP = 0;
  pop(): number {
    const pr = this.pr, tl = this.tl;
    const top = tl[0]; this.lastP = pr[0];
    const n = --this.size;
    if (n > 0) {
      const p = pr[n], t = tl[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && pr[c + 1] < pr[c]) c++;
        if (pr[c] >= p) break;
        pr[i] = pr[c]; tl[i] = tl[c]; i = c;
      }
      pr[i] = p; tl[i] = t;
    }
    return top;
  }
  minP(): number { return this.size ? this.pr[0] : 0; }
}

interface AtkState {
  a: Attack;
  heap: TileHeap;
  budget: number;
  lastTile: number;
  conqueredSinceCheck: number;

}

export function installAttacks(game: Game): void {
  const W = game.W, H = game.H, N = game.N;
  const owner = game.owner, terrain = game.terrain, fallout = game.fallout;
  const states = new Map<number, AtkState>();
  const byPair = new Map<number, AtkState>();
  const pairKey = (a: PlayerId, t: PlayerId) => a * 65536 + t;
  /** Attack id that last enqueued the tile (dedup), cleared on pop. */
  const queued = new Int32Array(N);
  // flood-fill scratch
  const stamp = new Int32Array(N);
  let stampGen = 0;
  let stack = new Int32Array(1024);

  // ── fort spatial index ────────────────────────────────────────────────────
  const CELL = 16;
  const CW = Math.ceil(W / CELL), CH = Math.ceil(H / CELL);
  const fortCells: (Structure[] | undefined)[] = new Array(CW * CH);
  const cellOf = (s: Structure) => ((s.y / CELL) | 0) * CW + ((s.x / CELL) | 0);
  const addFort = (s: Structure) => { const c = cellOf(s); (fortCells[c] ??= []).push(s); };
  const removeFort = (s: Structure) => {
    const arr = fortCells[cellOf(s)];
    if (!arr) return;
    const k = arr.indexOf(s);
    if (k >= 0) arr.splice(k, 1);
  };
  for (const s of game.structures) if (s.type === 'fort') addFort(s);

  const R2 = ATK.fortRange * ATK.fortRange;
  const hasFort = (o: PlayerId, x: number, y: number): boolean => {
    const cx0 = Math.max(0, ((x - ATK.fortRange) / CELL) | 0), cx1 = Math.min(CW - 1, ((x + ATK.fortRange) / CELL) | 0);
    const cy0 = Math.max(0, ((y - ATK.fortRange) / CELL) | 0), cy1 = Math.min(CH - 1, ((y + ATK.fortRange) / CELL) | 0);
    const tick = game.tick;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const arr = fortCells[cy * CW + cx];
      if (!arr) continue;
      for (let k = 0; k < arr.length; k++) {
        const s = arr[k];
        if (s.owner !== o || s.readyTick > tick) continue;
        const dx = s.x - x, dy = s.y - y;
        if (dx * dx + dy * dy <= R2) return true;
      }
    }
    return false;
  };

  const defenseAt = (i: Tile): number => {
    if (i < 0 || i >= N) return 1;
    let d = TERRAIN_DEF[terrain[i]];
    const o = owner[i];
    if (o) {
      if (hasFort(o, i % W, (i / W) | 0)) d *= ATK.fortMul;
      if (game.players[o].traitorUntil > game.tick) d *= 0.5;
    }
    return d;
  };
  game.q.defenseAt = defenseAt;

  // ── helpers ───────────────────────────────────────────────────────────────
  /** Cheap deterministic per-(tile, attack) jitter in [0,1). */
  const jitter = (t: number, seed: number) => {
    let h = Math.imul(t ^ (seed * 0x9e3779b1), 0x85ebca6b);
    h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
  const prioExtra = (t: number) => TERRAIN_PRIO[terrain[t]] + (fallout[t] ? (fallout[t] / 255) * 6 : 0);

  const isTargetTile = (t: number, target: PlayerId) => owner[t] === target && terrain[t] !== WATER;
  const touches = (t: number, who: PlayerId): boolean => {
    const x = t % W;
    return (x > 0 && owner[t - 1] === who) || (x < W - 1 && owner[t + 1] === who) ||
      (t >= W && owner[t - W] === who) || (t < N - W && owner[t + W] === who);
  };

  const enqueue = (st: AtkState, t: number, p: number) => {
    const id = st.a.id;
    if (queued[t] === id) return;
    queued[t] = id;
    st.heap.push(p + STEP_FIXED - Math.log(1 - jitter(t, id)) * STEP_EXP + prioExtra(t), t);
  };

  /** Scans the attacker's border for target tiles; pushes them. Returns how many were found. */
  const scanFrontier = (st: AtkState | null, attacker: PlayerId, target: PlayerId, base: number): number => {
    let found = 0;
    const tryN = (n: number) => {
      if (owner[n] !== target || terrain[n] === WATER) return;
      found++;
      if (st) enqueue(st, n, base);
    };
    for (const i of game.players[attacker].border) {
      const x = i % W;
      if (x > 0) tryN(i - 1);
      if (x < W - 1) tryN(i + 1);
      if (i >= W) tryN(i - W);
      if (i < N - W) tryN(i + W);
      if (!st && found) return found;
    }
    return found;
  };

  const tileCost = (t: number, target: PlayerId, density: number, mult: number) => {
    const f = fallout[t] ? 1 + (ATK.falloutCost * fallout[t]) / 255 : 1;
    if (!target) return ATK.freeCost * TERRAIN_DEF[terrain[t]] * f;
    return (ATK.playerBase + density * mult) * defenseAt(t) * f;
  };

  const endAttack = (st: AtkState, refund: number) => {
    const a = st.a;
    if (!a.alive) return;
    a.alive = false;
    const p = game.players[a.attacker];
    if (p.alive && refund > 0) p.troops += refund;
    a.troops = 0;
    states.delete(a.id);
    byPair.delete(pairKey(a.attacker, a.target));
    dirty = true;
  };
  let dirty = false;

  const canAttack = (attacker: PlayerId, target: PlayerId, troops: number): boolean => {
    const A = game.players[attacker];
    if (!A || !A.alive || attacker === target) return false;
    if (target) {
      const T = game.players[target];
      if (!T || !T.alive || game.areAllied(attacker, target)) return false;
    }
    if (!(troops >= ATK.minTroops) || troops > A.troops + 1e-6) return false;
    return true;
  };

  // ── commands ──────────────────────────────────────────────────────────────
  game.cmd.attack = (attacker, target, troops) => {
    troops = Math.floor(troops);
    if (!canAttack(attacker, target, troops)) return false;
    const A = game.players[attacker];
    troops = Math.min(troops, A.troops);
    const existing = byPair.get(pairKey(attacker, target));
    if (existing && existing.a.alive) {
      // reinforcement: pick up new border segments (e.g. a fresh beachhead)
      const base = existing.heap.size ? existing.heap.minP() : existing.heap.lastP;
      const before = existing.heap.size;
      scanFrontier(existing, attacker, target, base);
      if (existing.heap.size === 0 && before === 0) return false;
      A.troops -= troops;
      existing.a.troops += troops;
      existing.a.startTroops += troops;
      return true;
    }
    if (!scanFrontier(null, attacker, target, 0)) return false;
    A.troops -= troops;
    const a: Attack = { id: game.newId(), attacker, target, troops, startTroops: troops, alive: true, ext: {} };
    const st: AtkState = { a, heap: new TileHeap(), budget: 0, lastTile: -1, conqueredSinceCheck: 0 };
    scanFrontier(st, attacker, target, 0);
    states.set(a.id, st);
    byPair.set(pairKey(attacker, target), st);
    game.attacks.push(a);
    game.emit({ type: 'attackStarted', attack: a });
    return true;
  };

  game.cmd.retreat = (id) => {
    const st = states.get(id);
    if (!st || !st.a.alive) return false;
    endAttack(st, st.a.troops * ATK.retreatKeep);
    game.attacks = game.attacks.filter(x => x.alive);
    dirty = false;
    return true;
  };

  game.on(ev => {
    if (ev.type === 'structureBuilt' && ev.structure.type === 'fort') addFort(ev.structure);
    else if (ev.type === 'structureDestroyed' && ev.structure.type === 'fort') removeFort(ev.structure);
    else if (ev.type === 'playerDied') {
      for (const st of [...states.values()]) {
        if (st.a.attacker === ev.id) endAttack(st, 0);
        else if (st.a.target === ev.id) endAttack(st, st.a.troops);
      }
      if (dirty) { game.attacks = game.attacks.filter(x => x.alive); dirty = false; }
    } else if (ev.type === 'allianceFormed') {
      for (const k of [pairKey(ev.a, ev.b), pairKey(ev.b, ev.a)]) {
        const st = byPair.get(k);
        if (st) endAttack(st, st.a.troops);
      }
      if (dirty) { game.attacks = game.attacks.filter(x => x.alive); dirty = false; }
    }
  });

  // ── pocket capture ────────────────────────────────────────────────────────
  const growStack = () => { const s = new Int32Array(stack.length * 2); s.set(stack); stack = s; };
  /**
   * Bounded flood over `target`'s land from `start`. Succeeds (returns tile count, tiles in `stack[0..n)`)
   * only if the component touches nothing but `target`, `attacker` and water, and has ≤ max tiles.
   */
  const enclosedPocket = (start: number, target: PlayerId, attacker: PlayerId, max: number): number => {
    const gen = ++stampGen;
    let n = 0, head = 0;
    stamp[start] = gen; stack[n++] = start;
    while (head < n) {
      const t = stack[head++];
      const x = t % W;
      for (let k = 0; k < 4; k++) {
        let nb: number;
        if (k === 0) { if (x === 0) continue; nb = t - 1; }
        else if (k === 1) { if (x === W - 1) continue; nb = t + 1; }
        else if (k === 2) { if (t < W) continue; nb = t - W; }
        else { if (t >= N - W) continue; nb = t + W; }
        if (terrain[nb] === WATER) continue;
        const o = owner[nb];
        if (o === attacker) continue;
        if (o !== target) return 0;
        if (stamp[nb] === gen) continue;
        if (n >= max) return 0;
        stamp[nb] = gen;
        if (n >= stack.length) growStack();
        stack[n++] = nb;
      }
    }
    return n;
  };

  const capturePocket = (st: AtkState) => {
    const a = st.a, t0 = st.lastTile;
    if (t0 < 0 || owner[t0] !== a.attacker) return;
    const x = t0 % W;
    const nbs = [x > 0 ? t0 - 1 : -1, x < W - 1 ? t0 + 1 : -1, t0 >= W ? t0 - W : -1, t0 < N - W ? t0 + W : -1];
    for (const s of nbs) {
      if (s < 0 || !isTargetTile(s, a.target)) continue;
      const n = enclosedPocket(s, a.target, a.attacker, ATK.pocketMax);
      if (!n) continue;
      const T = a.target ? game.players[a.target] : null;
      const density = T && T.tiles ? T.troops / T.tiles : 0;
      for (let k = 0; k < n; k++) game.setOwner(stack[k], a.attacker);
      if (T) T.troops = Math.max(0, T.troops - density * n);
    }
  };

  // ── tiny enclosed players are annexed by the single neighbour attacking them ─
  let sweepCursor = 1;
  const neighbourOwners = new Set<PlayerId>();
  const sweepTiny = () => {
    const ps = game.players;
    for (let k = 0; k < 4; k++) {
      if (sweepCursor >= ps.length) sweepCursor = 1;
      const p = ps[sweepCursor++];
      if (!p || !p.alive || p.tiles > ATK.tinyMax || p.tiles === 0) continue;
      neighbourOwners.clear();
      for (const i of p.border) {
        const x = i % W;
        if (x > 0 && terrain[i - 1] !== WATER && owner[i - 1] !== p.id) neighbourOwners.add(owner[i - 1]);
        if (x < W - 1 && terrain[i + 1] !== WATER && owner[i + 1] !== p.id) neighbourOwners.add(owner[i + 1]);
        if (i >= W && terrain[i - W] !== WATER && owner[i - W] !== p.id) neighbourOwners.add(owner[i - W]);
        if (i < N - W && terrain[i + W] !== WATER && owner[i + W] !== p.id) neighbourOwners.add(owner[i + W]);
        if (neighbourOwners.size > 1) break;
      }
      if (neighbourOwners.size !== 1) continue;
      const X = neighbourOwners.values().next().value as PlayerId;
      if (!X || !ps[X].alive || game.areAllied(X, p.id)) continue;
      const attacking = byPair.has(pairKey(X, p.id));
      if (!attacking && p.tiles > 8) continue;
      if (ps[X].tiles < p.tiles * 4) continue;
      // collect p's tiles (connected components reachable from its border)
      const gen = ++stampGen;
      let n = 0;
      for (const b of p.border) {
        if (stamp[b] === gen) continue;
        stamp[b] = gen;
        if (n >= stack.length) growStack();
        stack[n++] = b;
      }
      for (let h = 0; h < n; h++) {
        const t = stack[h], x = t % W;
        const cand = [x > 0 ? t - 1 : -1, x < W - 1 ? t + 1 : -1, t >= W ? t - W : -1, t < N - W ? t + W : -1];
        for (const c of cand) {
          if (c < 0 || owner[c] !== p.id || stamp[c] === gen) continue;
          stamp[c] = gen;
          if (n >= stack.length) growStack();
          stack[n++] = c;
        }
      }
      if (attacking) game.msg(`${ps[X].name} ha annesso ${p.name}`, 'info', p.id);
      for (let h = 0; h < n; h++) game.setOwner(stack[h], X);
    }
  };

  // ── per-tick ──────────────────────────────────────────────────────────────
  let rot = 0;
  game.systems.push({
    name: 'attacks',
    tick() {
      const list = game.attacks;
      const players = game.players;
      // 1. validity + opposing attacks cancel out
      for (let k = 0; k < list.length; k++) {
        const a = list[k];
        if (!a.alive) continue;
        const st = states.get(a.id);
        if (!st) { a.alive = false; dirty = true; continue; }
        const A = players[a.attacker];
        if (!A.alive) { endAttack(st, 0); continue; }
        if (a.target && (!players[a.target].alive || game.areAllied(a.attacker, a.target))) { endAttack(st, a.troops); continue; }
        if (a.target) {
          const opp = byPair.get(pairKey(a.target, a.attacker));
          if (opp && opp.a.alive && opp.a.troops > 0 && a.troops > 0) {
            const m = Math.min(opp.a.troops, a.troops);
            opp.a.troops -= m; a.troops -= m;
          }
        }
      }
      // 2. conquest
      let globalLeft = ATK.maxPerTick;
      const n = list.length;
      if (n) rot = (rot + 1) % n;
      for (let kk = 0; kk < n; kk++) {
        const a = list[(kk + rot) % n];
        if (!a.alive) continue;
        const st = states.get(a.id)!;
        if (a.troops < 1) { endAttack(st, 0); continue; }
        const heap = st.heap;
        if (heap.size === 0) {
          // re-scan once (frontier may have reappeared, e.g. we regained a border tile)
          if (!scanFrontier(st, a.attacker, a.target, heap.lastP)) { endAttack(st, a.troops); continue; }
        }
        const target = a.target;
        const T = target ? players[target] : null;
        const density = T && T.tiles ? Math.max(0, T.troops) / T.tiles : 0;
        const mult = T ? Math.min(1.6, Math.max(0.6, 0.6 + 0.4 * Math.sqrt(Math.max(0, T.troops) / Math.max(1, a.troops)))) : 1;
        const avgCost = target ? (ATK.playerBase + density * mult) * 1.2 : ATK.freeCost * 1.2;
        const F = Math.max(1, heap.size);
        const d = a.troops / F;
        const vmax = target ? ATK.vmaxPlayer : ATK.vmaxFree;
        st.budget += F * vmax * (d / (d + 2 * avgCost)) + 0.3;
        if (st.budget > ATK.maxPerAttackTick) st.budget = ATK.maxPerAttackTick;
        let skips = 0;
        while (st.budget >= 1 && heap.size > 0 && globalLeft > 0) {
          const t = heap.pop();
          if (queued[t] === a.id) queued[t] = 0;
          if (owner[t] !== target || terrain[t] === WATER || !touches(t, a.attacker)) {
            if (++skips > 4000) break;
            continue;
          }
          const cost = tileCost(t, target, density, mult);
          if (a.troops < cost) {
            // not enough left for this tile: the remainder is spent against it
            if (T) T.troops = Math.max(0, T.troops - a.troops * ATK.defLoss / Math.max(1, mult));
            a.troops = 0;
            break;
          }
          a.troops -= cost;
          if (T) { T.troops -= density * ATK.defLoss; if (T.troops < 0) T.troops = 0; }
          game.setOwner(t, a.attacker);
          st.lastTile = t;
          st.conqueredSinceCheck++;
          st.budget -= 1; globalLeft--;
          const base = heap.lastP;
          const x = t % W;
          if (x > 0 && isTargetTile(t - 1, target)) enqueue(st, t - 1, base);
          if (x < W - 1 && isTargetTile(t + 1, target)) enqueue(st, t + 1, base);
          if (t >= W && isTargetTile(t - W, target)) enqueue(st, t - W, base);
          if (t < N - W && isTargetTile(t + W, target)) enqueue(st, t + W, base);
        }
        if (st.budget > 0 && heap.size === 0) st.budget = 0;
        a.ext.frontier = heap.size;
        if (st.lastTile >= 0) { a.ext.x = st.lastTile % W; a.ext.y = (st.lastTile / W) | 0; }
        // pocket check, staggered
        if (st.conqueredSinceCheck > 0 && (game.tick + a.id) % 8 === 0) {
          st.conqueredSinceCheck = 0;
          capturePocket(st);
        }
        if (a.troops < 1) endAttack(st, Math.max(0, a.troops));
      }
      sweepTiny();
      if (dirty) { game.attacks = game.attacks.filter(x => x.alive); dirty = false; }
    },
  });
}
