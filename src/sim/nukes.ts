// CAPTURE — nukes: silo launches, flying warheads, SAM interception, detonation, fallout decay.
// Owner: naval/nukes agent.
import type { Game } from './game';
import { WATER, type NukeKind, type PlayerId, type Structure, type Tile, type Unit } from './types';

// ── tuning ──────────────────────────────────────────────────────────────────
export const NUKE_COST: Record<NukeKind, number> = { atom: 1500, hydrogen: 7000 };
export const NUKE_RADIUS: Record<NukeKind, number> = { atom: 12, hydrogen: 30 };
/** Tiles per tick. */
export const NUKE_SPEED = 3;
/** Silo reload (ticks). */
export const SILO_RELOAD = 150;
export const SAM_RANGE = 45;
/** SAM reload (ticks), applied after every shot, hit or miss. */
export const SAM_RELOAD = 120;
export const SAM_ODDS: Record<NukeKind, number> = { atom: 0.7, hydrogen: 0.35 };
/** Fallout: each tile is visited every FALLOUT_PERIOD ticks and loses ~FALLOUT_STEP (+0..1). */
const FALLOUT_PERIOD = 10;
const FALLOUT_STEP = 3;
/** Visible fallout bands (renderer repaints only when a tile crosses one). */
const band = (v: number) => (v === 0 ? 0 : v <= 85 ? 1 : v <= 170 ? 2 : 3);

