// ADVANCED MODE — fleet: warships, naval combat, blockades. See docs/ADVANCED.md §5. Owner: SEA agent.
//
// Warships are Units of type 'warship' (ext.hp, ext.maxHp, ext.patrol {x,y}); the classic naval system never
// sees them (it only tracks the transports/trade ships it created). Routes come from the classic WaterNav
// (game.ext.naval.nav, cached two-level A*); uncached searches are limited to ROUTE_MISSES_PER_TICK per tick.
// Combat is resolved every COMBAT_PERIOD ticks per ship (staggered by unit id).
import { mulberry32, type Game } from '../game';
import { WATER, type GameOptions, type PlayerId, type Structure, type Tile, type Unit } from '../types';
import type { WaterNav } from '../naval';
import { ADV, doctrineLevel } from './rules';

// ── tuning (only this module reads these) ───────────────────────────────────
/** Ticks between two shots of the same warship. */
const COMBAT_PERIOD = 5;
/** Damage of one shot against a warship (±20%): a 100 HP ship survives ~7 s against one enemy. */
const SHOT_DAMAGE = 7;
/** Share of a transport's initial troops lost per shot (min TRANSPORT_MIN_LOSS): sunk in ~2.5 s by one warship. */
const TRANSPORT_LOSS = 0.2;
const TRANSPORT_MIN_LOSS = 30;
/** "At war" lasts this long after the last active attack / landing / nuke between the two. */
const WAR_MEMORY = 600;
/** Uncached route searches per tick for all warships together. */
const ROUTE_MISSES_PER_TICK = 2;
/** Blockade status of a port is recomputed at most this often. */
const BLOCKADE_CACHE_TICKS = 5;
/** Ports are checked for blockade changes (messages) this often. */
const BLOCKADE_SCAN_PERIOD = 20;
/** A ship pursues a hostile warship/transport it has fired at while it stays within this many × warshipRange (straight line, open water only). */
const CHASE_RANGE = 2;
/** Pursuit stops this close to the target. */
const CHASE_STOP = 4;

interface ShipExt {
  hp: number; maxHp: number; patrol: { x: number; y: number };
  path: number[] | null; pathIndex: number;
  /** Tick before which the ship idles (also used to retry a route when the search budget was used up). */
  wait: number;
  /** Explicit destination of a sendFleet order, reached before patrolling around it. */
  goto: Tile;
  ordered: boolean;
  /** Last water tile the ship was known to be on. */
  at: Tile;
  /** Unit being pursued (null = none). */
  chase: Unit | null;
}

