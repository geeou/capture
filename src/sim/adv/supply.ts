// ADVANCED MODE — capital, supply, encirclement, rebellion. See docs/ADVANCED.md §2. Owner: LAND agent.
//
// Hubs of a player = its capital + finished cities + finished ports not blockaded (adv.q.isBlockaded).
// Hub lists are rebuilt every HUB_PERIOD ticks from game.structures (small list).
//
// supply(p, tile): 1 within supplyFull of the nearest hub, linear down to supplyMin at supplyZero
// (×blitzSupply with Blitz II). Applied to attack strength through hook attackMul, cached per attack for
// SUPPLY_CACHE ticks (attack.ext.supply).
//
// Encirclement: each player is scanned every supplyScanPeriod ticks (staggered by id). Multi-source BFS over
// the player's own land from its hubs; if it does not reach every owned tile, the unreached components are
// found from the border set (every component off the main body contains a border tile). A component that
// touches the coast while the player has a working port is supplied by sea (otherwise every overseas beachhead
// would wither); the others are cut: adv.cut[t] = 1, defence ×cutDefense. A pocket whose oldest cut tile has
// been cut for cutSurrenderTicks (×2 with Fortress III) surrenders to the non-allied neighbour with the longest
// border on it (or becomes free land); the owner loses the pocket's share of troops. Event pocketLost.
// Stale flags (tiles captured since the last scan) are cleared every CLEAN_PERIOD ticks.
//
// Capital: checked every tick. When its tile changes owner, the loser loses capitalLossTroops of its troops
// (capitalLossFortress with Fortress III); if a player took it, it also takes capitalLootGold of the gold.
// The capital moves to the finished city nearest the territory centroid, else the owned tile nearest the
// centroid. Events capitalLost + capitalMoved.
//
// Rebellion: every rebelPeriod ticks (staggered by id) a player above rebelShare of the land loses a disc
// (radius 9–15) around its tile farthest from every hub, if that is more than rebelDistance away. The far tile
// candidate comes from the tail of the last supply BFS (largest path distance from the hubs).
import type { Game } from '../game';
import { WATER, type GameOptions, type PlayerId, type Tile } from '../types';
import { ADV, doctrineLevel } from './rules';

const HUB_PERIOD = 10;
const SUPPLY_CACHE = 10;
const CLEAN_PERIOD = 5;
/** BFS tail tiles examined for the rebellion candidate. */
const FAR_SAMPLES = 48;
/** After a capital loss, further losses within this many ticks only relocate it (no penalty, no capitalLost). */
const CAPITAL_GRACE = 300;
/** Smaller pockets surrender silently (event only): slivers left behind by the fronts. */
const POCKET_MSG_MIN = 10;