export function installNukes(game: Game): void {
  const W = game.W, H = game.H, N = game.N, terrain = game.terrain, owner = game.owner, fallout = game.fallout;
  const nukes: Unit[] = [];
  let sams: Structure[] = [];
  let samsTick = -1e9;

  // fallout work list (tiles with fallout > 0)
  let fList = new Int32Array(4096);
  let fLen = 0, fCur = 0;
  // pick up fallout that might already exist (e.g. a restored game)
  for (let i = 0; i < N; i++) if (fallout[i]) pushFallout(i);

  function pushFallout(i: Tile): void {
    if (fLen === fList.length) { const n = new Int32Array(fLen * 2); n.set(fList); fList = n; }
    fList[fLen++] = i;
  }

  const validKind = (k: string): k is NukeKind => k === 'atom' || k === 'hydrogen';
  const nukeCost = (_p: PlayerId, kind: NukeKind) => NUKE_COST[kind] ?? Infinity;
  const nukeRadius = (kind: NukeKind) => NUKE_RADIUS[kind] ?? 0;

  function readySilo(p: PlayerId, target: Tile): Structure | null | 'reload' {
    let best: Structure | null = null, bd = Infinity, any = false;
    const tx = target % W, ty = (target / W) | 0;
    for (const s of game.structures) {
      if (s.owner !== p || s.type !== 'silo' || s.readyTick > game.tick) continue;
      any = true;
      if (s.cooldownUntil > game.tick) continue;
      const d = (s.x - tx) ** 2 + (s.y - ty) ** 2;
      if (d < bd) { bd = d; best = s; }
    }
    return best ?? (any ? 'reload' : null);
  }

  function canNuke(p: PlayerId, kind: NukeKind, target: Tile): string | null {
    const pl = game.players[p];
    if (!pl || !pl.alive) return 'Non sei in gioco';
    if (!validKind(kind)) return 'Arma sconosciuta';
    if (!Number.isInteger(target) || target < 0 || target >= N) return 'Bersaglio non valido';
    const o = owner[target];
    if (o === p) return 'È il tuo territorio';
    if (game.areAllied(p, o)) return 'È un tuo alleato';
    const silo = readySilo(p, target);
    if (silo === null) return 'Nessun silo';
    if (silo === 'reload') return 'Silo in ricarica';
    if (pl.gold < NUKE_COST[kind]) return 'Oro insufficiente';
    return null;
  }

  function launchNuke(p: PlayerId, kind: NukeKind, target: Tile): boolean {
    if (canNuke(p, kind, target) !== null) return false;
    const silo = readySilo(p, target) as Structure;
    const pl = game.players[p];
    pl.gold -= NUKE_COST[kind];
    silo.cooldownUntil = game.tick + SILO_RELOAD;
    const tx = target % W, ty = (target / W) | 0;
    const u = game.addUnit(kind, p, silo.tile, target, 0);
    const dist = Math.max(1, Math.hypot(tx - silo.x, ty - silo.y));
    u.ext.sx = silo.x; u.ext.sy = silo.y;
    u.ext.tx = tx; u.ext.ty = ty;
    u.ext.dist = dist;
    u.ext.traveled = 0;
    u.ext.progress = 0;
    u.ext.radius = NUKE_RADIUS[kind];
    u.ext.speed = NUKE_SPEED;
    nukes.push(u);
    game.emit({ type: 'nukeLaunched', unit: u });
    const o = owner[target];
    if (o) game.msg(`☢ Missile in arrivo da ${pl.name}`, 'danger', o, tx, ty);
    return true;
  }

  /** Does SAM s defend the area this nuke is heading to? (its owner's/allies' land, or near the SAM) */
  function samCares(s: Structure, u: Unit): boolean {
    const o = owner[u.toTile];
    if (o && (o === s.owner || game.areAllied(o, s.owner))) return true;
    const reach = SAM_RANGE + (u.ext.radius as number);
    return (u.ext.tx - s.x) ** 2 + (u.ext.ty - s.y) ** 2 <= reach * reach;
  }

  function trySam(u: Unit): boolean {
    const R2 = SAM_RANGE * SAM_RANGE;
    for (const s of sams) {
      if (s.readyTick > game.tick || s.cooldownUntil > game.tick) continue;
      if (s.owner === u.owner || game.areAllied(s.owner, u.owner)) continue;
      if ((u.x - s.x) ** 2 + (u.y - s.y) ** 2 > R2) continue;
      if (game.structureAt.get(s.tile) !== s || !game.players[s.owner].alive) continue;
      if (!samCares(s, u)) continue;
      s.cooldownUntil = game.tick + SAM_RELOAD;
      if (game.rng() < SAM_ODDS[u.type as NukeKind]) {
        game.removeUnit(u);
        game.emit({ type: 'nukeIntercepted', x: u.x, y: u.y, owner: u.owner });
        const sx = Math.round(u.x), sy = Math.round(u.y);
        game.msg(`☢ Il nostro missile è stato abbattuto`, 'warn', u.owner, sx, sy);
        game.msg(`☢ SAM: missile di ${game.players[u.owner].name} abbattuto`, 'good', s.owner, sx, sy);
        return true;
      }
    }
    return false;
  }

  const lost = new Map<PlayerId, number>();
  function detonate(u: Unit): void {
    const kind = u.type as NukeKind, r = NUKE_RADIUS[kind], launcher = u.owner;
    const cx = u.ext.tx as number, cy = u.ext.ty as number;
    const p1 = game.rng() * 6.283, p2 = game.rng() * 6.283;
    const R = Math.ceil(r * 1.13);
    lost.clear();
    let destroyed = 0;
    for (let dy = -R; dy <= R; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= H) continue;
      for (let dx = -R; dx <= R; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= W) continue;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > R) continue;
        const th = Math.atan2(dy, dx);
        const rEff = r * (1 + 0.07 * Math.sin(3 * th + p1) + 0.05 * Math.sin(5 * th + p2));
        if (d > rEff) continue;
        const rim = rEff * 0.85;
        if (d > rim && game.rng() > (rEff - d) / (rEff - rim)) continue; // ragged edge
        const i = y * W + x;
        if (terrain[i] === WATER) continue;
        const o = owner[i];
        if (o) { lost.set(o, (lost.get(o) ?? 0) + 1); destroyed++; game.setOwner(i, 0); }
        const f = Math.round(255 - 35 * (d / rEff));
        if (fallout[i] === 0) pushFallout(i);
        if (f > fallout[i]) fallout[i] = f;
        game.markChanged(i);
      }
    }
    // boats and trade ships caught in the blast
    const r2 = r * r;
    for (const v of game.units) {
      if (!v.alive || (v.type !== 'transport' && v.type !== 'trade')) continue;
      if ((v.x - cx) ** 2 + (v.y - cy) ** 2 <= r2) game.removeUnit(v);
    }
    const victims: PlayerId[] = [];
    const lname = game.players[launcher].name;
    const label = kind === 'atom' ? 'Bomba atomica' : 'Bomba H';
    for (const [o, n] of lost) {
      victims.push(o);
      const pl = game.players[o];
      const before = pl.tiles + n;
      pl.troops = Math.max(0, pl.troops - pl.troops * (n / before));
      if (o !== launcher) {
        game.msg(`☢ ${label} di ${lname}: perse ${n} terre`, 'danger', o, cx, cy);
        if (game.areAllied(launcher, o)) game.cmd.breakAlliance(launcher, o); // betrayal
      }
    }
    game.msg(`☢ ${label} esplosa: ${destroyed} terre distrutte`, 'info', launcher, cx, cy);
    game.emit({ type: 'explosion', x: cx, y: cy, radius: r, kind, owner: launcher, victims });
  }

  function decayFallout(): void {
    if (!fLen) return;
    let m = Math.ceil(fLen / FALLOUT_PERIOD);
    while (m-- > 0 && fLen > 0) {
      if (fCur >= fLen) fCur = 0;
      const i = fList[fCur];
      const v = fallout[i];
      const step = FALLOUT_STEP + (game.rng() < 0.3 ? 1 : 0);
      const nv = v > step ? v - step : 0;
      fallout[i] = nv;
      if (band(v) !== band(nv)) game.markChanged(i);
      if (nv === 0) fList[fCur] = fList[--fLen];
      else fCur++;
    }
  }

  game.on(ev => {
    if (ev.type === 'playerDied') for (const u of nukes) if (u.owner === ev.id) game.removeUnit(u);
  });

  game.systems.push({
    name: 'nukes',
    tick() {
      if (nukes.length) {
        if (game.tick - samsTick >= 5) {
          samsTick = game.tick;
          sams = game.structures.filter(s => s.type === 'sam');
        }
        for (let k = nukes.length - 1; k >= 0; k--) {
          const u = nukes[k];
          let done = !u.alive || !game.players[u.owner].alive;
          if (!done) {
            const e = u.ext;
            e.traveled = Math.min(e.dist, e.traveled + e.speed);
            const t = e.traveled / e.dist;
            e.progress = t;
            u.x = e.sx + (e.tx - e.sx) * t;
            u.y = e.sy + (e.ty - e.sy) * t;
            if (sams.length && trySam(u)) done = true;
            else if (t >= 1) { detonate(u); done = true; }
          }
          if (done) {
            if (u.alive) game.removeUnit(u);
            nukes[k] = nukes[nukes.length - 1]; nukes.pop();
          }
        }
      }
      decayFallout();
    },
  });

  game.ext.nukes = { inFlight: () => nukes.length, falloutTiles: () => fLen };
  game.q.nukeCost = nukeCost;
  game.q.nukeRadius = nukeRadius;
  game.q.canNuke = canNuke;
  game.cmd.launchNuke = launchNuke;
}
