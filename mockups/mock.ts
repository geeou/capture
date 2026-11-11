// CAPTURE — graphic-direction mockups. Runs a real bot match on the world map, then renders the same
// frozen moment in four skins. Not part of the game build: open /mockups/ on the dev server.
import { loadWorldMap } from '../src/map';
import { createGame } from '../src/sim';
import type { Game, Player, Structure, StructureType } from '../src/sim';
import { drawGlyph, glyphURL, STRUCTURE_LABEL, STRUCTURE_KEY } from '../src/render/icons';

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const qs = new URLSearchParams(location.search);
const TICKS = +(qs.get('ticks') ?? 2600);
const SEED = +(qs.get('seed') ?? 1);

const STYLES = ['radar', 'holo', 'tat', 'orb'] as const;
type StyleId = typeof STYLES[number];
const INFO: Record<StyleId, { n: string; d: string }> = {
  radar: { n: 'Radar', d: 'Sala guerra a fosfori: vettoriale verde, spazzata radar, HUD solo testo.' },
  holo: { n: 'Ologramma', d: 'Tavolo olografico: vetro ciano, griglia esagonale, confini luminosi.' },
  tat: { n: 'Tattico', d: 'Carta tattica: opaca, colori per affiliazione (tu blu, nemici rossi), console laterale.' },
  orb: { n: 'Orbita', d: 'Comando orbitale chiaro: linee sottili, un solo accento arancio.' },
};

type RGB = [number, number, number];
const NONE = 0, ME = 1, ALLY = 2, ENEMY = 3, NEUTRAL = 4, TRIBE = 5;
const PRIO = [0, 6, 4, 5, 2, 1];
const WK = 0xffff;

const pk = (r: number, g: number, b: number) => ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
const pkc = (c: RGB, m = 1) => pk(Math.min(255, c[0] * m) | 0, Math.min(255, c[1] * m) | 0, Math.min(255, c[2] * m) | 0);
const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
function hsl(h: number, s: number, l: number): RGB {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return [f(0), f(8), f(4)];
}
function hueOf(c: number): number {
  const r = ((c >> 16) & 255) / 255, g = ((c >> 8) & 255) / 255, b = (c & 255) / 255;
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  if (!d) return 0;
  const h = 60 * (mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return h < 0 ? h + 360 : h;
}
const fmt = (n: number) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1e4 ? Math.round(n / 1e3) + 'K' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : '' + Math.round(n);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ── state ───────────────────────────────────────────────────────────────────
let g: Game, me: Player, rel: Uint8Array, wd: Uint8Array;
let enemy: Player | null = null;
let front = { x: 0, y: 0 };
let D: any;
let current: StyleId = (STYLES as readonly string[]).includes(location.hash.slice(1)) ? location.hash.slice(1) as StyleId : 'radar';

function yieldNow(): Promise<void> {
  return new Promise(res => { const c = new MessageChannel(); c.port1.onmessage = () => res(); c.port2.postMessage(0); });
}

async function boot() {
  const map = await loadWorldMap();
  g = createGame(map, { seed: SEED, humanSpawn: null });
  g.trackChanges = false;
  let t = 0;
  while (t < TICKS && !g.winner) {
    const end = performance.now() + 120;
    while (t < TICKS && performance.now() < end) { g.step(); t++; }
    $('#loading').textContent = `Simulazione di una partita… ${Math.round(100 * t / TICKS)}%`;
    await yieldNow();
  }
  setup();
  await Promise.race([
    Promise.allSettled(['13px "Share Tech Mono"', '600 13px Rajdhani', '500 10px Orbitron', '700 13px "Saira Condensed"', '500 11px "IBM Plex Mono"', '600 13px "Space Grotesk"', '400 10px "JetBrains Mono"'].map(f => document.fonts.load(f))),
    new Promise(r => setTimeout(r, 2500)),
  ]);
  $('#loading').remove();
  show(current);
}

function setup() {
  const P = g.players;
  const nations = P.filter(p => p.id && p.alive && p.kind !== 'tribe').sort((a, b) => b.tiles - a.tiles);
  // default "you": a mid-sized nation with the busiest neighbourhood, so the mockup shows many borders
  const busy = (p: Player) => [...g.neighborsOf(p.id).keys()].filter(i => i && P[i].alive && P[i].kind !== 'tribe' && P[i].tiles > 300).length;
  const pool = nations.filter(p => p.tiles >= 1800 && p.tiles <= 9000);
  me = nations.find(p => p.name === qs.get('me')) ?? pool.sort((a, b) => busy(b) - busy(a) || b.tiles - a.tiles)[0] ?? nations[Math.min(3, nations.length - 1)];
  rel = new Uint8Array(P.length);
  for (const p of P) if (p.id) rel[p.id] = p.kind === 'tribe' ? TRIBE : NEUTRAL;
  rel[me.id] = ME;
  for (const a of me.allies) if (P[a].alive) rel[a] = ALLY;
  for (const a of g.attacks) {
    if (!a.alive) continue;
    if (a.attacker === me.id && a.target && rel[a.target] !== ALLY) rel[a.target] = ENEMY;
    if (a.target === me.id) rel[a.attacker] = ENEMY;
  }
  const nb = [...g.neighborsOf(me.id).keys()].filter(id => id && P[id].alive).map(id => P[id]).sort((a, b) => b.tiles - a.tiles);
  if (!nb.some(p => rel[p.id] === ENEMY)) { const p = nb.find(p => rel[p.id] === NEUTRAL) ?? nb.find(p => rel[p.id] === TRIBE); if (p) rel[p.id] = ENEMY; }
  if (!nb.some(p => rel[p.id] === ALLY)) { const p = nb.find(p => rel[p.id] === NEUTRAL); if (p) rel[p.id] = ALLY; }
  enemy = nb.find(p => rel[p.id] === ENEMY) ?? null;
  const ally = nb.find(p => rel[p.id] === ALLY) ?? null;

  // front midpoint between me and the main enemy
  const mcx = me.sumX / me.tiles, mcy = me.sumY / me.tiles;
  front = { x: mcx, y: mcy };
  if (enemy) {
    let sx = 0, sy = 0, n = 0;
    for (const i of me.border) {
      let hit = false;
      g.forNeighbors(i, k => { if (g.owner[k] === enemy!.id) hit = true; });
      if (hit) { sx += g.xOf(i); sy += g.yOf(i); n++; }
    }
    front = n ? { x: sx / n, y: sy / n } : { x: (mcx + enemy.sumX / enemy.tiles) / 2, y: (mcy + enemy.sumY / enemy.tiles) / 2 };
  }

  // water distance to land (city-block, capped) for coast effects
  const W = g.W, H = g.H;
  wd = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) wd[i] = g.terrain[i] ? 0 : 40;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; let v = wd[i];
    if (x && wd[i - 1] + 1 < v) v = wd[i - 1] + 1;
    if (y && wd[i - W] + 1 < v) v = wd[i - W] + 1;
    wd[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; let v = wd[i];
    if (x < W - 1 && wd[i + 1] + 1 < v) v = wd[i + 1] + 1;
    if (y < H - 1 && wd[i + W] + 1 < v) v = wd[i + W] + 1;
    wd[i] = v;
  }

  // HUD data
  const sec = Math.floor(g.tick / 10);
  const clock = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  const all = P.filter(p => p.id && p.alive).sort((a, b) => b.tiles - a.tiles);
  const rank = all.indexOf(me) + 1;
  const top = all.slice(0, 8);
  if (!top.includes(me)) top[7] = me;
  const types: StructureType[] = ['city', 'port', 'fort', 'factory', 'silo', 'sam'];
  const ports = g.countStructures(me.id, 'port');
  const en = enemy?.name ?? 'Nemico', al = ally?.name ?? 'Alleato';
  D = {
    name: me.name, clock: clock(sec), troops: me.troops, max: g.q.maxTroops(me.id), troopRate: g.q.troopRate(me.id) * 10,
    gold: me.gold, goldRate: Math.round(g.q.goldRate(me.id) * 10), shareF: g.share(me.id), share: (100 * g.share(me.id)).toFixed(1), rank, alive: all.length,
    boats: `${Math.min(2, 3 + ports)}/${3 + ports}`,
    top: top.map(p => ({ id: p.id, rank: all.indexOf(p) + 1, name: p.name, share: (100 * g.share(p.id)).toFixed(1), troops: fmt(p.troops), rel: rel[p.id] })),
    build: types.map(t => ({ type: t, label: STRUCTURE_LABEL[t], key: STRUCTURE_KEY[t], cost: fmt(g.q.buildCost(me.id, t)) })),
    atom: fmt(g.q.nukeCost(me.id, 'atom')), hydro: fmt(g.q.nukeCost(me.id, 'hydrogen')),
    allies: nb.filter(p => rel[p.id] === ALLY).slice(0, 3), enemies: nb.filter(p => rel[p.id] === ENEMY).slice(0, 3),
    log: [
      { t: clock(sec - 41), lv: 'good', x: `Alleanza con ${al} rinnovata` },
      { t: clock(sec - 28), lv: 'info', x: `Sbarco riuscito: 4,2K truppe a terra` },
      { t: clock(sec - 17), lv: 'danger', x: `${en} attacca il tuo confine` },
      { t: clock(sec - 9), lv: 'info', x: `Silo missilistico operativo` },
      { t: clock(sec - 2), lv: 'warn', x: `Atomica in volo verso ${en}` },
    ],
  };
  console.log('[mock] me =', me.name, 'rank', rank, 'tiles', me.tiles, 'enemy', enemy?.name, 'tick', g.tick);
}

