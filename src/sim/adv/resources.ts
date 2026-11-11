// ADVANCED MODE — strategic resources (oil, iron, uranium). See docs/ADVANCED.md §4. Owner: SEA agent.
//
// Deposits are placed once at install, deterministically from the game seed with a PRIVATE rng (game.rng is
// never touched). Every land mass of meaningful size gets at least one deposit; the rest are spread uniformly
// over the land, at least ADV.depositMinDist apart and away from spawn points.
// Ownership is tracked by polling the (few dozen) deposit tiles once per tick: O(deposits), no map scans.
import { mulberry32, type Game } from '../game';
import { WATER, type GameOptions, type NukeKind, type PlayerId, type Tile } from '../types';
import { ADV } from './rules';
import { RESOURCE_KINDS, RESOURCE_LABEL, type Deposit, type ResourceKind } from './types';

/** Land masses with at least this many tiles (or this share of all land) are guaranteed a deposit. */
const CONTINENT_MIN_TILES = 1500;
const CONTINENT_MIN_SHARE = 0.004;
/** No deposit within this many tiles of a player's spawn point. */
const SPAWN_CLEAR = 9;

export function installResources(game: Game, opts: GameOptions): void {
  const adv = game.adv!;
  const W = game.W, H = game.H, N = game.N, terrain = game.terrain, owner = game.owner;
  const rng = mulberry32(((opts.seed ?? 1) ^ 0x5eed0d1) >>> 0);

  // ── placement ────────────────────────────────────────────────────────────
  // land masses (4-connected)
  const mass = new Int32Array(N);
  const massSize: number[] = [0];
  const massBox: [number, number, number, number][] = [[0, 0, 0, 0]];
  {
    const queue = new Int32Array(N);
    let id = 0;
    for (let s = 0; s < N; s++) {
      if (terrain[s] === WATER || mass[s]) continue;
      id++;
      let qh = 0, qt = 0;
      let x0 = W, y0 = H, x1 = 0, y1 = 0;
      queue[qt++] = s; mass[s] = id;
      while (qh < qt) {
        const i = queue[qh++];
        const x = i % W, y = (i - x) / W;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0 && terrain[i - 1] !== WATER && !mass[i - 1]) { mass[i - 1] = id; queue[qt++] = i - 1; }
        if (x < W - 1 && terrain[i + 1] !== WATER && !mass[i + 1]) { mass[i + 1] = id; queue[qt++] = i + 1; }
        if (i >= W && terrain[i - W] !== WATER && !mass[i - W]) { mass[i - W] = id; queue[qt++] = i - W; }
        if (i < N - W && terrain[i + W] !== WATER && !mass[i + W]) { mass[i + W] = id; queue[qt++] = i + W; }
      }
      massSize.push(qt);
      massBox.push([x0, y0, x1, y1]);
    }
  }

  const spawns: [number, number][] = [];
  for (let id = 1; id < game.players.length; id++) spawns.push([game.players[id].spawnX, game.players[id].spawnY]);
  const deposits = adv.deposits;
  const byTile = new Map<Tile, Deposit>();

  function okSpot(i: Tile, minDist: number): boolean {
    if (terrain[i] === WATER || byTile.has(i)) return false;
    const x = i % W, y = (i - x) / W;
    const sc = SPAWN_CLEAR * SPAWN_CLEAR;
    for (const [sx, sy] of spawns) if ((sx - x) ** 2 + (sy - y) ** 2 < sc) return false;
    const md = minDist * minDist;
    for (const d of deposits) if ((d.x - x) ** 2 + (d.y - y) ** 2 < md) return false;
    return true;
  }
  function place(kind: ResourceKind, i: Tile): void {
    const d: Deposit = { id: deposits.length + 1, kind, x: i % W, y: (i / W) | 0, tile: i };
    deposits.push(d);
    byTile.set(i, d);
  }
  /** Random land tile of land mass m (or of any land when m = 0), respecting distances; relaxes them if crowded. */
  function pick(m: number): Tile {
    let minDist: number = ADV.depositMinDist;
    for (let round = 0; round < 4; round++, minDist /= 2) {
      for (let t = 0; t < 1500; t++) {
        let i: number;
        if (m) {
          const [x0, y0, x1, y1] = massBox[m];
          i = (y0 + Math.floor(rng() * (y1 - y0 + 1))) * W + x0 + Math.floor(rng() * (x1 - x0 + 1));
          if (mass[i] !== m) continue;
        } else i = Math.floor(rng() * N);
        if (okSpot(i, minDist)) return i;
      }
    }
    return -1;
  }

  const want: Record<ResourceKind, number> = { oil: 0, iron: 0, uranium: 0 };
  for (const k of RESOURCE_KINDS) want[k] = Math.max(1, Math.round((game.landTiles / 100_000) * ADV.depositsPer100k[k]));
  const placed: Record<ResourceKind, number> = { oil: 0, iron: 0, uranium: 0 };
  // 1. one deposit per significant land mass, biggest first, kinds in rotation (oil, iron, uranium, …)
  const minMass = Math.min(CONTINENT_MIN_TILES, Math.max(200, game.landTiles * CONTINENT_MIN_SHARE));
  const masses: number[] = [];
  for (let m = 1; m < massSize.length; m++) if (massSize[m] >= minMass) masses.push(m);
  masses.sort((a, b) => massSize[b] - massSize[a] || a - b);
  let rot = Math.floor(rng() * 3);
  for (const m of masses) {
    const kind = RESOURCE_KINDS[rot++ % 3];
    const i = pick(m);
    if (i >= 0) { place(kind, i); placed[kind]++; }
  }
  // 2. the rest uniformly over the land
  for (const k of RESOURCE_KINDS) {
    while (placed[k] < want[k]) {
      const i = pick(0);
      if (i < 0) break;
      place(k, i); placed[k]++;
    }
  }

  // ── ownership tracking ───────────────────────────────────────────────────
  const depOwner = new Uint16Array(deposits.length);
  const res = (p: PlayerId) => adv.players[p]?.res;
  for (let k = 0; k < deposits.length; k++) {
    const o = owner[deposits[k].tile];
    depOwner[k] = o;
    const r = o ? res(o) : undefined;
    if (r) r[deposits[k].kind]++;
  }
  function sync(): void {
    for (let k = 0; k < deposits.length; k++) {
      const d = deposits[k];
      const o = owner[d.tile], prev = depOwner[k];
      if (o === prev) continue;
      depOwner[k] = o;
      const rp = prev ? res(prev) : undefined;
      if (rp && rp[d.kind] > 0) rp[d.kind]--;
      const ro = o ? res(o) : undefined;
      if (ro) ro[d.kind]++;
      if (o) {
        game.emit({ type: 'depositCaptured', deposit: d, owner: o, previousOwner: prev });
        game.msg(`⛏ Conquistato un giacimento di ${RESOURCE_LABEL[d.kind]}`, 'good', o, d.x, d.y);
      }
      if (prev && game.players[prev].alive) game.msg(`⛏ Perso un giacimento di ${RESOURCE_LABEL[d.kind]}`, 'warn', prev, d.x, d.y);
    }
  }
  game.systems.push({ name: 'adv.resources', tick: sync });
  game.on(ev => {
    if (ev.type === 'playerDied') { const r = res(ev.id); if (r) r.oil = r.iron = r.uranium = 0; }
  });

  // ── effects (hooks) ──────────────────────────────────────────────────────
  const total = (p: PlayerId) => { const r = res(p); return r ? r.oil + r.iron + r.uranium : 0; };
  game.hooks.goldRateAdd.push(p => total(p) * ADV.depositGold);
  game.hooks.attackMul.push(a => {
    const r = res(a.attacker);
    return r && r.iron > 0 ? 1 + ADV.ironAttack * Math.min(r.iron, ADV.ironMax) : 1;
  });
  game.hooks.boatCapAdd.push(p => { const r = res(p); return r ? Math.min(r.oil, ADV.oilMax) : 0; });
  game.hooks.boatSpeedMul.push(p => { const r = res(p); return r && r.oil > 0 ? 1 : ADV.noOilBoatSpeed; });
  game.hooks.forbidNuke.push((p: PlayerId, kind: NukeKind) => {
    const need = ADV.uranium[kind] ?? 1;
    const have = res(p)?.uranium ?? 0;
    if (have >= need) return null;
    return need === 1 ? 'Serve un giacimento di uranio' : `Servono ${need} giacimenti di uranio`;
  });

  adv.q.depositAt = (tile: Tile) => byTile.get(tile) ?? null;
  game.ext.advResources = { landMass: mass };
}