export function installSupply(game: Game, _opts: GameOptions): void {
  const adv = game.adv!;
  const W = game.W, H = game.H, N = game.N, owner = game.owner, terrain = game.terrain;
  const cut = adv.cut;
  /** Player that flagged the tile cut (the flag only counts while that player still owns it). */
  const cutOwner = new Uint16Array(N);
  /** Tick at which the tile became cut. */
  const cutSince = new Int32Array(N);
  const mark = new Int32Array(N);
  let gen = 0;
  const queue = new Int32Array(N);

  const NP = () => game.players.length;
  /** Per player: hub tiles (capital first). */
  const hubs: number[][] = [];
  /** Per player: has a working (finished, not blockaded) port → coastal pockets are supplied by sea. */
  let hasPort = new Uint8Array(NP() + 1);
  /** Per player: tiles flagged cut by the last scan. */
  const cutLists: (Int32Array | null)[] = [];
  /** Per player: rebellion candidate tile and its distance to the nearest hub. */
  let farTile = new Int32Array(NP() + 1).fill(-1);
  let farDist = new Float32Array(NP() + 1);

  const ensure = () => {
    const n = NP();
    while (hubs.length < n) hubs.push([]);
    while (cutLists.length < n) cutLists.push(null);
    if (hasPort.length < n) {
      hasPort = new Uint8Array(n);
      const ft = new Int32Array(n).fill(-1); ft.set(farTile.subarray(0, Math.min(n, farTile.length))); farTile = ft;
      const fd = new Float32Array(n); fd.set(farDist.subarray(0, Math.min(n, farDist.length))); farDist = fd;
    }
  };

  // ── capitals ─────────────────────────────────────────────────────────────
  const ap = (p: PlayerId) => adv.players[p];
  for (let id = 1; id < game.players.length; id++) {
    const P = game.players[id], a = ap(id);
    if (!a || !P.alive) continue;
    const t = game.idx(P.spawnX, P.spawnY);
    a.capital = owner[t] === id ? t : pickCapitalTile(id);
  }

  /**
   * Finished city nearest the centroid; else the owned tile deepest inside the territory (farthest by path from
   * any land front: BFS from border tiles touching foreign or free land); else the owned tile nearest the centroid.
   */
  function pickCapitalTile(p: PlayerId): Tile {
    const P = game.players[p];
    if (!P.alive || P.tiles <= 0) return -1;
    const cx = P.sumX / P.tiles, cy = P.sumY / P.tiles;
    let best = -1, bestD = Infinity;
    for (const s of game.structures) {
      if (s.owner !== p || s.type !== 'city' || s.readyTick > game.tick || owner[s.tile] !== p) continue;
      const d = (s.x - cx) ** 2 + (s.y - cy) ** 2;
      if (d < bestD) { bestD = d; best = s.tile; }
    }
    if (best >= 0) return best;
    // deepest tile
    const g = ++gen;
    let n = 0;
    const front = (t: number) => terrain[t] !== WATER && owner[t] !== p;
    for (const b of P.border) {
      if (owner[b] !== p) continue;
      const x = b % W;
      if ((x > 0 && front(b - 1)) || (x < W - 1 && front(b + 1)) || (b >= W && front(b - W)) || (b < N - W && front(b + W))) {
        mark[b] = g; queue[n++] = b;
      }
    }
    if (n > 0 && n < P.tiles) {
      for (let head = 0; head < n; head++) {
        const t = queue[head], x = t % W;
        if (x > 0 && owner[t - 1] === p && mark[t - 1] !== g) { mark[t - 1] = g; queue[n++] = t - 1; }
        if (x < W - 1 && owner[t + 1] === p && mark[t + 1] !== g) { mark[t + 1] = g; queue[n++] = t + 1; }
        if (t >= W && owner[t - W] === p && mark[t - W] !== g) { mark[t - W] = g; queue[n++] = t - W; }
        if (t < N - W && owner[t + W] === p && mark[t + W] !== g) { mark[t + W] = g; queue[n++] = t + W; }
      }
      return queue[n - 1];
    }
    const x0 = Math.round(cx), y0 = Math.round(cy);
    for (let r = 0; r <= 80; r++) {
      best = -1; bestD = Infinity;
      for (let dy = -r; dy <= r; dy++) {
        const y = y0 + dy;
        if (y < 0 || y >= H) continue;
        const step = Math.abs(dy) === r ? 1 : 2 * r;
        for (let dx = -r; dx <= r; dx += step) {
          const x = x0 + dx;
          if (x < 0 || x >= W) continue;
          const t = y * W + x;
          if (owner[t] !== p) continue;
          const d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = t; }
        }
        if (r === 0) break;
      }
      if (best >= 0) return best;
    }
    for (const b of P.border) if (owner[b] === p) return b;
    return -1;
  }

  // ── hubs & supply ────────────────────────────────────────────────────────
  const rebuildHubs = () => {
    ensure();
    const n = NP();
    for (let id = 0; id < n; id++) { hubs[id].length = 0; hasPort[id] = 0; }
    for (let id = 1; id < n; id++) {
      const c = ap(id)?.capital ?? -1;
      if (c >= 0 && owner[c] === id) hubs[id].push(c);
    }
    const tick = game.tick;
    for (const s of game.structures) {
      if (s.readyTick > tick || owner[s.tile] !== s.owner) continue;
      if (s.type === 'city') hubs[s.owner].push(s.tile);
      else if (s.type === 'port' && !adv.q.isBlockaded(s)) { hubs[s.owner].push(s.tile); hasPort[s.owner] = 1; }
    }
  };
  let hubsAt = -1;
  const freshHubs = () => { if (hubsAt < 0 || game.tick - hubsAt >= HUB_PERIOD) { rebuildHubs(); hubsAt = game.tick; } };

  /** Euclidean distance from (x, y) to the nearest hub of p (Infinity if none). */
  const hubDist = (p: PlayerId, x: number, y: number): number => {
    const hs = hubs[p];
    if (!hs) return Infinity;
    let best = Infinity;
    for (let k = 0; k < hs.length; k++) {
      const h = hs[k], dx = h % W - x, dy = ((h / W) | 0) - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };

  const supply = (p: PlayerId, tile: Tile): number => {
    if (!game.players[p] || tile < 0 || tile >= N) return 1;
    freshHubs();
    const k = doctrineLevel(game, p, 'blitz') >= 2 ? ADV.blitzSupply : 1;
    const full = ADV.supplyFull * k, zero = ADV.supplyZero * k;
    const d = hubDist(p, tile % W, (tile / W) | 0);
    if (d <= full) return 1;
    if (d >= zero) return ADV.supplyMin;
    return 1 - (1 - ADV.supplyMin) * (d - full) / (zero - full);
  };

  const isCut = (tile: Tile): boolean => tile >= 0 && tile < N && cut[tile] === 1 && cutOwner[tile] === owner[tile] && owner[tile] !== 0;

  adv.q.supply = supply;
  adv.q.isCut = isCut;

  // ── encirclement scan ────────────────────────────────────────────────────
  const setCut = (t: number, p: PlayerId) => {
    if (cut[t] === 1 && cutOwner[t] === p) return;
    cut[t] = 1; cutOwner[t] = p; cutSince[t] = game.tick;
    game.markChanged(t);
  };
  const clearCut = (t: number) => {
    if (cut[t] === 0) return;
    cut[t] = 0; cutOwner[t] = 0;
    game.markChanged(t);
  };
  const clearList = (p: PlayerId) => {
    const L = cutLists[p];
    if (L) for (let k = 0; k < L.length; k++) if (cutOwner[L[k]] === p) clearCut(L[k]);
    cutLists[p] = null;
    if (ap(p)) ap(p).cutTiles = 0;
  };

  const segStart: number[] = [], segEnd: number[] = [];
  const nbOwners = new Map<PlayerId, number>();

  const scan = (p: PlayerId) => {
    const P = game.players[p];
    if (!P || !P.alive || P.tiles <= 0) { clearList(p); return; }
    freshHubs();
    // 1. multi-source BFS from the hubs over own land
    const g = ++gen;
    let n = 0;
    for (const h of hubs[p]) if (owner[h] === p && mark[h] !== g) { mark[h] = g; queue[n++] = h; }
    for (let head = 0; head < n; head++) {
      const t = queue[head], x = t % W;
      if (x > 0 && owner[t - 1] === p && mark[t - 1] !== g) { mark[t - 1] = g; queue[n++] = t - 1; }
      if (x < W - 1 && owner[t + 1] === p && mark[t + 1] !== g) { mark[t + 1] = g; queue[n++] = t + 1; }
      if (t >= W && owner[t - W] === p && mark[t - W] !== g) { mark[t - W] = g; queue[n++] = t - W; }
      if (t < N - W && owner[t + W] === p && mark[t + W] !== g) { mark[t + W] = g; queue[n++] = t + W; }
    }
    const reached = n;
    // rebellion candidate: the BFS tail (largest path distance), only for big empires
    farTile[p] = -1; farDist[p] = 0;
    if (P.tiles > game.landTiles * ADV.rebelShare * 0.8 && reached > 0) {
      for (let k = Math.max(0, reached - FAR_SAMPLES); k < reached; k++) {
        const t = queue[k], d = hubDist(p, t % W, (t / W) | 0);
        if (d > farDist[p]) { farDist[p] = d; farTile[p] = t; }
      }
    }
    // 2. components not reached from any hub
    segStart.length = 0; segEnd.length = 0;
    if (reached < P.tiles) {
      const gp = ++gen;
      for (const b of P.border) {
        if (owner[b] !== p || mark[b] === g || mark[b] === gp) continue;
        const s0 = n;
        mark[b] = gp; queue[n++] = b;
        for (let head = s0; head < n; head++) {
          const t = queue[head], x = t % W;
          if (x > 0 && owner[t - 1] === p && mark[t - 1] !== gp) { mark[t - 1] = gp; queue[n++] = t - 1; }
          if (x < W - 1 && owner[t + 1] === p && mark[t + 1] !== gp) { mark[t + 1] = gp; queue[n++] = t + 1; }
          if (t >= W && owner[t - W] === p && mark[t - W] !== gp) { mark[t - W] = gp; queue[n++] = t - W; }
          if (t < N - W && owner[t + W] === p && mark[t + W] !== gp) { mark[t + W] = gp; queue[n++] = t + W; }
        }
        // supplied by sea?
        let seaFed = false;
        if (hasPort[p]) for (let k = s0; k < n && !seaFed; k++) if (game.isCoast(queue[k])) seaFed = true;
        if (seaFed) { n = s0; continue; } // drop the segment (its tiles keep mark gp: not revisited)
        segStart.push(s0); segEnd.push(n);
      }
    }
    // 3. flag the cut pockets (mark gc), clear flags that no longer apply
    const gc = ++gen;
    let cutCount = 0;
    for (let s = 0; s < segStart.length; s++) for (let k = segStart[s]; k < segEnd[s]; k++) {
      const t = queue[k];
      mark[t] = gc; setCut(t, p); cutCount++;
    }
    const old = cutLists[p];
    if (old) for (let k = 0; k < old.length; k++) {
      const t = old[k];
      if (cutOwner[t] === p && mark[t] !== gc) clearCut(t);
    }
    // 4. surrenders
    const hold = ADV.cutSurrenderTicks * (doctrineLevel(game, p, 'fortress') >= 3 ? 2 : 1);
    let kept = 0;
    const keep = new Int32Array(cutCount);
    for (let s = 0; s < segStart.length; s++) {
      let since = Infinity;
      for (let k = segStart[s]; k < segEnd[s]; k++) { const c = cutSince[queue[k]]; if (c < since) since = c; }
      if (game.tick - since < hold) {
        for (let k = segStart[s]; k < segEnd[s]; k++) keep[kept++] = queue[k];
        continue;
      }
      surrender(p, segStart[s], segEnd[s]);
    }
    cutLists[p] = kept ? keep.subarray(0, kept) : null;
    if (ap(p)) ap(p).cutTiles = kept;
  };

  /** The pocket queue[s0..s1) of p gives up. */
  const surrender = (p: PlayerId, s0: number, s1: number) => {
    const P = game.players[p];
    nbOwners.clear();
    let sx = 0, sy = 0;
    for (let k = s0; k < s1; k++) {
      const t = queue[k], x = t % W;
      sx += x; sy += (t / W) | 0;
      const see = (nb: number) => {
        const o = owner[nb];
        if (o === p || o === 0 || terrain[nb] === WATER) return;
        nbOwners.set(o, (nbOwners.get(o) ?? 0) + 1);
      };
      if (x > 0) see(t - 1);
      if (x < W - 1) see(t + 1);
      if (t >= W) see(t - W);
      if (t < N - W) see(t + W);
    }
    let to: PlayerId = 0, best = 0;
    for (const [o, c] of nbOwners) {
      if (!game.players[o].alive || game.areAllied(o, p)) continue;
      if (c > best || (c === best && o < to)) { best = c; to = o; }
    }
    const size = s1 - s0;
    if (P.tiles > 0) P.troops = Math.max(0, P.troops * (1 - size / P.tiles));
    // copy first: setOwner may trigger nothing that touches `queue`, but keep it simple and safe
    const tiles = queue.slice(s0, s1);
    for (let k = 0; k < tiles.length; k++) { clearCut(tiles[k]); game.setOwner(tiles[k], to); }
    const x = Math.round(sx / size), y = Math.round(sy / size);
    game.emit({ type: 'pocketLost', owner: p, to, tiles: size, x, y });
    if (size >= POCKET_MSG_MIN) {
      game.msg(`Una sacca accerchiata si è arresa (${size} caselle)`, 'danger', p, x, y);
      if (to) game.msg(`Una sacca nemica di ${P.name} si è arresa a te`, 'good', to, x, y);
    }
  };

  // ── capitals ─────────────────────────────────────────────────────────────
  const moveCapitalTo = (p: PlayerId, t: Tile) => {
    const a = ap(p);
    a.capital = t;
    hubsAt = -1; // hubs changed
    if (t >= 0) game.emit({ type: 'capitalMoved', owner: p, tile: t });
  };

  let graceUntil = new Int32Array(NP() + 1);
  const checkCapitals = () => {
    if (graceUntil.length < NP()) { const gu = new Int32Array(NP()); gu.set(graceUntil); graceUntil = gu; }
    const ps = game.players;
    for (let id = 1; id < ps.length; id++) {
      const P = ps[id], a = ap(id);
      if (!a || !P.alive) continue;
      const c = a.capital;
      if (c >= 0 && owner[c] === id) continue;
      if (c >= 0 && game.tick < graceUntil[id]) {
        // still reeling from the last loss: the government just flees again
      } else if (c >= 0) {
        graceUntil[id] = game.tick + CAPITAL_GRACE;
        const by = owner[c];
        const loss = doctrineLevel(game, id, 'fortress') >= 3 ? ADV.capitalLossFortress : ADV.capitalLossTroops;
        P.troops = Math.max(0, P.troops * (1 - loss));
        if (by && ps[by].alive) {
          const loot = P.gold * ADV.capitalLootGold;
          P.gold -= loot; ps[by].gold += loot;
          game.msg(`Hai conquistato la capitale di ${P.name}!`, 'good', by, c % W, (c / W) | 0);
        }
        game.emit({ type: 'capitalLost', owner: id, by, tile: c });
        game.msg(by ? `${ps[by].name} ha preso la tua capitale!` : 'La tua capitale è stata distrutta!', 'danger', id, c % W, (c / W) | 0);
      }
      if (P.tiles > 0) moveCapitalTo(id, pickCapitalTile(id));
    }
  };

  const canMoveCapital = (p: PlayerId, cityTile: Tile): string | null => {
    const P = game.players[p], a = ap(p);
    if (!P || !P.alive || !a) return 'Giocatore eliminato';
    const s = game.structureAt.get(cityTile);
    if (!s || s.type !== 'city' || s.owner !== p || owner[cityTile] !== p) return 'Serve una tua città';
    if (s.readyTick > game.tick) return 'Città in costruzione';
    if (a.capital === cityTile) return 'È già la capitale';
    if (P.gold < ADV.capitalMoveCost) return 'Oro insufficiente';
    return null;
  };
  adv.q.canMoveCapital = canMoveCapital;
  adv.cmd.moveCapital = (p, cityTile) => {
    if (canMoveCapital(p, cityTile) !== null) return false;
    game.players[p].gold -= ADV.capitalMoveCost;
    moveCapitalTo(p, cityTile);
    return true;
  };

  // ── rebellion ────────────────────────────────────────────────────────────
  const rebel = (p: PlayerId) => {
    const P = game.players[p];
    if (!P.alive || P.tiles <= game.landTiles * ADV.rebelShare) return;
    const t0 = farTile[p];
    if (t0 < 0 || owner[t0] !== p) return;
    freshHubs();
    const cx = t0 % W, cy = (t0 / W) | 0;
    if (hubDist(p, cx, cy) <= ADV.rebelDistance) return;
    let h = Math.imul(game.tick ^ (p * 0x9e3779b1), 0x85ebca6b); h ^= h >>> 13;
    const r = 9 + ((h >>> 0) % 7), r2 = r * r + 0.5;
    let n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const t = y * W + x;
      if (owner[t] !== p) continue;
      queue[n++] = t;
    }
    if (!n) return;
    P.troops = Math.max(0, P.troops * (1 - n / P.tiles));
    for (let k = 0; k < n; k++) { clearCut(queue[k]); game.setOwner(queue[k], 0); }
    farTile[p] = -1;
    game.emit({ type: 'rebellion', owner: p, x: cx, y: cy, tiles: n });
    game.msg(`Rivolta in una provincia lontana: ${n} caselle perse`, 'danger', p, cx, cy);
  };

  // ── hooks ────────────────────────────────────────────────────────────────
  game.hooks.attackMul.push((a, tile) => {
    const e = a.ext;
    if (e.supplyTick !== undefined && game.tick - e.supplyTick < SUPPLY_CACHE) return e.supply as number;
    e.supplyTick = game.tick;
    e.supply = supply(a.attacker, tile);
    return e.supply as number;
  });
  const CR2 = ADV.capitalRadius * ADV.capitalRadius;
  game.hooks.defenseMul.push((t, o) => {
    if (!o) return 1;
    let m = 1;
    if (cut[t] === 1 && cutOwner[t] === o) m *= ADV.cutDefense;
    const c = adv.players[o]?.capital ?? -1;
    if (c >= 0) {
      const dx = c % W - t % W, dy = ((c / W) | 0) - ((t / W) | 0);
      if (dx * dx + dy * dy <= CR2) m *= ADV.capitalDefense;
    }
    return m;
  });

  game.on(ev => {
    if (ev.type === 'playerDied') {
      clearList(ev.id);
      if (ap(ev.id)) ap(ev.id).capital = -1;
    } else if ((ev.type === 'structureBuilt' || ev.type === 'structureDestroyed' || ev.type === 'structureCaptured') &&
      (ev.structure.type === 'city' || ev.structure.type === 'port')) {
      hubsAt = -1;
    }
  });

  rebuildHubs(); hubsAt = game.tick;

  game.systems.push({
    name: 'adv-supply',
    tick() {
      ensure();
      checkCapitals();
      freshHubs();
      const tick = game.tick, n = NP(), per = ADV.supplyScanPeriod;
      for (let id = 1 + (tick % per); id < n; id += per) scan(id);
      if (tick % CLEAN_PERIOD === 0) {
        for (let id = 1; id < n; id++) {
          const L = cutLists[id];
          if (!L) continue;
          let lost = 0;
          for (let k = 0; k < L.length; k++) {
            const t = L[k];
            if (cutOwner[t] === id && owner[t] !== id) { clearCut(t); lost++; }
            else if (cutOwner[t] !== id) lost++;
          }
          if (lost && ap(id)) ap(id).cutTiles = Math.max(0, L.length - lost);
        }
      }
      for (let id = 1 + ((tick * 7) % ADV.rebelPeriod); id < n; id += ADV.rebelPeriod) rebel(id);
    },
  });
}
