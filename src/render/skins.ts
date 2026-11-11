// Visual skins: map palette, overlay styling and the active-skin state shared by renderer and DOM.
// The DOM side is themed by CSS through `body[data-skin="…"]` (see src/skins.css).
import type { Player } from '../sim/types';

export type SkinId = 'radar' | 'holo' | 'tat' | 'orb';
export const SKIN_IDS: SkinId[] = ['radar', 'holo', 'tat', 'orb'];
export const DEFAULT_SKIN: SkinId = 'radar';

export const SKIN_INFO: Record<SkinId, { name: string; desc: string; swatch: string[] }> = {
  radar: { name: 'Radar', desc: 'Sala guerra a fosfori verdi', swatch: ['#010605', '#00361b', '#5aff9b', '#ffbe3c'] },
  holo: { name: 'Ologramma', desc: 'Tavolo olografico ciano', swatch: ['#0e182e', '#10688e', '#8cf2ff', '#ff74a0'] },
  tat: { name: 'Tattico', desc: 'Carta tattica opaca', swatch: ['#161d22', '#36506d', '#80baff', '#ffb000'] },
  orb: { name: 'Orbita', desc: 'Comando orbitale chiaro', swatch: ['#eef1f3', '#c9d9ef', '#14161a', '#ff5a1f'] },
};

export function isSkinId(v: unknown): v is SkinId {
  return typeof v === 'string' && (SKIN_IDS as string[]).includes(v);
}

// ── relations ────────────────────────────────────────────────────────────────
export const R_NONE = 0, R_ME = 1, R_ALLY = 2, R_ENEMY = 3, R_NEUTRAL = 4, R_TRIBE = 5;
/** Border priority: on a shared border the higher-priority side draws the line. */
export const REL_PRIO = [0, 6, 4, 5, 2, 1];

// ── colour helpers ───────────────────────────────────────────────────────────
export type RGB = [number, number, number];
export const pk = (r: number, g: number, b: number, a = 255): number =>
  ((a << 24) | (Math.max(0, Math.min(255, b)) << 16) | (Math.max(0, Math.min(255, g)) << 8) | Math.max(0, Math.min(255, r))) >>> 0;
