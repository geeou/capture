// Frame profiler: per-frame timings of the main loop split by stage, kept in fixed ring buffers (no per-frame
// allocation). Read with window.capture.perf(); shown live with ?perf=1 (PerfOverlay).

export const PERF_KEYS = [
  'frame',     // whole loop body (CPU)
  'interval',  // time between animation frames (what the user feels; includes GPU back-pressure)
  'sim',       // game.step() calls of the frame
  'layer',     // map-layer update: paint changed tiles, upload, glow rebuild
  'fog',       //   of which: repaint of tiles whose fog state flipped (advanced)
  'draw',      // whole canvas draw (0 on skipped frames)
  'd.map',     //   map blit (territory + borders)
  'd.glow',    //   additive border glow
  'd.grid',    //   grid / range rings / hover outline
  'd.struct',  //   structures + advanced markers
  'd.labels',  //   names and troops
  'd.units',   //   boats, warships, missiles
  'd.fx',      //   transient effects, aim previews, sweep
  'minimap',
  'hud',       // HUD / DOM updates (incl. advanced HUD and tutorial)
] as const;
export type PerfKey = typeof PERF_KEYS[number];

const N = 240;
const K = PERF_KEYS.length;
const IDX: Record<string, number> = {};
PERF_KEYS.forEach((k, i) => { IDX[k] = i; });

export interface Stat { avg: number; p50: number; p95: number }

class PerfProbe {
  private ring = new Float32Array(N * K);
  private cur = new Float64Array(K);
  private drew = new Uint8Array(N);
  private head = 0;
  private count = 0;
  private sorted = new Float32Array(N);

  /** Add `ms` to a stage of the current frame. */
  add(key: PerfKey, ms: number): void { this.cur[IDX[key]] += ms; }

  /** Close the current frame. */
  commit(drew: boolean): void {
    const o = this.head * K;
    for (let k = 0; k < K; k++) { this.ring[o + k] = this.cur[k]; this.cur[k] = 0; }
    this.drew[this.head] = drew ? 1 : 0;
    this.head = (this.head + 1) % N;
    if (this.count < N) this.count++;
  }

  reset(): void { this.head = 0; this.count = 0; this.cur.fill(0); }

  get frames(): number { return this.count; }

  /** Share of recent frames that redrew the canvas. */
  drawnRatio(): number {
    let d = 0;
    for (let i = 0; i < this.count; i++) d += this.drew[i];
    return this.count ? d / this.count : 0;
  }

  stat(key: PerfKey, onlyDrawn = false): Stat {
    const k = IDX[key], s = this.sorted;
    let n = 0, sum = 0;
    for (let i = 0; i < this.count; i++) {
      if (onlyDrawn && !this.drew[i]) continue;
      const v = this.ring[i * K + k];
      s[n++] = v; sum += v;
    }
    if (!n) return { avg: 0, p50: 0, p95: 0 };
    const view = s.subarray(0, n).sort();
    const r = (v: number) => Math.round(v * 100) / 100;
    return { avg: r(sum / n), p50: r(view[Math.floor(n * 0.5)]), p95: r(view[Math.min(n - 1, Math.floor(n * 0.95))]) };
  }

  /** All stages; draw sub-parts are averaged over the frames that actually drew. */
  all(): Record<PerfKey, Stat> {
    const out = {} as Record<PerfKey, Stat>;
    for (const key of PERF_KEYS) out[key] = this.stat(key, key === 'draw' || key.startsWith('d.'));
    return out;
  }
}

export const perf = new PerfProbe();

/** Small fixed text box (?perf=1) the user can read on the phone and report back. */
export class PerfOverlay {
  readonly el: HTMLDivElement;
  private last = 0;

  constructor(host: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'perf-hud';
    host.appendChild(this.el);
  }

  update(now: number, info: () => string[]): void {
    if (now - this.last < 500) return;
    this.last = now;
    const t = info().join('\n');
    if (this.el.textContent !== t) this.el.textContent = t;
  }
}