// ── map skins ───────────────────────────────────────────────────────────────
interface Skin {
  bw: number; glow: number; glowA: number; lighter: boolean; padL: number;
  fill: Uint32Array; alt: Uint32Array; edge: RGB[]; coast: RGB; front: RGB;
  stripeMe(sx: number, sy: number): boolean; stripeEn(sx: number, sy: number): boolean;
  water(sx: number, sy: number, d: number): number;
  mini: { water: RGB; land: RGB; other: RGB };
}
type Def = { f: RGB; a?: RGB; e: RGB };

function skin(id: StyleId, u: number): Skin {
  const P = g.players, n = P.length;
  const fill = new Uint32Array(n * 4), alt = new Uint32Array(n), edge: RGB[] = new Array(n);
  const build = (uncl: RGB[], tm: number[], def: (p: Player, r: number, h: number) => Def) => {
    for (let t = 1; t < 4; t++) fill[t] = pkc(uncl[t - 1]);
    edge[0] = uncl[2];
    for (const p of P) {
      if (!p.id) continue;
      const d = def(p, rel[p.id], hueOf(p.color));
      for (let t = 1; t < 4; t++) fill[p.id * 4 + t] = pkc(d.f, tm[t]);
      alt[p.id] = pkc(d.a ?? d.f); edge[p.id] = d.e;
    }
  };
  const m = (k: number) => Math.max(2, Math.round(k * u));
  const diag = (per: number, on: number, dir: number) => (sx: number, sy: number) => ((sx + dir * sy) % per + per) % per < on;
  const rows = (per: number) => (_sx: number, sy: number) => sy % per === 0;
  const never = () => false;

  if (id === 'radar') {
    const NEU = [38, 72, 165, 200, 265, 315];
    build([[4, 13, 9], [6, 17, 12], [9, 23, 16]], [0, 1, 1.18, 1.4], (p, r) =>
      r === ME ? { f: [0, 54, 27], a: [0, 124, 60], e: [90, 255, 155] }
      : r === ALLY ? { f: [0, 40, 48], e: [80, 228, 238] }
      : r === ENEMY ? { f: [58, 6, 8], a: [132, 16, 18], e: [255, 76, 62] }
      : r === TRIBE ? { f: [7, 17, 12], e: [42, 84, 58] }
      : { f: hsl(NEU[p.id % 6], .75, .065), e: hsl(NEU[p.id % 6], .7, .42) });
    const w0 = pk(1, 6, 5), w1 = pk(3, 21, 14);
    return { bw: 1.2 * u, glow: 5 * u, glowA: .9, lighter: true, padL: 0, fill, alt, edge, coast: [34, 96, 62], front: [255, 190, 60],
      stripeMe: diag(m(7), m(2), 1), stripeEn: diag(m(7), m(2), -1), water: (_x, _y, d) => d <= 9 && d % 3 === 0 ? w1 : w0,
      mini: { water: [1, 8, 5], land: [10, 50, 30], other: [20, 90, 55] } };
  }
  if (id === 'holo') {
    build([[14, 24, 46], [18, 30, 54], [24, 38, 66]], [0, 1, 1.1, 1.24], (_p, r, h) =>
      r === ME ? { f: [16, 104, 142], a: [34, 146, 190], e: [140, 242, 255] }
      : r === ALLY ? { f: [16, 104, 92], e: [110, 255, 212] }
      : r === ENEMY ? { f: [118, 26, 60], a: [158, 40, 82], e: [255, 116, 156] }
      : r === TRIBE ? { f: mix(hsl(h, .25, .2), [14, 24, 46], .45), e: hsl(h, .3, .4) }
      : { f: mix(hsl(h, .55, .27), [10, 22, 48], .3), e: hsl(h, .8, .68) });
    const wt = new Uint32Array(11);
    for (let d = 0; d <= 10; d++) { const v = d < 10 ? 10 - d : 0; wt[d] = pk(4 + v, 9 + v * 2.4, 22 + v * 3.6); }
    return { bw: 1.3 * u, glow: 7 * u, glowA: 1, lighter: true, padL: 0, fill, alt, edge, coast: [70, 150, 200], front: [255, 255, 255],
      stripeMe: rows(m(4)), stripeEn: rows(m(4)), water: (_x, _y, d) => wt[d > 10 ? 10 : d],
      mini: { water: [5, 12, 28], land: [26, 52, 86], other: [50, 96, 140] } };
  }
  if (id === 'tat') {
    const base: RGB = [50, 55, 45];
    build([[38, 42, 36], [44, 47, 39], [53, 54, 46]], [0, 1, 1.16, 1.36], (_p, r, h) =>
      r === ME ? { f: mix(base, [56, 120, 212], .52), e: [128, 186, 255] }
      : r === ALLY ? { f: mix(base, [48, 170, 158], .42), e: [104, 218, 202] }
      : r === ENEMY ? { f: mix(base, [204, 58, 44], .46), a: mix(base, [110, 28, 24], .6), e: [255, 100, 78] }
      : r === TRIBE ? { f: mix(base, [96, 96, 74], .16), e: [104, 106, 88] }
      : { f: mix(base, hsl(h, .3, .42), .24), e: [152, 152, 122] });
    const w0 = pk(22, 29, 34), w1 = pk(31, 41, 47);
    return { bw: 1.3 * u, glow: 0, glowA: 0, lighter: false, padL: 268, fill, alt, edge, coast: [118, 126, 112], front: [255, 176, 0],
      stripeMe: never, stripeEn: diag(m(8), m(3), 1), water: (_x, _y, d) => d === 2 || d === 6 ? w1 : w0,
      mini: { water: [22, 29, 34], land: [58, 62, 50], other: [92, 94, 76] } };
  }
  // orb
  build([[212, 216, 219], [205, 209, 212], [196, 200, 204]], [0, 1, .965, .91], (_p, r, h) =>
    r === ME ? { f: [255, 98, 42], a: [255, 128, 80], e: [170, 42, 0] }
    : r === ALLY ? { f: hsl(214, .78, .74), e: [34, 82, 172] }
    : r === ENEMY ? { f: [54, 56, 62], a: [78, 80, 88], e: [14, 14, 18] }
    : r === TRIBE ? { f: hsl(h, .14, .83), e: [150, 156, 162] }
    : { f: hsl(h, .4, .8), e: hsl(h, .35, .42) });
  const w0 = pk(238, 241, 243), w1 = pk(224, 229, 233), w2 = pk(212, 218, 223), dp = m(9);
  return { bw: 1 * u, glow: 0, glowA: 0, lighter: false, padL: 0, fill, alt, edge, coast: [124, 132, 140], front: [255, 255, 255],
    stripeMe: diag(m(9), m(1), 1), stripeEn: diag(m(6), m(2), -1), water: (x, y, d) => d <= 1 ? w1 : (x % dp === 0 && y % dp === 0 ? w2 : w0),
    mini: { water: [238, 241, 243], land: [204, 208, 212], other: [160, 166, 172] } };
}

