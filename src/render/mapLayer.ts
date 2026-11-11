// Map-sized offscreen layers, one pixel per tile, repainted incrementally from game.changed:
//  - `canvas`: territory fills (water, unclaimed land, owned fills with tile-space hatching, fallout)
//  - `borders`: transparent except border/coast tiles in edge colours
//  - `glow2` / `glow4`: half / quarter resolution copies of `borders` (cheap blur for glowing skins)
// Colours come from the active skin and the human's relations (me / ally / enemy / neutral / tribe).
import { WATER } from '../sim/types';
import type { Game } from '../sim/game';
import { REL_PRIO, R_ENEMY, R_ME, css, pk, pkc, type RGB, type Skin } from './skins';
import type { Relations } from './relations';
import type { Adv } from '../sim/adv/types';
import { fogOf, type FogState } from '../sim/adv/fog';

const CH = 64; // dirty chunk size (tiles)
const WK = 0xffff; // "water" pseudo-owner for border checks
const CAP = 28; // water distance cap

export class MapLayer {
  readonly canvas: HTMLCanvasElement;
  readonly borders: HTMLCanvasElement;
  readonly glow2: HTMLCanvasElement;
  readonly glow4: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bctx: CanvasRenderingContext2D;
  private g2: CanvasRenderingContext2D;
  private g4: CanvasRenderingContext2D;
  private img: ImageData;
  private bimg: ImageData;
  private px: Uint32Array;
  private bpx: Uint32Array;
  /** Water distance to land (tiles, capped). */
  private dist: Uint8Array;
  /** Unowned look per tile (packed ABGR). */
  private base: Uint32Array;
  private stamp: Uint32Array;
  private frame = 1;
  private cw: number;
  private chh: number;
  private dirty: Uint8Array;
  private anyDirty = false;
  private glowDirty = true;
  private lastGlow = -1e9;
  // per-player colour cache (packed)
  private fill = new Uint32Array(0);
  private alt = new Uint32Array(0);
  private edge = new Uint32Array(0);
  /** Edge colour per player as CSS (labels, structures, units). */
  edgeCss: string[] = [];
  edgeRgb: RGB[] = [];
  fillCss: string[] = [];
  private known = 0;
  private coastPk = 0;
  private frontPk = 0;
  private falloutC: RGB = [0, 0, 0];
  /** Bumped whenever pixels change (minimap uses it). */
  version = 0;
  // advanced mode only (null in classic matches: the classic paint path is untouched)
  private adv: Adv | null = null;
  private fog: FogState | null = null;
  private fogT = new Float32Array(8);

  constructor(private game: Game, private skin: Skin, private relations: Relations) {
    const { W, H, N } = game;
    if (game.advanced && game.adv) { this.adv = game.adv; this.fog = fogOf(game); }
    const mk = (w: number, h: number) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    this.canvas = mk(W, H);
    this.borders = mk(W, H);
    this.glow2 = mk(Math.ceil(W / 2), Math.ceil(H / 2));
    this.glow4 = mk(Math.ceil(W / 4), Math.ceil(H / 4));
    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    this.bctx = this.borders.getContext('2d')!;
    this.g2 = this.glow2.getContext('2d')!;
    this.g4 = this.glow4.getContext('2d')!;
    this.img = this.ctx.createImageData(W, H);
    this.bimg = this.bctx.createImageData(W, H);
    this.px = new Uint32Array(this.img.data.buffer);
    this.bpx = new Uint32Array(this.bimg.data.buffer);
    this.dist = new Uint8Array(N);
    this.base = new Uint32Array(N);
    this.stamp = new Uint32Array(N);
    this.cw = Math.ceil(W / CH); this.chh = Math.ceil(H / CH);
    this.dirty = new Uint8Array(this.cw * this.chh);
    this.buildDist();
    relations.update(true);
    this.setSkin(skin);
  }

