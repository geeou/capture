// Main renderer: map layers through the camera, then screen-space overlays, all styled by the active skin.
import type { Game } from '../sim/game';
import type { NationSeed, NukeKind, Player, StructureType, Unit } from '../sim/types';
import { Camera } from './camera';
import { MapLayer } from './mapLayer';
import { Effects } from './effects';
import { drawAdvGlyph, drawGlyph, STRUCTURE_KEY, type AdvGlyph } from './icons';
import { ADV } from '../sim/adv/rules';
import { fogOf, type FogState } from '../sim/adv/fog';
import { Relations } from './relations';
import {
  R_ALLY, R_ENEMY, R_ME, R_NEUTRAL, R_TRIBE, REL_PRIO, css, getSkin, mix, onSkinChange, skinId,
  type RGB, type Skin, type SkinId,
} from './skins';
import { fmt } from '../ui/format';

/** Generic UI font (kept for callers that drew text with it). */
export const FONT = '"Inter", "SF Pro Text", "Segoe UI", system-ui, -apple-system, sans-serif';

/**
 * Aiming mode set by the UI. Advanced-only kinds: 'focus' (focused attack: radius ring at the cursor),
 * 'fleet' (warship patrol target on water), 'capital' (move the capital: own cities highlighted).
 * For the advanced kinds the renderer computes the refusal reason itself (adv.q.canAttackAt / canSendFleet /
 * canMoveCapital) and ignores `aimReason`.
 */
export type Aim =
  | { kind: 'nuke'; nuke: NukeKind }
  | { kind: 'boat' }
  | { kind: 'focus' }
  | { kind: 'fleet' }
  | { kind: 'capital' }
  | null;

export interface SpawnOverlay {
  seeds: NationSeed[];
  pick: { x: number; y: number } | null;
  color: number;
  name: string;
}

interface LabelPos { x: number; y: number; tick: number }
interface Trail { pts: number[]; angle: number }

