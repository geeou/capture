// 2D camera: centre (x,y) in tile coordinates, `scale` = CSS pixels per tile.

export class Camera {
  x = 0;
  y = 0;
  scale = 1;
  viewW = 1;
  viewH = 1;
  mapW = 1;
  mapH = 1;
  minScale = 0.2;
  maxScale = 48;
  /** Smooth flight target (centreOn with animate). */
  private target: { x: number; y: number; scale: number } | null = null;

  setMap(w: number, h: number): void { this.mapW = w; this.mapH = h; this.updateMin(); }
  setView(w: number, h: number): void {
    const degenerate = this.viewW <= 2 || this.viewH <= 2;
    this.viewW = Math.max(1, w); this.viewH = Math.max(1, h);
    this.updateMin();
    if (degenerate && w > 2 && h > 2) this.fit();
    this.scale = Math.max(this.minScale, this.scale);
    this.clamp();
  }

  private updateMin(): void {
    this.minScale = Math.min(this.viewW / this.mapW, this.viewH / this.mapH) * 0.85;
  }

  /** Scale at which the whole map fits the view. */
  fitScale(): number { return Math.min(this.viewW / this.mapW, this.viewH / this.mapH) * 0.96; }

  fit(): void {
    this.target = null;
    this.scale = this.fitScale();
    this.x = this.mapW / 2; this.y = this.mapH / 2;
    this.clamp();
  }

  toScreenX(wx: number): number { return (wx - this.x) * this.scale + this.viewW / 2; }
  toScreenY(wy: number): number { return (wy - this.y) * this.scale + this.viewH / 2; }
  toWorldX(sx: number): number { return (sx - this.viewW / 2) / this.scale + this.x; }
  toWorldY(sy: number): number { return (sy - this.viewH / 2) / this.scale + this.y; }

  /** Pan by a screen-space delta (pixels). */
  panBy(dx: number, dy: number): void {
    this.target = null;
    this.x -= dx / this.scale;
    this.y -= dy / this.scale;
    this.clamp();
  }

  zoomAt(sx: number, sy: number, factor: number): void {
    this.target = null;
    const wx = this.toWorldX(sx), wy = this.toWorldY(sy);
    this.scale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * factor));
    this.x = wx - (sx - this.viewW / 2) / this.scale;
    this.y = wy - (sy - this.viewH / 2) / this.scale;
    this.clamp();
  }

  centerOn(x: number, y: number, scale?: number, animate = true): void {
    const s = scale ? Math.max(this.minScale, Math.min(this.maxScale, scale)) : this.scale;
    if (!animate) { this.x = x; this.y = y; this.scale = s; this.target = null; this.clamp(); return; }
    this.target = { x, y, scale: s };
  }

  /** Advance smooth flights. dt in ms. */
  update(dt: number): void {
    if (!this.target) return;
    const k = 1 - Math.exp(-dt / 110);
    const t = this.target;
    this.x += (t.x - this.x) * k;
    this.y += (t.y - this.y) * k;
    this.scale *= Math.pow(t.scale / this.scale, k);
    if (Math.abs(t.x - this.x) * this.scale < 0.5 && Math.abs(t.y - this.y) * this.scale < 0.5 && Math.abs(t.scale / this.scale - 1) < 0.002) {
      this.x = t.x; this.y = t.y; this.scale = t.scale; this.target = null;
    }
    this.clamp();
  }

  get moving(): boolean { return this.target !== null; }

  clamp(): void {
    // Allow the map edge to reach the screen centre-ish, never lose the map entirely.
    const halfW = this.viewW / 2 / this.scale, halfH = this.viewH / 2 / this.scale;
    const padX = Math.min(halfW * 0.6, this.mapW * 0.1), padY = Math.min(halfH * 0.6, this.mapH * 0.1);
    const minX = Math.min(halfW - padX, this.mapW / 2), maxX = Math.max(this.mapW - halfW + padX, this.mapW / 2);
    const minY = Math.min(halfH - padY, this.mapH / 2), maxY = Math.max(this.mapH - halfH + padY, this.mapH / 2);
    this.x = Math.max(minX, Math.min(maxX, this.x));
    this.y = Math.max(minY, Math.min(maxY, this.y));
  }

  /** Visible world rect [x0,y0,x1,y1] (unclamped to the map). */
  bounds(): [number, number, number, number] {
    return [this.toWorldX(0), this.toWorldY(0), this.toWorldX(this.viewW), this.toWorldY(this.viewH)];
  }
}
