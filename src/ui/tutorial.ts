// "Partita tutorial": a real, playable match on a small map that stops and explains every feature,
// first the classic game (chapter 1), then the advanced one (chapter 2).
//
// The engine runs only inside a tutorial match (App.tut !== null): it builds its own world (fixed map, seed,
// players), tames the bots by wrapping game.cmd / game.adv.cmd on THAT game instance only (no rule changes),
// holds the simulation while a card explains something, and checks a predicate while the player acts.
// Steps are data: see ./tutorial-script.ts.
import { Game } from '../sim/game';
import { installEconomy } from '../sim/economy';
import { installAttacks } from '../sim/attacks';
import { installBuildings } from '../sim/buildings';
import { installNaval } from '../sim/naval';
import { installNukes } from '../sim/nukes';
import { installDiplomacy } from '../sim/diplomacy';
import { installAI } from '../sim/ai';
import { installAdvanced } from '../sim/adv/index';
import { WATER, type Commands, type GameEvent, type Player, type PlayerId, type StructureType, type Tile } from '../sim/types';
import type { Adv, AdvCommands } from '../sim/adv/types';
import { tutorialMap, TUTORIAL_SPOTS } from '../map/index';
import type { Renderer } from '../render/renderer';
import { h, setText } from './dom';
import { fmt } from './format';
import { loadSetup } from './screens';
import type { Actions } from './actions';
import type { AdvActions, AdvCtl, AdvHud } from './adv';
import type { Hud } from './hud';
import type { MobileUI } from './mobile';
import type { ContextMenu } from './context';
import type { Screens } from './screens';
import { STEPS, type Step, type Role } from './tutorial-script';

export type TutorialChapter = 1 | 2;

/** What the tutorial needs from the app shell (implemented by App in main.ts). */
export interface TutApp extends AdvCtl {
  readonly hud: Hud;
  readonly advHud: AdvHud;
  readonly act: Actions;
  readonly aa: AdvActions;
  readonly mobile: MobileUI;
  readonly ctxMenu: ContextMenu;
  readonly screens: Screens;
  phase: string;
  attachMatch(game: Game, speed?: number): Game;
  showTitle(): void;
  startTutorial(chapter: TutorialChapter, step?: string | number): void;
  playFromTutorial(advanced: boolean): void;
}

// ── progress (localStorage) ─────────────────────────────────────────────────
const SAVE_KEY = 'capture.tutorial.v1';
export interface TutorialProgress { chapter: TutorialChapter; step: string; label: string }
export function loadTutorialProgress(): TutorialProgress | null {
  try {
    const o = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null');
    if (!o || (o.chapter !== 1 && o.chapter !== 2) || typeof o.step !== 'string') return null;
    if (!STEPS.some(s => s.id === o.step)) return null;
    return { chapter: o.chapter, step: o.step, label: typeof o.label === 'string' ? o.label : '' };
  } catch { return null; }
}
function saveProgress(p: TutorialProgress | null): void {
  try { if (p) localStorage.setItem(SAVE_KEY, JSON.stringify(p)); else localStorage.removeItem(SAVE_KEY); } catch { /* storage unavailable */ }
}

// ── world ───────────────────────────────────────────────────────────────────
const SEED = 7311;
/** Chapter 2: a seed whose oil deposit lies on the continent, a few tiles beyond the player's border. */
const SEED2 = 15;
/** Bots stop grabbing free land beyond this many tiles (keeps room for the player). */
const BOT_CAP = 1300;
interface RoleDef { role: Role; name: string; kind: 'nation' | 'tribe'; color: number; x: number; y: number }
const ROLES: RoleDef[] = [
  { role: 'borea', name: 'Borea', kind: 'nation', color: 0xc8553d, ...TUTORIAL_SPOTS.borea },
  { role: 'corvia', name: 'Corvia', kind: 'nation', color: 0x3fa66b, ...TUTORIAL_SPOTS.corvia },
  { role: 'marea', name: 'Marea', kind: 'nation', color: 0x8a63d2, ...TUTORIAL_SPOTS.marea },
  { role: 'ulda', name: 'Tribù di Ulda', kind: 'tribe', color: 0x9c8f6a, ...TUTORIAL_SPOTS.ulda },
  { role: 'sarn', name: 'Tribù di Sarn', kind: 'tribe', color: 0x7f9a8e, ...TUTORIAL_SPOTS.sarn },
];

/** Same order as createGame(): human, nations, tribes, then every system. Fixed spots instead of random tribes. */
function buildWorld(chapter: TutorialChapter): { game: Game; roles: Record<Role, PlayerId> } {
  const map = tutorialMap();
  const seed = chapter === 2 ? SEED2 : SEED;
  const g = new Game(map, seed);
  g.difficulty = 'easy';
  const base = loadSetup();
  const hs = TUTORIAL_SPOTS.human;
  const human = g.addPlayer(base.name || 'Comandante', 'human', base.color, hs.x, hs.y, 5, 1200);
  if (human) g.humanId = human.id;
  const roles = {} as Record<Role, PlayerId>;
  for (const r of ROLES) {
    const p = g.addPlayer(r.name, r.kind, r.color, r.x, r.y, r.kind === 'tribe' ? 3 : 5, r.kind === 'tribe' ? 350 : 1200);
    roles[r.role] = p ? p.id : 0;
  }
  installEconomy(g);
  installAttacks(g);
  installBuildings(g);
  installNaval(g);
  installNukes(g);
  installDiplomacy(g);
  installAI(g);
  if (chapter === 2) installAdvanced(g, { seed, advanced: true, scenario: 'libero', fog: true, humanSpawn: hs });
  return { game: g, roles };
}

// ── events seen by the step predicates ──────────────────────────────────────
export type CmdName = keyof Commands | keyof AdvCommands;
export type TutEvent = GameEvent | { type: 'cmd'; name: CmdName; args: any[]; ok: boolean } | { type: 'ui'; what: string };
interface Logged { seq: number; tick: number; ev: TutEvent }

type Raw = Commands & { adv: AdvCommands | null };