export function installFleet(game: Game, opts: GameOptions): void {
  const adv = game.adv!;
  const W = game.W, H = game.H, N = game.N, terrain = game.terrain, owner = game.owner;
  const nav = game.ext.naval?.nav as WaterNav | undefined;
  const comp = nav ? nav.comp : new Int32Array(N);
  const rng = mulberry32(((opts.seed ?? 1) ^ 0x0f1ee7) >>> 0);

  const ships: Unit[] = [];
  const owned = new Map<PlayerId, number>();
  let routeMisses = 0;

  // ── war / hostility ──────────────────────────────────────────────────────
  const lastWar = new Map<number, number>();
  const pairKey = (a: PlayerId, b: PlayerId) => (a < b ? a * 65536 + b : b * 65536 + a);
  const markWar = (a: PlayerId, b: PlayerId) => { if (a && b && a !== b) lastWar.set(pairKey(a, b), game.tick); };
  function atWar(a: PlayerId, b: PlayerId): boolean {
    const t = lastWar.get(pairKey(a, b));
    return t !== undefined && game.tick - t <= WAR_MEMORY + 10;
  }
  function hostile(a: PlayerId, b: PlayerId): boolean {
    if (!a || !b || a === b) return false;
    const A = game.players[a], B = game.players[b];
    if (!A || !B || !A.alive || !B.alive || game.areAllied(a, b)) return false;
    if (adv.q.pact(a, b)) return false;
    return atWar(a, b) || A.embargoes.has(b) || B.embargoes.has(a);
  }
  const friendly = (a: PlayerId, b: PlayerId) => a === b || game.areAllied(a, b);

  // ── costs / capacity ─────────────────────────────────────────────────────
  const count = (p: PlayerId) => owned.get(p) ?? 0;
  function fleetCap(p: PlayerId): number {
    const ap = adv.players[p];
    if (!ap) return 0;
    let ports = 0;
    for (const s of game.structures) if (s.owner === p && s.type === 'port' && s.readyTick <= game.tick) ports++;
    return Math.min(ADV.warshipCapMax, 1 + ports + Math.min(ap.res.oil, ADV.oilMax));
  }
  function warshipCost(p: PlayerId): number {
    const m = doctrineLevel(game, p, 'projection') >= 2 ? 0.75 : 1;
    return Math.round(ADV.warshipCost * (1 + ADV.warshipCostGrowth * count(p)) * m);
  }
  function maxHpOf(p: PlayerId): number {
    return ADV.warshipHp * (doctrineLevel(game, p, 'projection') >= 2 ? ADV.warshipHpProjection : 1);
  }

  /** Water tile next to the port in the biggest sea. */
  function portWater(tile: Tile): Tile {
    let best = -1, bs = -1;
    const x = tile % W;
    const test = (n: Tile) => {
      if (terrain[n] !== WATER) return;
      const s = nav ? nav.compSize[comp[n]] : 1;
      if (s > bs) { bs = s; best = n; }
    };
    if (x > 0) test(tile - 1);
    if (x < W - 1) test(tile + 1);
    if (tile >= W) test(tile - W);
    if (tile < N - W) test(tile + W);
    return best;
  }

  function canBuildWarship(p: PlayerId, portTile: Tile): string | null {
    const pl = game.players[p], ap = adv.players[p];
    if (!pl || !pl.alive || !ap) return 'Non sei in gioco';
    if (!nav) return 'Non disponibile';
    const s = game.structureAt.get(portTile);
    if (!s || s.type !== 'port' || s.owner !== p) return 'Serve un tuo porto';
    if (s.readyTick > game.tick) return 'Porto in costruzione';
    if (ap.res.oil < 1) return 'Serve un giacimento di petrolio';
    if (count(p) >= fleetCap(p)) return 'Flotta al completo';
    if (isBlockaded(s)) return 'Porto bloccato';
    if (portWater(portTile) < 0) return 'Porto senza sbocco sul mare';
    if (pl.gold < warshipCost(p)) return 'Oro insufficiente';
    return null;
  }

  function buildWarship(p: PlayerId, portTile: Tile): boolean {
    if (canBuildWarship(p, portTile) !== null) return false;
    const pl = game.players[p];
    pl.gold -= warshipCost(p);
    const w = portWater(portTile);
    const u = game.addUnit('warship', p, portTile, w, 0);
    u.x = w % W; u.y = (w / W) | 0;
    const hp = maxHpOf(p);
    const e: ShipExt = { hp, maxHp: hp, patrol: { x: u.x, y: u.y }, path: null, pathIndex: 0, wait: game.tick + 5, goto: -1, ordered: false, at: w, chase: null };
    Object.assign(u.ext, e);
    ships.push(u);
    owned.set(p, count(p) + 1);
    game.msg('⚓ Nave da guerra varata', 'good', p, u.x, u.y);
    return true;
  }

  // ── orders ───────────────────────────────────────────────────────────────
  function canSendFleet(p: PlayerId, seaTile: Tile): string | null {
    const pl = game.players[p];
    if (!pl || !pl.alive) return 'Non sei in gioco';
    if (!Number.isInteger(seaTile) || seaTile < 0 || seaTile >= N) return 'Bersaglio non valido';
    if (terrain[seaTile] !== WATER) return 'Scegli un punto di mare';
    if (!count(p)) return 'Non hai navi da guerra';
    if (!pickShip(p, seaTile)) return 'Mare non raggiungibile';
    return null;
  }
  function pickShip(p: PlayerId, seaTile: Tile): Unit | null {
    const c = comp[seaTile], sx = seaTile % W, sy = (seaTile / W) | 0;
    let best: Unit | null = null, bd = Infinity;
    for (const u of ships) {
      if (u.owner !== p || !u.alive || comp[u.ext.at] !== c) continue;
      const d = (u.x - sx) ** 2 + (u.y - sy) ** 2 + (u.ext.ordered ? 1e9 : 0); // prefer ships still at home
      if (d < bd) { bd = d; best = u; }
    }
    return best;
  }
  function sendFleet(p: PlayerId, seaTile: Tile): boolean {
    if (canSendFleet(p, seaTile) !== null) return false;
    const u = pickShip(p, seaTile)!;
    const e = u.ext as ShipExt;
    e.patrol = { x: seaTile % W, y: (seaTile / W) | 0 };
    e.goto = seaTile; e.ordered = true; e.path = null; e.wait = 0;
    return true;
  }

  // ── movement ─────────────────────────────────────────────────────────────
  function patrolDest(u: Unit): Tile {
    const e = u.ext as ShipExt, c = comp[e.at];
    for (let t = 0; t < 8; t++) {
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * ADV.patrolRadius;
      const x = Math.round(e.patrol.x + Math.cos(a) * r), y = Math.round(e.patrol.y + Math.sin(a) * r);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (comp[i] === c && i !== e.at) return i;
    }
    const pi = Math.round(e.patrol.y) * W + Math.round(e.patrol.x);
    return comp[pi] === c && pi !== e.at ? pi : -1;
  }
  function chase(u: Unit, e: ShipExt): boolean {
    const v = e.chase!;
    const dx = v.x - u.x, dy = v.y - u.y, d = Math.sqrt(dx * dx + dy * dy);
    const lim = ADV.warshipRange * CHASE_RANGE;
    const vi = Math.round(v.y) * W + Math.round(v.x);
    if (!v.alive || d > lim || !hostile(u.owner, v.owner) || terrain[vi] !== WATER || comp[vi] !== comp[e.at] || !nav || !nav.los(e.at, vi)) { e.chase = null; return false; }
    if (d > CHASE_STOP) {
      const s = Math.min(ADV.warshipSpeed, d - CHASE_STOP);
      const nx = u.x + (dx / d) * s, ny = u.y + (dy / d) * s;
      const ri = Math.round(ny) * W + Math.round(nx);
      if (terrain[ri] !== WATER) { e.chase = null; return false; }
      u.x = nx; u.y = ny; e.at = ri;
    }
    e.path = null; e.wait = game.tick + 10; // back to patrolling after the chase
    return true;
  }
  function move(u: Unit): void {
    const e = u.ext as ShipExt;
    if (e.chase && chase(u, e)) return;
    if (!e.path) {
      if (game.tick < e.wait || !nav) return;
      if (routeMisses >= ROUTE_MISSES_PER_TICK) return; // try again next tick
      const dest = e.goto >= 0 ? e.goto : patrolDest(u);
      e.goto = -1;
      if (dest < 0) { e.wait = game.tick + 30; return; }
      const path = nav.route(e.at, dest);
      if (nav.lastMiss) routeMisses++;
      if (!path || path.length < 2) { e.wait = game.tick + 30; return; }
      e.path = path; e.pathIndex = 1; u.toTile = dest;
    }
    const path = e.path;
    let k = e.pathIndex, s: number = ADV.warshipSpeed, x = u.x, y = u.y;
    while (s > 1e-9 && k < path.length) {
      const t = path[k], tx = t % W, ty = (t - tx) / W;
      const dx = tx - x, dy = ty - y, d = Math.sqrt(dx * dx + dy * dy);
      if (d <= s) { x = tx; y = ty; s -= d; k++; e.at = t; }
      else { x += (dx / d) * s; y += (dy / d) * s; s = 0; }
    }
    u.x = x; u.y = y; e.pathIndex = k;
    const ri = Math.round(y) * W + Math.round(x);
    if (terrain[ri] === WATER) e.at = ri;
    if (k >= path.length) { e.path = null; e.wait = game.tick + 20 + Math.floor(rng() * 40); }
  }

  // ── combat ───────────────────────────────────────────────────────────────
  const targets: Unit[] = [];
  const R2 = ADV.warshipRange * ADV.warshipRange;
  const prio = (t: string) => (t === 'warship' ? 0 : t === 'transport' ? 1 : 2);
  function sink(v: Unit, by: PlayerId): void {
    game.removeUnit(v);
    game.emit({ type: 'warshipSunk', unit: v, by });
    const x = Math.round(v.x), y = Math.round(v.y);
    game.msg('⚓ Nave da guerra affondata', 'danger', v.owner, x, y);
    if (by && by !== v.owner) game.msg(`⚓ Affondata una nave da guerra di ${game.players[v.owner].name}`, 'good', by, x, y);
  }
  function fire(u: Unit): void {
    let best: Unit | null = null, bp = 9, bd = Infinity;
    for (const v of targets) {
      if (!v.alive || v.owner === u.owner) continue;
      const d = (v.x - u.x) ** 2 + (v.y - u.y) ** 2;
      if (d > R2) continue;
      const pr = prio(v.type);
      if (pr > bp || (pr === bp && d >= bd)) continue;
      if (!hostile(u.owner, v.owner)) continue;
      best = v; bp = pr; bd = d;
    }
    if (!best) return;
    const v = best;
    if (v.type !== 'trade') (u.ext as ShipExt).chase = v;
    if (v.type === 'warship') {
      v.ext.hp -= SHOT_DAMAGE * (0.8 + 0.4 * rng());
      if (v.ext.hp <= 0) sink(v, u.owner);
    } else if (v.type === 'transport') {
      if (!v.ext.fleetT0) {
        v.ext.fleetT0 = v.troops;
        game.msg('⚓ Il nostro trasporto è sotto il fuoco nemico', 'warn', v.owner, Math.round(v.x), Math.round(v.y));
      }
      v.troops = Math.floor(v.troops - Math.max(TRANSPORT_MIN_LOSS, v.ext.fleetT0 * TRANSPORT_LOSS));
      if (v.troops <= 0) {
        v.troops = 0;
        game.removeUnit(v);
        const x = Math.round(v.x), y = Math.round(v.y);
        game.msg('⚓ Trasporto affondato', 'danger', v.owner, x, y);
        game.msg(`⚓ Affondato un trasporto di ${game.players[v.owner].name}`, 'good', u.owner, x, y);
      }
    } else game.removeUnit(v); // trade ship
  }

  // ── blockade ─────────────────────────────────────────────────────────────
  const blk = new Map<number, { t: number; v: boolean }>();
  const BR2 = ADV.blockadeRadius * ADV.blockadeRadius;
  function isBlockaded(port: Structure): boolean {
    if (!ships.length || port.type !== 'port') return false;
    const c = blk.get(port.id);
    if (c && game.tick - c.t < BLOCKADE_CACHE_TICKS) return c.v;
    let dh = Infinity, df = Infinity;
    const o = port.owner;
    for (const u of ships) {
      if (!u.alive) continue;
      const d = (u.x - port.x) ** 2 + (u.y - port.y) ** 2;
      if (friendly(o, u.owner)) { if (d < df) df = d; }
      else if (d <= BR2 && d < dh && hostile(u.owner, o)) dh = d;
    }
    const v = dh <= BR2 && !(df < dh);
    blk.set(port.id, { t: game.tick, v });
    return v;
  }
  function scanBlockades(): void {
    for (const s of game.structures) {
      if (s.type !== 'port') continue;
      const v = isBlockaded(s);
      if (v === !!s.ext.fleetBlk) continue;
      s.ext.fleetBlk = v;
      game.markChanged(s.tile);
      if (s.readyTick <= game.tick) game.msg(v ? '⚓ Un nostro porto è sotto blocco navale' : '⚓ Blocco navale terminato', v ? 'danger' : 'good', s.owner, s.x, s.y);
    }
  }

  // ── events ───────────────────────────────────────────────────────────────
  function drop(u: Unit): void {
    if (u.alive) game.removeUnit(u);
  }
  game.on(ev => {
    switch (ev.type) {
      case 'attackStarted': markWar(ev.attack.attacker, ev.attack.target); break;
      case 'boatLaunched': markWar(ev.unit.owner, owner[ev.unit.toTile]); break;
      case 'explosion': {
        for (const v of ev.victims) markWar(ev.owner, v);
        const r2 = ev.radius * ev.radius;
        for (const u of ships) if (u.alive && (u.x - ev.x) ** 2 + (u.y - ev.y) ** 2 <= r2) sink(u, ev.owner);
        break;
      }
      case 'playerDied':
        for (const u of ships) if (u.owner === ev.id) drop(u);
        owned.delete(ev.id);
        break;
      case 'doctrineDone':
        if (ev.branch === 'projection' && ev.level === 2) {
          for (const u of ships) if (u.owner === ev.player && u.alive) {
            u.ext.maxHp *= ADV.warshipHpProjection; u.ext.hp *= ADV.warshipHpProjection;
          }
        }
        break;
    }
  });

  // ── tick ─────────────────────────────────────────────────────────────────
  game.systems.push({
    name: 'adv.fleet',
    tick() {
      if (game.tick % 10 === 0) for (const a of game.attacks) if (a.alive && a.target) markWar(a.attacker, a.target);
      if (!ships.length) return;
      routeMisses = 0;
      // combat targets: every ship-like unit (warships, transports, trade ships)
      targets.length = 0;
      for (const v of game.units) if (v.alive && (v.type === 'warship' || v.type === 'transport' || v.type === 'trade')) targets.push(v);
      const phase = game.tick % COMBAT_PERIOD;
      for (const u of ships) {
        if (!u.alive) continue;
        move(u);
        if (u.id % COMBAT_PERIOD === phase) fire(u);
      }
      // drop sunk ships
      let n = 0;
      for (let k = 0; k < ships.length; k++) {
        const u = ships[k];
        if (u.alive && game.players[u.owner].alive) ships[n++] = u;
        else { drop(u); const c = count(u.owner) - 1; if (c > 0) owned.set(u.owner, c); else owned.delete(u.owner); }
      }
      ships.length = n;
      if (game.tick % BLOCKADE_SCAN_PERIOD === 0) scanBlockades();
    },
  });
  // ports that lose their last blockader must be released too
  game.systems.push({
    name: 'adv.fleet.blockade',
    tick() { if (!ships.length && game.tick % BLOCKADE_SCAN_PERIOD === 0 && blk.size) { scanBlockades(); blk.clear(); } },
  });

  game.hooks.portBlocked.push(isBlockaded);

  adv.cmd.buildWarship = buildWarship;
  adv.cmd.sendFleet = sendFleet;
  adv.q.warshipCost = warshipCost;
  adv.q.fleetCap = fleetCap;
  adv.q.canBuildWarship = canBuildWarship;
  adv.q.canSendFleet = canSendFleet;
  adv.q.isBlockaded = isBlockaded;
  /** Helpers for the advanced AI / UI. */
  game.ext.fleet = {
    ships: (p?: PlayerId) => (p === undefined ? ships.filter(u => u.alive) : ships.filter(u => u.alive && u.owner === p)),
    count,
    atWar,
    hostile,
  };
}