interface View { s: number; u: number; x0: number; y0: number; cw: number; ch: number; }

function render(id: StyleId) {
  const stage = $('#stage'), cv = $('#map') as HTMLCanvasElement;
  const u = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(stage.clientWidth * u), ch = Math.round(stage.clientHeight * u);
  cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d')!;
  const S = skin(id, u);
  const W = g.W, H = g.H, ter = g.terrain, own = g.owner;

  const visW = cw - S.padL * u;
  const viewW = clamp(Math.sqrt(me.tiles) * 3.0, 210, 360) * (cw / visW);
  const s = cw / viewW, viewH = ch / s;
  const padT = S.padL * u / s;
  const x0 = clamp((me.sumX / me.tiles + front.x) / 2 - padT - (viewW - padT) / 2, 0, W - viewW);
  const y0 = clamp((me.sumY / me.tiles + front.y) / 2 - viewH / 2, 0, H - viewH);
  const V: View = { s, u, x0, y0, cw, ch };

  const base = ctx.createImageData(cw, ch), line = new ImageData(cw, ch);
  const bd = new Uint32Array(base.data.buffer), ld = new Uint32Array(line.data.buffer);
  const E = S.edge.map(c => pkc(c)), coast = pkc(S.coast), frontC = pkc(S.front);
  const edgeOf = (a: number, b: number): number => {
    if (a === WK) return b === 0 ? coast : E[b];
    if (b === WK) return a === 0 ? coast : E[a];
    const ra = rel[a], rb = rel[b];
    if ((ra === ME && rb === ENEMY) || (ra === ENEMY && rb === ME)) return frontC;
    return PRIO[ra] >= PRIO[rb] ? E[a] : E[b];
  };
  const bw = S.bw, tx = new Int32Array(cw), tx2 = new Int32Array(cw);
  for (let x = 0; x < cw; x++) { tx[x] = Math.min(W - 1, (x0 + x / s) | 0); tx2[x] = Math.min(W - 1, (x0 + (x + bw) / s) | 0); }
  for (let y = 0, p = 0; y < ch; y++) {
    const r1 = Math.min(H - 1, (y0 + y / s) | 0) * W, r2 = Math.min(H - 1, (y0 + (y + bw) / s) | 0) * W;
    for (let x = 0; x < cw; x++, p++) {
      const i = r1 + tx[x], t = ter[i];
      let k: number;
      if (t) {
        k = own[i];
        const r = rel[k];
        bd[p] = (r === ME && S.stripeMe(x, y)) || (r === ENEMY && S.stripeEn(x, y)) ? S.alt[k] : S.fill[k * 4 + t];
      } else { k = WK; bd[p] = S.water(x, y, wd[i]); }
      const iR = r1 + tx2[x], kR = ter[iR] ? own[iR] : WK;
      if (kR !== k) { ld[p] = edgeOf(k, kR); continue; }
      const iD = r2 + tx[x], kD = ter[iD] ? own[iD] : WK;
      if (kD !== k) ld[p] = edgeOf(k, kD);
    }
  }
  ctx.putImageData(base, 0, 0);
  const lc = document.createElement('canvas'); lc.width = cw; lc.height = ch;
  lc.getContext('2d')!.putImageData(line, 0, 0);
  if (S.glow) {
    ctx.save();
    if (S.lighter) ctx.globalCompositeOperation = 'lighter';
    ctx.filter = `blur(${S.glow}px)`; ctx.globalAlpha = S.glowA;
    ctx.drawImage(lc, 0, 0);
    ctx.restore();
  }
  ctx.drawImage(lc, 0, 0);
  overlay(ctx, id, V, S);

  const fx = $('#fx');
  fx.className = 'fx-' + id;
  fx.style.setProperty('--cx', ((me.sumX / me.tiles - x0) * s / u) + 'px');
  fx.style.setProperty('--cy', ((me.sumY / me.tiles - y0) * s / u) + 'px');
  return { V, S };
}