/** Everything a step (tutorial-script.ts) can use. */
export class Ctx {
  /** Scratch space of the current step (reset on enter). */
  data: Record<string, any> = {};
  constructor(readonly t: Tutorial) {}
  get g(): Game { return this.t.game!; }
  get adv(): Adv | null { return this.t.game?.adv ?? null; }
  get app(): TutApp { return this.t.app; }
  get r(): Renderer { return this.t.app.renderer; }
  get me(): Player { return this.g.players[this.g.humanId]; }
  get raw(): Raw { return this.t.raw!; }
  get touch(): boolean { return document.body.classList.contains('touch-ui'); }
  /** Phone landscape layout (icon rail, one-line strip, panels on demand). */
  get phone(): boolean { return document.body.classList.contains('m-phone'); }
  id(role: Role): PlayerId { return this.t.roles[role]; }
  P(role: Role): Player { return this.g.players[this.t.roles[role]]; }
  alive(role: Role): boolean { const p = this.P(role); return !!p && p.alive; }
  /** Game seconds since the step started. */
  get secs(): number { return (this.g.tick - this.t.enterTick) / 10; }
  /** Any event since the step started matching `fn`. */
  saw(fn: (e: TutEvent) => boolean): boolean { return this.t.sawSince(fn); }
  /** A command the human issued (accepted) since the step started. */
  did(name: CmdName, fn: (args: any[]) => boolean = () => true): boolean {
    return this.saw(e => e.type === 'cmd' && e.name === name && e.ok && fn(e.args));
  }
  /** Note shown on the card ("Ti ho dato…"). */
  give(text: string): void { this.t.note(text); }

  // ── grants ─────────────────────────────────────────────────────────────
  gold(n: number, why = 'per provare'): void {
    const me = this.me;
    if (me.gold >= n) return;
    const d = Math.ceil((n - me.gold) / 50) * 50;
    me.gold += d;
    this.give(`Ti ho dato ${fmt(d)} oro ${why}.`);
  }
  troops(n: number): void {
    const me = this.me;
    if (me.troops >= n * 0.8) return;
    const d = Math.ceil((n - me.troops) / 50) * 50;
    me.troops += d;
    this.give(`Ti ho dato ${fmt(d)} truppe.`);
  }

  // ── geometry helpers ───────────────────────────────────────────────────
  xy(t: Tile): { x: number; y: number } { return { x: this.g.xOf(t), y: this.g.yOf(t) }; }
  centroid(id: PlayerId): { x: number; y: number } {
    const p = this.g.players[id];
    return { x: Math.round(p.sumX / Math.max(1, p.tiles)), y: Math.round(p.sumY / Math.max(1, p.tiles)) };
  }
  /** Owned tiles of `id` (full scan: the map is small). */
  tilesOf(id: PlayerId): Tile[] {
    const out: Tile[] = [], ow = this.g.owner;
    for (let i = 0; i < ow.length; i++) if (ow[i] === id) out.push(i);
    return out;
  }
  /** Free land tile next to the human, toward (tx,ty), pushed `depth` tiles into the free land. */
  freeNear(tx: number, ty: number, depth = 3): Tile {
    const g = this.g, me = this.me.id;
    let best = -1, bd = Infinity;
    for (const b of g.players[me].border) {
      g.forNeighbors(b, n => {
        if (g.isWater(n) || g.owner[n] !== 0) return;
        const d = (g.xOf(n) - tx) ** 2 + (g.yOf(n) - ty) ** 2;
        if (d < bd) { bd = d; best = n; }
      });
    }
    if (best < 0) return -1;
    // walk a few tiles further into free land, toward the goal
    let cur = best;
    for (let k = 0; k < depth; k++) {
      let nxt = -1, nd = Infinity;
      g.forNeighbors(cur, n => {
        if (g.isWater(n) || g.owner[n] !== 0) return;
        const d = (g.xOf(n) - tx) ** 2 + (g.yOf(n) - ty) ** 2;
        if (d < nd) { nd = d; nxt = n; }
      });
      if (nxt < 0) break;
      cur = nxt;
    }
    return cur;
  }
  /** Tile of `id` touching the human (the one nearest the human's centroid), or its centroid tile. */
  frontTileOf(id: PlayerId, depth = 2): Tile {
    const g = this.g, me = this.me.id;
    const c = this.centroid(me);
    let best = -1, bd = Infinity;
    for (const b of g.players[me].border) {
      g.forNeighbors(b, n => {
        if (g.owner[n] !== id) return;
        const d = (g.xOf(n) - c.x) ** 2 + (g.yOf(n) - c.y) ** 2;
        if (d < bd) { bd = d; best = n; }
      });
    }
    if (best < 0) { const k = this.centroid(id); return g.idx(k.x, k.y); }
    let cur = best;
    const k = this.centroid(id);
    for (let s = 0; s < depth; s++) {
      let nxt = -1, nd = Infinity;
      g.forNeighbors(cur, n => {
        if (g.owner[n] !== id) return;
        const d = (g.xOf(n) - k.x) ** 2 + (g.yOf(n) - k.y) ** 2;
        if (d < nd) { nd = d; nxt = n; }
      });
      if (nxt < 0) break;
      cur = nxt;
    }
    return cur;
  }
  /** Own tile accepting `type`, near (x,y) (default: centroid). Gold must already be enough. */
  buildSpot(type: StructureType, near?: { x: number; y: number }, coast = false): Tile {
    const g = this.g, me = this.me.id;
    const c = near ?? this.centroid(me);
    let best = -1, bd = Infinity;
    const list = coast ? [...g.players[me].border].filter(t => g.isCoast(t)) : this.tilesOf(me);
    for (const t of list) {
      const d = (g.xOf(t) - c.x) ** 2 + (g.yOf(t) - c.y) ** 2;
      if (d >= bd) continue;
      if (g.q.canBuild(me, type, t) !== null) continue;
      bd = d; best = t;
    }
    return best;
  }
  /** Finished structure of the human of that type (newest first). */
  structure(type: StructureType, finished = true) {
    const l = this.g.structuresOf(this.me.id, type, !finished);
    return l.length ? l[l.length - 1] : null;
  }