  private buildDist(): void {
    const { W, N, terrain } = this.game;
    const dist = this.dist.fill(255);
    const q = new Int32Array(N);
    let qh = 0, qt = 0;
    for (let i = 0; i < N; i++) if (terrain[i] !== WATER) { dist[i] = 0; q[qt++] = i; }
    while (qh < qt) {
      const i = q[qh++], d = dist[i];
      if (d >= CAP) continue;
      const x = i % W, nd = d + 1;
      if (x > 0 && dist[i - 1] > nd) { dist[i - 1] = nd; q[qt++] = i - 1; }
      if (x < W - 1 && dist[i + 1] > nd) { dist[i + 1] = nd; q[qt++] = i + 1; }
      if (i >= W && dist[i - W] > nd) { dist[i - W] = nd; q[qt++] = i - W; }
      if (i < N - W && dist[i + W] > nd) { dist[i + W] = nd; q[qt++] = i + W; }
    }
    for (let i = 0; i < N; i++) if (dist[i] > CAP) dist[i] = CAP;
  }

  /** Switch palette: rebuild the unowned base and every colour, then repaint the whole map. */
  setSkin(skin: Skin): void {
    this.skin = skin;
    const { W, H, terrain } = this.game;
    const dist = this.dist;
    let seed = 0x9e3779b9;
    const noise = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296) - 0.5; };
    const amp = skin.light ? 3 : 2.4;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x, t = terrain[i];
      const c = t === WATER ? skin.water(dist[i], x, y) : skin.land[t - 1];
      const n = t === WATER ? 0 : noise() * amp;
      this.base[i] = pk((c[0] + n) | 0, (c[1] + n) | 0, (c[2] + n) | 0);
    }
    this.coastPk = skin.coast ? pkc(skin.coast) : 0;
    this.frontPk = pkc(skin.front);
    this.falloutC = skin.fallout;
    const ft = this.fogT;
    ft[0] = skin.fogTint[0]; ft[1] = skin.fogTint[1]; ft[2] = skin.fogTint[2];
    ft[3] = skin.fogDesat; ft[4] = skin.fogK; ft[5] = skin.fogK2;
    this.known = 0;
    this.syncPlayers();
    this.fullPaint();
  }

  private grow(n: number): void {
    if (this.fill.length >= n * 4) return;
    const m = n + 32;
    const f = new Uint32Array(m * 4), a = new Uint32Array(m), e = new Uint32Array(m);
    f.set(this.fill); a.set(this.alt); e.set(this.edge);
    this.fill = f; this.alt = a; this.edge = e;
  }

  private lookOf(id: number): void {
    const p = this.game.players[id];
    const s = this.skin;
    const d = s.look(p, this.relations.rel[id] ?? 0);
    const tm = s.terrMul;
    for (let t = 1; t < 4; t++) this.fill[id * 4 + t] = pkc(d.f, tm[t - 1]);
    this.alt[id] = pkc(d.a ?? d.f);
    this.edge[id] = pkc(d.e);
    this.edgeRgb[id] = d.e;
    this.edgeCss[id] = css(d.e);
    this.fillCss[id] = css(d.f);
  }

  /** Grow the per-player colour cache when players appear. */
  private syncPlayers(): void {
    const ps = this.game.players;
    if (this.known >= ps.length) return;
    this.grow(ps.length);
    for (let id = this.known; id < ps.length; id++) this.lookOf(id);
    this.known = ps.length;
  }

  private paint(i: number): void {
    if (this.adv) { this.paintAdv(i); return; }
    const g = this.game, s = this.skin;
    const t = g.terrain[i];
    const W = g.W, x = i % W, y = (i - x) / W;
    let c: number, b = 0;
    if (t === WATER) c = this.base[i];
    else {
      const ow = g.owner, ter = g.terrain, N = g.N;
      const o = ow[i];
      if (o === 0) {
        c = this.base[i];
        if (this.coastPk && ((x > 0 && ter[i - 1] === WATER) || (x < W - 1 && ter[i + 1] === WATER) ||
          (i >= W && ter[i - W] === WATER) || (i < N - W && ter[i + W] === WATER))) b = this.coastPk;
      } else {
        const rel = this.relations.rel, r = rel[o];
        const hatch = (r === R_ME && s.hatchMe(x, y)) || (r === R_ENEMY && s.hatchEn(x, y));
        c = hatch ? this.alt[o] : this.fill[o * 4 + t];
        // border: this tile draws the line if it "wins" over a differing neighbour
        const po = REL_PRIO[r];
        for (let k = 0; k < 4; k++) {
          let j: number;
          if (k === 0) { if (x === 0) continue; j = i - 1; }
          else if (k === 1) { if (x === W - 1) continue; j = i + 1; }
          else if (k === 2) { if (i < W) continue; j = i - W; }
          else { if (i >= N - W) continue; j = i + W; }
          const q = ter[j] === WATER ? WK : ow[j];
          if (q === o) continue;
          if (q === WK || q === 0) { if (!b) b = this.edge[o]; continue; }
          const rq = rel[q], pq = REL_PRIO[rq];
          if (po > pq || (po === pq && o < q)) {
            if ((r === R_ME && rq === R_ENEMY) || (r === R_ENEMY && rq === R_ME)) { b = this.frontPk; break; }
            b = this.edge[o];
          }
        }
      }
    }
    const f = g.fallout[i];
    if (f > 0) {
      const k = 0.35 + 0.45 * (f / 255);
      const [fr, fg, fb] = this.falloutC;
      const r0 = c & 255, g0 = (c >> 8) & 255, b0 = (c >> 16) & 255;
      const d = ((x + y) & 3) === 0 ? 0.7 : 1;
      c = pk(((r0 + (fr - r0) * k) * d) | 0, ((g0 + (fg - g0) * k) * d) | 0, ((b0 + (fb - b0) * k) * d) | 0);
    }
    this.px[i] = c;
    this.bpx[i] = b;
  }

  /** Owner shown on a tile: the real one inside vision, the remembered one in the fog. */
  shownOwner(i: number): number {
    const f = this.fog;
    return f && !f.off && !f.visible[i] ? f.seenOwner[i] : this.game.owner[i];
  }

  /** Fogged version of a packed colour (desaturate, then mix towards the skin's fog tint). */
  private fogPx(c: number, k: number): number {
    const ft = this.fogT, d = ft[3];
    const r = c & 255, gg = (c >> 8) & 255, b = (c >> 16) & 255;
    const l = r * 0.3 + gg * 0.59 + b * 0.11;
    const r1 = r + (l - r) * d, g1 = gg + (l - gg) * d, b1 = b + (l - b) * d;
    return pk((r1 + (ft[0] - r1) * k) | 0, (g1 + (ft[1] - g1) * k) | 0, (b1 + (ft[2] - b1) * k) | 0);
  }

  /** Advanced-mode paint: owners seen through the fog, dimmed fog, hatched cut-off tiles. */
  private paintAdv(i: number): void {
    const g = this.game, s = this.skin, fog = this.fog && !this.fog.off ? this.fog : null;
    const vis = fog ? fog.visible : null, seen = fog ? fog.seenOwner : null;
    const t = g.terrain[i];
    const W = g.W, x = i % W, y = (i - x) / W;
    const hidden = !!vis && !vis[i];
    let c: number, b = 0;
    if (t === WATER) c = this.base[i];
    else {
      const ow = g.owner, ter = g.terrain, N = g.N;
      const o = hidden ? seen![i] : ow[i];
      if (o === 0) {
        c = this.base[i];
        if (this.coastPk && ((x > 0 && ter[i - 1] === WATER) || (x < W - 1 && ter[i + 1] === WATER) ||
          (i >= W && ter[i - W] === WATER) || (i < N - W && ter[i + W] === WATER))) b = this.coastPk;
      } else {
        const rel = this.relations.rel, r = rel[o];
        const hatch = (r === R_ME && s.hatchMe(x, y)) || (r === R_ENEMY && s.hatchEn(x, y));
        c = hatch ? this.alt[o] : this.fill[o * 4 + t];
        const po = REL_PRIO[r];
        for (let k = 0; k < 4; k++) {
          let j: number;
          if (k === 0) { if (x === 0) continue; j = i - 1; }
          else if (k === 1) { if (x === W - 1) continue; j = i + 1; }
          else if (k === 2) { if (i < W) continue; j = i - W; }
          else { if (i >= N - W) continue; j = i + W; }
          const q = ter[j] === WATER ? WK : vis && !vis[j] ? seen![j] : ow[j];
          if (q === o) continue;
          if (q === WK || q === 0) { if (!b) b = this.edge[o]; continue; }
          const rq = rel[q], pq = REL_PRIO[rq];
          if (po > pq || (po === pq && o < q)) {
            if (!hidden && ((r === R_ME && rq === R_ENEMY) || (r === R_ENEMY && rq === R_ME))) { b = this.frontPk; break; }
            b = this.edge[o];
          }
        }
        // cut off from supply (visible tiles only): tile-space hatch + slight dim
        if (!hidden && this.adv!.cut[i]) {
          const cc = s.cut, kk = ((x + y) & 3) === 0 ? s.cutK : 0.18;
          const r0 = c & 255, g0 = (c >> 8) & 255, b0 = (c >> 16) & 255;
          c = pk((r0 + (cc[0] - r0) * kk) | 0, (g0 + (cc[1] - g0) * kk) | 0, (b0 + (cc[2] - b0) * kk) | 0);
        }
      }
    }
    const f = g.fallout[i];
    if (f > 0) {
      const k = 0.35 + 0.45 * (f / 255);
      const [fr, fg, fb] = this.falloutC;
      const r0 = c & 255, g0 = (c >> 8) & 255, b0 = (c >> 16) & 255;
      const d = ((x + y) & 3) === 0 ? 0.7 : 1;
      c = pk(((r0 + (fr - r0) * k) * d) | 0, ((g0 + (fg - g0) * k) * d) | 0, ((b0 + (fb - b0) * k) * d) | 0);
    }
    if (hidden) {
      const k = fog!.explored[i] ? this.fogT[4] : this.fogT[5];
      c = this.fogPx(c, k);
      if (b) b = this.fogPx(b, k * 0.8);
    }
    this.px[i] = c;
    this.bpx[i] = b;
  }

  fullPaint(): void {
    this.syncPlayers();
    const N = this.game.N;
    for (let i = 0; i < N; i++) this.paint(i);
    this.ctx.putImageData(this.img, 0, 0);
    this.bctx.putImageData(this.bimg, 0, 0);
    this.dirty.fill(0);
    this.anyDirty = false;
    this.glowDirty = true;
    this.lastGlow = -1e9;
    this.version++;
  }

  private touch(i: number): void {
    if (this.stamp[i] === this.frame) return;
    this.stamp[i] = this.frame;
    this.paint(i);
    const W = this.game.W;
    const cx = ((i % W) / CH) | 0, cy = ((i / W) / CH) | 0;
    this.dirty[cy * this.cw + cx] = 1;
  }

  private nextFrame(): void {
    this.frame++;
    if (this.frame === 0xffffffff) { this.stamp.fill(0); this.frame = 1; }
  }

  /**
   * Repaint changed tiles plus their 4 neighbours (border state shifts with them).
   * `skipHidden` (advanced, fog on): ignore tiles outside vision — the map keeps showing what was last seen.
   */
  apply(changed: number[], skipHidden = false): void {
    if (!changed.length) return;
    this.syncPlayers();
    this.nextFrame();
    const W = this.game.W, N = this.game.N;
    const vis = skipHidden && this.fog && !this.fog.off ? this.fog.visible : null;
    for (let k = 0; k < changed.length; k++) {
      const i = changed[k];
      if (i < 0 || i >= N) continue;
      if (vis && !vis[i]) continue;
      this.touch(i);
      const x = i % W;
      if (x > 0) this.touch(i - 1);
      if (x < W - 1) this.touch(i + 1);
      if (i >= W) this.touch(i - W);
      if (i < N - W) this.touch(i + W);
    }
    this.anyDirty = true;
  }

  /** Relations of some players changed: recolour all their tiles and the borders around them. */
  recolor(ids: number[]): void {
    if (!ids.length) return;
    this.syncPlayers();
    const g = this.game, ps = g.players;
    const flag = new Uint8Array(ps.length + 1);
    for (const id of ids) { if (id < ps.length) { flag[id] = 1; this.lookOf(id); } }
    this.nextFrame();
    const ow = g.owner, N = g.N, W = g.W;
    const fog = this.fog && !this.fog.off ? this.fog : null;
    if (fog) {
      // fogged tiles are drawn with their remembered owner: recolour those (and the borders around them)
      const vis = fog.visible, seen = fog.seenOwner;
      for (let i = 0; i < N; i++) {
        if (vis[i]) { if (flag[ow[i]]) this.touch(i); continue; }
        const o = seen[i];
        if (!flag[o]) continue;
        this.touch(i);
        const x = i % W;
        if (x > 0) this.touch(i - 1);
        if (x < W - 1) this.touch(i + 1);
        if (i >= W) this.touch(i - W);
        if (i < N - W) this.touch(i + W);
      }
    } else for (let i = 0; i < N; i++) if (flag[ow[i]]) this.touch(i);
    for (const id of ids) {
      const p = ps[id];
      if (!p) continue;
      for (const i of p.border) {
        const x = i % W;
        if (x > 0) this.touch(i - 1);
        if (x < W - 1) this.touch(i + 1);
        if (i >= W) this.touch(i - W);
        if (i < N - W) this.touch(i + W);
      }
    }
    this.anyDirty = true;
  }

  /** Repaint a list of tiles without neighbours. */
  repaint(tiles: Iterable<number>): void {
    this.nextFrame();
    for (const i of tiles) this.touch(i);
    this.anyDirty = true;
  }

  /** Upload dirty chunks to the canvases. */
  flush(): void {
    if (!this.anyDirty) return;
    const { W, H } = this.game;
    for (let cy = 0; cy < this.chh; cy++) for (let cx = 0; cx < this.cw; cx++) {
      const k = cy * this.cw + cx;
      if (!this.dirty[k]) continue;
      this.dirty[k] = 0;
      const x = cx * CH, y = cy * CH, w = Math.min(CH, W - x), h = Math.min(CH, H - y);
      this.ctx.putImageData(this.img, 0, 0, x, y, w, h);
      this.bctx.putImageData(this.bimg, 0, 0, x, y, w, h);
    }
    this.anyDirty = false;
    this.glowDirty = true;
    this.version++;
  }

  /** Rebuild the blurred border copies (throttled; GPU downscales only). */
  updateGlow(now: number): void {
    if (!this.skin.glow || !this.glowDirty || now - this.lastGlow < 220) return;
    this.glowDirty = false;
    this.lastGlow = now;
    const a = this.g2, b = this.g4;
    a.imageSmoothingEnabled = true; a.imageSmoothingQuality = 'medium';
    b.imageSmoothingEnabled = true; b.imageSmoothingQuality = 'medium';
    a.clearRect(0, 0, this.glow2.width, this.glow2.height);
    a.drawImage(this.borders, 0, 0, this.glow2.width, this.glow2.height);
    b.clearRect(0, 0, this.glow4.width, this.glow4.height);
    b.drawImage(this.glow2, 0, 0, this.glow4.width, this.glow4.height);
  }
}
