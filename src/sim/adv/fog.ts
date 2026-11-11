// ADVANCED MODE — fog of war for the human player (docs/ADVANCED.md §9). DOM-free, deterministic, no rng.
//
// visible = (tiles owned by the human or an ally)
//         ∪ (tiles within ADV.visionBorder of the border of the human / allies)   ← "band"
//         ∪ (discs around finished capitals/cities/ports/SAMs and warships of the human / allies)
//
// Cost model: every ADV.fogPeriod ticks the band and the discs are rebuilt with a bounded BFS that starts from
// the friendly border tiles (Euclidean-limited source propagation), so the work is proportional to
// perimeter × visionBorder plus the disc areas, never to the map. The result is diffed against the tiles
// marked last time; friendly interior tiles that drop out of the band simply stay visible (they are owned).
// The rare events that can hide friendly interior land without touching the band (an alliance changing,
// a pocket surrendering, a nuke deeper than the band, a friendly player dying) trigger one full-map pass.
import type { Game } from '../game';
import type { GameOptions, PlayerId, Tile } from '../types';
import { ADV } from './rules';
import type { Fog } from './types';

/** Fog state with the renderer-side extras (`explored`, `off`). Stored in game.adv.fog. */
export interface FogState extends Fog {
  /** 1 = the human has seen this tile at least once (or it was known at the start). */
  explored: Uint8Array;
  /** True once the fog has been lifted for good (human dead): everything visible. */
  off: boolean;
}

/** The fog state of a game, or null when there is no fog (classic, fog off, no human). */
export function fogOf(game: Game): FogState | null {
  return (game.adv?.fog as FogState | null) ?? null;
}