export const pkc = (c: RGB, m = 1): number => pk((c[0] * m) | 0, (c[1] * m) | 0, (c[2] * m) | 0);
export const css = (c: RGB, a = 1): string => (a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`);
export const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export function hsl(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}
export function hueOf(c: number): number {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  if (!d) return 0;
  const h = 60 * (mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return h < 0 ? h + 360 : h;
}

// ── skin definition ──────────────────────────────────────────────────────────
/** Territory look for one player: fill, hatch fill (alt) and edge colour. */
export interface Look { f: RGB; a?: RGB; e: RGB }

export interface FxTheme {
  flash: string;
  /** fireball gradient stops (rgb triplets) */
  core: RGB; mid: RGB; outer: RGB;
  ring: string;
  smoke: RGB;
  puff: string;
  ping: string;
}

export interface Skin {
  id: SkinId;
  light: boolean;
  /** Canvas clear colour (outside the map). */
  bg: string;
  frame: string;
  /** Water colour from the distance to land (tiles, capped) and tile position. */
  water(d: number, x: number, y: number): RGB;
  /** Unclaimed land: plains, hills, mountain. */
  land: [RGB, RGB, RGB];
  /** Per-terrain multiplier of owned fills (plains, hills, mountain). */
  terrMul: [number, number, number];
  look(p: Player, rel: number): Look;
  /** Tile-space hatching of own / enemy territory. */
  hatchMe(x: number, y: number): boolean;
  hatchEn(x: number, y: number): boolean;
  coast: RGB | null;
  front: RGB;
  fallout: RGB;
  /** Additive border glow strength (0 = none). */
  glow: number;
  grid: 'radar' | 'hex' | 'square' | 'cross';
  gridLine: string;
  gridMajor: string;
  gridText: string;
  font: string;
  mono: string;
  labelWeight: string;
  labelUpper: boolean;
  /** letter spacing as a fraction of the font size */
  labelTrack: number;
  struct: 'bracket' | 'disc' | 'box' | 'ring';
  accent: string;
  hot: RGB;
  hover: string;
  select: string;
  wake: string;
  text: string;
  halo: string;
  /** Background/ink of small on-map tags (aim reason, labels on light skins). */
  tagBg: string;
  tagInk: string;
  miniFrame: string;
  fx: FxTheme;
  // ── advanced mode ──
  /** Fog of war: colours outside vision are desaturated by `fogDesat`, then mixed towards `fogTint` by `fogK`
   * (`fogK2` for land never explored). */
  fogTint: RGB;
  fogDesat: number;
  fogK: number;
  fogK2: number;
  /** Hatch colour of cut-off (out of supply) tiles and how strongly it is mixed in. */
  cut: RGB;
  cutK: number;
  /** Ink of unowned deposits / neutral advanced markers. */
  neutral: string;
}

const diag = (per: number, on: number, dir: number) => (x: number, y: number) => ((x + dir * y) % per + per) % per < on;
const rows = (per: number) => (_x: number, y: number) => y % per === 0;
const never = () => false;

const RADAR_NEU = [38, 72, 165, 200, 265, 315];

function makeRadar(): Skin {
  return {
    id: 'radar', light: false, bg: '#010605', frame: 'rgba(70,255,150,0.22)',
    water: (d) => (d > 0 && d <= 9 && d % 3 === 0 ? [3, 21, 14] : [1, 6, 5]),
    land: [[4, 13, 9], [6, 17, 12], [9, 23, 16]],
    terrMul: [1, 1.18, 1.4],
    look: (p, r) =>
      r === R_ME ? { f: [0, 54, 27], a: [0, 112, 55], e: [90, 255, 155] }
      : r === R_ALLY ? { f: [0, 40, 48], e: [80, 228, 238] }
      : r === R_ENEMY ? { f: [58, 6, 8], a: [120, 16, 18], e: [255, 76, 62] }
      : r === R_TRIBE ? { f: [7, 17, 12], e: [42, 84, 58] }
      : { f: hsl(RADAR_NEU[p.id % 6], 0.75, 0.065), e: hsl(RADAR_NEU[p.id % 6], 0.7, 0.42) },
    hatchMe: diag(4, 1, 1), hatchEn: diag(4, 1, -1),
    coast: [34, 96, 62], front: [255, 190, 60], fallout: [150, 210, 40],
    glow: 0.9,
    grid: 'radar', gridLine: 'rgba(70,255,150,0.06)', gridMajor: 'rgba(70,255,150,0.16)', gridText: 'rgba(90,255,160,0.5)',
    font: '"Share Tech Mono", ui-monospace, Menlo, monospace', mono: '"Share Tech Mono", ui-monospace, Menlo, monospace',
    labelWeight: '400', labelUpper: true, labelTrack: 0.06,
    struct: 'bracket', accent: '#ffbe3c', hot: [255, 76, 62],
    hover: 'rgba(160,255,200,0.55)', select: 'rgba(255,200,90,0.8)', wake: 'rgba(90,255,160,', text: '#62f59d', halo: 'rgba(0,8,4,0.85)',
    tagBg: 'rgba(0,12,6,0.88)', tagInk: '#ffb23e', miniFrame: '#ffbe3c',
    fogTint: [1, 6, 5], fogDesat: 0.75, fogK: 0.5, fogK2: 0.72, cut: [255, 190, 60], cutK: 0.55, neutral: '#7fa592',
    fx: { flash: '#c8ffdc', core: [235, 255, 240], mid: [120, 255, 170], outer: [30, 190, 100], ring: '#7dffb0', smoke: [6, 34, 20], puff: '#9effc4', ping: '#ffbe3c' },
  };
}

function makeHolo(): Skin {
  const wt: RGB[] = [];
  for (let d = 0; d <= 10; d++) { const v = d < 10 ? 10 - d : 0; wt[d] = [4 + v, 9 + v * 2.4, 22 + v * 3.6]; }
  return {
    id: 'holo', light: false, bg: '#040916', frame: 'rgba(110,225,255,0.25)',
    water: (d) => wt[d > 10 ? 10 : d],
    land: [[14, 24, 46], [18, 30, 54], [24, 38, 66]],
    terrMul: [1, 1.1, 1.24],
    look: (p, r) => {
      const h = hueOf(p.color);
      return r === R_ME ? { f: [16, 104, 142], a: [34, 146, 190], e: [140, 242, 255] }
        : r === R_ALLY ? { f: [16, 104, 92], e: [110, 255, 212] }
        : r === R_ENEMY ? { f: [118, 26, 60], a: [158, 40, 82], e: [255, 116, 156] }
        : r === R_TRIBE ? { f: mix(hsl(h, 0.25, 0.2), [14, 24, 46], 0.45), e: hsl(h, 0.3, 0.4) }
        : { f: mix(hsl(h, 0.55, 0.27), [10, 22, 48], 0.3), e: hsl(h, 0.8, 0.68) };
    },
    hatchMe: rows(3), hatchEn: rows(3),
    coast: [70, 150, 200], front: [255, 255, 255], fallout: [120, 255, 120],
    glow: 1,
    grid: 'hex', gridLine: 'rgba(110,225,255,0.07)', gridMajor: 'rgba(110,225,255,0.14)', gridText: 'rgba(140,230,255,0.6)',
    font: 'Rajdhani, "DIN Alternate", system-ui, sans-serif', mono: 'Orbitron, Rajdhani, system-ui, sans-serif',
    labelWeight: '700', labelUpper: true, labelTrack: 0.12,
    struct: 'disc', accent: '#7fe8ff', hot: [255, 110, 200],
    hover: 'rgba(170,240,255,0.55)', select: 'rgba(255,255,255,0.8)', wake: 'rgba(140,235,255,', text: '#cdeeff', halo: 'rgba(3,10,26,0.8)',
    tagBg: 'rgba(7,22,46,0.9)', tagInk: '#ffc0d0', miniFrame: '#7fe8ff',
    fogTint: [4, 9, 22], fogDesat: 0.8, fogK: 0.5, fogK2: 0.72, cut: [255, 255, 255], cutK: 0.5, neutral: '#9fb3c4',
    fx: { flash: '#d8f7ff', core: [255, 255, 255], mid: [140, 242, 255], outer: [255, 110, 200], ring: '#bff6ff', smoke: [20, 30, 60], puff: '#cdeeff', ping: '#7fe8ff' },
  };
}

function makeTat(): Skin {
  const base: RGB = [50, 55, 45];
  return {
    id: 'tat', light: false, bg: '#12171b', frame: 'rgba(230,232,200,0.2)',
    water: (d) => (d === 2 || d === 6 ? [31, 41, 47] : [22, 29, 34]),
    land: [[38, 42, 36], [44, 47, 39], [53, 54, 46]],
    terrMul: [1, 1.16, 1.36],
    look: (p, r) => {
      const h = hueOf(p.color);
      return r === R_ME ? { f: mix(base, [56, 120, 212], 0.52), e: [128, 186, 255] }
        : r === R_ALLY ? { f: mix(base, [48, 170, 158], 0.42), e: [104, 218, 202] }
        : r === R_ENEMY ? { f: mix(base, [204, 58, 44], 0.46), a: mix(base, [110, 28, 24], 0.6), e: [255, 100, 78] }
        : r === R_TRIBE ? { f: mix(base, [96, 96, 74], 0.16), e: [104, 106, 88] }
        : { f: mix(base, hsl(h, 0.3, 0.42), 0.24), e: [152, 152, 122] };
    },
    hatchMe: never, hatchEn: diag(4, 1, 1),
    coast: [118, 126, 112], front: [255, 176, 0], fallout: [190, 200, 60],
    glow: 0,
    grid: 'square', gridLine: 'rgba(230,232,200,0.05)', gridMajor: 'rgba(230,232,200,0.14)', gridText: 'rgba(225,226,200,0.5)',
    font: '"Saira Condensed", "DIN Condensed", "Arial Narrow", sans-serif', mono: '"IBM Plex Mono", ui-monospace, Menlo, monospace',
    labelWeight: '700', labelUpper: true, labelTrack: 0.12,
    struct: 'box', accent: '#ffb000', hot: [255, 176, 0],
    hover: 'rgba(240,240,215,0.5)', select: 'rgba(255,176,0,0.85)', wake: 'rgba(210,212,190,', text: '#cfd0bd', halo: 'rgba(14,16,10,0.85)',
    tagBg: '#12140e', tagInk: '#ffb000', miniFrame: '#ffb000',
    fogTint: [16, 20, 23], fogDesat: 0.8, fogK: 0.5, fogK2: 0.7, cut: [255, 176, 0], cutK: 0.6, neutral: '#a3a48c',
    fx: { flash: '#fff1cc', core: [255, 244, 210], mid: [255, 176, 0], outer: [255, 96, 40], ring: '#ffcf66', smoke: [40, 42, 32], puff: '#e2e3ca', ping: '#ffb000' },
  };
}

function makeOrb(): Skin {
  return {
    id: 'orb', light: true, bg: '#e4e8eb', frame: 'rgba(20,22,26,0.35)',
    water: (d) => (d <= 1 ? [224, 229, 233] : [238, 241, 243]),
    land: [[212, 216, 219], [205, 209, 212], [196, 200, 204]],
    terrMul: [1, 0.965, 0.91],
    look: (p, r) => {
      const h = hueOf(p.color);
      return r === R_ME ? { f: [255, 98, 42], a: [255, 128, 80], e: [170, 42, 0] }
        : r === R_ALLY ? { f: hsl(214, 0.78, 0.74), e: [34, 82, 172] }
        : r === R_ENEMY ? { f: [54, 56, 62], a: [78, 80, 88], e: [14, 14, 18] }
        : r === R_TRIBE ? { f: hsl(h, 0.14, 0.83), e: [150, 156, 162] }
        : { f: hsl(h, 0.4, 0.8), e: hsl(h, 0.35, 0.42) };
    },
    hatchMe: diag(5, 1, 1), hatchEn: diag(4, 1, -1),
    coast: [124, 132, 140], front: [255, 255, 255], fallout: [196, 214, 80],
    glow: 0,
    grid: 'cross', gridLine: 'rgba(30,38,48,0.3)', gridMajor: 'rgba(20,22,26,0.4)', gridText: 'rgba(20,22,26,0.55)',
    font: '"Space Grotesk", "Helvetica Neue", system-ui, sans-serif', mono: '"JetBrains Mono", ui-monospace, Menlo, monospace',
    labelWeight: '600', labelUpper: false, labelTrack: 0,
    struct: 'ring', accent: '#ff5a1f', hot: [216, 60, 0],
    hover: 'rgba(20,22,26,0.45)', select: 'rgba(255,90,31,0.85)', wake: 'rgba(20,22,26,', text: '#14161a', halo: 'rgba(250,251,252,0.85)',
    tagBg: '#fafbfc', tagInk: '#d83c00', miniFrame: '#ff5a1f',
    fogTint: [226, 229, 232], fogDesat: 0.85, fogK: 0.55, fogK2: 0.78, cut: [20, 22, 26], cutK: 0.55, neutral: '#5d646b',
    fx: { flash: '#ffffff', core: [255, 250, 240], mid: [255, 140, 90], outer: [216, 60, 0], ring: '#14161a', smoke: [120, 126, 132], puff: '#14161a', ping: '#ff5a1f' },
  };
}

const MAKERS: Record<SkinId, () => Skin> = { radar: makeRadar, holo: makeHolo, tat: makeTat, orb: makeOrb };
const cache = new Map<SkinId, Skin>();
export function getSkin(id: SkinId = current): Skin {
  let s = cache.get(id);
  if (!s) { s = MAKERS[id](); cache.set(id, s); }
  return s;
}

// ── active skin state ────────────────────────────────────────────────────────
const SETUP_KEY = 'capture.setup.v1';
const listeners = new Set<(id: SkinId) => void>();

function storedSkin(): SkinId | null {
  try {
    const raw = localStorage.getItem(SETUP_KEY);
    const v = raw ? JSON.parse(raw).skin : null;
    return isSkinId(v) ? v : null;
  } catch { return null; }
}
function urlSkin(): SkinId | null {
  try {
    const v = new URLSearchParams(location.search).get('skin');
    return isSkinId(v) ? v : null;
  } catch { return null; }
}

let current: SkinId = urlSkin() ?? storedSkin() ?? DEFAULT_SKIN;

const FONT_PROBES: Record<SkinId, string[]> = {
  radar: ['16px "Share Tech Mono"'],
  holo: ['600 16px Rajdhani', '700 16px Rajdhani', '500 16px Orbitron', '700 16px Orbitron'],
  tat: ['600 16px "Saira Condensed"', '700 16px "Saira Condensed"', '500 16px "IBM Plex Mono"'],
  orb: ['600 16px "Space Grotesk"', '500 16px "Space Grotesk"', '400 16px "JetBrains Mono"'],
};

function applyDom(id: SkinId): void {
  if (typeof document === 'undefined') return;
  document.body.dataset.skin = id;
  document.documentElement.style.colorScheme = getSkin(id).light ? 'light' : 'dark';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', getSkin(id).bg);
  // canvas text needs the faces loaded explicitly (CSS only fetches what the DOM uses)
  if (document.fonts) {
    Promise.allSettled(FONT_PROBES[id].map(f => document.fonts.load(f))).then(() => {
      if (current === id) listeners.forEach(fn => fn(id));
    });
  }
}

export function skinId(): SkinId { return current; }

/** Switch the active skin (repaints map and DOM). `persist` stores it with the setup preferences. */
export function setSkin(id: SkinId, persist = false): void {
  if (!isSkinId(id)) return;
  if (persist) {
    try {
      const raw = localStorage.getItem(SETUP_KEY);
      const o = raw ? JSON.parse(raw) : {};
      o.skin = id;
      localStorage.setItem(SETUP_KEY, JSON.stringify(o));
    } catch { /* storage unavailable */ }
  }
  if (id === current && document.body.dataset.skin === id) return;
  current = id;
  applyDom(id);
  listeners.forEach(fn => fn(id));
}

/** Subscribe to skin changes; returns an unsubscribe function. */
export function onSkinChange(fn: (id: SkinId) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof document !== 'undefined') {
  if (document.body) applyDom(current);
  else document.addEventListener('DOMContentLoaded', () => applyDom(current), { once: true });
}