  /** Make `a` share a land border with `b`, claiming a corridor of free land for `a` if needed. */
  ensureBorder(a: PlayerId, b: PlayerId, note = true): boolean {
    const g = this.g;
    if (!g.players[a]?.alive || !g.players[b]?.alive || g.sharesBorder(a, b)) return false;
    const path = this.corridor(a, n => g.owner[n] === b, n => g.owner[n] === 0 || g.owner[n] === a)
      ?? this.corridor(a, n => g.owner[n] === b, n => g.owner[n] !== b);
    if (!path) return false;
    // both grow toward each other (path[0] is next to b): two blobs that meet, not a thin corridor
    const half = g.players[b].kind === 'tribe' ? 0 : Math.ceil(path.length / 2);
    this.claim(b, path.slice(0, half), 4);
    this.claim(a, path.slice(half), 5);
    (g as any).neighborCache?.delete?.(a); (g as any).neighborCache?.delete?.(b);
    if (note && a === g.humanId) this.give(half ? `Ho fatto crescere te e ${g.players[b].name} finché i vostri confini si toccano.` : `Ho allargato il tuo territorio fino a ${g.players[b].name}.`);
    return true;
  }
  /** Make sure the player (default: the human) owns a coast tile with room for a port. */
  ensureCoast(id: PlayerId = this.me.id): boolean {
    const g = this.g;
    for (const t of g.players[id].border) if (g.isCoast(t) && this.coastBuildable(t)) return false;
    const path = this.corridor(id, n => g.isCoast(n) && g.owner[n] === 0 && this.coastBuildable(n), n => g.owner[n] === 0 || g.owner[n] === id)
      ?? this.corridor(id, n => g.isCoast(n) && g.owner[n] === 0, n => g.owner[n] === 0 || g.owner[n] === id);
    if (!path) return false;
    this.claim(id, path, 2);
    if (id === g.humanId) this.give('Ti ho dato una striscia di terra fino alla costa.');
    return true;
  }
  private coastBuildable(t: Tile): boolean {
    // a port needs room: no structure within 5 tiles
    const g = this.g, x = g.xOf(t), y = g.yOf(t);
    for (const s of g.structures) if ((s.x - x) ** 2 + (s.y - y) ** 2 < 25) return false;
    return true;
  }
  /** BFS from `a`'s border through tiles where `pass` holds, until a tile where `goal` holds. */
  corridor(a: PlayerId, goal: (n: Tile) => boolean, pass: (n: Tile) => boolean): Tile[] | null {
    const g = this.g, N = g.N;
    const prev = new Int32Array(N).fill(-2);
    const q: number[] = [];
    for (const b of g.players[a].border) { prev[b] = -1; q.push(b); }
    for (let k = 0; k < q.length; k++) {
      const i = q[k];
      let hit = -1;
      g.forNeighbors(i, n => {
        if (hit >= 0 || prev[n] !== -2 || g.isWater(n)) return;
        if (goal(n)) { hit = n; prev[n] = i; return; }
        if (!pass(n)) return;
        prev[n] = i;
        q.push(n);
      });
      if (hit >= 0) {
        // nearest-the-goal first; the goal tile itself only when it is free land
        const out: Tile[] = g.owner[hit] === 0 ? [hit] : [];
        for (let c = prev[hit]; c >= 0 && g.owner[c] !== a; c = prev[c]) out.push(c);
        return out;
      }
    }
    return null;
  }
  /** Give tiles (and a halo of radius `w`) to `id`. */
  claim(id: PlayerId, tiles: Tile[], w = 1): void {
    const g = this.g;
    for (const t of tiles) {
      const x = g.xOf(t), y = g.yOf(t);
      for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++) {
        if (dx * dx + dy * dy > w * w + 0.5 || !g.inBounds(x + dx, y + dy)) continue;
        const i = g.idx(x + dx, y + dy);
        if (g.isLand(i) && (g.owner[i] === 0 || i === t || (dx === 0 && dy === 0))) g.setOwner(i, id);
      }
    }
  }
  /** Nearest water tile to (x,y) at least `minFrom` tiles away from any human tile, within `maxR`. */
  safeWater(x: number, y: number, minFrom: number, maxR: number): Tile {
    const g = this.g, me = this.me.id;
    let best = -1, bd = Infinity;
    for (let dy = -maxR; dy <= maxR; dy++) for (let dx = -maxR; dx <= maxR; dx++) {
      const d = dx * dx + dy * dy;
      if (d > maxR * maxR || d >= bd || !g.inBounds(x + dx, y + dy)) continue;
      const i = g.idx(x + dx, y + dy);
      if (!g.isWater(i)) continue;
      let ok = true;
      for (let ry = -minFrom; ry <= minFrom && ok; ry += 2) for (let rx = -minFrom; rx <= minFrom; rx += 2) {
        if (rx * rx + ry * ry > minFrom * minFrom) continue;
        const xx = x + dx + rx, yy = y + dy + ry;
        if (g.inBounds(xx, yy) && g.owner[g.idx(xx, yy)] === me) { ok = false; break; }
      }
      if (ok) { bd = d; best = i; }
    }
    return best;
  }
  /** Water tile next to a structure (port), in the biggest neighbouring sea. */
  waterNear(t: Tile, r = 6): Tile {
    const g = this.g, x = g.xOf(t), y = g.yOf(t);
    let best = -1, bd = Infinity;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (!g.inBounds(x + dx, y + dy)) continue;
      const i = g.idx(x + dx, y + dy);
      if (!g.isWater(i)) continue;
      const d = dx * dx + dy * dy;
      if (d >= 4 && d < bd) { bd = d; best = i; }
    }
    return best;
  }
  /** Camera to a world point (zoom: tiles visible across the short side). */
  look(x: number, y: number, span = 90): void {
    const cam = this.r.cam;
    const s = Math.max(cam.fitScale(), Math.min(cam.viewW, cam.viewH) / span);
    cam.centerOn(x, y, s);
  }
}

// ── engine ──────────────────────────────────────────────────────────────────
type Mode = 'card' | 'bar' | 'done';
interface Rect { x: number; y: number; w: number; h: number }
const HINT_MS = 20000;

export class Tutorial {
  game: Game | null = null;
  roles = {} as Record<Role, PlayerId>;
  raw: Raw | null = null;
  chapter: TutorialChapter = 1;
  /** Steps of the current chapter visible on this device. */
  steps: Step[] = [];
  idx = 0;
  /** Simulation held (explanations, confirmations). */
  hold = true;
  enterTick = 0;
  private mode: Mode = 'card';
  private ctx: Ctx;
  private log: Logged[] = [];
  private seq = 0;
  private enterSeq = 0;
  private enterAt = 0;
  private notes: string[] = [];
  private confirm = '';
  private pendingConfirm = '';
  private entering = false;
  private hintShown = false;
  private doneAt = 0;
  private forceAt = 0;
  private lastCheck = 0;
  private lastPlace = 0;
  private placeSig = '';
  private scriptedOffer = false;
  private dropMsgTick = -1;
  private undo: (() => void)[] = [];
  private disposed = false;

  // DOM
  private root = h('div', { class: 'tut' });
  private dim = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  private dimPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  private rings = h('div', { class: 'tut-rings' });
  private marker = h('div', { class: 'tut-marker hidden' }, h('i'));
  private card = h('div', { class: 'tut-card panel', role: 'dialog', 'aria-live': 'polite' });