export function installFog(game: Game, opts: GameOptions): void {
  const adv = game.adv;
  if (!adv || opts.fog === false || !game.humanId) return;
  const N = game.N, W = game.W, H = game.H;
  const me = game.humanId;
  const fog: FogState = {
    visible: new Uint8Array(N),
    seenOwner: new Uint16Array(N),
    changed: [],
    explored: new Uint8Array(N),
    off: false,
  };
  // The starting atlas is known: everything shows its owner at the start of the match.
  fog.seenOwner.set(game.owner);
  adv.fog = fog;
  adv.q.visible = (t: Tile) => fog.visible[t] === 1;

  const vis = fog.visible, seen = fog.seenOwner, explored = fog.explored, ow = game.owner;
  /** Stamp of the last recompute that marked the tile (band or disc). */
  const mark = new Uint32Array(N);
  /** Nearest source tile of the band BFS. */
  const src = new Int32Array(N);
  let gen = 0;
  let list = new Int32Array(1024), listN = 0;      // tiles marked in the current recompute (also the BFS queue)
  let prev = new Int32Array(1024), prevN = 0;      // tiles marked in the previous recompute
  let friend = new Uint8Array(game.players.length + 1);
  let friendKey = '';
  let needFull = true;
  const regions: number[] = [];                    // x, y, r triples to re-check after the band pass

  const push = (t: Tile) => { if (game.trackChanges) fog.changed.push(t); };
  const add = (t: Tile) => {
    if (listN === list.length) { const n = new Int32Array(list.length * 2); n.set(list); list = n; }
    list[listN++] = t;
  };

  const syncFriends = (): boolean => {
    const ps = game.players;
    if (friend.length < ps.length + 1) friend = new Uint8Array(ps.length + 16);
    friend.fill(0);
    const ids: PlayerId[] = [];
    const h = ps[me];
    if (h && h.alive) { friend[me] = 1; ids.push(me); for (const a of h.allies) if (ps[a]?.alive) { friend[a] = 1; ids.push(a); } }
    ids.sort((a, b) => a - b);
    const key = ids.join(',');
    const changed = key !== friendKey;
    friendKey = key;
    return changed;
  };

  const show = (t: Tile) => {
    if (vis[t] === 0) { vis[t] = 1; explored[t] = 1; seen[t] = ow[t]; push(t); }
    else if (seen[t] !== ow[t]) { seen[t] = ow[t]; push(t); }
  };
  const hide = (t: Tile) => {
    if (vis[t] === 1) { vis[t] = 0; seen[t] = ow[t]; push(t); }
  };

  const disc = (cx: number, cy: number, r: number) => {
    cx = Math.round(cx); cy = Math.round(cy);
    const r2 = r * r + 0.5;
    const y0 = Math.max(0, cy - r), y1 = Math.min(H - 1, cy + r);
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy, half = Math.floor(Math.sqrt(Math.max(0, r2 - dy * dy)));
      const x0 = Math.max(0, cx - half), x1 = Math.min(W - 1, cx + half);
      for (let x = x0, t = y * W + x0; x <= x1; x++, t++) if (mark[t] !== gen) { mark[t] = gen; add(t); }
    }
  };

  const recompute = () => {
    const ps = game.players;
    const human = ps[me];
    if (!human || !human.alive) { reveal(); return; }
    if (syncFriends()) needFull = true;
    // swap lists
    const tl = prev; prev = list; list = tl; prevN = listN; listN = 0;
    gen++;
    if (gen === 0xffffffff) { mark.fill(0); gen = 1; }

    // 1) band: BFS from every friendly border tile, limited to visionBorder (Euclidean, via source propagation)
    const R = ADV.visionBorder, R2 = R * R + 0.5;
    for (let id = 1; id < ps.length; id++) {
      if (!friend[id]) continue;
      for (const t of ps[id].border) if (mark[t] !== gen) { mark[t] = gen; src[t] = t; add(t); }
    }
    for (let h = 0; h < listN; h++) {
      const t = list[h], s = src[t], sx = s % W, sy = (s / W) | 0, x = t % W;
      const y = (t / W) | 0;
      if (x > 0) { const n = t - 1; if (mark[n] !== gen) { const dx = x - 1 - sx, dy = y - sy; if (dx * dx + dy * dy <= R2) { mark[n] = gen; src[n] = s; add(n); } } }
      if (x < W - 1) { const n = t + 1; if (mark[n] !== gen) { const dx = x + 1 - sx, dy = y - sy; if (dx * dx + dy * dy <= R2) { mark[n] = gen; src[n] = s; add(n); } } }
      if (y > 0) { const n = t - W; if (mark[n] !== gen) { const dx = x - sx, dy = y - 1 - sy; if (dx * dx + dy * dy <= R2) { mark[n] = gen; src[n] = s; add(n); } } }
      if (y < H - 1) { const n = t + W; if (mark[n] !== gen) { const dx = x - sx, dy = y + 1 - sy; if (dx * dx + dy * dy <= R2) { mark[n] = gen; src[n] = s; add(n); } } }
    }

    // 2) discs: capitals, finished cities / ports / SAMs, warships of friends
    const VH = ADV.visionHub;
    for (let id = 1; id < ps.length; id++) {
      if (!friend[id]) continue;
      const cap = adv.players[id]?.capital ?? -1;
      if (cap >= 0 && ow[cap] === id) disc(cap % W, (cap / W) | 0, VH.capital);
    }
    for (const s of game.structures) {
      if (!friend[s.owner] || s.readyTick > game.tick) continue;
      const r = s.type === 'city' ? VH.city : s.type === 'port' ? VH.port : s.type === 'sam' ? VH.sam : 0;
      if (r) disc(s.x, s.y, r);
    }
    for (const u of game.units) if (u.alive && u.type === 'warship' && friend[u.owner]) disc(u.x, u.y, VH.warship);

    // 3) diff
    if (needFull) {
      needFull = false;
      regions.length = 0;
      for (let t = 0; t < N; t++) {
        if (mark[t] === gen || friend[ow[t]]) show(t); else hide(t);
      }
      return;
    }
    for (let k = 0; k < listN; k++) show(list[k]);
    for (let k = 0; k < prevN; k++) {
      const t = prev[k];
      if (mark[t] !== gen && !friend[ow[t]]) hide(t);
    }
    // friendly interior tiles outside the band: refresh their remembered owner cheaply is not needed (they are
    // visible and owned); regions flagged by events are re-checked here.
    for (let k = 0; k < regions.length; k += 3) {
      const cx = regions[k], cy = regions[k + 1], r = regions[k + 2];
      const y0 = Math.max(0, cy - r), y1 = Math.min(H - 1, cy + r), x0 = Math.max(0, cx - r), x1 = Math.min(W - 1, cx + r);
      for (let y = y0; y <= y1; y++) for (let x = x0, t = y * W + x0; x <= x1; x++, t++) {
        if (mark[t] === gen || friend[ow[t]]) show(t); else hide(t);
      }
    }
    regions.length = 0;
  };

  const reveal = () => {
    if (fog.off) return;
    fog.off = true;
    for (let t = 0; t < N; t++) { if (!vis[t]) { vis[t] = 1; push(t); } explored[t] = 1; seen[t] = ow[t]; }
    adv.q.visible = () => true;
  };

  game.on(ev => {
    if (fog.off) return;
    switch (ev.type) {
      // alliance changes are caught by syncFriends(); only friendly pockets can hide friendly interior land
      case 'pocketLost': if (friend[ev.owner]) needFull = true; break;
      case 'playerDied': if (ev.id === me) reveal(); else if (friend[ev.id]) needFull = true; break;
      case 'explosion': regions.push(Math.round(ev.x), Math.round(ev.y), Math.ceil(ev.radius) + 2); break;
      case 'rebellion': regions.push(Math.round(ev.x), Math.round(ev.y), 18); break;
    }
  });

  recompute();
  game.systems.push({
    name: 'fog',
    tick() {
      if (fog.off) return;
      const h = game.players[me];
      if (!h || !h.alive) { reveal(); return; }
      if (game.tick % ADV.fogPeriod === 0) recompute();
    },
  });
}
