// Corner minimap: a downscaled copy of the map layer plus the viewport rectangle. Click/drag to jump.
import type { Renderer } from './renderer';

export class Minimap {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private base: HTMLCanvasElement;
  private bctx: CanvasRenderingContext2D;
  private lastVersion = -1;
  private lastBase = 0;
  private w = 220;
  private h = 110;
  private dpr = 1;
  private dragging = false;

  constructor(private r: Renderer, host: HTMLElement) {
    this.el = document.createElement('canvas');
    this.el.className = 'minimap';
    host.appendChild(this.el);
    this.ctx = this.el.getContext('2d')!;
    this.base = document.createElement('canvas');
    this.bctx = this.base.getContext('2d')!;
    const jump = (e: PointerEvent) => {
      const rect = this.el.getBoundingClientRect();
      const g = this.r.game;
      const x = ((e.clientX - rect.left) / rect.width) * g.W;
      const y = ((e.clientY - rect.top) / rect.height) * g.H;
      this.r.cam.centerOn(x, y, undefined, !this.dragging);
    };
    this.el.addEventListener('pointerdown', e => { e.stopPropagation(); this.el.setPointerCapture(e.pointerId); jump(e); this.dragging = true; });
    this.el.addEventListener('pointermove', e => { if (this.dragging) jump(e); });
    this.el.addEventListener('pointerup', () => { this.dragging = false; });
    this.el.addEventListener('contextmenu', e => e.preventDefault());
  }

  layout(): void {
    const g = this.r.game;
    if (!g) return;
    const vw = window.innerWidth;
    const maxW = vw < 700 ? 140 : vw < 1100 ? 190 : 240;
    this.w = maxW;
    this.h = Math.round(maxW * (g.H / g.W));
    this.dpr = this.r.dpr;
    this.el.width = Math.round(this.w * this.dpr);
    this.el.height = Math.round(this.h * this.dpr);
    this.el.style.width = this.w + 'px';
    this.el.style.height = this.h + 'px';
    this.base.width = this.el.width;
    this.base.height = this.el.height;
    this.lastVersion = -1;
    this.lastBase = -1e9;
    document.documentElement.style.setProperty('--mm-h', this.h + 'px');
  }

  draw(now: number): void {
    const r = this.r, g = r.game;
    if (!g) return;
    if (this.base.width !== Math.round(this.w * this.dpr) || this.el.width === 0) this.layout();
    if (r.layer.version !== this.lastVersion && now - this.lastBase > 400) {
      this.lastVersion = r.layer.version;
      this.lastBase = now;
      this.bctx.imageSmoothingEnabled = true;
      this.bctx.imageSmoothingQuality = 'high';
      this.bctx.drawImage(r.layer.canvas, 0, 0, this.base.width, this.base.height);
      // borders carry most of the information on dark skins: blend them in
      this.bctx.globalAlpha = r.skin.light ? 0.5 : 0.9;
      this.bctx.drawImage(r.layer.borders, 0, 0, this.base.width, this.base.height);
      this.bctx.globalAlpha = 1;
    }
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(this.base, 0, 0);
    const sk = r.skin;
    const kx = this.base.width / g.W, ky = this.base.height / g.H;
    const [x0, y0, x1, y1] = r.cam.bounds();
    c.strokeStyle = sk.miniFrame;
    c.lineWidth = 1.5 * this.dpr;
    const rx = Math.max(0, x0 * kx), ry = Math.max(0, y0 * ky);
    const rw = Math.min(this.base.width, x1 * kx) - rx, rh = Math.min(this.base.height, y1 * ky) - ry;
    c.strokeRect(rx + 0.5, ry + 0.5, Math.max(2, rw - 1), Math.max(2, rh - 1));
    const me = g.human;
    if (me && me.alive && me.tiles > 0) {
      c.fillStyle = sk.light ? '#14161a' : '#fff';
      c.beginPath();
      c.arc((me.sumX / me.tiles) * kx, (me.sumY / me.tiles) * ky, 2.5 * this.dpr, 0, Math.PI * 2);
      c.fill();
    }
  }
}