const WHITE: RGB = [255, 255, 255];

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly cam = new Camera();
  readonly fx = new Effects();
  game!: Game;
  layer!: MapLayer;
  relations!: Relations;
  skin: Skin = getSkin();
  dpr = 1;

  // UI-provided state
  hoverTile = -1;
  selected = 0;
  aim: Aim = null;
  /** Reason string shown next to the aim preview (null = allowed). */
  aimReason: string | null = null;
  spawn: SpawnOverlay | null = null;
  showLabels = true;

  private prev = new Map<number, [number, number]>();
  private trails = new Map<number, Trail>();
  private labelPos = new Map<number, LabelPos>();
  private widthCache = new Map<string, number>();
  private markers = new Map<string, HTMLCanvasElement>();
  private cooldowns = new Map<number, { until: number; start: number }>();
  private lastFrame = 0;
  private placed: number[] = [];
  private fxEl: HTMLDivElement;
  private fxCx = -1e9;
  private fxCy = -1e9;
  private fxAt = 0;
  /** Smoothed frame time (ms) for the debug overlay / perf checks. */
  frameMs = 16;
  // advanced mode
  private fog: FogState | null = null;
  private blockTick = -1;
  private blocked = new Set<number>();
  private advReasonKey = '';
  private advReason: string | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false })!;
    this.fxEl = document.createElement('div');
    this.fxEl.className = 'fx-overlay';
    this.mountFx();
    this.resize();
    onSkinChange(id => this.applySkin(id));
  }

  private mountFx(): void {
    const p = this.canvas.parentElement;
    if (p && this.fxEl.parentElement !== p) p.insertBefore(this.fxEl, this.canvas.nextSibling);
  }

  /** Re-read the active skin (called on every skin change). */
  applySkin(id: SkinId = skinId()): void {
    this.skin = getSkin(id);
    this.fx.theme = this.skin.fx;
    this.widthCache.clear();
    this.markers.clear();
    if (this.layer) this.layer.setSkin(this.skin);
  }

  setGame(game: Game, keepCamera = false): void {
    this.game = game;
    this.skin = getSkin();
    this.fx.theme = this.skin.fx;
    this.relations = new Relations(game);
    this.layer = new MapLayer(game, this.skin, this.relations);
    this.fog = game.advanced ? fogOf(game) : null;
    this.fx.hidden = this.fog ? (x, y) => !this.seesXY(x, y) : null;
    this.blockTick = -1; this.blocked.clear(); this.advReasonKey = '';
    this.cam.setMap(game.W, game.H);
    if (!keepCamera) this.cam.fit();
    this.prev.clear(); this.trails.clear(); this.labelPos.clear(); this.cooldowns.clear();
    this.fx.clear();
    this.hoverTile = -1; this.selected = 0; this.aim = null;
    this.mountFx();
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
    this.dpr = Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2);
    const w = Math.max(1, Math.round(r.width * this.dpr)), h = Math.max(1, Math.round(r.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.cam.setView(r.width, r.height);
    this.markers.clear();
  }

  /** Call right before each game.step() so units can be interpolated. */
  beforeStep(): void {
    const g = this.game;
    for (const u of g.units) {
      let p = this.prev.get(u.id);
      if (!p) { p = [u.x, u.y]; this.prev.set(u.id, p); }
      else { p[0] = u.x; p[1] = u.y; }
      let tr = this.trails.get(u.id);
      if (!tr) { tr = { pts: [], angle: 0 }; this.trails.set(u.id, tr); }
      tr.pts.push(u.x, u.y);
      const max = u.type === 'atom' || u.type === 'hydrogen' ? 28 : u.type === 'interceptor' ? 12 : 14;
      if (tr.pts.length > max) tr.pts.splice(0, 2);
    }
    if (this.prev.size > g.units.length + 64) {
      const alive = new Set(g.units.map(u => u.id));
      for (const id of this.prev.keys()) if (!alive.has(id)) { this.prev.delete(id); this.trails.delete(id); }
    }
  }

  /** Tile under a screen point, or -1. */
  tileAt(sx: number, sy: number): number {
    const x = Math.floor(this.cam.toWorldX(sx)), y = Math.floor(this.cam.toWorldY(sy));
    if (!this.game || x < 0 || y < 0 || x >= this.game.W || y >= this.game.H) return -1;
    return y * this.game.W + x;
  }

  /** Display colour of a player in the active skin (relation-aware), as CSS. */
  colorOf(id: number): string {
    return (this.layer && this.layer.edgeCss[id]) || '#888';
  }
  /** Territory fill colour of a player in the active skin, as CSS. */
  fillOf(id: number): string {
    return (this.layer && this.layer.fillCss[id]) || '#888';
  }
  /** Relation of a player to the human: 0 none, 1 me, 2 ally, 3 enemy, 4 neutral, 5 tribe. */
  relationOf(id: number): number {
    return this.relations ? this.relations.rel[id] ?? 0 : 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  render(alpha: number, now: number): void {
    const g = this.game;
    if (!g) return;
    const dt = this.lastFrame ? now - this.lastFrame : 16;
    this.lastFrame = now;
    this.frameMs += (Math.min(dt, 200) - this.frameMs) * 0.08;
    this.cam.update(dt);

    const fog = this.fog;
    if (!fog) {
      if (g.trackChanges && g.changed.length) { this.layer.apply(g.changed); g.changed.length = 0; }
    } else {
      // fog: tiles that change outside vision keep their remembered look; tiles whose visibility or memory
      // flipped are repainted from fog.changed (a mass reveal repaints the whole layer once)
      if (g.changed.length) { if (g.trackChanges) this.layer.apply(g.changed, true); g.changed.length = 0; }
      if (fog.changed.length) {
        if (fog.changed.length > g.N / 4) this.layer.fullPaint(); else this.layer.apply(fog.changed);
        fog.changed.length = 0;
      }
    }
    const relChanged = this.relations.update();
    if (relChanged) { this.layer.recolor(relChanged); this.markers.clear(); }
    this.layer.flush();
    this.layer.updateGlow(now);

    const c = this.ctx, cam = this.cam;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = this.skin.bg;
    c.fillRect(0, 0, cam.viewW, cam.viewH);

    const [shx, shy] = this.fx.shake(now);
    if (shx || shy) c.translate(shx, shy);

    this.drawMap(c);
    this.drawGrid(c);
    this.drawHover(c);
    if (this.spawn) this.drawSpawn(c, now);
    else {
      if (g.advanced && g.adv) this.drawFocusRings(c, now);
      this.drawStructures(c);
      if (g.advanced && g.adv) this.drawAdvMarkers(c, now);
      if (this.showLabels) this.drawLabels(c);
      this.drawUnits(c, alpha, now);
      this.fx.draw(c, cam, now);
      this.drawAim(c, now);
    }
    this.updateFxCentre(now);
  }

  /** The radar sweep / vignette overlay follows the human's centroid. */
  private updateFxCentre(now: number): void {
    if (now - this.fxAt < 120) return;
    this.fxAt = now;
    const g = this.game, cam = this.cam, me = g.human;
    let x = cam.viewW / 2, y = cam.viewH / 2;
    if (me && me.alive && me.tiles > 0 && !this.spawn) { x = cam.toScreenX(me.sumX / me.tiles); y = cam.toScreenY(me.sumY / me.tiles); }
    x = Math.max(-cam.viewW, Math.min(cam.viewW * 2, x)); y = Math.max(-cam.viewH, Math.min(cam.viewH * 2, y));
    if (Math.abs(x - this.fxCx) > 2 || Math.abs(y - this.fxCy) > 2) {
      this.fxCx = x; this.fxCy = y;
      this.fxEl.style.setProperty('--cx', `${x.toFixed(0)}px`);
      this.fxEl.style.setProperty('--cy', `${y.toFixed(0)}px`);
    }
  }

  private drawMap(c: CanvasRenderingContext2D): void {
    const g = this.game, cam = this.cam, L = this.layer, sk = this.skin;
    const [bx0, by0, bx1, by1] = cam.bounds();
    const x0 = Math.max(0, Math.floor(bx0)), y0 = Math.max(0, Math.floor(by0));
    const x1 = Math.min(g.W, Math.ceil(bx1)), y1 = Math.min(g.H, Math.ceil(by1));
    if (x1 <= x0 || y1 <= y0) return;
    const w = x1 - x0, h = y1 - y0;
    const dx = cam.toScreenX(x0), dy = cam.toScreenY(y0), dw = w * cam.scale, dh = h * cam.scale;
    const smooth = cam.scale < 1.5;
    c.imageSmoothingEnabled = smooth;
    c.imageSmoothingQuality = 'high';
    c.drawImage(L.canvas, x0, y0, w, h, dx, dy, dw, dh);
    if (sk.glow > 0) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = 'low';
      if (cam.scale < 4) {
        c.globalAlpha = sk.glow * 0.6;
        c.drawImage(L.glow4, x0 / 4, y0 / 4, w / 4, h / 4, dx, dy, dw, dh);
      }
      c.globalAlpha = sk.glow * 0.8;
      c.drawImage(L.glow2, x0 / 2, y0 / 2, w / 2, h / 2, dx, dy, dw, dh);
      c.restore();
    }
    c.imageSmoothingEnabled = smooth;
    c.drawImage(L.borders, x0, y0, w, h, dx, dy, dw, dh);
    c.strokeStyle = sk.frame;
    c.lineWidth = 1;
    c.strokeRect(cam.toScreenX(0) - 0.5, cam.toScreenY(0) - 0.5, g.W * cam.scale + 1, g.H * cam.scale + 1);
  }

  // ── grid & range overlays ─────────────────────────────────────────────────
  private gridStep(base: number, minPx: number): number {
    let s = base;
    while (s * this.cam.scale < minPx) s *= 2;
    return s;
  }

  private drawGrid(c: CanvasRenderingContext2D): void {
    const sk = this.skin, cam = this.cam, g = this.game;
    const [bx0, by0, bx1, by1] = cam.bounds();
    const gx0 = Math.max(0, bx0), gy0 = Math.max(0, by0), gx1 = Math.min(g.W, bx1), gy1 = Math.min(g.H, by1);
    if (gx1 <= gx0 || gy1 <= gy0) return;
    const X = (x: number) => cam.toScreenX(x), Y = (y: number) => cam.toScreenY(y);
    const top = Y(gy0), bot = Y(gy1), left = X(gx0), right = X(gx1);
    const me = g.human && g.human.alive && g.human.tiles > 0 && !this.spawn ? g.human : null;
    c.save();
    c.lineWidth = 1;
    c.textBaseline = 'middle';
    if (sk.grid === 'radar') {
      const st = this.gridStep(40, 34);
      c.strokeStyle = sk.gridLine;
      c.beginPath();
      for (let x = Math.ceil(gx0 / st) * st; x <= gx1; x += st) { const sx = Math.round(X(x)) + 0.5; c.moveTo(sx, top); c.lineTo(sx, bot); }
      for (let y = Math.ceil(gy0 / st) * st; y <= gy1; y += st) { const sy = Math.round(Y(y)) + 0.5; c.moveTo(left, sy); c.lineTo(right, sy); }
      c.stroke();
      if (me) {
        const mx = X(me.sumX / me.tiles), my = Y(me.sumY / me.tiles);
        const rs = this.gridStep(40, 30);
        c.strokeStyle = sk.gridMajor;
        c.fillStyle = sk.gridText;
        c.font = `10px ${sk.mono}`;
        c.textAlign = 'left';
        for (let k = 1; k <= 7; k++) {
          const r = rs * k;
          c.beginPath(); c.arc(mx, my, r * cam.scale, 0, Math.PI * 2); c.stroke();
          c.fillText(`${r * 25}KM`, mx + 4, my - r * cam.scale + 8);
        }
        c.globalAlpha = 0.45;
        c.beginPath();
        const R0 = 12 * cam.scale, R1 = rs * 7.5 * cam.scale;
        for (let a = 0; a < 12; a++) {
          const an = (a * Math.PI) / 6, ca = Math.cos(an), sa = Math.sin(an);
          c.moveTo(mx + ca * R0, my + sa * R0); c.lineTo(mx + ca * R1, my + sa * R1);
        }
        c.stroke();
      }
    } else if (sk.grid === 'hex') {
      const R = this.gridStep(6, 22), hw = R * Math.sqrt(3), vh = R * 1.5;
      c.strokeStyle = sk.gridLine;
      c.beginPath();
      const r0 = Math.floor(gy0 / vh) - 1, r1 = Math.ceil(gy1 / vh) + 1;
      const s = cam.scale;
      for (let row = r0; row <= r1; row++) {
        const cy = row * vh, off = (row & 1) ? hw / 2 : 0;
        const c0 = Math.floor((gx0 - off) / hw) - 1, c1 = Math.ceil((gx1 - off) / hw) + 1;
        for (let col = c0; col <= c1; col++) {
          const cx = col * hw + off;
          const sx = X(cx), sy = Y(cy);
          // three edges per hex (the others belong to the neighbours)
          c.moveTo(sx, sy - R * s);
          c.lineTo(sx + (hw / 2) * s, sy - (R / 2) * s);
          c.lineTo(sx + (hw / 2) * s, sy + (R / 2) * s);
          c.lineTo(sx, sy + R * s);
        }
      }
      c.stroke();
    } else if (sk.grid === 'square') {
      const st = this.gridStep(25, 40);
      c.font = `500 9.5px ${sk.mono}`;
      c.fillStyle = sk.gridText;
      c.textAlign = 'left';
      const minor = new Path2D(), major = new Path2D();
      for (let x = Math.ceil(gx0 / st) * st; x <= gx1; x += st) {
        const sx = Math.round(X(x)) + 0.5, p = x % (st * 4) === 0 ? major : minor;
        p.moveTo(sx, top); p.lineTo(sx, bot);
        const idx = Math.round(x / 25);
        if (sx > 12 && sx < cam.viewW - 30) c.fillText(String.fromCharCode(65 + ((idx / 4) | 0) % 26) + String.fromCharCode(65 + idx % 4), sx + 3, Math.max(top, 0) + 62);
      }
      for (let y = Math.ceil(gy0 / st) * st; y <= gy1; y += st) {
        const sy = Math.round(Y(y)) + 0.5, p = y % (st * 4) === 0 ? major : minor;
        p.moveTo(left, sy); p.lineTo(right, sy);
        if (sy > 80 && sy < cam.viewH - 10) c.fillText(String(Math.round(y / 25)).padStart(2, '0'), Math.max(left, 0) + 5, sy - 6);
      }
      c.strokeStyle = sk.gridLine; c.stroke(minor);
      c.strokeStyle = sk.gridMajor; c.stroke(major);
    } else {
      const st = this.gridStep(30, 44), k = 4;
      c.strokeStyle = sk.gridLine;
      c.beginPath();
      for (let x = Math.ceil(gx0 / st) * st; x <= gx1; x += st) {
        const sx = Math.round(X(x)) + 0.5;
        for (let y = Math.ceil(gy0 / st) * st; y <= gy1; y += st) {
          const sy = Math.round(Y(y)) + 0.5;
          c.moveTo(sx - k, sy); c.lineTo(sx + k, sy); c.moveTo(sx, sy - k); c.lineTo(sx, sy + k);
        }
      }
      c.stroke();
      if (me) {
        const mx = X(me.sumX / me.tiles), my = Y(me.sumY / me.tiles), r1 = Math.max(60, 100 * cam.scale);
        c.strokeStyle = sk.gridMajor;
        c.beginPath(); c.arc(mx, my, r1, 0, Math.PI * 2); c.stroke();
        c.beginPath();
        for (let a = 0; a < 72; a++) {
          const an = (a * Math.PI) / 36, r2 = r1 + (a % 6 ? 4 : 9);
          c.moveTo(mx + Math.cos(an) * r1, my + Math.sin(an) * r1); c.lineTo(mx + Math.cos(an) * r2, my + Math.sin(an) * r2);
        }
        c.stroke();
      }
    }
    c.restore();
  }

  private drawHover(c: CanvasRenderingContext2D): void {
    const g = this.game, cam = this.cam, sk = this.skin;
    const ids: number[] = [];
    const ho = this.hoverTile >= 0 ? this.shownOwner(this.hoverTile) : 0;
    const vis = this.fog && !this.fog.off ? this.fog.visible : null;
    if (ho && !this.spawn) ids.push(ho);
    if (this.selected && this.selected !== ho && g.players[this.selected]?.alive) ids.push(this.selected);
    const [bx0, by0, bx1, by1] = cam.bounds();
    for (const id of ids) {
      const p = g.players[id];
      if (!p || p.border.size > 60000) continue;
      const W = g.W;
      const s = Math.max(cam.scale, 1);
      c.beginPath();
      let n = 0;
      for (const i of p.border) {
        const x = i % W, y = (i / W) | 0;
        if (x < bx0 - 1 || x > bx1 || y < by0 - 1 || y > by1) continue;
        if (vis && !vis[i]) continue;
        c.rect(cam.toScreenX(x), cam.toScreenY(y), s, s);
        if (++n > 30000) break;
      }
      c.fillStyle = id === this.selected ? sk.select : sk.hover;
      c.fill();
    }
    if (this.hoverTile >= 0 && cam.scale >= 5) {
      const x = this.hoverTile % g.W, y = (this.hoverTile / g.W) | 0;
      c.strokeStyle = sk.light ? 'rgba(20,22,26,0.9)' : 'rgba(255,255,255,0.9)';
      c.lineWidth = 1.5;
      c.strokeRect(cam.toScreenX(x) + 0.75, cam.toScreenY(y) + 0.75, cam.scale - 1.5, cam.scale - 1.5);
    }
  }

  // ── labels ─────────────────────────────────────────────────────────────────
  private labelFont(px: number): string {
    return `${this.skin.labelWeight} ${px}px ${this.skin.font}`;
  }

  private setTrack(c: CanvasRenderingContext2D, px: number): void {
    if ('letterSpacing' in c) (c as any).letterSpacing = `${(this.skin.labelTrack * px).toFixed(2)}px`;
  }

  /** Width of a label at 1px font size (cached per skin). */
  private nameWidth(text: string): number {
    let w = this.widthCache.get(text);
    if (w === undefined) {
      const c = this.ctx;
      c.font = this.labelFont(100);
      this.setTrack(c, 100);
      w = c.measureText(text).width / 100;
      this.setTrack(c, 0);
      this.widthCache.set(text, w);
    }
    return w;
  }

  private anchor(p: Player, budget: { n: number }): LabelPos {
    const g = this.game;
    let lp = this.labelPos.get(p.id);
    if (lp && (g.tick - lp.tick < 6 || budget.n <= 0)) return lp;
    budget.n--;
    const cx = p.sumX / p.tiles, cy = p.sumY / p.tiles;
    let ax = cx, ay = cy;
    const tx = Math.round(cx), ty = Math.round(cy);
    const ok = (x: number, y: number) => x >= 0 && y >= 0 && x < g.W && y < g.H && g.owner[y * g.W + x] === p.id;
    if (!ok(tx, ty)) {
      const R = Math.min(80, Math.ceil(Math.sqrt(p.tiles)) + 4);
      let found = false;
      for (let r = 1; r <= R && !found; r += r < 8 ? 1 : 2) {
        const step = Math.max(1, (r / 6) | 0);
        for (let d = -r; d <= r && !found; d += step) {
          if (ok(tx + d, ty - r)) { ax = tx + d; ay = ty - r; found = true; }
          else if (ok(tx + d, ty + r)) { ax = tx + d; ay = ty + r; found = true; }
          else if (ok(tx - r, ty + d)) { ax = tx - r; ay = ty + d; found = true; }
          else if (ok(tx + r, ty + d)) { ax = tx + r; ay = ty + d; found = true; }
        }
      }
      if (!found) { ax = p.spawnX; ay = p.spawnY; }
    }
    if (!lp) { lp = { x: ax, y: ay, tick: g.tick }; this.labelPos.set(p.id, lp); }
    else { lp.x = ax; lp.y = ay; lp.tick = g.tick; }
    return lp;
  }

  private drawLabels(c: CanvasRenderingContext2D): void {
    const g = this.game, cam = this.cam, sk = this.skin, rel = this.relations.rel;
    const list: Player[] = [];
    for (let id = 1; id < g.players.length; id++) {
      const p = g.players[id];
      if (p.alive && p.tiles > 0) list.push(p);
    }
    list.sort((a, b) => REL_PRIO[rel[b.id]] - REL_PRIO[rel[a.id]] || b.tiles - a.tiles);
    const budget = { n: 30 };
    const placed = this.placed; placed.length = 0;
    const me = g.humanId;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    for (const p of list) {
      const r = Math.sqrt(p.tiles / Math.PI) * cam.scale;
      if (r < (p.id === me ? 3 : 7)) continue;
      const name = sk.labelUpper ? p.name.toUpperCase() : p.name;
      const wpx = this.nameWidth(name);
      let f = Math.min(r * 0.5, (r * 1.7) / Math.max(wpx, 2.2), 28);
      if (p.id === me) f = Math.max(f, 11);
      if (f < 8) continue;
      f = Math.round(f);
      const lp = this.anchor(p, budget);
      let troops = true;
      if (this.fog && !this.fog.off) {
        // in the fog: name only, and only where the map remembers this player
        const ti = Math.round(lp.y) * g.W + Math.round(lp.x);
        if (ti >= 0 && ti < g.N && !this.fog.visible[ti]) {
          if (this.fog.seenOwner[ti] !== p.id) continue;
          troops = false;
        }
      }
      const sx = cam.toScreenX(lp.x + 0.5), sy = cam.toScreenY(lp.y + 0.5);
      const w = wpx * f + 6, h = f * 2.05;
      const x0 = sx - w / 2, y0 = sy - f * 0.75;
      if (x0 > cam.viewW || y0 > cam.viewH || x0 + w < 0 || y0 + h < 0) continue;
      let hit = false;
      for (let k = 0; k < placed.length; k += 4) {
        if (x0 < placed[k + 2] && x0 + w > placed[k] && y0 < placed[k + 3] && y0 + h > placed[k + 1]) { hit = true; break; }
      }
      if (hit) continue;
      placed.push(x0, y0, x0 + w, y0 + h);
      this.drawLabel(c, p, name, rel[p.id], sx, sy, f, wpx * f, troops);
    }
    if ('letterSpacing' in c) (c as any).letterSpacing = '0px';
  }

  private drawLabel(c: CanvasRenderingContext2D, p: Player, name: string, r: number, sx: number, sy: number, f: number, w: number, troops = true): void {
    const sk = this.skin, g = this.game;
    const ec = this.layer.edgeRgb[p.id] ?? WHITE;
    const traitor = p.traitorUntil > g.tick;
    const nameY = sy - f * 0.28;
    c.font = this.labelFont(f);
    this.setTrack(c, f);
    let fill: string;
    switch (sk.id) {
      case 'radar':
        c.lineWidth = Math.max(2, f * 0.3); c.strokeStyle = css(ec, 0.28); c.strokeText(name, sx, nameY);
        fill = css(mix(ec, WHITE, 0.25));
        break;
      case 'holo':
        c.lineWidth = Math.max(2, f * 0.34); c.strokeStyle = css(ec, 0.4); c.strokeText(name, sx, nameY);
        fill = '#ffffff';
        break;
      case 'tat':
        c.lineWidth = Math.max(2.5, f * 0.22); c.strokeStyle = sk.halo; c.strokeText(name, sx, nameY);
        fill = r === R_NEUTRAL || r === R_TRIBE ? '#e2e3ca' : css(mix(ec, WHITE, 0.35));
        break;
      default: {
        const inv = r === R_ME || r === R_ENEMY;
        c.lineWidth = Math.max(2, f * 0.2); c.strokeStyle = inv ? css(ec, 0.55) : sk.halo; c.strokeText(name, sx, nameY);
        fill = inv ? '#ffffff' : '#14161a';
      }
    }
    c.fillStyle = fill;
    c.fillText(name, sx, nameY);
    this.setTrack(c, 0);
    if (!troops) return;
    // troops line
    const tf = Math.max(8, Math.round(f * 0.62));
    const ty = sy + f * 0.62;
    const tt = (sk.id === 'radar' ? '▸' : '') + fmt(p.troops);
    c.font = `${sk.id === 'holo' ? '500 ' : sk.id === 'tat' ? '500 ' : ''}${tf}px ${sk.mono}`;
    let sub: string;
    if (sk.id === 'radar') sub = css(ec);
    else if (sk.id === 'holo') {
      c.strokeStyle = css(ec); c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(sx - w / 2, sy + f * 0.2); c.lineTo(sx + w / 2, sy + f * 0.2); c.stroke();
      sub = css(mix(ec, WHITE, 0.5));
    } else if (sk.id === 'tat') {
      c.lineWidth = 3; c.strokeStyle = sk.halo; c.strokeText(tt, sx, ty);
      sub = '#cfd0bd';
    } else {
      const inv = r === R_ME || r === R_ENEMY;
      if (!inv) { c.lineWidth = 2.5; c.strokeStyle = sk.halo; c.strokeText(tt, sx, ty); }
      sub = inv ? 'rgba(255,255,255,0.85)' : '#4a525b';
    }
    c.fillStyle = traitor ? css(sk.hot) : sub;
    c.fillText(tt, sx, ty);
    if (p.id === g.humanId && f >= 8) {
      c.fillStyle = sk.accent;
      const mw = Math.max(4, f * 0.3);
      c.beginPath();
      c.moveTo(sx - mw, nameY - f * 0.66);
      c.lineTo(sx, nameY - f * 0.66 - mw * 0.9);
      c.lineTo(sx + mw, nameY - f * 0.66);
      c.closePath();
      c.fill();
    }
  }

  // ── structures ─────────────────────────────────────────────────────────────
  /** Pre-rendered structure marker (glow and all), cached per skin/type/colour/size. */
  private marker(type: StructureType, owner: number, size: number, building: boolean): HTMLCanvasElement {
    const sk = this.skin;
    const r = this.relations.rel[owner] ?? 0;
    const col = building ? (sk.light ? '#8a9199' : '#7d8794') : this.colorOf(owner);
    const variant = sk.struct === 'ring' ? (r === R_ME ? 'm' : r === R_ENEMY ? 'e' : 'n') : '';
    const key = `${sk.id}|${type}|${col}|${size}|${variant}|${building ? 1 : 0}`;
    let cv = this.markers.get(key);
    if (cv) return cv;
    if (this.markers.size > 500) this.markers.clear();
    const d = this.dpr, pad = 8;
    const box = Math.ceil((size * 1.5 + pad * 2) * d);
    cv = document.createElement('canvas');
    cv.width = cv.height = box;
    const c = cv.getContext('2d')!;
    c.scale(d, d);
    const x = box / d / 2, y = box / d / 2, half = size / 2;
    switch (sk.struct) {
      case 'bracket': {
        const q = half + 1, k = Math.max(3, size * 0.22);
        c.fillStyle = 'rgba(0,8,4,0.82)';
        c.fillRect(x - q, y - q, q * 2, q * 2);
        c.strokeStyle = col; c.lineWidth = 1.2; c.shadowColor = col; c.shadowBlur = 5;
        c.beginPath();
        for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          c.moveTo(x + dx * q, y + dy * (q - k)); c.lineTo(x + dx * q, y + dy * q); c.lineTo(x + dx * (q - k), y + dy * q);
        }
        c.stroke();
        drawGlyph(c, type, x, y, half * 0.68, col);
        break;
      }
      case 'disc':
        c.fillStyle = 'rgba(4,14,32,0.85)'; c.strokeStyle = col; c.lineWidth = 1.4; c.shadowColor = col; c.shadowBlur = 8;
        c.beginPath(); c.arc(x, y, half, 0, Math.PI * 2); c.fill(); c.stroke();
        c.shadowBlur = 0;
        drawGlyph(c, type, x, y, half * 0.6, building ? '#9fb3c4' : '#eaf9ff');
        break;
      case 'box': {
        const q = half * 0.82;
        c.fillStyle = '#12140e'; c.strokeStyle = col; c.lineWidth = 1.5;
        c.fillRect(x - q * 1.25, y - q, q * 2.5, q * 2); c.strokeRect(x - q * 1.25, y - q, q * 2.5, q * 2);
        c.fillStyle = col; c.font = `700 ${Math.round(q * 1.55)}px ${sk.font}`; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(STRUCTURE_KEY[type], x, y + 0.5);
        break;
      }
      default: {
        const bg = variant === 'm' ? '#ffffff' : variant === 'e' ? '#14161a' : '#fafbfc';
        const ink = building ? '#8a9199' : variant === 'm' ? '#d83c00' : variant === 'e' ? '#ffffff' : '#14161a';
        c.fillStyle = bg; c.strokeStyle = variant === 'm' && !building ? '#d83c00' : '#14161a'; c.lineWidth = 1.2;
        c.beginPath(); c.arc(x, y, half, 0, Math.PI * 2); c.fill(); c.stroke();
        drawGlyph(c, type, x, y, half * 0.62, ink);
      }
    }
    this.markers.set(key, cv);
    return cv;
  }

  private drawStructures(c: CanvasRenderingContext2D): void {
    const g = this.game, cam = this.cam, sk = this.skin;
    if (cam.scale < 1.6 || !g.structures.length) return;
    const size = Math.round(Math.max(11, Math.min(26, cam.scale * 3.2)));
    const half = size / 2;
    const [bx0, by0, bx1, by1] = cam.bounds();
    const pad = half / cam.scale + 1;
    const vis = this.fog && !this.fog.off ? this.fog.visible : null;
    for (const s of g.structures) {
      if (s.x < bx0 - pad || s.x > bx1 + pad || s.y < by0 - pad || s.y > by1 + pad) continue;
      if (vis && !vis[s.tile]) continue;
      const sx = cam.toScreenX(s.x + 0.5), sy = cam.toScreenY(s.y + 0.5);
      const building = s.readyTick > g.tick;
      const m = this.marker(s.type as StructureType, s.owner, size, building);
      const mw = m.width / this.dpr;
      c.globalAlpha = building ? 0.75 : 1;
      c.drawImage(m, sx - mw / 2, sy - mw / 2, mw, mw);
      c.globalAlpha = 1;
      const ringR = (sk.struct === 'box' ? half * 1.15 : half) + 2.5;
      if (building) {
        const tot = Math.max(1, s.readyTick - s.builtTick);
        const k = Math.max(0, Math.min(1, (g.tick - s.builtTick) / tot));
        c.strokeStyle = sk.accent;
        c.lineWidth = Math.max(2, size * 0.12);
        c.beginPath(); c.arc(sx, sy, ringR, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2); c.stroke();
      } else if ((s.type === 'silo' || s.type === 'sam') && s.cooldownUntil > g.tick) {
        let cd = this.cooldowns.get(s.id);
        if (!cd || cd.until !== s.cooldownUntil) { cd = { until: s.cooldownUntil, start: g.tick }; this.cooldowns.set(s.id, cd); }
        const tot = Math.max(1, cd.until - cd.start);
        const k = Math.max(0, Math.min(1, (cd.until - g.tick) / tot));
        c.strokeStyle = css(sk.hot, 0.95);
        c.lineWidth = Math.max(2, size * 0.12);
        c.beginPath(); c.arc(sx, sy, ringR, -Math.PI / 2, -Math.PI / 2 + k * Math.PI * 2); c.stroke();
      }
    }
    if (this.cooldowns.size > 400) this.cooldowns.clear();
  }

  // ── units ──────────────────────────────────────────────────────────────────
  private drawUnits(c: CanvasRenderingContext2D, alpha: number, now: number): void {
    const g = this.game, cam = this.cam;
    if (!g.units.length) return;
    const [bx0, by0, bx1, by1] = cam.bounds();
    const nukes: Unit[] = [];
    const fogOn = !!this.fog && !this.fog.off;
    for (const u of g.units) {
      if (!u.alive) continue;
      if (u.type === 'atom' || u.type === 'hydrogen') { nukes.push(u); continue; }
      if (fogOn && !this.friendly(u.owner) && !this.seesXY(u.x, u.y)) continue;
      const pv = this.prev.get(u.id);
      const wx = pv ? pv[0] + (u.x - pv[0]) * alpha : u.x;
      const wy = pv ? pv[1] + (u.y - pv[1]) * alpha : u.y;
      if (wx < bx0 - 4 || wx > bx1 + 4 || wy < by0 - 4 || wy > by1 + 4) continue;
      const tr = this.trails.get(u.id);
      if (pv) {
        const dx = u.x - pv[0], dy = u.y - pv[1];
        if (tr && dx * dx + dy * dy > 1e-4) tr.angle = Math.atan2(dy, dx);
      }
      const sx = cam.toScreenX(wx + 0.5), sy = cam.toScreenY(wy + 0.5);
      if (u.type === 'interceptor') { this.drawInterceptor(c, sx, sy, tr); continue; }
      if (u.type === 'warship') { this.drawWarship(c, u, sx, sy, tr, now); continue; }
      this.drawBoat(c, u, sx, sy, tr, now);
    }
    for (const u of nukes) {
      if (fogOn && !this.friendly(u.owner) && !this.seesXY(u.x, u.y)) continue;
      this.drawNuke(c, u, alpha, now);
    }
  }

  private drawWake(c: CanvasRenderingContext2D, tr: Trail | undefined, sx: number, sy: number, width: number): void {
    if (!tr || tr.pts.length < 4) return;
    const cam = this.cam, wake = this.skin.wake;
    const n = tr.pts.length / 2;
    c.lineCap = 'round';
    if (cam.scale < 2.5) {
      c.strokeStyle = wake + '0.3)';
      c.lineWidth = Math.max(1, width * 0.7);
      c.beginPath(); c.moveTo(sx, sy);
      for (let k = n - 1; k >= 0; k -= 2) c.lineTo(cam.toScreenX(tr.pts[k * 2] + 0.5), cam.toScreenY(tr.pts[k * 2 + 1] + 0.5));
      c.stroke();
      return;
    }
    let lx = sx, ly = sy;
    for (let k = n - 1; k >= 0; k--) {
      const px = cam.toScreenX(tr.pts[k * 2] + 0.5), py = cam.toScreenY(tr.pts[k * 2 + 1] + 0.5);
      const a = k / n;
      c.strokeStyle = `${wake}${(0.45 * a).toFixed(3)})`;
      c.lineWidth = width * (0.35 + a * 0.65);
      c.beginPath(); c.moveTo(lx, ly); c.lineTo(px, py); c.stroke();
      lx = px; ly = py;
    }
  }

  private drawBoat(c: CanvasRenderingContext2D, u: Unit, sx: number, sy: number, tr: Trail | undefined, _now: number): void {
    const cam = this.cam, sk = this.skin, g = this.game;
    const trade = u.type === 'trade';
    const mine = u.owner === g.humanId;
    const L = (trade ? Math.max(6, Math.min(12, cam.scale * 1.8)) : Math.max(9, Math.min(18, cam.scale * 2.8))) * (mine ? 1.15 : 1);
    const col = this.colorOf(u.owner);
    this.drawWake(c, tr, sx, sy, L * 0.3);
    c.save();
    c.translate(sx, sy);
    c.rotate(tr ? tr.angle : 0);
    const z = L * 0.5;
    c.beginPath();
    c.moveTo(z * 1.4, 0); c.lineTo(-z, -z * 0.8); c.lineTo(-z * 0.5, 0); c.lineTo(-z, z * 0.8); c.closePath();
    if (sk.id === 'orb') {
      c.fillStyle = trade ? '#fafbfc' : mine ? '#ff5a1f' : '#14161a';
      c.strokeStyle = trade ? '#14161a' : '#ffffff';
      c.lineWidth = 1;
      c.fill(); c.stroke();
    } else {
      c.fillStyle = trade ? (sk.id === 'tat' ? '#cfd0bd' : css(mix(this.layer.edgeRgb[u.owner] ?? WHITE, WHITE, 0.5), 0.8)) : col;
      c.fill();
      c.strokeStyle = sk.id === 'tat' ? 'rgba(14,16,10,0.9)' : 'rgba(0,0,0,0.6)';
      c.lineWidth = 1;
      c.stroke();
      if (sk.glow && !trade) {
        c.globalAlpha = 0.35; c.strokeStyle = col; c.lineWidth = 4; c.stroke(); c.globalAlpha = 1;
      }
    }
    c.restore();
    if (!trade && u.troops > 0 && cam.scale >= 2.5) {
      c.font = `${sk.id === 'radar' ? '' : '600 '}${Math.round(Math.max(9, Math.min(12, L * 0.62)))}px ${sk.mono}`;
      c.textAlign = 'center'; c.textBaseline = 'bottom';
      c.lineWidth = 3; c.strokeStyle = sk.halo;
      const t = fmt(u.troops);
      c.strokeText(t, sx, sy - L * 0.55);
      c.fillStyle = sk.light ? '#14161a' : sk.id === 'radar' ? col : '#ffffff';
      c.fillText(t, sx, sy - L * 0.55);
    }
  }

  private drawInterceptor(c: CanvasRenderingContext2D, sx: number, sy: number, tr: Trail | undefined): void {
    const cam = this.cam, sk = this.skin;
    const ink = sk.light ? 'rgba(20,22,26,' : sk.id === 'radar' ? 'rgba(160,255,200,' : sk.id === 'tat' ? 'rgba(230,232,200,' : 'rgba(200,240,255,';
    if (tr && tr.pts.length >= 4) {
      c.strokeStyle = ink + '0.55)';
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(cam.toScreenX(tr.pts[0] + 0.5), cam.toScreenY(tr.pts[1] + 0.5));
      for (let k = 2; k < tr.pts.length; k += 2) c.lineTo(cam.toScreenX(tr.pts[k] + 0.5), cam.toScreenY(tr.pts[k + 1] + 0.5));
      c.lineTo(sx, sy);
      c.stroke();
    }
    c.fillStyle = ink + '1)';
    c.beginPath(); c.arc(sx, sy, 2.5, 0, Math.PI * 2); c.fill();
  }

  private drawNuke(c: CanvasRenderingContext2D, u: Unit, alpha: number, now: number): void {
    const g = this.game, cam = this.cam, sk = this.skin;
    const fx = g.xOf(u.fromTile), fy = g.yOf(u.fromTile), tx = g.xOf(u.toTile), ty = g.yOf(u.toTile);
    const D = Math.hypot(tx - fx, ty - fy) || 1;
    const lift = Math.min(160, D * cam.scale * 0.28 + 20);
    const pv = this.prev.get(u.id);
    const wx = pv ? pv[0] + (u.x - pv[0]) * alpha : u.x;
    const wy = pv ? pv[1] + (u.y - pv[1]) * alpha : u.y;
    const prog = (x: number, y: number) => Math.max(0, Math.min(1, Math.hypot(x - fx, y - fy) / D));
    const air = (x: number, y: number): [number, number] => {
      const t = prog(x, y);
      return [cam.toScreenX(x + 0.5), cam.toScreenY(y + 0.5) - Math.sin(Math.PI * t) * lift];
    };
    const hyd = u.type === 'hydrogen';
    const hot = sk.hot;
    // target marker: blast footprint + reticle
    const R = Math.max(4, g.q.nukeRadius(u.type as NukeKind)) * cam.scale;
    const tsx = cam.toScreenX(tx + 0.5), tsy = cam.toScreenY(ty + 0.5);
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.012);
    c.save();
    c.strokeStyle = css(hot, 0.7 + pulse * 0.3);
    c.fillStyle = css(hot, (sk.light ? 0.08 : 0.1) + pulse * 0.08);
    c.lineWidth = sk.light ? 1.5 : 2;
    c.setLineDash(sk.id === 'tat' ? [8, 5] : sk.id === 'orb' ? [] : [7, 5]);
    c.lineDashOffset = -now * 0.02;
    c.beginPath(); c.arc(tsx, tsy, R, 0, Math.PI * 2); c.fill(); c.stroke();
    c.setLineDash([]);
    c.globalAlpha = 1 - pulse;
    c.beginPath(); c.arc(tsx, tsy, R + 4 + pulse * 14, 0, Math.PI * 2); c.stroke();
    c.globalAlpha = 1;
    c.beginPath();
    for (const [qx, qy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      c.moveTo(tsx + qx * R * 0.55, tsy + qy * R * 0.55); c.lineTo(tsx + qx * (R + 8), tsy + qy * (R + 8));
    }
    c.stroke();
    // ground shadow
    const gsx = cam.toScreenX(wx + 0.5), gsy = cam.toScreenY(wy + 0.5);
    c.fillStyle = sk.light ? 'rgba(20,22,26,0.25)' : 'rgba(0,0,0,0.4)';
    c.beginPath(); c.ellipse(gsx, gsy, 5, 2.5, 0, 0, Math.PI * 2); c.fill();
    // remaining path (dashed) to the target
    const [ax, ay] = air(wx, wy);
    c.strokeStyle = css(hot, 0.5);
    c.lineWidth = 1.2;
    c.setLineDash([2, 5]);
    c.beginPath(); c.moveTo(ax, ay);
    const steps = 14;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const [px, py] = air(wx + (tx - wx) * t, wy + (ty - wy) * t);
      c.lineTo(px, py);
    }
    c.stroke();
    c.setLineDash([]);
    // trail
    const tr = this.trails.get(u.id);
    if (tr && tr.pts.length >= 2) {
      const n = tr.pts.length / 2;
      let lx = ax, ly = ay;
      c.lineCap = 'round';
      for (let k = n - 1; k >= 0; k--) {
        const [px, py] = air(tr.pts[k * 2], tr.pts[k * 2 + 1]);
        const a = k / n;
        c.strokeStyle = css(hot, a * (sk.light ? 0.8 : 0.7));
        c.lineWidth = (hyd ? 5 : 3.5) * (0.3 + a * 0.7);
        c.beginPath(); c.moveTo(lx, ly); c.lineTo(px, py); c.stroke();
        lx = px; ly = py;
      }
    }
    // warhead
    const [bx, by] = air(wx - ((tx - fx) / D) * 0.6, wy - ((ty - fy) / D) * 0.6);
    const ang = Math.atan2(ay - by, ax - bx);
    c.translate(ax, ay);
    c.rotate(ang);
    const L = hyd ? 20 : 15;
    if (!sk.light) {
      const glow = c.createRadialGradient(0, 0, 0, 0, 0, L * 1.1);
      glow.addColorStop(0, css(hot, 0.5));
      glow.addColorStop(1, css(hot, 0));
      c.fillStyle = glow;
      c.beginPath(); c.arc(0, 0, L * 1.1, 0, Math.PI * 2); c.fill();
    }
    c.fillStyle = sk.light ? css(hot) : '#ffffff';
    c.strokeStyle = sk.light ? '#14161a' : 'rgba(0,0,0,0.7)';
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(L * 0.6, 0); c.lineTo(-L * 0.4, -L * 0.34); c.lineTo(-L * 0.18, 0); c.lineTo(-L * 0.4, L * 0.34);
    c.closePath();
    c.fill(); c.stroke();
    c.restore();
  }

  // ── aiming previews ────────────────────────────────────────────────────────
  private drawAim(c: CanvasRenderingContext2D, now: number): void {
    const g = this.game, cam = this.cam, sk = this.skin;
    if (!this.aim || this.hoverTile < 0) return;
    const x = g.xOf(this.hoverTile), y = g.yOf(this.hoverTile);
    const sx = cam.toScreenX(x + 0.5), sy = cam.toScreenY(y + 0.5);
    const advAim = this.aim.kind === 'focus' || this.aim.kind === 'fleet' || this.aim.kind === 'capital';
    const reason = advAim ? this.advAimReason() : this.aimReason;
    const ok = reason === null;
    const off = sk.light ? 'rgba(110,118,126,' : 'rgba(170,180,195,';
    c.save();
    if (advAim) this.drawAdvAim(c, sx, sy, ok, now);
    else if (this.aim.kind === 'nuke') {
      const R = Math.max(2, g.q.nukeRadius(this.aim.nuke)) * cam.scale;
      c.strokeStyle = ok ? css(sk.hot, 0.95) : off + '0.8)';
      c.fillStyle = ok ? css(sk.hot, 0.14) : off + '0.12)';
      c.lineWidth = 2;
      c.setLineDash([7, 5]);
      c.lineDashOffset = -now * 0.03;
      c.beginPath(); c.arc(sx, sy, R, 0, Math.PI * 2); c.fill(); c.stroke();
      c.setLineDash([]);
      c.beginPath();
      c.moveTo(sx - 9, sy); c.lineTo(sx + 9, sy); c.moveTo(sx, sy - 9); c.lineTo(sx, sy + 9);
      c.stroke();
    } else {
      const me = g.human;
      const col = ok ? sk.accent : off + '0.7)';
      if (me && me.tiles > 0) {
        const ox = cam.toScreenX(me.sumX / me.tiles + 0.5), oy = cam.toScreenY(me.sumY / me.tiles + 0.5);
        c.strokeStyle = col;
        c.globalAlpha = 0.85;
        c.lineWidth = 2;
        c.setLineDash([4, 6]);
        c.lineDashOffset = -now * 0.03;
        c.beginPath(); c.moveTo(ox, oy); c.lineTo(sx, sy); c.stroke();
        c.setLineDash([]);
        c.globalAlpha = 1;
      }
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.beginPath(); c.arc(sx, sy, 9, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.moveTo(sx, sy - 5); c.lineTo(sx, sy + 5); c.moveTo(sx - 4, sy + 1); c.quadraticCurveTo(sx, sy + 7, sx + 4, sy + 1); c.stroke();
    }
    if (reason) {
      c.font = `600 12px ${sk.mono}`;
      c.textAlign = 'left'; c.textBaseline = 'middle';
      const w = c.measureText(reason).width + 14;
      c.fillStyle = sk.tagBg;
      c.fillRect(sx + 16, sy + 12, w, 22);
      if (sk.light) { c.strokeStyle = '#14161a'; c.lineWidth = 1; c.strokeRect(sx + 16.5, sy + 12.5, w - 1, 21); }
      c.fillStyle = sk.tagInk;
      c.fillText(reason, sx + 23, sy + 23);
    }
    c.restore();
  }

  // ── spawn phase overlay ────────────────────────────────────────────────────
  private drawSpawn(c: CanvasRenderingContext2D, now: number): void {
    const sp = this.spawn!, cam = this.cam, sk = this.skin;
    const placed = this.placed; placed.length = 0;
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.lineJoin = 'round';
    const f = Math.round(Math.max(10, Math.min(14, cam.scale * 4)));
    const pickR = 5 * cam.scale;
    if (sp.pick) {
      const sx = cam.toScreenX(sp.pick.x + 0.5), sy = cam.toScreenY(sp.pick.y + 0.5);
      placed.push(sx - 60, sy - 40, sx + 60, sy + 30);
    }
    for (const s of sp.seeds) {
      const sx = cam.toScreenX(s.x + 0.5), sy = cam.toScreenY(s.y + 0.5);
      if (sx < -50 || sy < -20 || sx > cam.viewW + 50 || sy > cam.viewH + 20) continue;
      c.fillStyle = sk.text;
      c.strokeStyle = sk.halo;
      c.lineWidth = 1.5;
      c.beginPath(); c.arc(sx, sy, 3, 0, Math.PI * 2); c.fill(); c.stroke();
      const name = sk.labelUpper ? s.name.toUpperCase() : s.name;
      const w = this.nameWidth(name) * f + 4;
      const x0 = sx - w / 2, y0 = sy - f * 1.9;
      let hit = false;
      for (let k = 0; k < placed.length; k += 4) {
        if (x0 < placed[k + 2] && x0 + w > placed[k] && y0 < placed[k + 3] && y0 + f * 1.3 > placed[k + 1]) { hit = true; break; }
      }
      if (hit) continue;
      placed.push(x0, y0, x0 + w, y0 + f * 1.3);
      c.font = this.labelFont(f);
      this.setTrack(c, f);
      c.lineWidth = 3;
      c.strokeText(name, sx, sy - f * 1.2);
      c.fillStyle = sk.text;
      c.fillText(name, sx, sy - f * 1.2);
      this.setTrack(c, 0);
    }
    if (sp.pick) {
      const sx = cam.toScreenX(sp.pick.x + 0.5), sy = cam.toScreenY(sp.pick.y + 0.5);
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.006);
      const look = sk.look({ id: 1, color: sp.color } as Player, R_ME);
      const col = css(look.e);
      c.fillStyle = css(look.f, 0.75);
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.beginPath(); c.arc(sx, sy, Math.max(6, pickR), 0, Math.PI * 2); c.fill(); c.stroke();
      c.globalAlpha = 1 - pulse;
      c.beginPath(); c.arc(sx, sy, Math.max(6, pickR) + 6 + pulse * 18, 0, Math.PI * 2); c.stroke();
      c.globalAlpha = 1;
      const nm = sk.labelUpper ? sp.name.toUpperCase() : sp.name;
      c.font = this.labelFont(15);
      this.setTrack(c, 15);
      c.lineWidth = 4; c.strokeStyle = sk.halo;
      c.strokeText(nm, sx, sy - Math.max(6, pickR) - 14);
      c.fillStyle = sk.light ? '#14161a' : css(mix(look.e, WHITE, 0.3));
      c.fillText(nm, sx, sy - Math.max(6, pickR) - 14);
      this.setTrack(c, 0);
    }
  }

  // ── advanced mode ──────────────────────────────────────────────────────────
  /** Owner the map shows on a tile: the real one inside vision, the remembered one in the fog (for UI hover). */
  shownOwner(tile: number): number {
    return this.layer ? this.layer.shownOwner(tile) : this.game.owner[tile];
  }
  /** True when the human can see the tile (always true without fog). */
  sees(tile: number): boolean {
    const f = this.fog;
    return !f || f.off || f.visible[tile] === 1;
  }
  private seesXY(x: number, y: number): boolean {
    const g = this.game;
    const xi = Math.max(0, Math.min(g.W - 1, Math.round(x))), yi = Math.max(0, Math.min(g.H - 1, Math.round(y)));
    return this.sees(yi * g.W + xi);
  }
  private friendly(id: number): boolean {
    const g = this.game, me = g.humanId;
    return id === me || (me > 0 && g.players[me].allies.has(id));
  }
  /** Colour used when an advanced aim is refused (distinct from the accent in every skin). */
  private refuseCol(a = 0.9): string {
    const sk = this.skin;
    return sk.id === 'orb' ? `rgba(110,118,126,${a})` : sk.id === 'tat' ? `rgba(255,100,78,${a})` : css(sk.hot, a);
  }
  private goodCol(): string {
    const id = this.skin.id;
    return id === 'radar' ? '#5aff9b' : id === 'holo' ? '#8cf2ff' : id === 'tat' ? '#9be07a' : '#1f8a3a';
  }

  /** Pre-rendered deposit (diamond badge) or capital (star) marker, cached like structure markers. */
  private advMarker(shape: 'dep' | 'cap', kind: AdvGlyph, owner: number, size: number): HTMLCanvasElement {
    const sk = this.skin;
    const col = owner ? this.colorOf(owner) : sk.neutral;
    const r = owner ? this.relations.rel[owner] ?? 0 : 0;
    const key = `${shape}|${sk.id}|${kind}|${col}|${size}|${r}`;
    let cv = this.markers.get(key);
    if (cv) return cv;
    if (this.markers.size > 500) this.markers.clear();
    const d = this.dpr, pad = 6;
    const box = Math.ceil((size * 1.5 + pad * 2) * d);
    cv = document.createElement('canvas');
    cv.width = cv.height = box;
    const c = cv.getContext('2d')!;
    c.scale(d, d);
    const x = box / d / 2, y = box / d / 2, half = size / 2;
    if (shape === 'cap') {
      const glow = sk.glow > 0;
      drawAdvGlyph(c, 'capital', x, y, half * 1.28, sk.light ? '#fafbfc' : sk.halo);
      if (glow) { c.shadowColor = col; c.shadowBlur = 8; }
      drawAdvGlyph(c, 'capital', x, y, half, sk.light && r === 0 ? '#14161a' : col);
      c.shadowBlur = 0;
      if (sk.light) drawAdvGlyph(c, 'capital', x, y, half * 0.42, '#fafbfc');
      else drawAdvGlyph(c, 'capital', x, y, half * 0.4, sk.id === 'tat' ? '#12140e' : '#ffffff');
    } else {
      const q = half + 1;
      c.beginPath();
      c.moveTo(x, y - q * 1.12); c.lineTo(x + q * 1.12, y); c.lineTo(x, y + q * 1.12); c.lineTo(x - q * 1.12, y); c.closePath();
      let ink = col;
      switch (sk.struct) {
        case 'bracket':
          c.fillStyle = 'rgba(0,8,4,0.85)'; c.fill();
          c.strokeStyle = col; c.lineWidth = 1.2; c.shadowColor = col; c.shadowBlur = owner ? 5 : 0; c.stroke(); c.shadowBlur = 0;
          break;
        case 'disc':
          c.fillStyle = 'rgba(4,14,32,0.88)'; c.fill();
          c.strokeStyle = col; c.lineWidth = 1.4; c.shadowColor = col; c.shadowBlur = owner ? 8 : 0; c.stroke(); c.shadowBlur = 0;
          ink = owner ? '#eaf9ff' : sk.neutral;
          break;
        case 'box':
          c.fillStyle = '#12140e'; c.fill();
          c.strokeStyle = col; c.lineWidth = 1.5; c.stroke();
          break;
        default:
          c.fillStyle = r === 1 ? '#ffffff' : r === 3 ? '#14161a' : '#fafbfc'; c.fill();
          c.strokeStyle = owner ? (r === 3 ? '#14161a' : col) : '#5d646b'; c.lineWidth = owner ? 1.6 : 1.2; c.stroke();
          ink = r === 3 ? '#ffffff' : owner ? col : '#5d646b';
      }
      drawAdvGlyph(c, kind, x, y, half * 0.66, ink);
    }
    this.markers.set(key, cv);
    return cv;
  }

  /** Focus rings of the human's focused attacks (attack.ext.focus), under the structures. */
  private drawFocusRings(c: CanvasRenderingContext2D, now: number): void {
    const g = this.game, cam = this.cam, sk = this.skin, me = g.humanId;
    if (!me || !g.attacks.length) return;
    const R = ADV.focusRadius * cam.scale;
    for (const a of g.attacks) {
      if (!a.alive || a.attacker !== me) continue;
      const f = a.ext.focus as { x: number; y: number } | undefined;
      if (!f) continue;
      const sx = cam.toScreenX(f.x + 0.5), sy = cam.toScreenY(f.y + 0.5);
      if (sx < -R - 20 || sy < -R - 20 || sx > cam.viewW + R + 20 || sy > cam.viewH + R + 20) continue;
      c.save();
      c.strokeStyle = sk.accent;
      c.fillStyle = sk.accent;
      c.globalAlpha = sk.light ? 0.07 : 0.06;
      c.beginPath(); c.arc(sx, sy, R, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 0.9;
      c.lineWidth = sk.light ? 1.5 : 2;
      c.setLineDash([8, 6]);
      c.lineDashOffset = -now * 0.02;
      c.stroke();
      c.setLineDash([]);
      const k = Math.max(5, Math.min(10, R * 0.18));
      c.beginPath();
      for (const [qx, qy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { c.moveTo(sx + qx * (R - k), sy + qy * (R - k)); c.lineTo(sx + qx * (R + k * 0.6), sy + qy * (R + k * 0.6)); }
      c.moveTo(sx - 5, sy); c.lineTo(sx + 5, sy); c.moveTo(sx, sy - 5); c.lineTo(sx, sy + 5);
      c.stroke();
      c.restore();
    }
  }

  /** Deposits, capitals and blockaded-port warnings. */
  private drawAdvMarkers(c: CanvasRenderingContext2D, now: number): void {
    const g = this.game, adv = g.adv!, cam = this.cam, sk = this.skin, W = g.W;
    const [bx0, by0, bx1, by1] = cam.bounds();
    const fog = this.fog && !this.fog.off ? this.fog : null;
    const structsShown = cam.scale >= 1.6;
    const sSize = Math.round(Math.max(11, Math.min(26, cam.scale * 3.2)));
    // deposits: terrain, so visible on explored land even in the fog (owner as remembered there)
    if (adv.deposits.length) {
      const size = Math.round(Math.max(10, Math.min(22, cam.scale * 2.8)));
      const pad = size / cam.scale + 1;
      for (const d of adv.deposits) {
        if (d.x < bx0 - pad || d.x > bx1 + pad || d.y < by0 - pad || d.y > by1 + pad) continue;
        if (fog && !fog.explored[d.tile]) continue;
        const m = this.advMarker('dep', d.kind, this.shownOwner(d.tile), size);
        const mw = m.width / this.dpr;
        let sx = cam.toScreenX(d.x + 0.5), sy = cam.toScreenY(d.y + 0.5);
        if (structsShown && g.structureAt.has(d.tile) && this.sees(d.tile)) { sx -= sSize * 0.62; sy += sSize * 0.62; }
        c.drawImage(m, sx - mw / 2, sy - mw / 2, mw, mw);
      }
    }
    // capitals (hidden in the fog, like structures)
    const ps = g.players;
    for (let id = 1; id < ps.length; id++) {
      const p = ps[id];
      if (!p.alive) continue;
      const cap = adv.players[id]?.capital ?? -1;
      if (cap < 0) continue;
      if (p.kind === 'tribe' && cam.scale < 2.5) continue;
      const x = cap % W, y = (cap / W) | 0;
      if (x < bx0 - 3 || x > bx1 + 3 || y < by0 - 3 || y > by1 + 3) continue;
      if (fog && !fog.visible[cap]) continue;
      let size = Math.round(Math.max(p.kind === 'tribe' ? 9 : 11, Math.min(24, cam.scale * 3.4)));
      let sx = cam.toScreenX(x + 0.5), sy = cam.toScreenY(y + 0.5);
      if (structsShown && g.structureAt.has(cap)) { size = Math.round(sSize * 0.8); sx += sSize * 0.6; sy -= sSize * 0.6; }
      const m = this.advMarker('cap', 'capital', id, size);
      const mw = m.width / this.dpr;
      c.drawImage(m, sx - mw / 2, sy - mw / 2, mw, mw);
    }
    // blockaded ports (queried a few times per second, not per frame)
    if (g.tick !== this.blockTick && (g.tick - this.blockTick >= 5 || g.tick < this.blockTick)) {
      this.blockTick = g.tick;
      this.blocked.clear();
      for (const s of g.structures) if (s.type === 'port' && adv.q.isBlockaded(s)) this.blocked.add(s.id);
    }
    if (this.blocked.size) {
      const me = g.humanId;
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.008);
      for (const s of g.structures) {
        if (!this.blocked.has(s.id)) continue;
        if (!structsShown && s.owner !== me) continue;
        if (s.x < bx0 - 3 || s.x > bx1 + 3 || s.y < by0 - 3 || s.y > by1 + 3) continue;
        if (fog && !fog.visible[s.tile]) continue;
        let sx = cam.toScreenX(s.x + 0.5), sy = cam.toScreenY(s.y + 0.5);
        if (structsShown) { sx -= sSize * 0.62; sy -= sSize * 0.62; }
        const k = 7 + (s.owner === me ? 1.5 : 0);
        c.save();
        if (s.owner === me) {
          c.strokeStyle = css(sk.hot, 0.35 + 0.5 * (1 - pulse)); c.lineWidth = 2;
          c.beginPath(); c.arc(sx, sy + 1, k + 4 + pulse * 6, 0, Math.PI * 2); c.stroke();
        }
        c.beginPath();
        c.moveTo(sx, sy - k); c.lineTo(sx + k * 1.1, sy + k * 0.85); c.lineTo(sx - k * 1.1, sy + k * 0.85); c.closePath();
        c.fillStyle = css(sk.hot); c.fill();
        c.strokeStyle = sk.light ? '#14161a' : sk.halo; c.lineWidth = 1.5; c.stroke();
        c.fillStyle = sk.light ? '#ffffff' : sk.id === 'tat' ? '#12140e' : '#ffffff';
        c.font = `700 ${Math.round(k * 1.2)}px ${sk.mono}`; c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText('!', sx, sy + k * 0.22);
        c.restore();
      }
    }
  }

  private drawWarship(c: CanvasRenderingContext2D, u: Unit, sx: number, sy: number, tr: Trail | undefined, now: number): void {
    const cam = this.cam, sk = this.skin, g = this.game;
    const mine = u.owner === g.humanId;
    const L = Math.max(13, Math.min(26, cam.scale * 3.8)) * (mine ? 1.1 : 1);
    const col = this.colorOf(u.owner);
    const pt = u.ext.patrol as { x: number; y: number } | undefined;
    if (mine && pt) {
      const px = cam.toScreenX(pt.x + 0.5), py = cam.toScreenY(pt.y + 0.5), R = ADV.patrolRadius * cam.scale;
      c.save();
      c.strokeStyle = sk.accent;
      c.globalAlpha = 0.5;
      c.lineWidth = 1.2;
      c.setLineDash([3, 6]);
      c.lineDashOffset = -now * 0.01;
      c.beginPath(); c.arc(px, py, R, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 0.8;
      c.beginPath(); c.moveTo(px - 4, py); c.lineTo(px + 4, py); c.moveTo(px, py - 4); c.lineTo(px, py + 4); c.stroke();
      c.restore();
    }
    this.drawWake(c, tr, sx, sy, L * 0.32);
    c.save();
    c.translate(sx, sy);
    c.rotate(tr ? tr.angle : 0);
    const z = L * 0.5;
    c.beginPath();
    c.moveTo(z * 1.25, 0); c.lineTo(z * 0.6, -z * 0.42); c.lineTo(-z * 0.95, -z * 0.42); c.lineTo(-z * 1.1, 0);
    c.lineTo(-z * 0.95, z * 0.42); c.lineTo(z * 0.6, z * 0.42); c.closePath();
    let deck: string;
    if (sk.id === 'orb') {
      const enemy = this.relationOf(u.owner) === R_ENEMY;
      c.fillStyle = mine ? '#ff5a1f' : enemy ? '#14161a' : col;
      c.strokeStyle = mine || enemy ? '#ffffff' : '#14161a';
      c.lineWidth = 1.2; c.fill(); c.stroke();
      deck = mine || enemy ? '#ffffff' : '#14161a';
    } else {
      c.fillStyle = col; c.fill();
      c.strokeStyle = sk.id === 'tat' ? 'rgba(14,16,10,0.95)' : 'rgba(0,0,0,0.7)';
      c.lineWidth = 1.2; c.stroke();
      if (sk.glow) { c.globalAlpha = 0.4; c.strokeStyle = col; c.lineWidth = 4; c.stroke(); c.globalAlpha = 1; }
      deck = sk.id === 'tat' ? '#12140e' : 'rgba(0,0,0,0.6)';
    }
    // superstructure + turrets
    c.fillStyle = deck; c.strokeStyle = deck;
    c.fillRect(-z * 0.5, -z * 0.2, z * 0.62, z * 0.4);
    c.beginPath(); c.arc(z * 0.45, 0, z * 0.15, 0, Math.PI * 2); c.arc(-z * 0.72, 0, z * 0.12, 0, Math.PI * 2); c.fill();
    c.lineWidth = Math.max(1, z * 0.09); c.lineCap = 'round';
    c.beginPath(); c.moveTo(z * 0.45, 0); c.lineTo(z * 0.95, 0); c.stroke();
    c.restore();
    const hp = u.ext.hp as number | undefined, max = u.ext.maxHp as number | undefined;
    if (typeof hp === 'number' && max && max > 0) {
      const k = Math.max(0, Math.min(1, hp / max));
      const w = Math.round(L * 1.05), h = 3, x0 = Math.round(sx - w / 2), y0 = Math.round(sy + L * 0.42);
      c.fillStyle = sk.light ? 'rgba(20,22,26,0.75)' : 'rgba(0,0,0,0.7)';
      c.fillRect(x0 - 1, y0 - 1, w + 2, h + 2);
      c.fillStyle = k > 0.35 ? this.goodCol() : css(sk.hot);
      c.fillRect(x0, y0, Math.max(1, Math.round(w * k)), h);
    }
  }

  private advAimReason(): string | null {
    const g = this.game, me = g.humanId, t = this.hoverTile, adv = g.adv, aim = this.aim;
    if (!adv || !me || t < 0 || !aim) return null;
    const key = `${aim.kind}|${t}|${g.tick}`;
    if (key === this.advReasonKey) return this.advReason;
    this.advReasonKey = key;
    this.advReason = aim.kind === 'focus' ? adv.q.canAttackAt(me, t)
      : aim.kind === 'fleet' ? adv.q.canSendFleet(me, t)
      : aim.kind === 'capital' ? adv.q.canMoveCapital(me, t) : null;
    return this.advReason;
  }

  private drawAdvAim(c: CanvasRenderingContext2D, sx: number, sy: number, ok: boolean, now: number): void {
    const g = this.game, cam = this.cam, sk = this.skin, aim = this.aim!, me = g.humanId;
    const col = ok ? sk.accent : this.refuseCol();
    if (aim.kind === 'focus') {
      const R = ADV.focusRadius * cam.scale;
      c.fillStyle = col;
      c.globalAlpha = ok ? 0.1 : 0.07;
      c.beginPath(); c.arc(sx, sy, R, 0, Math.PI * 2); c.fill();
      c.globalAlpha = ok ? 0.95 : 0.7;
      c.strokeStyle = col; c.lineWidth = 2;
      c.setLineDash(ok ? [8, 6] : [3, 6]);
      c.lineDashOffset = -now * 0.03;
      c.stroke();
      c.setLineDash([]);
      c.beginPath();
      c.moveTo(sx - 10, sy); c.lineTo(sx - 3, sy); c.moveTo(sx + 3, sy); c.lineTo(sx + 10, sy);
      c.moveTo(sx, sy - 10); c.lineTo(sx, sy - 3); c.moveTo(sx, sy + 3); c.lineTo(sx, sy + 10);
      c.stroke();
      c.globalAlpha = 1;
    } else if (aim.kind === 'fleet') {
      const R = ADV.patrolRadius * cam.scale;
      // nearest own warship → target
      let best: Unit | null = null, bd = Infinity;
      const tx = g.xOf(this.hoverTile), ty = g.yOf(this.hoverTile);
      for (const u of g.units) {
        if (!u.alive || u.type !== 'warship' || u.owner !== me) continue;
        const d = (u.x - tx) ** 2 + (u.y - ty) ** 2;
        if (d < bd) { bd = d; best = u; }
      }
      c.strokeStyle = col; c.lineWidth = 2;
      if (best) {
        c.globalAlpha = 0.8;
        c.setLineDash([4, 6]); c.lineDashOffset = -now * 0.03;
        c.beginPath(); c.moveTo(cam.toScreenX(best.x + 0.5), cam.toScreenY(best.y + 0.5)); c.lineTo(sx, sy); c.stroke();
      }
      c.globalAlpha = ok ? 0.85 : 0.6;
      c.setLineDash([3, 6]); c.lineDashOffset = -now * 0.01;
      c.beginPath(); c.arc(sx, sy, R, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
      c.beginPath(); c.arc(sx, sy, 8, 0, Math.PI * 2); c.stroke();
      c.beginPath(); c.arc(sx, sy, 3, 0, Math.PI * 2); c.fillStyle = col; c.fill();
      c.beginPath();
      for (const [qx, qy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { c.moveTo(sx + qx * 11, sy + qy * 11); c.lineTo(sx + qx * 16, sy + qy * 16); }
      c.stroke();
    } else {
      // capital: highlight the human's finished cities
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.006);
      const r0 = Math.max(10, Math.min(20, cam.scale * 2.6));
      c.strokeStyle = sk.accent; c.lineWidth = 2;
      for (const s of g.structures) {
        if (s.owner !== me || s.type !== 'city' || s.readyTick > g.tick) continue;
        const px = cam.toScreenX(s.x + 0.5), py = cam.toScreenY(s.y + 0.5);
        if (px < -40 || py < -40 || px > cam.viewW + 40 || py > cam.viewH + 40) continue;
        const hit = s.tile === this.hoverTile;
        c.globalAlpha = hit ? 1 : 0.55 + 0.35 * pulse;
        c.beginPath(); c.arc(px, py, r0 + (hit ? 4 : pulse * 3), 0, Math.PI * 2); c.stroke();
      }
      c.globalAlpha = 1;
      const m = this.advMarker('cap', 'capital', ok ? me : 0, 16);
      const mw = m.width / this.dpr;
      c.globalAlpha = ok ? 1 : 0.6;
      c.drawImage(m, sx + 6, sy - mw + 2, mw, mw);
      c.globalAlpha = 1;
    }
  }

  /** Is a world point currently visible? */
  visible(x: number, y: number, margin = 0): boolean {
    const sx = this.cam.toScreenX(x), sy = this.cam.toScreenY(y);
    return sx >= -margin && sy >= -margin && sx <= this.cam.viewW + margin && sy <= this.cam.viewH + margin;
  }
}

export { R_ALLY, R_ENEMY, R_ME, R_NEUTRAL, R_TRIBE };