  constructor(readonly app: TutApp) {
    this.ctx = new Ctx(this);
    this.dim.setAttribute('class', 'tut-dim');
    this.dimPath.setAttribute('fill-rule', 'evenodd');
    this.dim.appendChild(this.dimPath);
    this.root.append(this.dim, this.rings, this.marker, this.card);
    (document.getElementById('app') ?? document.body).appendChild(this.root);
    this.card.addEventListener('pointerdown', e => e.stopPropagation());
    window.addEventListener('resize', this.onResize);
    document.body.classList.add('tut-on');
  }

  private onResize = () => { this.placeSig = ''; this.lastPlace = 0; };

  // ── lifecycle ───────────────────────────────────────────────────────────
  /** Build the chapter's world and enter `step` (id or 1-based number within the chapter). */
  begin(chapter: TutorialChapter, step?: string | number): void {
    this.chapter = chapter;
    const { game, roles } = buildWorld(chapter);
    this.game = game;
    this.roles = roles;
    this.tame(game);
    game.on(ev => this.record(ev));
    this.app.attachMatch(game, 1);
    this.app.hud.addLog(chapter === 1 ? 'Tutorial · capitolo 1: il gioco base' : 'Tutorial · capitolo 2: la modalità avanzata', 'info');
    this.setupChapter();
    this.steps = STEPS.filter(s => s.chapter === chapter && (!s.only || s.only === (this.ctx.touch ? 'touch' : 'mouse')));
    let k = 0;
    if (typeof step === 'number') k = Math.max(0, Math.min(this.steps.length - 1, step - 1));
    else if (typeof step === 'string') { const f = this.steps.findIndex(s => s.id === step); if (f >= 0) k = f; }
    this.publish();
    const mm = document.querySelector<HTMLElement>('.minimap');
    if (mm) { mm.addEventListener('pointerdown', this.onMinimap); this.undoAll.push(() => mm.removeEventListener('pointerdown', this.onMinimap)); }
    this.enter(k, true);
  }

