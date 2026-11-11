// Graphics quality: Auto / Alta / Media / Bassa. "Auto" picks a starting level from the device and lets the
// governor (QualityGovernor, fed by the frame loop) step it down when frames run over budget and back up only
// after a long stable period. The effective level is mirrored on <body data-q="high|medium|low"> for src/perf.css.
// "high" renders exactly like the game did before quality levels existed.

export type QualityLevel = 'high' | 'medium' | 'low';
export type QualitySetting = 'auto' | QualityLevel;

export const QUALITY_SETTINGS: QualitySetting[] = ['auto', 'high', 'medium', 'low'];
export const QUALITY_LABEL: Record<QualitySetting, string> = { auto: 'Auto', high: 'Alta', medium: 'Media', low: 'Bassa' };
const LEVELS: QualityLevel[] = ['low', 'medium', 'high'];

export interface QualityProfile {
  level: QualityLevel;
  /** Upper bound of the canvas pixel ratio (on top of the device cap: 2, or 1.5 on coarse pointers). */
  dprCap: number;
  /** Border glow: 'full' = two additive blurred copies (as designed), 'merged' = one pre-mixed copy, 'off'. */
  glow: 'full' | 'merged' | 'off';
  /** Minimum interval between rebuilds of the blurred border copies (ms). */
  glowMs: number;
  /** Radar sweep: 'css' = rotating conic layer of the fx overlay, 'canvas' = wedge drawn on the map canvas, 'off'. */
  sweep: 'css' | 'canvas' | 'off';
  /** Max map redraws per second (0 = every animation frame). */
  fpsCap: number;
  /** Minimum interval between minimap base rebuilds (ms). */
  minimapMs: number;
  /** Cheaper transient effects (fewer smoke puffs, no smoke gradient). */
  liteFx: boolean;
  /** Upload map-layer changes on the frame after a sim step instead of the same frame. */
  deferFlush: boolean;
  /** Max sim time per frame (ms) before the remaining catch-up is dropped. */
  simBudgetMs: number;
}

const PROFILES: Record<QualityLevel, QualityProfile> = {
  high: { level: 'high', dprCap: Infinity, glow: 'full', glowMs: 220, sweep: 'css', fpsCap: 0, minimapMs: 400, liteFx: false, deferFlush: false, simBudgetMs: 40 },
  medium: { level: 'medium', dprCap: 1.25, glow: 'merged', glowMs: 500, sweep: 'canvas', fpsCap: 0, minimapMs: 900, liteFx: false, deferFlush: true, simBudgetMs: 16 },
  low: { level: 'low', dprCap: 1, glow: 'off', glowMs: 1000, sweep: 'off', fpsCap: 30, minimapMs: 1600, liteFx: true, deferFlush: true, simBudgetMs: 12 },
};

const STORE_KEY = 'capture.quality.v1';

function parseSetting(v: string | null | undefined): QualitySetting | null {
  if (!v) return null;
  const s = v.toLowerCase();
  if (s === 'auto') return 'auto';
  if (s === 'high' || s === 'alta' || s === 'h' || s === '3') return 'high';
  if (s === 'medium' || s === 'media' || s === 'm' || s === '2') return 'medium';
  if (s === 'low' || s === 'bassa' || s === 'l' || s === '1') return 'low';
  return null;
}

function urlSetting(): QualitySetting | null {
  try { return parseSetting(new URLSearchParams(location.search).get('q')); } catch { return null; }
}
function storedSetting(): QualitySetting | null {
  try { return parseSetting(localStorage.getItem(STORE_KEY)); } catch { return null; }
}

/** Touch-first device (phone / tablet), or the touch layout forced with ?touch=1. */
export function isTouchDevice(): boolean {
  try {
    if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return true;
    return new URLSearchParams(location.search).get('touch') === '1';
  } catch { return false; }
}

/** Level "auto" starts from: high on desktop, medium on touch devices, low on small touch devices. */
export function autoStartLevel(): QualityLevel {
  if (!isTouchDevice()) return 'high';
  const nav = navigator as Navigator & { deviceMemory?: number };
  const mem = nav.deviceMemory ?? 8, cores = nav.hardwareConcurrency ?? 8;
  return mem <= 3 || cores <= 4 ? 'low' : 'medium';
}

let setting: QualitySetting = urlSetting() ?? storedSetting() ?? 'auto';
let level: QualityLevel = setting === 'auto' ? autoStartLevel() : setting;
const listeners = new Set<(p: QualityProfile) => void>();

function applyDom(): void {
  if (typeof document === 'undefined') return;
  const put = () => { document.body.dataset.q = level; };
  if (document.body) put(); else document.addEventListener('DOMContentLoaded', put, { once: true });
}