// ── vector overlay ──────────────────────────────────────────────────────────
function overlay(c: CanvasRenderingContext2D, id: StyleId, V: View, S: Skin) {
  const { s, u, x0, y0, cw, ch } = V;
  const X = (x: number) => (x - x0) * s, Y = (y: number) => (y - y0) * s;
  const mx = X(me.sumX / me.tiles), my = Y(me.sumY / me.tiles);
  const F = { radar: '"Share Tech Mono", ui-monospace, monospace', holo: 'Rajdhani, "DIN Alternate", sans-serif', tat: '"Saira Condensed", "DIN Condensed", sans-serif', orb: '"Space Grotesk", "Helvetica Neue", sans-serif' }[id];
  const MONO = { radar: F, holo: 'Orbitron, sans-serif', tat: '"IBM Plex Mono", monospace', orb: '"JetBrains Mono", monospace' }[id];
  const padL = S.padL * u;
  c.lineCap = 'butt'; c.textBaseline = 'middle';

  // grid
  c.save();
  if (id === 'radar') {
    c.strokeStyle = 'rgba(70,255,150,.06)'; c.lineWidth = u; c.beginPath();
    for (let x = Math.ceil(x0 / 40) * 40; X(x) < cw; x += 40) { c.moveTo(X(x), 0); c.lineTo(X(x), ch); }
    for (let y = Math.ceil(y0 / 40) * 40; Y(y) < ch; y += 40) { c.moveTo(0, Y(y)); c.lineTo(cw, Y(y)); }
    c.stroke();
    c.strokeStyle = 'rgba(70,255,150,.16)'; c.fillStyle = 'rgba(90,255,160,.5)'; c.font = `${10 * u}px ${F}`;
    for (let r = 40; r <= 280; r += 40) { c.beginPath(); c.arc(mx, my, r * s, 0, 7); c.stroke(); c.fillText(`${r * 25}KM`, mx + 4 * u, my - r * s + 8 * u); }
    c.beginPath();
    for (let a = 0; a < 12; a++) { const an = a * Math.PI / 6; c.moveTo(mx + Math.cos(an) * 12 * s, my + Math.sin(an) * 12 * s); c.lineTo(mx + Math.cos(an) * 300 * s, my + Math.sin(an) * 300 * s); }
    c.globalAlpha = .45; c.stroke();
  } else if (id === 'holo') {
    const R = 24 * u, hw = R * Math.sqrt(3);
    c.strokeStyle = 'rgba(110,225,255,.06)'; c.lineWidth = u; c.beginPath();
    for (let row = -1, y = 0; y < ch + R; row++, y = row * R * 1.5) for (let x = (row & 1) ? hw / 2 : 0; x < cw + hw; x += hw) {
      for (let k = 0; k < 6; k++) { const an = Math.PI / 6 + k * Math.PI / 3; const px = x + R * Math.cos(an), py = y + R * Math.sin(an); k ? c.lineTo(px, py) : c.moveTo(px, py); }
      c.closePath();
    }
    c.stroke();
  } else if (id === 'tat') {
    c.font = `500 ${9.5 * u}px ${MONO}`; c.fillStyle = 'rgba(225,226,200,.5)';
    for (let x = Math.ceil(x0 / 25) * 25; X(x) < cw; x += 25) {
      const major = x % 100 === 0; c.strokeStyle = `rgba(230,232,200,${major ? .14 : .05})`; c.lineWidth = u;
      c.beginPath(); c.moveTo(X(x), 0); c.lineTo(X(x), ch); c.stroke();
      if (X(x) > padL + 20 * u) c.fillText(String.fromCharCode(65 + ((x / 100) | 0) % 26) + String.fromCharCode(65 + (x / 25) % 4), X(x) + 3 * u, 44 * u);
    }
    for (let y = Math.ceil(y0 / 25) * 25; Y(y) < ch; y += 25) {
      const major = y % 100 === 0; c.strokeStyle = `rgba(230,232,200,${major ? .14 : .05})`;
      c.beginPath(); c.moveTo(0, Y(y)); c.lineTo(cw, Y(y)); c.stroke();
      if (Y(y) > 60 * u) c.fillText(String(y / 25 | 0).padStart(2, '0'), padL + 5 * u, Y(y) - 6 * u);
    }
  } else {
    c.strokeStyle = 'rgba(30,38,48,.3)'; c.lineWidth = u; c.beginPath();
    for (let x = Math.ceil(x0 / 30) * 30; X(x) < cw; x += 30) for (let y = Math.ceil(y0 / 30) * 30; Y(y) < ch; y += 30) {
      c.moveTo(X(x) - 4 * u, Y(y)); c.lineTo(X(x) + 4 * u, Y(y)); c.moveTo(X(x), Y(y) - 4 * u); c.lineTo(X(x), Y(y) + 4 * u);
    }
    c.stroke();
    c.strokeStyle = 'rgba(20,22,26,.4)'; c.beginPath(); c.arc(mx, my, 100 * s, 0, 7); c.stroke();
    c.beginPath();
    for (let a = 0; a < 72; a++) { const an = a * Math.PI / 36, r1 = 100 * s, r2 = r1 + (a % 6 ? 4 : 9) * u; c.moveTo(mx + Math.cos(an) * r1, my + Math.sin(an) * r1); c.lineTo(mx + Math.cos(an) * r2, my + Math.sin(an) * r2); }
    c.stroke();
  }
  c.restore();

  // structures
  const inView = (x: number, y: number, mrg = 20) => x > padL - mrg * u && y > -mrg * u && x < cw + mrg * u && y < ch + mrg * u;
  const structs = g.structures.filter(st => st.readyTick <= g.tick && inView(X(st.x), Y(st.y), 0))
    .sort((a, b) => PRIO[rel[a.owner]] - PRIO[rel[b.owner]]);
  const drawStruct = (st: Structure) => {
    const r = rel[st.owner], x = X(st.x + .5), y = Y(st.y + .5), big = r === ME || r === ENEMY || r === ALLY;
    if (!big && st.type !== 'city' && st.type !== 'silo') return;
    const h = (r === ME ? 7 : big ? 6 : 4.5) * u, col = css(S.edge[st.owner]);
    c.save();
    if (id === 'radar') {
      const q = h + 3 * u, k = 3 * u;
      c.strokeStyle = col; c.lineWidth = u; c.shadowColor = col; c.shadowBlur = 6 * u;
      c.fillStyle = 'rgba(0,8,4,.8)'; c.fillRect(x - q, y - q, q * 2, q * 2);
      c.beginPath();
      for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { c.moveTo(x + dx * q, y + dy * (q - k)); c.lineTo(x + dx * q, y + dy * q); c.lineTo(x + dx * (q - k), y + dy * q); }
      c.stroke();
      drawGlyph(c, st.type, x, y, h, col);
    } else if (id === 'holo') {
      c.fillStyle = 'rgba(4,14,32,.82)'; c.strokeStyle = col; c.lineWidth = 1.3 * u; c.shadowColor = col; c.shadowBlur = 9 * u;
      c.beginPath(); c.arc(x, y, h + 3.5 * u, 0, 7); c.fill(); c.stroke();
      c.shadowBlur = 0; drawGlyph(c, st.type, x, y, h * .95, '#eaf9ff');
    } else if (id === 'tat') {
      const q = h + 2.5 * u;
      c.fillStyle = '#12140e'; c.strokeStyle = col; c.lineWidth = 1.5 * u;
      c.fillRect(x - q * 1.25, y - q, q * 2.5, q * 2); c.strokeRect(x - q * 1.25, y - q, q * 2.5, q * 2);
      c.fillStyle = col; c.font = `700 ${q * 1.5}px ${F}`; c.textAlign = 'center';
      c.fillText(STRUCTURE_KEY[st.type], x, y + u * .5);
    } else {
      c.fillStyle = r === ME ? '#fff' : r === ENEMY ? '#14161a' : '#fafbfc'; c.strokeStyle = '#14161a'; c.lineWidth = u;
      c.beginPath(); c.arc(x, y, h + 3 * u, 0, 7); c.fill(); c.stroke();
      drawGlyph(c, st.type, x, y, h * .9, r === ME ? '#d83c00' : r === ENEMY ? '#fff' : '#14161a');
    }
    c.restore();
  };
  structs.forEach(drawStruct);

  // attack arrow (me → main enemy) and a nuke in flight
  const accent = { radar: [255, 190, 60], holo: [255, 255, 255], tat: [128, 186, 255], orb: [216, 60, 0] }[id] as RGB;
  const hot = { radar: [255, 76, 62], holo: [255, 110, 200], tat: [255, 176, 0], orb: [216, 60, 0] }[id] as RGB;
  if (enemy) {
    const ex = enemy.sumX / enemy.tiles, ey = enemy.sumY / enemy.tiles;
    const mcx = me.sumX / me.tiles, mcy = me.sumY / me.tiles;
    const dx = ex - mcx, dy = ey - mcy, dl = Math.hypot(dx, dy) || 1, nx = dx / dl, ny = dy / dl;
    const ax = X(front.x - nx * 16), ay = Y(front.y - ny * 16), bx = X(front.x + nx * 15), by = Y(front.y + ny * 15);
    const ang = Math.atan2(by - ay, bx - ax), len = Math.hypot(bx - ax, by - ay);
    c.save(); c.translate(ax, ay); c.rotate(ang);
    if (id === 'tat') {
      const w = 7 * u, hw = 15 * u, hl = 20 * u;
      c.beginPath(); c.moveTo(0, -w * 1.6); c.lineTo(len * .3, -w); c.lineTo(len - hl, -w); c.lineTo(len - hl, -hw); c.lineTo(len, 0);
      c.lineTo(len - hl, hw); c.lineTo(len - hl, w); c.lineTo(len * .3, w); c.lineTo(0, w * 1.6);
      c.fillStyle = 'rgba(128,186,255,.22)'; c.fill(); c.strokeStyle = css(accent); c.lineWidth = 2 * u; c.stroke();
    } else if (id === 'radar') {
      c.strokeStyle = css(accent); c.lineWidth = 2 * u; c.shadowColor = css(accent); c.shadowBlur = 8 * u; c.beginPath();
      for (let d = 0; d < len; d += 11 * u) { c.moveTo(d, -7 * u); c.lineTo(d + 7 * u, 0); c.lineTo(d, 7 * u); }
      c.stroke();
    } else if (id === 'holo') {
      const gr = c.createLinearGradient(0, 0, len, 0); gr.addColorStop(0, 'rgba(140,242,255,0)'); gr.addColorStop(1, 'rgba(255,255,255,.95)');
      c.strokeStyle = gr; c.lineWidth = 5 * u; c.shadowColor = '#7fe8ff'; c.shadowBlur = 14 * u;
      c.beginPath(); c.moveTo(0, 0); c.lineTo(len - 8 * u, 0); c.stroke();
      c.fillStyle = '#fff'; c.beginPath(); c.moveTo(len, 0); c.lineTo(len - 15 * u, -9 * u); c.lineTo(len - 11 * u, 0); c.lineTo(len - 15 * u, 9 * u); c.fill();
    } else {
      c.strokeStyle = '#14161a'; c.lineWidth = 1.5 * u; c.beginPath(); c.moveTo(0, 0); c.lineTo(len, 0); c.moveTo(len - 9 * u, -5 * u); c.lineTo(len, 0); c.lineTo(len - 9 * u, 5 * u); c.stroke();
      c.fillStyle = '#14161a'; c.beginPath(); c.arc(0, 0, 3 * u, 0, 7); c.fill();
    }
    c.restore();
    if (id !== 'holo') {
      c.save(); c.font = `${id === 'tat' ? '600 ' : ''}${10.5 * u}px ${MONO}`; c.textAlign = 'center';
      const tx = (ax + bx) / 2 - Math.sin(ang) * 18 * u, ty = (ay + by) / 2 + Math.cos(ang) * 18 * u;
      const txt = `ATTACCO ${fmt(me.troops * .4)}`;
      if (id !== 'radar') { const w = c.measureText(txt).width + 10 * u; c.fillStyle = id === 'tat' ? '#12140e' : '#fafbfc'; c.fillRect(tx - w / 2, ty - 8 * u, w, 16 * u); }
      c.fillStyle = css(id === 'orb' ? [20, 22, 26] : accent); c.fillText(txt, tx, ty);
      c.restore();
    }

    // nuke arc: from my silo (or capital) to an enemy structure / rear area
    const silo = g.structures.find(st => st.owner === me.id && st.type === 'silo') ?? null;
    const sx = silo ? silo.x : mcx, sy = silo ? silo.y : mcy;
    const tgt = g.structures.find(st => st.owner === enemy!.id && st.type === 'city' && inView(X(st.x), Y(st.y), -60));
    const tx = tgt ? tgt.x : front.x + nx * 42, ty = tgt ? tgt.y : front.y + ny * 42;
    const A = [X(sx), Y(sy)], B = [X(tx), Y(ty)], dist = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const C = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2 - dist * .34];
    const bez = (t: number) => [(1 - t) ** 2 * A[0] + 2 * t * (1 - t) * C[0] + t * t * B[0], (1 - t) ** 2 * A[1] + 2 * t * (1 - t) * C[1] + t * t * B[1]];
    const T = .64, hp = bez(T), R = g.q.nukeRadius('atom') * s;
    c.save();
    c.strokeStyle = css(hot, id === 'orb' ? 1 : .9); c.lineWidth = (id === 'orb' ? 1.2 : 1.8) * u;
    if (id !== 'orb') { c.shadowColor = css(hot); c.shadowBlur = (id === 'tat' ? 0 : 10) * u; }
    c.setLineDash([2 * u, 5 * u]); c.beginPath(); c.moveTo(hp[0], hp[1]);
    for (let t = T; t <= 1.001; t += .02) { const q = bez(t); c.lineTo(q[0], q[1]); } c.stroke();
    c.setLineDash([]); c.beginPath(); c.moveTo(A[0], A[1]);
    for (let t = 0; t <= T + .001; t += .02) { const q = bez(t); c.lineTo(q[0], q[1]); } c.stroke();
    // blast footprint + reticle
    c.fillStyle = css(hot, id === 'orb' ? .1 : .13); c.beginPath(); c.arc(B[0], B[1], R, 0, 7); c.fill();
    c.setLineDash(id === 'tat' ? [6 * u, 4 * u] : []); c.stroke(); c.setLineDash([]);
    c.beginPath();
    for (const [qx, qy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { c.moveTo(B[0] + qx * R * .55, B[1] + qy * R * .55); c.lineTo(B[0] + qx * (R + 8 * u), B[1] + qy * (R + 8 * u)); }
    c.stroke();
    // warhead
    const q2 = bez(T + .01), wa = Math.atan2(q2[1] - hp[1], q2[0] - hp[0]);
    c.translate(hp[0], hp[1]); c.rotate(wa); c.fillStyle = id === 'orb' ? css(hot) : '#fff';
    c.beginPath(); c.moveTo(8 * u, 0); c.lineTo(-5 * u, -4.5 * u); c.lineTo(-2 * u, 0); c.lineTo(-5 * u, 4.5 * u); c.fill();
    c.restore();
    c.save(); c.font = `${id === 'tat' ? '600 ' : ''}${10.5 * u}px ${MONO}`; c.textAlign = 'left';
    const lt = id === 'radar' ? 'ATOMICA // IMPATTO 00:09' : id === 'tat' ? 'ATOMICA · T-00:09' : 'IMPATTO 00:09';
    const lx = B[0] + R * .75 + 8 * u, ly = B[1] - R * .75;
    if (id === 'tat' || id === 'orb') { const w = c.measureText(lt).width + 10 * u; c.fillStyle = id === 'tat' ? '#12140e' : '#fafbfc'; c.fillRect(lx - 5 * u, ly - 8 * u, w, 16 * u); }
    else { c.shadowColor = css(hot); c.shadowBlur = 8 * u; }
    c.fillStyle = css(hot); c.fillText(lt, lx, ly);
    c.restore();
  }

  // ships
  for (const un of g.units) {
    if (!un.alive || (un.type !== 'transport' && un.type !== 'trade')) continue;
    const x = X(un.x), y = Y(un.y); if (!inView(x, y, 0)) continue;
    const r = rel[un.owner], col = css(S.edge[un.owner] ?? S.coast), an = Math.atan2(g.yOf(un.toTile) - un.y, g.xOf(un.toTile) - un.x);
    const z = (un.type === 'transport' ? 5 : 3) * u * (r === ME ? 1.3 : 1);
    c.save(); c.translate(x, y); c.rotate(an);
    if (id === 'radar' || id === 'holo') { c.shadowColor = col; c.shadowBlur = 7 * u; }
    c.fillStyle = id === 'orb' ? '#14161a' : col; c.strokeStyle = id === 'orb' ? '#fff' : 'rgba(0,0,0,.6)'; c.lineWidth = u;
    c.beginPath(); c.moveTo(z * 1.4, 0); c.lineTo(-z, -z * .8); c.lineTo(-z * .5, 0); c.lineTo(-z, z * .8); c.closePath(); c.fill(); if (id === 'orb' || id === 'tat') c.stroke();
    c.restore();
  }

  // nation labels
  const placed: number[][] = [];
  const cand = g.players.filter(p => p.id && p.alive && (rel[p.id] <= ENEMY || (rel[p.id] === NEUTRAL && p.tiles >= 260) || p.tiles >= 900))
    .sort((a, b) => PRIO[rel[b.id]] - PRIO[rel[a.id]] || b.tiles - a.tiles);
  for (const p of cand) {
    const x = X(p.sumX / p.tiles), y = Y(p.sumY / p.tiles);
    if (!inView(x, y, -30)) continue;
    const r = rel[p.id], sz = clamp(Math.sqrt(p.tiles) * s * .1, 10 * u, 21 * u);
    const name = id === 'orb' ? p.name : p.name.toUpperCase(), sub = fmt(p.troops);
    c.save();
    c.font = `${{ radar: '', holo: '700 ', tat: '700 ', orb: '600 ' }[id]}${sz}px ${F}`;
    if ('letterSpacing' in c) (c as any).letterSpacing = `${(id === 'orb' ? 0 : id === 'radar' ? .06 : .12) * sz}px`;
    const w = c.measureText(name).width, hgt = sz * 2.1, box = [x - w / 2 - 4 * u, y - hgt / 2, x + w / 2 + 4 * u, y + hgt / 2];
    if (placed.some(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) { c.restore(); continue; }
    placed.push(box);
    c.textAlign = 'center';
    const ec = S.edge[p.id];
    if (id === 'radar') { c.fillStyle = css(mix(ec, [255, 255, 255], .25)); c.shadowColor = css(ec); c.shadowBlur = 8 * u; }
    else if (id === 'holo') { c.fillStyle = '#fff'; c.shadowColor = css(ec); c.shadowBlur = 12 * u; }
    else if (id === 'tat') { c.lineWidth = 3 * u; c.strokeStyle = 'rgba(14,16,10,.85)'; c.lineJoin = 'round'; c.strokeText(name, x, y - sz * .3); c.fillStyle = r === NEUTRAL || r === TRIBE ? '#e2e3ca' : css(mix(ec, [255, 255, 255], .35)); }
    else { c.fillStyle = r === ME || r === ENEMY ? '#fff' : '#14161a'; }
    c.fillText(name, x, y - sz * .3);
    if ('letterSpacing' in c) (c as any).letterSpacing = '0px';
    c.shadowBlur = 0;
    c.font = `${id === 'holo' ? '500 ' : ''}${Math.max(9 * u, sz * .6)}px ${MONO}`;
    if (id === 'holo') { c.strokeStyle = css(ec); c.lineWidth = 1.5 * u; c.beginPath(); c.moveTo(x - w / 2, y + sz * .22); c.lineTo(x + w / 2, y + sz * .22); c.stroke(); c.fillStyle = css(mix(ec, [255, 255, 255], .5)); }
    else if (id === 'radar') c.fillStyle = css(ec);
    else if (id === 'tat') { c.fillStyle = '#cfd0bd'; c.lineWidth = 3 * u; c.strokeText(sub, x, y + sz * .62); }
    else c.fillStyle = r === ME || r === ENEMY ? 'rgba(255,255,255,.8)' : '#5a626b';
    c.fillText(id === 'radar' ? `▸${sub}` : sub, x, y + sz * (id === 'holo' ? .75 : .62));
    c.restore();
  }
}

// ── HUDs ────────────────────────────────────────────────────────────────────
const bar = (f: number, n: number) => { const k = clamp(Math.round(f * n), 0, n); return '▮'.repeat(k) + '▯'.repeat(n - k); };
const relCls = (r: number) => r === ME ? 'me' : r === ENEMY ? 'en' : r === ALLY ? 'al' : '';

function hud(id: StyleId, S: Skin) {
  const col = (pid: number) => css(S.edge[pid]);
  const fillCol = (pid: number) => { const v = S.fill[pid * 4 + 1]; return `rgb(${v & 255},${(v >> 8) & 255},${(v >> 16) & 255})`; };
  const tf = D.troops / D.max, atk = fmt(D.troops * .4);
  const mini = `<canvas class="mini" width="220" height="108"></canvas>`;
  const gl = (t: StructureType, c: string) => `<img src="${glyphURL(t, c)}" alt="">`;
  let h = '';
  if (id === 'radar') {
    h = `<div class="hud hud-radar">
<div class="r r-tl"><div class="r-h">CAPTURE // COMANDO STRATEGICO</div><div><i>NODO</i> ${D.name} <i>· T+</i>${D.clock} <i>· VEL</i> 1×</div><div class="r-warn">▲ ALLERTA 2 — LANCIO IN CORSO</div></div>
<div class="r r-tc"><span><i>TRUPPE</i> ${fmt(D.troops)}/${fmt(D.max)} <em>${bar(tf, 12)}</em> +${fmt(D.troopRate)}/S</span><span><i>ORO</i> ${fmt(D.gold)} +${D.goldRate}/S</span><span><i>DOMINIO</i> ${D.share}% <em>${bar(D.shareF / .8, 10)}</em></span><span><i>NAVI</i> ${D.boats}</span></div>
<div class="r r-tr"><div class="r-h">CLASSIFICA DOMINIO</div><table>${D.top.map((p: any) => `<tr class="${relCls(p.rel)}"><td>${String(p.rank).padStart(2, '0')}</td><td>${p.rel === ME ? '►' : p.rel === ENEMY ? '✕' : p.rel === ALLY ? '＋' : '·'} ${p.name}</td><td class="n">${p.share}%</td><td class="n">${p.troops}</td></tr>`).join('')}</table></div>
<div class="r r-bl"><div class="r-h">REGISTRO</div>${D.log.map((l: any) => `<div class="${l.lv}"><i>[${l.t}]</i> ${l.x}</div>`).join('')}</div>
<div class="r r-bc"><div><i>FORZA D'ATTACCO</i> <em>${bar(.4, 20)}</em> 40% <i>→</i> ${atk}</div><div class="r-keys">${D.build.map((b: any) => `<span><b>[${b.key}]</b> ${b.label} <i>${b.cost}</i></span>`).join('')}<span><b>[N]</b> ATOMICA <i>${D.atom}</i></span></div></div>
<div class="r r-br"><div class="r-scope">${mini}</div></div></div>`;
  } else if (id === 'holo') {
    const ring = (f: number) => `<svg width="44" height="44" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" fill="none" stroke="rgba(100,225,255,.18)" stroke-width="3"/><circle cx="22" cy="22" r="18" fill="none" stroke="#7fe8ff" stroke-width="3" stroke-dasharray="${(113 * clamp(f, 0, 1)).toFixed(1)} 113" transform="rotate(-90 22 22)" style="filter:drop-shadow(0 0 4px #5fdcff)"/><circle cx="22" cy="22" r="12.5" fill="none" stroke="rgba(100,225,255,.3)" stroke-width="1" stroke-dasharray="2 3"/></svg>`;
    h = `<div class="hud hud-holo">
<div class="h-w h-top"><div class="h-p"><div class="h-g">${ring(tf)}<div><small>TRUPPE</small><b>${fmt(D.troops)}</b><span>di ${fmt(D.max)} · +${fmt(D.troopRate)}/s</span></div></div><div class="h-sep"></div>
<div class="h-g"><div><small>ORO</small><b>${fmt(D.gold)}</b><span>+${D.goldRate}/s</span></div></div><div class="h-sep"></div>
<div class="h-g">${ring(D.shareF / .8)}<div><small>DOMINIO</small><b>${D.share}%</b><span>obiettivo 80% · ${D.rank}º di ${D.alive}</span></div></div></div></div>
<div class="h-w h-left"><div class="h-p"><h6>COSTRUZIONE</h6>${D.build.map((b: any, i: number) => `<div class="h-b${i === 4 ? ' on' : ''}"><div class="h-hex">${gl(b.type, '#eaf9ff')}</div><div><b>${b.label}</b><span>${b.cost} oro</span></div><kbd>${b.key}</kbd></div>`).join('')}</div></div>
<div class="h-w h-right"><div class="h-p"><h6>POTENZE</h6>${D.top.map((p: any) => `<div class="h-row ${relCls(p.rel)}" style="--c:${col(p.id)}"><span>${p.rank}</span><span class="nm"><i></i>${p.name}<u style="width:${Math.min(100, +p.share * 9)}%"></u></span><span class="v">${p.share}%</span></div>`).join('')}</div></div>
<div class="h-w h-bl"><div class="h-p"><h6>COMUNICAZIONI</h6>${D.log.map((l: any) => `<div class="h-log ${l.lv}"><time>${l.t}</time>${l.x}</div>`).join('')}</div></div>
<div class="h-w h-bc"><div class="h-p"><h6>FORZA D'ATTACCO</h6><div class="h-seg">${Array.from({ length: 20 }, (_, i) => `<i class="${i < 8 ? 'on' : ''}"></i>`).join('')}</div><div class="h-val"><b>40%</b>${atk} truppe in campo</div></div></div>
<div class="h-w h-br"><div class="h-p"><h6>SCANSIONE GLOBALE</h6>${mini}</div></div></div>`;
  } else if (id === 'tat') {
    const aff = (p: Player, lab: string) => `<div class="t-aff" style="--c:${col(p.id)}"><i></i>${p.name}<span>${lab}</span></div>`;
    h = `<div class="hud hud-tat">
<div class="t-top"><b>CAPTURE</b><span>OP. ${D.name}</span><span>T+${D.clock}</span><div class="t-def"><span>DEFCON 2</span></div><span>${D.rank}º / ${D.alive} potenze</span><span class="sp">VEL 1× · SPAZIO pausa · ? aiuto</span></div>
<div class="t-dock">
<section><h5>Forze <span>01</span></h5><div class="t-big">${fmt(D.troops)}<small>/ ${fmt(D.max)}</small></div><div class="t-meter"><i style="width:${(tf * 100).toFixed(0)}%"></i></div><dl><dt>Crescita</dt><dd>+${fmt(D.troopRate)}/s</dd><dt>In attacco</dt><dd>${atk}</dd><dt>Navi in mare</dt><dd>${D.boats}</dd></dl></section>
<section><h5>Economia <span>02</span></h5><dl><dt>Oro</dt><dd>${fmt(D.gold)}</dd><dt>Entrate</dt><dd>+${D.goldRate}/s</dd><dt>Dominio</dt><dd>${D.share}% di 80%</dd></dl></section>
<section><h5>Ordini di costruzione <span>03</span></h5>${D.build.map((b: any, i: number) => `<div class="t-row${i === 4 ? ' on' : ''}"><kbd>${b.key}</kbd>${gl(b.type, '#cfd0bd')}<span>${b.label}</span><b>${b.cost}</b></div>`).join('')}<div class="t-row"><kbd>N</kbd><span></span><span>Atomica</span><b>${D.atom}</b></div></section>
<section><h5>Forza d'attacco <span>04</span></h5><div class="t-rule"><i></i><b>40%</b></div></section>
<section><h5>Diplomazia <span>05</span></h5>${D.allies.map((p: Player) => aff(p, 'alleato 3:12')).join('')}${D.enemies.map((p: Player) => aff(p, 'in guerra')).join('')}</section>
</div>
<div class="t-right"><h5>Ordine di battaglia <span>% · truppe</span></h5>${D.top.map((p: any) => `<div class="t-ob ${relCls(p.rel)}" style="--c:${col(p.id)}"><span>${p.rank}</span><i></i><span class="nm">${p.name}</span><span>${p.share}%</span><span class="v">${p.troops}</span></div>`).join('')}</div>
<div class="t-mini">${mini}</div>
<div class="t-bot"><span class="tag">SITREP</span>${D.log.slice().reverse().map((l: any) => `<span class="${l.lv}"><time>${l.t}</time>${l.x}</span>`).join('')}</div></div>`;
  } else {
    h = `<div class="hud hud-orb">
<div class="o o-tl"><b>CAPTURE</b><i></i><span>${D.name} · T+${D.clock} · 1×</span></div>
<div class="o o-top"><div><small>Truppe</small><b>${fmt(D.troops)}</b><span>di ${fmt(D.max)} · +${fmt(D.troopRate)}/s</span><div class="o-line"><u style="width:${(tf * 100).toFixed(0)}%"></u></div></div>
<div><small>Oro</small><b>${fmt(D.gold)}</b><span>+${D.goldRate}/s</span><div class="o-line"></div></div>
<div><small>Dominio</small><b>${D.share}<sup>%</sup></b><span>obiettivo 80 · ${D.rank}º</span><div class="o-line"><u style="width:${(D.shareF / .8 * 100).toFixed(0)}%"></u></div></div></div>
<div class="o o-right"><h6>Classifica <span>${D.alive} in gioco</span></h6>${D.top.map((p: any) => `<div class="o-row ${relCls(p.rel)}" style="--c:${fillCol(p.id)}"><span>${p.rank}</span><i></i><span class="nm">${p.name}</span><span class="v">${p.share}% · ${p.troops}</span></div>`).join('')}</div>
<div class="o o-bl"><h6>Registro</h6>${D.log.map((l: any) => `<div class="o-log ${l.lv}"><time>${l.t}</time><i></i><span>${l.x}</span></div>`).join('')}</div>
<div class="o o-bc">${D.build.map((b: any, i: number) => `<div class="o-tool${i === 4 ? ' on' : ''}"><kbd>${b.key}</kbd>${gl(b.type, '#14161a')}<span>${b.label}</span><em>${b.cost}</em></div>`).join('')}<div class="o-sl"><div><small>Forza d'attacco</small><b>40%<span>${atk}</span></b></div><div class="o-track"><u></u><em></em></div></div></div>
<div class="o o-br">${mini}</div></div>`;
  }
  $('#hud').innerHTML = h;
}

function drawMini(V: View, S: Skin) {
  const cv = document.querySelector('canvas.mini') as HTMLCanvasElement | null; if (!cv) return;
  const c = cv.getContext('2d')!, w = cv.width, hh = cv.height, im = c.createImageData(w, hh), d = new Uint32Array(im.data.buffer);
  const W = g.W, H = g.H, k = W / w, yo = (hh * k - H) / 2;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    const ty = Math.round(y * k - yo), i = ty * W + ((x * k) | 0);
    if (ty < 0 || ty >= H || !g.terrain[i]) { d[y * w + x] = pkc(S.mini.water); continue; }
    const o = g.owner[i], r = rel[o];
    d[y * w + x] = r === ME || r === ALLY || r === ENEMY ? pkc(S.edge[o]) : o ? pkc(S.mini.other) : pkc(S.mini.land);
  }
  c.putImageData(im, 0, 0);
  c.strokeStyle = css(S.edge[me.id]); c.lineWidth = 1;
  c.strokeRect(Math.round(V.x0 / k) + .5, Math.round((V.y0 + yo) / k) + .5, Math.round(V.cw / V.s / k), Math.round(V.ch / V.s / k));
}

function show(id: StyleId) {
  current = id;
  history.replaceState(null, '', '#' + id);
  const { V, S } = render(id);
  hud(id, S);
  drawMini(V, S);
  document.querySelectorAll('#tabs button').forEach((b, i) => b.classList.toggle('on', STYLES[i] === id));
  $('#desc').textContent = INFO[id].d;
}

$('#tabs').innerHTML = STYLES.map((s, i) => `<button data-s="${s}"><kbd>${i + 1}</kbd>${INFO[s].n}</button>`).join('');
$('#tabs').addEventListener('click', e => { const b = (e.target as HTMLElement).closest('button'); if (b && g) show(b.dataset.s as StyleId); });
addEventListener('keydown', e => { const i = +e.key - 1; if (g && me && i >= 0 && i < 4) show(STYLES[i]); });
let rz = 0;
addEventListener('resize', () => { clearTimeout(rz); rz = window.setTimeout(() => { if (me) show(current); }, 150); });
(window as any).mock = { show, get game() { return g; }, get me() { return me; } };
boot();