  private undoAll: (() => void)[] = [];
  private onMinimap = () => this.signal('minimap');

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.leave();
    for (const u of this.undoAll.splice(0)) { try { u(); } catch { /* ignore */ } }
    this.root.remove();
    window.removeEventListener('resize', this.onResize);
    document.body.classList.remove('tut-on', 'tut-hold');
    if ((window as any).tutorial?.__t === this) (window as any).tutorial = null;
  }

  /** Per-chapter world setup (grants that make the lessons possible). */
  private setupChapter(): void {
    const c = this.ctx, g = this.game!;
    if (this.chapter === 2) {
      const hs = TUTORIAL_SPOTS.human;
      g.claimDisc(g.humanId, hs.x, hs.y, 19);
      c.me.troops = Math.max(c.me.troops, 6000);
      c.me.gold = Math.max(c.me.gold, 1000);
      for (const r of ['borea', 'corvia', 'marea'] as Role[]) {
        const p = c.P(r);
        if (p?.alive) { g.claimDisc(p.id, p.spawnX, p.spawnY, 13); p.troops = Math.max(p.troops, 4000); }
      }
      // objectives arrive when the tutorial explains them
      g.ext.advScenario?.nextObjectiveAt?.(1e12);
      const cam = this.app.renderer.cam;
      cam.centerOn(hs.x, hs.y, Math.max(cam.fitScale() * 2, Math.min(cam.viewW, cam.viewH) / 120), false);
    }
  }

  private publish(): void {
    const self = this;
    (window as any).tutorial = {
      __t: this,
      get index() { return self.idx; },
      get chapter() { return self.chapter; },
      get steps() { return self.steps.map((s, i) => ({ n: i + 1, id: s.id, title: s.title, kind: s.kind })); },
      get step() { const s = self.steps[self.idx]; return s ? { n: self.idx + 1, id: s.id, title: s.title, kind: s.kind, mode: self.mode } : null; },
      goto: (n: number | string) => self.goto(n),
      next: () => self.next(),
      back: () => self.back(),
      doIt: () => self.doIt(),
      ctx: this.ctx,
    };
  }

  // ── navigation ──────────────────────────────────────────────────────────
  get cur(): Step | undefined { return this.steps[this.idx]; }

  /** 0-based index within the chapter, or a step id (may switch chapter). */
  goto(n: number | string): void {
    if (typeof n === 'string') {
      const f = this.steps.findIndex(s => s.id === n);
      if (f < 0) {
        const s = STEPS.find(x => x.id === n);
        if (s) this.app.startTutorial(s.chapter, s.id);
        return;
      }
      n = f;
    }
    this.enter(Math.max(0, Math.min(this.steps.length - 1, n)), true);
  }

  next(): void {
    const s = this.cur;
    if (!s) return;
    if (this.mode === 'bar') { this.complete(true); return; }
    if (this.idx >= this.steps.length - 1) return;
    this.enter(this.idx + 1, false);
  }

  back(): void {
    if (this.idx > 0) this.enter(this.idx - 1, true);
  }

  exit(): void {
    this.app.showTitle();
  }

  private enter(k: number, jump: boolean): void {
    this.leave();
    this.idx = k;
    const s = this.steps[k];
    const c = this.ctx;
    c.data = {};
    this.notes = [];
    this.confirm = jump ? '' : this.pendingConfirm;
    this.pendingConfirm = '';
    this.entering = true;
    this.enterSeq = this.seq;
    this.enterTick = this.game!.tick;
    this.enterAt = performance.now();
    this.hintShown = false;
    this.forceAt = 0;
    this.placeSig = '';
    this.lastPlace = 0;
    this.app.ctxMenu.close();
    // a slider dragged in the previous step keeps the focus and would swallow Enter
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae.tagName === 'INPUT' && (ae as HTMLInputElement).type === 'range') ae.blur();
    try { s.prep?.(c); } catch (e) { console.warn('tutorial prep', s.id, e); }
    try { s.enter?.(c); } catch (e) { console.warn('tutorial enter', s.id, e); }
    if (s.sheet && c.touch && this.game!.adv) this.undo.push(this.app.mobile.pin('cmd'));
    // phones: open the fly-out (or the minimap) the step talks about, for as long as the step lasts
    if (s.panel && c.phone) this.undo.push(s.panel === 'mm' ? this.app.mobile.forceMinimap() : this.app.mobile.pin(s.panel));
    const f = s.focus?.(c);
    if (f) c.look(f.x, f.y, f.span ?? 90);
    else if (s.mark) {
      // keep the marked spot in the open middle of the screen (not under the HUD)
      let m: { x: number; y: number } | null = null;
      try { m = s.mark(c); } catch { m = null; }
      const cam = this.app.renderer.cam;
      if (m) {
        const sx = cam.toScreenX(m.x), sy = cam.toScreenY(m.y);
        if (sx < cam.viewW * 0.2 || sx > cam.viewW * 0.8 || sy < cam.viewH * 0.22 || sy > cam.viewH * 0.75) cam.centerOn(m.x, m.y, cam.scale);
      }
    }
    this.mode = s.kind === 'info' ? 'card' : 'bar';
    this.hold = s.kind === 'info';
    this.entering = false;
    if (s.final && this.chapter === 2) saveProgress(null);
    else saveProgress({ chapter: this.chapter, step: s.id, label: `Capitolo ${this.chapter} · ${s.title}` });
    this.render();
  }

  private leave(): void {
    const s = this.cur, c = this.ctx;
    if (s && this.game) { try { s.leave?.(c); } catch (e) { console.warn('tutorial leave', s.id, e); } }
    for (const u of this.undo.splice(0)) { try { u(); } catch { /* ignore */ } }
  }

  /** Predicate became true (or the player skipped): hold and confirm. */
  private complete(skipped = false): void {
    const s = this.cur!;
    const ae = document.activeElement as HTMLElement | null;
    if (ae && ae.tagName === 'INPUT' && (ae as HTMLInputElement).type === 'range') ae.blur();
    let msg = 'Fatto.';
    try { msg = this.fmtText(s.ok ?? 'Fatto.'); } catch { /* keep default */ }
    const conf = skipped && s.kind === 'watch' ? '' : msg;
    const nxt = this.steps[this.idx + 1];
    if (nxt && nxt.kind === 'info') { this.pendingConfirm = conf; this.enter(this.idx + 1, false); return; }
    this.confirm = conf || 'Fatto.';
    if (!nxt) { this.mode = 'card'; this.hold = true; this.render(); return; }
    // next is another action: pause here with a one-line confirmation
    this.mode = 'done';
    this.hold = true;
    this.doneAt = performance.now();
    this.render();
  }

  doIt(): void {
    const s = this.cur;
    if (!s || this.mode !== 'bar') return;
    try { s.doIt?.(this.ctx); } catch (e) { console.warn('tutorial doIt', s.id, e); }
    this.forceAt = performance.now() + (s.doItWait ?? 6) * 1000;
    this.render();
  }

  key(e: KeyboardEvent): boolean {
    if (this.app.screens.modalOpen && !this.cur?.modalOk) return false;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      if (this.mode === 'card' || this.mode === 'done') {
        if (this.cur?.final) return false;
        if (this.mode === 'done') this.enter(this.idx + 1, false);
        else this.next();
        return true;
      }
    }
    return false;
  }

  // ── events & taming ─────────────────────────────────────────────────────
  private push(ev: TutEvent): void {
    this.log.push({ seq: ++this.seq, tick: this.game?.tick ?? 0, ev });
    if (this.log.length > 600) this.log.splice(0, this.log.length - 400);
  }
  sawSince(fn: (e: TutEvent) => boolean): boolean {
    for (let k = this.log.length - 1; k >= 0; k--) {
      const l = this.log[k];
      if (l.seq <= this.enterSeq) break;
      if (fn(l.ev)) return true;
    }
    return false;
  }
  /** UI-side signals (minimap clicks…). */
  signal(what: string): void { this.push({ type: 'ui', what }); }

  private record(ev: GameEvent): void {
    const g = this.game!;
    if (ev.type === 'diploOffer' && ev.offer.to === g.humanId && !this.scriptedOffer && g.players[ev.offer.from]?.kind !== 'human') {
      // unscripted bot initiative towards the player: dropped (the tutorial world stays predictable)
      const k = g.adv!.offers.indexOf(ev.offer);
      if (k >= 0) g.adv!.offers.splice(k, 1);
      this.dropMsgTick = g.tick;
      return;
    }
    this.push(ev);
  }

  /** Bots never attack, invade, nuke, embargo, betray or court the player unless a step scripts it. */
  private tame(g: Game): void {
    const H = g.humanId;
    const cmd = g.cmd;
    const raw: Raw = { ...cmd, adv: g.adv ? { ...g.adv.cmd } : null };
    this.raw = raw;
    const rec = (name: CmdName, args: any[], ok: boolean) => { this.push({ type: 'cmd', name, args, ok }); return ok; };
    const big = (id: PlayerId) => (g.players[id]?.tiles ?? 0) > BOT_CAP;
    cmd.attack = (a, t, n) => {
      if (a !== H) return t === 0 && !big(a) ? raw.attack(a, t, n) : false;
      return rec('attack', [a, t, n], raw.attack(a, t, n));
    };
    cmd.retreat = id => {
      const at = g.attacks.find(x => x.id === id);
      const ok = raw.retreat(id);
      if (at && at.attacker === H) rec('retreat', [id, at.target], ok);
      return ok;
    };
    cmd.build = (p, t, tile) => (p === H ? rec('build', [p, t, tile], raw.build(p, t, tile)) : raw.build(p, t, tile));
    cmd.sendBoat = (p, tile, n) => (p === H ? rec('sendBoat', [p, tile, n], raw.sendBoat(p, tile, n)) : false);
    cmd.launchNuke = (p, k, tile) => (p === H ? rec('launchNuke', [p, k, tile], raw.launchNuke(p, k, tile)) : false);
    cmd.proposeAlliance = (f, t) => {
      if (f !== H) return t === H ? false : raw.proposeAlliance(f, t);
      return rec('proposeAlliance', [f, t], raw.proposeAlliance(f, t));
    };
    cmd.respondAlliance = (id, acc) => {
      const r = g.allianceRequests.find(x => x.id === id);
      const ok = raw.respondAlliance(id, acc);
      if (r && r.to === H) rec('respondAlliance', [id, acc, r.from], ok);
      return ok;
    };
    cmd.breakAlliance = (by, o) => {
      if (by !== H) return o === H ? false : raw.breakAlliance(by, o);
      return rec('breakAlliance', [by, o], raw.breakAlliance(by, o));
    };
    cmd.setEmbargo = (by, o, on) => {
      if (by !== H) return o === H && on ? false : raw.setEmbargo(by, o, on);
      return rec('setEmbargo', [by, o, on], raw.setEmbargo(by, o, on));
    };
    cmd.donate = (f, t, k, n) => (f === H ? rec('donate', [f, t, k, n], raw.donate(f, t, k, n)) : raw.donate(f, t, k, n));
    // a bot betraying the player through a nuke detonation never happens: bots cannot launch
    const adv = g.adv;
    if (adv && raw.adv) {
      const ra = raw.adv, ac = adv.cmd;
      ac.attackAt = (a, tile, n) => {
        const t = g.owner[tile];
        if (a !== H) return t === 0 && !big(a) ? ra.attackAt(a, tile, n) : false;
        return rec('attackAt', [a, tile, n], ra.attackAt(a, tile, n));
      };
      ac.setStance = (p, s) => (p === H ? rec('setStance', [p, s], ra.setStance(p, s)) : ra.setStance(p, s));
      ac.moveCapital = (p, t) => (p === H ? rec('moveCapital', [p, t], ra.moveCapital(p, t)) : ra.moveCapital(p, t));
      ac.setWorkers = (p, w) => (p === H ? rec('setWorkers', [p, w], ra.setWorkers(p, w)) : ra.setWorkers(p, w));
      ac.buildWarship = (p, t) => (p === H ? rec('buildWarship', [p, t], ra.buildWarship(p, t)) : false);
      ac.sendFleet = (p, t) => (p === H ? rec('sendFleet', [p, t], ra.sendFleet(p, t)) : false);
      ac.research = (p, b) => (p === H ? rec('research', [p, b], ra.research(p, b)) : ra.research(p, b));
      ac.offer = (f, t, k, x) => {
        if (f !== H) return t === H && !this.scriptedOffer ? false : ra.offer(f, t, k, x);
        return rec('offer', [f, t, k, x ?? 0], ra.offer(f, t, k, x));
      };
      ac.respondOffer = (id, acc) => {
        const o = adv.offers.find(x => x.id === id);
        const ok = ra.respondOffer(id, acc);
        if (o && o.to === H) rec('respondOffer', [id, acc, o.from, o.kind], ok);
        return ok;
      };
      ac.breakPact = (by, o, k) => {
        if (by !== H) return o === H ? false : ra.breakPact(by, o, k);
        return rec('breakPact', [by, o, k], ra.breakPact(by, o, k));
      };
    }
    // log lines of dropped bot offers
    const msg = g.msg.bind(g);
    g.msg = (text, level, to, x, y) => {
      if (to === H && g.tick === this.dropMsgTick && /propone|chiede/.test(text)) return;
      msg(text, level, to, x, y);
    };
  }

  /** A scripted bot offer to the player (bypasses the taming). */
  botOffer(from: PlayerId, kind: 'nap' | 'truce' | 'tribute' | 'jointWar', target = 0): boolean {
    const adv = this.game?.adv;
    if (!adv || !this.raw?.adv) return false;
    this.scriptedOffer = true;
    try { return this.raw.adv.offer(from, this.game!.humanId, kind, target); } finally { this.scriptedOffer = false; }
  }

  /** Bots answer the player's proposals with a yes (after a short pause). */
  private autoAccept(): void {
    const g = this.game!, H = g.humanId, raw = this.raw!;
    for (const r of [...g.allianceRequests]) {
      if (r.from === H && g.tick - r.tick >= 6 && g.players[r.to]?.alive) raw.respondAlliance(r.id, true);
    }
    const adv = g.adv;
    if (adv && raw.adv) for (const o of [...adv.offers]) {
      if (o.from === H && g.tick - o.tick >= 6 && g.players[o.to]?.alive) raw.adv.respondOffer(o.id, true);
    }
  }

  note(text: string): void {
    if (!this.notes.includes(text)) this.notes.push(text);
    if (!this.entering) this.render();
  }

  // ── per frame ───────────────────────────────────────────────────────────
  frame(now: number): void {
    const g = this.game, s = this.cur;
    if (!g || !s || this.disposed) return;
    const modalHide = this.app.screens.modalOpen && !s.modalOk;
    this.root.classList.toggle('tut-hidden', modalHide);
    document.body.classList.toggle('tut-hold', this.hold);
    if (now - this.lastCheck > 100) {
      this.lastCheck = now;
      this.autoAccept();
      if (this.mode === 'bar') {
        try { s.tick?.(this.ctx); } catch (e) { console.warn('tutorial tick', s.id, e); }
        let done = false;
        try { done = !!s.done?.(this.ctx); } catch (e) { console.warn('tutorial done', s.id, e); }
        if (!done && this.forceAt && now > this.forceAt) done = true;
        if (done) { this.complete(); return; }
        if (!this.hintShown && now - this.enterAt > HINT_MS && s.hint) { this.hintShown = true; this.render(); }
      }
    }
    this.updateMarker();
    if (now - this.lastPlace > 120) { this.lastPlace = now; this.place(); }
  }

  // ── rendering ───────────────────────────────────────────────────────────
  private fmtText(t: string | ((c: Ctx) => string) | undefined): string {
    if (!t) return '';
    const s = typeof t === 'function' ? t(this.ctx) : t;
    const touch = this.ctx.touch, phone = this.ctx.phone;
    // {mouse|touch} or {mouse|touch|phone}
    return s.replace(/\{([^|{}]*)\|([^|{}]*)(?:\|([^{}]*))?\}/g, (_m, a, b, c) => (phone && c !== undefined ? c : touch ? b : a));
  }

  private render(): void {
    const s = this.cur;
    if (!s) return;
    const c = this.ctx;
    const n = this.idx + 1, tot = this.steps.length;
    const kick = h('div', { class: 'tut-kick' },
      h('span', null, `Capitolo ${this.chapter} · ${this.chapter === 1 ? 'gioco base' : 'modalità avanzata'}`),
      h('b', null, `${n} / ${tot}`));
    const notes = this.notes.map(t => h('div', { class: 'tut-note' }, t));
    const exitBtn = h('button', { class: 'btn ghost sm tut-exit', type: 'button', onclick: () => this.exit() }, 'Esci dal tutorial');
    const backBtn = h('button', { class: 'btn sm tut-back', type: 'button', disabled: this.idx === 0, onclick: () => this.back() }, 'Indietro');
    this.card.className = `tut-card panel mode-${this.mode} kind-${s.kind}`;
    const fill = (...k: (Node | null | undefined | false)[]) => this.card.replaceChildren(...k.filter((x): x is Node => !!x));
    if (this.mode === 'card') {
      const paras = this.fmtText(s.text).split('\n').filter(Boolean).map(p => h('p', null, p));
      const actions: HTMLElement[] = [];
      if (s.final) {
        for (const b of s.final(c)) actions.push(h('button', { class: `btn sm${b.primary ? ' primary' : ''}`, type: 'button', onclick: () => b.run(this) }, b.label));
      } else {
        actions.push(h('button', { class: 'btn primary sm tut-next', type: 'button', disabled: n >= tot, onclick: () => this.next() }, 'Avanti', c.touch ? null : h('kbd', null, '↵')));
      }
      fill(
        kick,
        this.confirm ? h('div', { class: 'tut-ok' }, this.confirm) : null,
        h('h3', null, this.fmtText(s.title)),
        h('div', { class: 'tut-text' }, paras),
        ...notes,
        h('div', { class: 'tut-foot' }, s.final ? null : exitBtn, h('span', { class: 'tut-sp' }), backBtn, ...actions));
    } else if (this.mode === 'bar') {
      const lead = s.kind === 'watch' ? 'Guarda' : 'Ora tocca a te';
      const hint = this.hintShown && s.hint ? h('div', { class: 'tut-hint' }, this.fmtText(s.hint)) : null;
      const forcing = this.forceAt > 0;
      const doBtn = h('button', { class: `btn sm tut-do${this.hintShown ? ' pulse' : ''}`, type: 'button', disabled: forcing, onclick: () => (s.kind === 'watch' && !s.doIt ? this.complete(true) : this.doIt()) },
        forcing ? 'Ci penso io…' : s.kind === 'watch' ? 'Salta l’attesa' : 'Fallo per me');
      fill(
        h('div', { class: 'tut-bar-main' },
          h('div', { class: 'tut-kick' }, h('span', null, lead), h('b', null, `${n} / ${tot}`)),
          this.confirm ? h('div', { class: 'tut-ok' }, this.confirm) : null,
          h('div', { class: 'tut-do-text' }, h('b', null, this.fmtText(s.title)), ' ', this.fmtText(s.text)),
          ...notes, hint),
        h('div', { class: 'tut-bar-btns' },
          doBtn,
          h('button', { class: 'ib tut-ib', type: 'button', title: 'Indietro', 'aria-label': 'Indietro', disabled: this.idx === 0, onclick: () => this.back() }, '‹'),
          h('button', { class: 'ib tut-ib', type: 'button', title: 'Esci dal tutorial', 'aria-label': 'Esci dal tutorial', onclick: () => this.exit() }, '✕')));
    } else {
      fill(
        h('div', { class: 'tut-bar-main' },
          h('div', { class: 'tut-kick' }, h('span', null, 'Fatto'), h('b', null, `${n} / ${tot}`)),
          h('div', { class: 'tut-ok big' }, this.confirm || 'Fatto.'),
          ...notes),
        h('div', { class: 'tut-bar-btns' },
          h('button', { class: 'btn primary sm tut-next', type: 'button', onclick: () => this.enter(this.idx + 1, false) }, 'Avanti', c.touch ? null : h('kbd', null, '↵')),
          h('button', { class: 'ib tut-ib', type: 'button', title: 'Esci dal tutorial', 'aria-label': 'Esci dal tutorial', onclick: () => this.exit() }, '✕')));
    }
    this.placeSig = '';
    this.place();
  }

  /** Elements the step points at (resolved now: they may appear later). */
  private targets(): HTMLElement[] {
    const s = this.cur;
    if (!s?.target) return [];
    const sel = this.fmtText(typeof s.target === 'function' ? s.target(this.ctx) : s.target);
    if (!sel) return [];
    const out: HTMLElement[] = [];
    for (const part of sel.split(';')) {
      for (const el of document.querySelectorAll<HTMLElement>(part.trim())) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') {
          // inside the scrolling Comando column (touch sheet): bring it into view once per step
          const col = el.closest<HTMLElement>('.adv-col');
          if (col && !this.ctx.data.__scrolled) {
            const cr = col.getBoundingClientRect();
            if (r.top < cr.top || r.bottom > cr.bottom) { el.scrollIntoView({ block: 'nearest' }); this.ctx.data.__scrolled = true; }
          }
          out.push(el);
          break;
        }
      }
    }
    return out;
  }

  private markerXY(): [number, number] | null {
    const s = this.cur;
    let f: { x: number; y: number } | null = null;
    if (s?.mark) {
      const d = this.ctx.data;
      if (s.markLive) f = s.mark(this.ctx);
      else { if (!('__mark' in d)) d.__mark = s.mark(this.ctx); f = d.__mark; }
    }
    if (!f) return null;
    const cam = this.app.renderer.cam;
    return [cam.toScreenX(f.x + 0.5), cam.toScreenY(f.y + 0.5)];
  }

  private updateMarker(): void {
    const p = this.markerXY();
    this.marker.classList.toggle('hidden', !p);
    if (!p) return;
    const [x, y] = p;
    this.marker.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  /** Spotlight + position the card / bar so it never covers its targets (nor the map centre, for the bar). */
  private place(): void {
    const s = this.cur;
    if (!s) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const tg = this.targets();
    const rects: Rect[] = tg.map(el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const mk = this.markerXY();
    const sig = `${vw}x${vh}|${this.mode}|${rects.map(r => `${r.x|0},${r.y|0},${r.w|0},${r.h|0}`).join(';')}|${mk ? `${mk[0] | 0},${mk[1] | 0}` : ''}|${this.softRects().map(r => `${r.x|0},${r.y|0},${r.w|0},${r.h|0}`).join(';')}`;
    if (sig === this.placeSig) return;
    this.placeSig = sig;

    // spotlight: dim everything but the targets (explanations only), outline them always
    const pad = 5;
    const holes = rects.map(r => ({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 }));
    const dimOn = this.mode === 'card' && (holes.length > 0 || !!mk);
    this.dim.classList.toggle('on', dimOn);
    this.dim.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
    this.dim.setAttribute('width', String(vw));
    this.dim.setAttribute('height', String(vh));
    let d = `M0 0H${vw}V${vh}H0Z`;
    for (const r of holes) d += `M${r.x} ${r.y}h${r.w}v${r.h}h${-r.w}Z`;
    if (mk) { const R = 46; d += `M${mk[0] - R} ${mk[1]}a${R} ${R} 0 1 0 ${R * 2} 0a${R} ${R} 0 1 0 ${-R * 2} 0Z`; }
    this.dimPath.setAttribute('d', d);
    this.rings.replaceChildren(...holes.map(r => h('div', { class: 'tut-ring', style: `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px` })));

    // card / bar placement
    const el = this.card;
    const bar = this.mode !== 'card';
    const touch = this.ctx.touch;
    const phone = vh < 520 || vw < 700;
    let w = bar ? Math.min(460, vw - 24) : Math.min(phone ? (vw < 720 ? 350 : 380) : 420, vw - 24);
    // phone bar: wide and short (one or two lines), between the rail and the right edge
    if (bar && phone) w = touch ? Math.min(540, vw - 2 * 58) : Math.min(w, Math.max(300, vw - 440));
    el.style.width = `${w}px`;
    const top = this.edge('.topbar', 'bottom', 0) + 8;
    // phones: the card never covers the top strip (it scrolls instead)
    const minY = phone && touch ? top : 6;
    el.style.maxHeight = `${vh - minY - 8}px`;
    const ch = el.getBoundingClientRect().height;
    const bottomLimit = Math.min(this.edge('.ratio:not(.hidden)', 'top', vh), this.edge('.m-banner:not(.hidden)', 'top', vh)) - 8;
    const cx = (vw - w) / 2;
    type Cand = { x: number; y: number; w: number };
    // explanation cards may cover the (paused) map, so they keep their full width on the sides too
    const sideW = bar ? (phone && touch ? Math.min(w, Math.max(300, vw - 352)) : Math.min(w, Math.max(240, vw / 2 - 70))) : w;
    const cands: Cand[] = [];
    if (!bar) cands.push({ x: cx, y: (vh - ch) / 2, w });
    cands.push({ x: cx, y: top, w });
    cands.push({ x: cx, y: Math.max(top, bottomLimit - ch), w });
    cands.push({ x: 12, y: Math.max(top, (vh - ch) / 2), w: sideW });
    cands.push({ x: vw - sideW - 12, y: Math.max(top, (vh - ch) / 2), w: sideW });
    cands.push({ x: 12, y: top, w: sideW }, { x: vw - sideW - 12, y: top, w: sideW });
    // phones: the bottom corners stop above the strength bar / armed banner (they span most of the width)
    const lowY = phone && touch ? Math.max(top, bottomLimit - ch) : Math.max(top, vh - ch - 12);
    cands.push({ x: 12, y: lowY, w: sideW }, { x: vw - sideW - 12, y: lowY, w: sideW });
    // phones: beside each spotlighted part, in the room left by it (fly-outs leave too little for the usual width)
    if (phone && touch) {
      for (const r of holes) {
        const rw = Math.min(w, vw - (r.x + r.w) - 20), lw = Math.min(w, r.x - 20);
        const y = Math.max(top, Math.min(r.y, bottomLimit - ch));
        if (rw >= 240) cands.push({ x: r.x + r.w + 8, y, w: rw });
        if (lw >= 240) cands.push({ x: r.x - lw - 8, y, w: lw });
      }
    }
    const soft = this.softRects();
    const hard = holes.slice();
    if (mk) hard.push({ x: mk[0] - 40, y: mk[1] - 40, w: 80, h: 80 });
    const inter = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    let best: Cand = cands[0], bs = Infinity;
    for (const cd of cands) {
      const hh = cd.w === w ? ch : ch * (w / cd.w) * 1.05;
      const r: Rect = { x: cd.x, y: Math.max(minY, Math.min(cd.y, vh - hh - 6)), w: cd.w, h: hh };
      let sc = 0;
      for (const t of hard) sc += inter(r, t) * 50;
      if (bar) {
        // the instruction bar never covers the middle of the map
        const mid: Rect = { x: vw / 2 - 60, y: vh / 2 - 50, w: 120, h: 100 };
        sc += inter(r, mid) * 20;
      }
      for (const t of soft) sc += inter(r, t);
      sc += cands.indexOf(cd) * 30;
      if (sc < bs) { bs = sc; best = { ...cd, y: r.y }; }
    }
    el.style.width = `${best.w}px`;
    el.style.left = `${Math.round(best.x)}px`;
    el.style.top = `${Math.round(Math.max(minY, best.y))}px`;
    // phones: a marker under an open fly-out (command sheet, attacks, history, leaderboard) slides into the free map
    if (mk && phone && touch && !this.ctx.data.__flyPanned) {
      for (const sel of ['.adv-col.open', '.log.expanded', '.m-lcol', '.side']) {
        const fe = document.querySelector<HTMLElement>(sel);
        const fr = fe?.getBoundingClientRect();
        if (!fr || !fr.width || !fr.height || mk[0] < fr.left - 20 || mk[0] > fr.right + 20 || mk[1] < fr.top - 20 || mk[1] > fr.bottom + 20) continue;
        const wm = this.cur?.mark?.(this.ctx);
        if (!wm) break;
        this.ctx.data.__flyPanned = true;
        const tx = fr.left < vw / 2 ? (fr.right + vw) / 2 : fr.left / 2;
        const cam = this.app.renderer.cam;
        const t = (cam as unknown as { target: { x: number; y: number; scale: number } | null }).target;
        const sc = t ? t.scale : cam.scale;
        cam.centerOn(wm.x + 0.5 - (tx - cam.viewW / 2) / sc, t ? t.y : cam.y, sc);
        this.placeSig = '';
        return;
      }
    }
    // small screens: when no spot leaves the marker free, slide the map so the marker sits beside the card
    if (mk && !this.ctx.data.__panned) {
      const bh = best.w === w ? ch : ch * (w / best.w) * 1.05;
      const r: Rect = { x: best.x, y: best.y, w: best.w, h: bh };
      if (inter(r, { x: mk[0] - 30, y: mk[1] - 30, w: 60, h: 60 }) > 0) {
        const left = best.x, right = vw - (best.x + best.w);
        const tx = left > right ? left / 2 : best.x + best.w + right / 2;
        const wm = this.cur?.mark?.(this.ctx);
        if (wm && Math.max(left, right) >= 90) {
          this.ctx.data.__panned = true;
          const cam = this.app.renderer.cam;
          const t = (cam as unknown as { target: { x: number; y: number; scale: number } | null }).target;
          const sc = t ? t.scale : cam.scale;
          const nx = wm.x + 0.5 - (tx - cam.viewW / 2) / sc;
          cam.centerOn(nx, t ? t.y : cam.y, sc);
          this.placeSig = '';
        }
      }
    }
  }

  private edge(sel: string, side: 'top' | 'bottom', def: number): number {
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) return def;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || el.closest('.hud.hidden')) return def;
    return side === 'top' ? r.top : r.bottom;
  }

  /** HUD parts the card should rather not cover. */
  private softRects(): Rect[] {
    const sels = ['.ctxmenu', '.requests .req', '.m-banner:not(.hidden)', '.m-tray:not(.hidden)', '.side .leaderboard', '.side .pcard:not(.hidden)', '.attacks:not(.hidden)', '.adv-col.open .adv-panel', '.adv-col.open .adv-obj', '.minimap', '.ratio', '.m-dock-row', '.modal-wrap .modal', '.log.expanded', '.tb-l', '.tb-r'];
    const out: Rect[] = [];
    for (const sel of sels) for (const el of document.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) out.push({ x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  }
}

/** Water tiles helper re-exported for the script. */
export const isWater = (g: Game, t: Tile) => g.terrain[t] === WATER;