export function qualitySetting(): QualitySetting { return setting; }
export function qualityLevel(): QualityLevel { return level; }
export function qualityProfile(): QualityProfile { return PROFILES[level]; }

function setLevel(l: QualityLevel): void {
  if (l === level) return;
  level = l;
  applyDom();
  listeners.forEach(fn => fn(PROFILES[level]));
}

/** Change the setting (from the menus or ?q=). `persist` stores it in localStorage. */
export function setQuality(s: QualitySetting, persist = true): void {
  setting = s;
  if (persist) { try { localStorage.setItem(STORE_KEY, s); } catch { /* storage unavailable */ } }
  governor.reset(true);
  const prev = level;
  setLevel(s === 'auto' ? autoStartLevel() : s);
  if (prev === level) listeners.forEach(fn => fn(PROFILES[level])); // only the setting changed (menus show it)
}

export function onQualityChange(fn: (p: QualityProfile) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Label for menus: "Auto (Media)" while auto is active. */
export function qualityLabel(): string {
  return setting === 'auto' ? `Auto (${QUALITY_LABEL[level]})` : QUALITY_LABEL[setting];
}

/**
 * Auto-quality governor. Fed once per animation frame while a match is running (not paused, no modal, page
 * visible) with the frame interval and the CPU time of the frame. Every WINDOW ms it averages them:
 *  - over budget (interval > 21.5 ms, i.e. under ~46 fps, or CPU > 11 ms) twice in a row → one level down;
 *  - comfortably fast (interval < 18 ms and CPU < 5 ms) for `upAfter` ms in a row → one level up.
 * A step up that is followed by a step down within PROBE_FAIL_MS counts as a failed probe: `upAfter` doubles,
 * and after two failed probes the governor stops stepping up for the session. No oscillation by construction.
 */
const WINDOW = 2000;
const PROBE_FAIL_MS = 25000;

export class QualityGovernor {
  private winStart = 0;
  private n = 0;
  private sumDt = 0;
  private sumCpu = 0;
  private drawn = 0;
  private bad = 0;
  private goodSince = 0;
  private lastChange = 0;
  private lastUp = -1e12;
  private upAfter = 30000;
  private fails = 0;
  /** Last window averages (for the ?perf=1 overlay). */
  lastInterval = 0;
  lastCpu = 0;

  reset(full = false): void {
    this.winStart = 0; this.n = 0; this.sumDt = 0; this.sumCpu = 0; this.drawn = 0; this.bad = 0; this.goodSince = 0;
    if (full) { this.upAfter = 30000; this.fails = 0; this.lastUp = -1e12; }
  }

  feed(now: number, dt: number, cpu: number, drew: boolean): void {
    if (setting !== 'auto') return;
    if (dt > 500) { this.reset(); return; } // tab switch, GC pause, debugger: not a load signal
    if (!this.winStart) { this.winStart = now; return; }
    this.n++; this.sumDt += Math.min(dt, 100); this.sumCpu += cpu; if (drew) this.drawn++;
    if (now - this.winStart < WINDOW || this.n < 20) return;
    const iv = this.sumDt / this.n, cp = this.sumCpu / this.n, drawRatio = this.drawn / this.n;
    this.lastInterval = iv; this.lastCpu = cp;
    this.winStart = now; this.n = 0; this.sumDt = 0; this.sumCpu = 0; this.drawn = 0;
    const over = iv > 21.5 || cp > 11;
    // "good" only counts when the map was really being redrawn (idle frames say nothing about headroom)
    const good = iv < 18 && cp < 5 && drawRatio > (PROFILES[level].fpsCap ? 0.35 : 0.6);
    if (over) {
      this.goodSince = 0;
      if (++this.bad >= 2 && now - this.lastChange > 3000) {
        this.bad = 0;
        const i = LEVELS.indexOf(level);
        if (i > 0) {
          if (now - this.lastUp < PROBE_FAIL_MS) { this.fails++; this.upAfter *= 2; }
          this.lastChange = now;
          setLevel(LEVELS[i - 1]);
        }
      }
      return;
    }
    this.bad = 0;
    if (!good) { this.goodSince = 0; return; }
    if (!this.goodSince) this.goodSince = now;
    const i = LEVELS.indexOf(level);
    if (i < LEVELS.length - 1 && this.fails < 2 && now - this.goodSince >= this.upAfter && now - this.lastChange > 10000) {
      this.goodSince = 0;
      this.lastChange = now;
      this.lastUp = now;
      setLevel(LEVELS[i + 1]);
    }
  }
}

export const governor = new QualityGovernor();

applyDom();
