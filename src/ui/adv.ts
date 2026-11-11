// ADVANCED MODE — UI: actions on game.adv, command panel (resources, stance, workers, supply, capital, fleet,
// doctrines, pacts), objectives, diplomatic offers inbox, event-log lines, doctrine modal, fog helpers.
// Everything here is inert in classic matches (game.adv === null).
import type { Game } from '../sim/game';
import { TICKS_PER_SEC, type GameEvent, type Player, type Structure, type StructureType, type Tile } from '../sim/types';
import {
  DOCTRINE_BRANCHES, DOCTRINE_LABEL, SCENARIO_LABEL, OFFER_LABEL, PACT_LABEL, RESOURCE_KINDS, RESOURCE_LABEL, STANCES, STANCE_LABEL,
  type Adv, type DoctrineBranch, type DiploOffer, type OfferKind, type Pact, type PactKind, type ResourceKind, type Stance,
} from '../sim/adv/types';
import { ADV } from '../sim/adv/rules';
import type { Aim, Renderer } from '../render/renderer';
import { advGlyphURL } from '../render/icons';
import { h, setText, toast } from './dom';
import { clock, fmt, fmtRate, hexColor } from './format';
import type { Actions, Ctl } from './actions';
import type { Hud } from './hud';

// ── aim kinds added by advanced mode (the renderer draws them) ───────────────
export type AdvAim = { kind: 'focus' } | { kind: 'fleet' } | { kind: 'capital' };
export type AnyAim = Aim | AdvAim;
export function aimOf(r: Renderer): AnyAim { return r.aim as AnyAim; }
export function putAim(r: Renderer, a: AnyAim): void { (r as unknown as { aim: AnyAim }).aim = a; }

// ── glyphs (advGlyphURL from the renderer; text fallback until it exists) ────
type AdvGlyph = 'oil' | 'iron' | 'uranium' | 'capital' | 'warship';
/** Renderer glyph drawn through a CSS mask so it takes the skin's text colour (light skins too). */
export function advGlyph(kind: AdvGlyph, cls = 'adv-gl'): HTMLElement {
  const el = h('span', { class: `${cls} mask k-${kind}` });
  const u = `url("${advGlyphURL(kind, '#fff')}")`;
  el.style.setProperty('-webkit-mask-image', u);
  el.style.setProperty('mask-image', u);
  return el;
}

// ── shared texts ─────────────────────────────────────────────────────────────
const dec = (n: number) => String(Math.round(n * 100) / 100).replace('.', ',');
const pctTxt = (n: number) => `${Math.round(n * 100)}%`;
export const DOCTRINE_SUB: Record<DoctrineBranch, string> = { blitz: 'Attacco e rifornimenti', fortress: 'Difesa e resistenza', projection: 'Mare e atomiche' };
export const DOCTRINE_EFFECT: Record<DoctrineBranch, string[]> = {
  blitz: [
    `Attacco ×${dec(ADV.blitzAttack)}`,
    `Rifornimenti arrivano ${dec(ADV.blitzSupply)}× più lontano`,
    `Attacco mirato ×${dec(ADV.focusBonusBlitz)} (invece di ×${dec(ADV.focusBonus)}) · cambio postura in metà tempo`,
  ],
  fortress: [
    `Difesa ×${dec(ADV.fortressDefense)}`,
    `Raggio dei forti ×${dec(ADV.fortressFortRadius)} · truppe massime ×${dec(ADV.fortressTroopCap)}`,
    `Sacche isolate resistono il doppio · perdi il ${pctTxt(ADV.capitalLossFortress)} (non il ${pctTxt(ADV.capitalLossTroops)}) se cade la capitale`,
  ],
  projection: [
    `Navi ×${dec(ADV.projectionBoatSpeed)} più veloci e +1 nave in mare`,
    `Navi da guerra: resistenza ×${dec(ADV.warshipHpProjection)}, costo ×0,75`,
    `Atomiche ×${dec(ADV.projectionNukeCost)} di costo · SAM +${pctTxt(ADV.projectionSam)} di intercettazione`,
  ],
};
const ROMAN = ['', 'I', 'II', 'III'];
const OFFER_TEXT: Record<OfferKind, string> = {
  nap: 'propone un patto di non aggressione',
  truce: 'propone una tregua',
  tribute: 'chiede che tu diventi suo vassallo',
  jointWar: 'ti chiede di attaccare',
};
const OFFER_SENT: Record<OfferKind, string> = { nap: 'Patto proposto a', truce: 'Tregua proposta a', tribute: 'Tributo chiesto a', jointWar: 'Guerra congiunta chiesta a' };
export const OFFER_HINT: Record<OfferKind, string> = {
  nap: `Niente attacchi tra voi per ${Math.round(ADV.napTicks / TICKS_PER_SEC / 60)} min`,
  truce: `Ferma gli attacchi per ${dec(ADV.truceTicks / TICKS_PER_SEC / 60)} min`,
  tribute: `Diventa suo signore: ti versa il ${pctTxt(ADV.tributeShare)} dell’oro`,
  jointWar: 'Chiedi a un alleato di attaccarlo ora',
};
export function repWord(r: number): string {
  return r >= 40 ? 'Affidabile' : r >= 10 ? 'Rispettato' : r > -10 ? 'Neutra' : r > -40 ? 'Discussa' : 'Inaffidabile';
}
const name = (g: Game, id: number) => (id ? g.players[id]?.name ?? '?' : 'Terra libera');

// ── fog helpers ──────────────────────────────────────────────────────────────
const seenCache = new WeakMap<Game, Map<number, { tick: number; v: boolean }>>();
/** Can the human currently see any part of player `id`? Always true without fog. */
export function playerSeen(g: Game, id: number): boolean {
  const adv = g.adv;
  if (!adv || !adv.fog || !g.humanId || !id || id === g.humanId) return true;
  if (g.areAllied(g.humanId, id)) return true;
  let m = seenCache.get(g);
  if (!m) { m = new Map(); seenCache.set(g, m); }
  const c = m.get(id);
  if (c && g.tick - c.tick < 10) return c.v;
  const p = g.players[id];
  let v = false;
  if (p && p.alive) {
    const cap = adv.players[id]?.capital ?? -1;
    if (cap >= 0 && adv.q.visible(cap)) v = true;
    else for (const t of p.border) { if (adv.q.visible(t)) { v = true; break; } }
  }
  m.set(id, { tick: g.tick, v });
  return v;
}
/** Troop count text that respects fog. */
export function troopsTxt(g: Game, p: Player): string { return playerSeen(g, p.id) ? fmt(p.troops) : '?'; }

/** Nearest finished structure of `type` owned by `owner` within `r` tiles of `tile`. */
export function nearestStructure(g: Game, owner: number, type: StructureType, tile: Tile, r: number): Structure | null {
  const x = g.xOf(tile), y = g.yOf(tile);
  let best: Structure | null = null, bd = r * r;
  for (const s of g.structuresOf(owner, type)) {
    const d = (s.x - x) ** 2 + (s.y - y) ** 2;
    if (d <= bd) { bd = d; best = s; }
  }
  return best;
}

export function warshipsOf(g: Game, id: number): number {
  let n = 0;
  for (const u of g.units) if (u.alive && u.type === 'warship' && u.owner === id) n++;
  return n;
}

/** Tribute gold per tick (positive for the overlord, negative for the vassal): paid by transfer, not in q.goldRate. */
export function tributeRate(g: Game, id: number): number {
  const fn = g.ext.advDiplo?.tributeRate;
  return typeof fn === 'function' ? Number(fn(id)) || 0 : 0;
}
/** Gold per tick including tribute (advanced). */
export function advGoldRate(g: Game, id: number): number { return g.q.goldRate(id) + (g.adv ? tributeRate(g, id) : 0); }

/** Pacts involving `id`. */
export function pactsOf(adv: Adv, id: number): Pact[] { return adv.pacts.filter(p => p.a === id || p.b === id); }

// ═════════════════════════════════════════════════════════════════════════════
// Actions
// ═════════════════════════════════════════════════════════════════════════════
export interface AdvCtl extends Ctl {
  /** Advanced: plain clicks use the classic whole-front attack instead of a focused one. */
  wholeFront: boolean;
  setWholeFront(v: boolean): void;
  setAim(a: AnyAim): void;
  openDoctrines(): void;
  /** Open a panel as a modal; returns a close function. */
  showPanel(el: HTMLElement): () => void;
}

export class AdvActions {
  constructor(private c: AdvCtl, private act: Actions) {}
  private get g(): Game { return this.c.game; }
  private get adv(): Adv | null { return this.c.game?.adv ?? null; }

  isWholeFront(): boolean { return this.c.wholeFront; }
  openDoctrines(): void { this.c.openDoctrines(); }

  private splash(tile: Tile): void {
    const me = this.c.me();
    if (me) this.c.renderer.fx.splash(this.g.xOf(tile), this.g.yOf(tile), performance.now(), hexColor(me.color));
  }

  /** Advanced primary click: focused attack (or whole front when toggled), boat when only reachable by sea. */
  primary(tile: Tile): void {
    const g = this.g, me = this.c.me(), adv = this.adv;
    if (!adv || this.c.wholeFront || !me || tile < 0) { this.act.primary(tile); return; }
    const o = g.owner[tile];
    if (g.isWater(tile) || o === me.id) { this.act.primary(tile); return; }
    if (o && g.areAllied(me.id, o)) { toast(`${g.players[o].name} è tuo alleato: non puoi attaccarlo`); return; }
    if (!this.act.landReachable(tile)) { this.act.boat(tile); return; }
    this.focus(tile);
  }

  focus(tile: Tile): boolean {
    const g = this.g, me = this.c.me(), adv = this.adv;
    if (!me || !adv || tile < 0) return false;
    const troops = this.act.troops();
    const why = adv.q.canAttackAt(me.id, tile);
    if (why) { toast(why); return false; }
    if (troops < 1) { toast('Truppe insufficienti'); return false; }
    const ok = adv.cmd.attackAt(me.id, tile, troops);
    if (!ok) toast('Attacco mirato non possibile');
    else this.splash(tile);
    return ok;
  }

  /** Classic whole-front attack on the owner of `tile`. */
  wholeFront(tile: Tile): void {
    const g = this.g, me = this.c.me();
    if (!me || tile < 0) return;
    const o = g.owner[tile];
    if (o && g.areAllied(me.id, o)) { toast('Siete alleati: rompi prima l’alleanza'); return; }
    if (!this.act.landReachable(tile)) { toast('Nessun confine via terra: usa una nave'); return; }
    const troops = this.act.troops();
    if (troops < 1) { toast('Truppe insufficienti'); return; }
    const ok = g.cmd.attack(me.id, o, troops);
    if (!ok) toast(o ? `Impossibile attaccare ${g.players[o].name}` : 'Impossibile espandersi qui');
    else this.splash(tile);
  }

  stance(s: Stance): void {
    const g = this.g, me = this.c.me(), adv = this.adv;
    if (!me || !adv) return;
    const ap = adv.players[me.id];
    if (ap.stance === s) return;
    if (ap.stanceReadyTick > g.tick) { toast(`Postura bloccata ancora ${Math.ceil((ap.stanceReadyTick - g.tick) / TICKS_PER_SEC)} s`); return; }
    if (adv.cmd.setStance(me.id, s)) toast(`Postura ${STANCE_LABEL[s].toLowerCase()}`, 'info');
    else toast('Postura non modificabile ora');
  }

  cycleStance(): void {
    const me = this.c.me(), adv = this.adv;
    if (!me || !adv) return;
    const cur = adv.players[me.id].stance;
    this.stance(STANCES[(STANCES.indexOf(cur) + 1) % STANCES.length]);
  }

  workers(w: number): boolean {
    const me = this.c.me(), adv = this.adv;
    if (!me || !adv) return false;
    const ok = adv.cmd.setWorkers(me.id, Math.max(0, Math.min(1, w)));
    if (!ok) toast('Ripartizione non modificabile ora');
    return ok;
  }

  research(b: DoctrineBranch): void {
    const me = this.c.me(), adv = this.adv;
    if (!me || !adv) return;
    const why = adv.q.canResearch(me.id, b);
    if (why) { toast(why); return; }
    if (adv.cmd.research(me.id, b)) toast(`Ricerca avviata: ${DOCTRINE_LABEL[b]} ${ROMAN[adv.players[me.id].doctrine.level[b] + 1] ?? ''}`, 'good');
    else toast('Ricerca non avviata');
  }

  offer(to: number, kind: OfferKind, target?: number): void {
    const me = this.c.me(), adv = this.adv;
    if (!me || !adv) return;
    const why = adv.q.canOffer(me.id, to, kind, target);
    if (why) { toast(why); return; }
    if (adv.cmd.offer(me.id, to, kind, target)) toast(`${OFFER_SENT[kind]} ${name(this.g, to)}${kind === 'jointWar' && target ? ` contro ${name(this.g, target)}` : ''}`, 'info');
    else toast('Proposta non inviata');
  }

  respond(id: number, accept: boolean): void {
    if (!this.adv?.cmd.respondOffer(id, accept)) toast('Offerta non più valida');
  }

  breakPact(other: number, kind: PactKind): void {
    const me = this.c.me(), adv = this.adv;
    if (!me || !adv) return;
    if (adv.cmd.breakPact(me.id, other, kind)) toast(`${PACT_LABEL[kind]} con ${name(this.g, other)} rotto`, 'danger');
    else toast('Impossibile rompere il patto');
  }

  buildWarship(port: Tile): boolean {
    const me = this.c.me(), adv = this.adv;
    if (!me || !adv) return false;
    const why = adv.q.canBuildWarship(me.id, port);
    if (why) { toast(why); return false; }
    const ok = adv.cmd.buildWarship(me.id, port);
    if (ok) { toast('Nave da guerra in cantiere', 'good'); this.splash(port); } else toast('Costruzione non riuscita');
    return ok;
  }

  sendFleet(sea: Tile): boolean {
    const me = this.c.me(), adv = this.adv;
    if (!me || !adv || sea < 0) return false;
    const why = adv.q.canSendFleet(me.id, sea);
    if (why) { toast(why); return false; }
    const ok = adv.cmd.sendFleet(me.id, sea);
    if (ok) { toast('Flotta in rotta', 'info'); this.splash(sea); } else toast('Flotta non disponibile');
    return ok;
  }

  moveCapital(city: Tile): boolean {
    const me = this.c.me(), adv = this.adv;
    if (!me || !adv || city < 0) return false;
    const why = adv.q.canMoveCapital(me.id, city);
    if (why) { toast(why); return false; }
    const ok = adv.cmd.moveCapital(me.id, city);
    if (ok) { toast('Capitale spostata', 'good'); this.splash(city); } else toast('Spostamento non riuscito');
    return ok;
  }

  /** For a tap with the capital aim: the own finished city nearest to the tap (generous radius). */
  cityNear(tile: Tile): Tile {
    const me = this.c.me();
    if (!me || tile < 0) return -1;
    const s = nearestStructure(this.g, me.id, 'city', tile, Math.max(3, 14 / this.c.renderer.cam.scale));
    return s ? s.tile : tile;
  }

  jumpCapital(): void {
    const me = this.c.me(), adv = this.adv;
    if (!me || !adv) return;
    const t = adv.players[me.id].capital;
    if (t < 0) { toast('Nessuna capitale'); return; }
    this.c.jumpTo(this.g.xOf(t), this.g.yOf(t));
  }

  armFleet(): void {
    if (!this.c.me() || !this.adv) return;
    if (aimOf(this.c.renderer)?.kind === 'fleet') { this.c.setAim(null); return; }
    this.c.setAim({ kind: 'fleet' });
    if (!document.body.classList.contains('touch-ui')) toast('Flotta: clicca il mare dove pattugliare (Esc annulla)', 'info');
  }

  armCapital(): void {
    if (!this.c.me() || !this.adv) return;
    if (aimOf(this.c.renderer)?.kind === 'capital') { this.c.setAim(null); return; }
    this.c.setAim({ kind: 'capital' });
    if (!document.body.classList.contains('touch-ui')) toast('Clicca una tua città per farne la capitale (Esc annulla)', 'info');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// HUD
// ═════════════════════════════════════════════════════════════════════════════
export class AdvHud {
  /** Left column (desktop) / command sheet (touch). Holds the command panel, objectives and (advanced) the attacks list. */
  readonly col = h('div', { class: 'adv-col hidden' });
  private panel = h('div', { class: 'panel adv-panel' });
  private objEl = h('div', { class: 'panel adv-obj hidden' });
  private game: Game | null = null;
  private last = 0;
  private offerCards = new Map<number, HTMLElement>();
  private doctrineEl: HTMLElement | null = null;
  private closeDoctrine: (() => void) | null = null;
  /** Sheet open on touch layouts. */
  sheetOpen = false;
  /** Something new the player should look at (touch dock badge). */
  attention = false;
  private objSeen = new Set<number>();

  // panel parts
  private res = new Map<ResourceKind, HTMLElement>();
  private fleetTxt = h('b');
  private stanceBtns = new Map<Stance, HTMLButtonElement>();
  private stanceInfo = h('small', { class: 'adv-note' });
  private workIn = h('input', { type: 'range', min: '0', max: '100', step: '5', value: '50', 'aria-label': 'Lavoratori' }) as HTMLInputElement;
  private workPct = h('b');
  private workRates = h('small', { class: 'adv-note' });
  private blocEl = h('small', { class: 'adv-note adv-bloc hidden' });
  private capBtn: HTMLButtonElement;
  private cutWarn = h('div', { class: 'adv-cut hidden' });
  private docBtn: HTMLButtonElement;
  private docBar = h('i');
  private docTxt = h('small');
  private frontBtn: HTMLButtonElement;
  private fleetBtn: HTMLButtonElement;
  private pactsEl = h('div', { class: 'adv-pacts' });
  private pactSig = '';
  private objSig = '';
  /** Ratio-panel chip: focused / whole front. */
  readonly frontChip: HTMLButtonElement;

  constructor(private c: AdvCtl, private aa: AdvActions, private hud: Hud) {
    const resRow = h('div', { class: 'adv-res' },
      RESOURCE_KINDS.map(k => {
        const v = h('b', null, '0');
        this.res.set(k, v);
        return h('span', { class: `adv-chip res-${k}`, title: `${RESOURCE_LABEL[k]}: giacimenti posseduti` }, advGlyph(k), v);
      }),
      h('span', { class: 'adv-chip fleet', title: 'Navi da guerra / capacità' }, advGlyph('warship'), this.fleetTxt));
    for (const s of STANCES) {
      const b = h('button', { type: 'button', class: `st-${s}`, title: `${STANCE_LABEL[s]}: attacco ×${dec(ADV.stance[s].atk)}, difesa ×${dec(ADV.stance[s].def)}`, onclick: () => this.aa.stance(s) }, STANCE_LABEL[s]) as HTMLButtonElement;
      this.stanceBtns.set(s, b);
    }
    const onWork = () => {
      const w = Number(this.workIn.value) / 100;
      this.workIn.style.setProperty('--p', `${this.workIn.value}%`);
      setText(this.workPct, `${this.workIn.value}%`);
      if (!this.aa.workers(w)) this.syncWorkers(true);
    };
    this.workIn.addEventListener('change', onWork);
    this.workIn.addEventListener('input', () => { this.workIn.style.setProperty('--p', `${this.workIn.value}%`); setText(this.workPct, `${this.workIn.value}%`); });
    this.capBtn = h('button', { type: 'button', class: 'btn xs', title: 'Vai alla capitale', onclick: () => this.aa.jumpCapital() }, advGlyph('capital', 'adv-gl sm'), 'Capitale') as HTMLButtonElement;
    const moveCap = h('button', { type: 'button', class: 'btn xs', title: 'Scegli una tua città come nuova capitale', onclick: () => this.aa.armCapital() }, 'Sposta…');
    this.docBtn = h('button', { type: 'button', class: 'btn sm adv-doc', title: 'Dottrine (R)', onclick: () => this.c.openDoctrines() },
      h('span', null, 'Dottrine', h('kbd', null, 'R')), this.docTxt, h('span', { class: 'adv-docbar' }, this.docBar)) as HTMLButtonElement;
    this.frontBtn = h('button', { type: 'button', class: 'btn sm adv-front', title: 'Il clic attacca tutto il confine invece di un punto (G)', onclick: () => this.c.setWholeFront(!this.c.wholeFront) },
      'Fronte intero', h('kbd', null, 'G')) as HTMLButtonElement;
    this.fleetBtn = h('button', { type: 'button', class: 'btn sm adv-fleet', title: 'Manda la nave da guerra libera più vicina a pattugliare un punto di mare (X)', onclick: () => this.aa.armFleet() },
      'Invia flotta', h('kbd', null, 'X')) as HTMLButtonElement;
    this.frontChip = h('button', { type: 'button', class: 'rt-front hidden', title: 'Clic: attacco mirato o fronte intero (G)', onclick: () => this.c.setWholeFront(!this.c.wholeFront) }, 'Mirato') as HTMLButtonElement;

    this.panel.append(
      h('div', { class: 'ph' }, h('span', null, 'Comando'), h('span', { class: 'adv-tag' }, 'Avanzata')),
      h('div', { class: 'adv-body' },
        this.blocEl,
        resRow,
        h('div', { class: 'adv-sec' },
          h('div', { class: 'adv-lbl' }, 'Postura', h('kbd', null, 'Z')),
          h('div', { class: 'seg adv-stance' }, [...this.stanceBtns.values()]),
          this.stanceInfo),
        h('div', { class: 'adv-sec' },
          h('div', { class: 'adv-lbl' }, h('span', null, 'Lavoratori'), this.workPct, h('span', { class: 'adv-lbl-r' }, 'Soldati')),
          this.workIn,
          this.workRates),
        h('div', { class: 'adv-sec adv-caprow' }, this.capBtn, moveCap, this.cutWarn),
        h('div', { class: 'adv-btns' }, this.docBtn, this.frontBtn, this.fleetBtn),
        this.pactsEl));
    this.col.append(this.panel, this.objEl);
    hud.root.appendChild(this.col);
    hud.ratioHead.appendChild(this.frontChip);
  }

  attach(game: Game): void {
    this.game = game;
    const on = !!game.adv;
    const human = on && !!game.humanId;
    document.body.classList.toggle('adv-match', on);
    this.col.classList.toggle('hidden', !human);
    this.frontChip.classList.toggle('hidden', !human);
    this.offerCards.forEach(el => el.remove());
    this.offerCards.clear();
    this.objSeen.clear();
    this.pactSig = ''; this.objSig = '';
    this.pending = [];
    this.sheetOpen = false;
    this.attention = false;
    this.col.classList.remove('open');
    this.closeDoctrinePanel();
    // the attacks list joins the left column so the two never overlap
    const atk = this.hud.attacksEl;
    if (human) this.col.appendChild(atk);
    else if (atk.parentElement !== this.hud.root) this.hud.root.insertBefore(atk, this.hud.logEl);
    if (!on) return;
    game.on(ev => { if (this.game === game) this.onEvent(ev); });
    this.syncWorkers(true);
    this.syncFront();
    this.update(performance.now(), true);
  }

  setSheet(open: boolean): void {
    this.sheetOpen = open;
    this.col.classList.toggle('open', open);
    if (open) this.attention = false;
  }

  syncFront(): void {
    const wf = this.c.wholeFront;
    this.frontBtn.classList.toggle('on', wf);
    this.frontChip.classList.toggle('on', wf);
    setText(this.frontChip, wf ? 'Fronte intero' : 'Mirato');
  }

  private syncWorkers(force = false): void {
    const g = this.game, me = this.c.me();
    if (!g?.adv || !me) return;
    if (!force && document.activeElement === this.workIn) return;
    const v = Math.round(g.adv.players[me.id].workers * 100);
    if (Number(this.workIn.value) !== v) this.workIn.value = String(v);
    this.workIn.style.setProperty('--p', `${v}%`);
    setText(this.workPct, `${v}%`);
  }

  // ── events ─────────────────────────────────────────────────────────────────
  /** Fallback log lines: dropped when the sim already messaged the human in the same tick. */
  private pending: { tick: number; text: string; level: 'info' | 'good' | 'warn' | 'danger'; x?: number; y?: number }[] = [];
  private log(text: string, level: 'info' | 'good' | 'warn' | 'danger', x?: number, y?: number): void {
    this.pending.push({ tick: this.game!.tick, text, level, x, y });
  }
  private flushLog(g: Game): void {
    while (this.pending.length && this.pending[0].tick < g.tick) {
      const l = this.pending.shift()!;
      if (!this.hud.msgTicks.has(l.tick)) this.hud.addLog(l.text, l.level, l.x, l.y);
    }
  }

  private onEvent(ev: GameEvent): void {
    const g = this.game!, adv = g.adv!, me = g.humanId;
    if (!me) return;
    const xy = (t: Tile): [number, number] | [] => (t >= 0 && adv.q.visible(t) ? [g.xOf(t), g.yOf(t)] : []);
    switch (ev.type) {
      case 'capitalLost':
        if (ev.owner === me) this.log(`La tua capitale è caduta${ev.by ? ` in mano a ${name(g, ev.by)}` : ''}!`, 'danger', ...xy(ev.tile));
        else if (ev.by === me) this.log(`Hai preso la capitale di ${name(g, ev.owner)}: bottino d’oro`, 'good', ...xy(ev.tile));
        break;
      case 'capitalMoved':
        if (ev.owner === me) this.log('Nuova capitale', 'info', g.xOf(ev.tile), g.yOf(ev.tile));
        break;
      case 'pocketLost':
        if (ev.owner === me) this.log(`Sacca isolata arresa: perse ${fmt(ev.tiles)} terre`, 'danger', ev.x, ev.y);
        else if (ev.to === me) this.log(`Una sacca di ${name(g, ev.owner)} si arrende: +${fmt(ev.tiles)} terre`, 'good', ev.x, ev.y);
        break;
      case 'rebellion':
        if (ev.owner === me) this.log(`Rivolta: ${fmt(ev.tiles)} terre lontane dai centri si staccano`, 'danger', ev.x, ev.y);
        break;
      case 'depositCaptured': {
        const d = ev.deposit, lbl = RESOURCE_LABEL[d.kind].toLowerCase();
        if (ev.owner === me) this.log(`Giacimento di ${lbl} conquistato`, 'good', d.x, d.y);
        else if (ev.previousOwner === me) this.log(`Giacimento di ${lbl} perso${ev.owner && playerSeen(g, ev.owner) ? ` contro ${name(g, ev.owner)}` : ''}`, 'warn', d.x, d.y);
        break;
      }
      case 'doctrineDone':
        if (ev.player === me) { this.log(`Dottrina completata: ${DOCTRINE_LABEL[ev.branch]} ${ROMAN[ev.level] ?? ev.level}`, 'good'); toast(`${DOCTRINE_LABEL[ev.branch]} ${ROMAN[ev.level] ?? ''} completata`, 'good'); }
        break;
      case 'warshipSunk': {
        const u = ev.unit, x = Math.round(u.x), y = Math.round(u.y);
        if (u.owner === me) this.log(`Nave da guerra affondata${ev.by && playerSeen(g, ev.by) ? ` da ${name(g, ev.by)}` : ''}`, 'danger', x, y);
        else if (ev.by === me) this.log(`Hai affondato una nave da guerra di ${name(g, u.owner)}`, 'good', x, y);
        break;
      }
      case 'pactFormed': {
        const p = ev.pact;
        if (p.a !== me && p.b !== me) break;
        const other = p.a === me ? p.b : p.a;
        const dur = p.untilTick > 0 ? ` (${clock(p.untilTick - p.startTick)})` : '';
        const role = p.kind === 'tribute' ? (p.a === me ? ' · è tuo vassallo' : ' · sei suo vassallo') : '';
        this.log(`${PACT_LABEL[p.kind]} con ${name(g, other)}${dur}${role}`, 'good');
        break;
      }
      case 'pactEnded': {
        const p = ev.pact;
        if (p.a !== me && p.b !== me) break;
        const other = p.a === me ? p.b : p.a;
        if (!ev.brokenBy) this.log(`${PACT_LABEL[p.kind]} con ${name(g, other)} scaduto`, 'info');
        else if (ev.brokenBy === me) this.log(`Hai rotto: ${PACT_LABEL[p.kind].toLowerCase()} con ${name(g, other)}`, 'warn');
        else this.log(`${name(g, ev.brokenBy)} ha rotto: ${PACT_LABEL[p.kind].toLowerCase()}`, 'danger');
        break;
      }
      case 'diploOffer':
        if (ev.offer.to === me) this.addOffer(ev.offer);
        break;
      case 'objective': {
        const o = ev.objective;
        const jx = o.x !== undefined && o.y !== undefined ? [o.x, o.y] as [number, number] : [] as [];
        if (ev.state === 'new') { this.log(`Nuovo obiettivo: ${o.title}`, 'info', ...jx); toast(`Nuovo obiettivo: ${o.title}`, 'info'); this.attention = !this.sheetOpen; }
        else if (ev.state === 'done') { this.log(`Obiettivo completato: ${o.title} · +${fmt(o.reward)} oro`, 'good', ...jx); toast(`Obiettivo completato · +${fmt(o.reward)} oro`, 'good'); }
        else { this.log(`Obiettivo fallito: ${o.title}`, 'warn'); toast(`Obiettivo fallito: ${o.title}`, 'warn'); }
        this.objSig = '';
        break;
      }
    }
  }

  // ── offers inbox (cards next to the alliance requests) ────────────────────
  private addOffer(o: DiploOffer): void {
    const g = this.game!;
    if (this.offerCards.has(o.id)) return;
    const p = g.players[o.from];
    if (!p) return;
    const what = o.kind === 'jointWar' ? `${OFFER_TEXT.jointWar} ${name(g, o.target)}` : OFFER_TEXT[o.kind];
    const el = h('div', { class: `req panel adv-offer k-${o.kind}` },
      h('span', { class: 'sw', style: `background:${hexColor(p.color)}` }),
      h('div', { class: 'req-t' }, h('b', null, p.name), h('small', null, what)),
      h('button', { class: 'btn ok', onclick: () => { this.aa.respond(o.id, true); this.dropOffer(o.id); } }, 'Accetta'),
      h('button', { class: 'btn', onclick: () => { this.aa.respond(o.id, false); this.dropOffer(o.id); } }, 'Rifiuta'),
    );
    el.title = OFFER_LABEL[o.kind];
    el.addEventListener('mouseenter', () => { this.hud.hoverPlayer = o.from; });
    el.addEventListener('mouseleave', () => { this.hud.hoverPlayer = 0; });
    this.offerCards.set(o.id, el);
    this.hud.requestsEl.appendChild(el);
    while (this.offerCards.size > 3) this.dropOffer(this.offerCards.keys().next().value!);
  }

  private dropOffer(id: number): void {
    const el = this.offerCards.get(id);
    if (!el) return;
    this.offerCards.delete(id);
    el.classList.add('out');
    setTimeout(() => el.remove(), 180);
  }

  // ── per-frame update (throttled) ───────────────────────────────────────────
  update(now: number, force = false): void {
    const g = this.game;
    if (!g?.adv || !g.humanId) return;
    if (!force && now - this.last < 250) return;
    this.last = now;
    this.flushLog(g);
    const adv = g.adv, me = this.c.me();
    // offers: drop stale, pick up missed
    for (const id of [...this.offerCards.keys()]) if (!adv.offers.some(o => o.id === id)) this.dropOffer(id);
    if (me) for (const o of adv.offers) if (o.to === me.id && !this.offerCards.has(o.id)) this.addOffer(o);
    this.updateObjectives(g, adv);
    if (!me) { this.panel.classList.add('dead'); return; }
    this.panel.classList.remove('dead');
    const ap = adv.players[me.id];
    for (const [k, el] of this.res) setText(el, String(ap.res[k] ?? 0));
    const cap = adv.q.fleetCap(me.id);
    setText(this.fleetTxt, `${warshipsOf(g, me.id)}/${isFinite(cap) ? cap : 0}`);
    // stance
    const wait = ap.stanceReadyTick - g.tick;
    for (const [s, b] of this.stanceBtns) { b.classList.toggle('on', ap.stance === s); b.disabled = wait > 0 && ap.stance !== s; }
    const st = ADV.stance[ap.stance];
    setText(this.stanceInfo, wait > 0 ? `Cambio possibile tra ${Math.ceil(wait / TICKS_PER_SEC)} s` : `Attacco ×${dec(st.atk)} · difesa ×${dec(st.def)}`);
    // workers & rates
    this.syncWorkers();
    const trib = tributeRate(g, me.id) * TICKS_PER_SEC;
    const gr = advGoldRate(g, me.id) * TICKS_PER_SEC, tr = g.q.troopRate(me.id) * TICKS_PER_SEC, up = ap.upkeep * TICKS_PER_SEC;
    setText(this.workRates, `Oro ${fmtRate(gr)}/s · truppe ${fmtRate(tr)}/s${up > 0.05 ? ` · manutenzione −${dec(Math.round(up * 10) / 10)}/s` : ''}${Math.abs(trib) > 0.05 ? ` · tributo ${fmtRate(trib)}/s` : ''}`);
    const bloc = adv.scenario !== 'libero' && typeof g.ext.advScenario?.blocOf === 'function' ? g.ext.advScenario.blocOf(me.id) as string | null : null;
    this.blocEl.classList.toggle('hidden', adv.scenario === 'libero');
    if (adv.scenario !== 'libero') setText(this.blocEl, `Scenario ${SCENARIO_LABEL[adv.scenario]} · ${bloc ? `blocco: ${bloc}` : 'neutrale'}`);
    this.workRates.classList.toggle('neg', gr < 0);
    // capital & supply
    this.capBtn.disabled = ap.capital < 0;
    this.cutWarn.classList.toggle('hidden', ap.cutTiles <= 0);
    if (ap.cutTiles > 0) setText(this.cutWarn, `⚠ ${fmt(ap.cutTiles)} terre isolate: senza rifornimenti difendono poco e rischiano la resa`);
    // doctrines
    const d = ap.doctrine;
    if (d.researching) {
      const p = Math.max(0, Math.min(1, (g.tick - d.startTick) / Math.max(1, d.doneTick - d.startTick)));
      setText(this.docTxt, `${DOCTRINE_LABEL[d.researching]} ${ROMAN[d.level[d.researching] + 1] ?? ''} · ${Math.round(p * 100)}%`);
      this.docBar.style.width = `${p * 100}%`;
    } else {
      setText(this.docTxt, DOCTRINE_BRANCHES.map(b => `${DOCTRINE_LABEL[b].split(' ')[0]} ${d.level[b]}`).join(' · '));
      this.docBar.style.width = '0%';
    }
    this.docBtn.classList.toggle('busy', !!d.researching);
    this.fleetBtn.classList.toggle('on', aimOf(this.c.renderer)?.kind === 'fleet');
    this.updatePacts(g, adv, me.id);
    if (this.doctrineEl?.isConnected) this.renderDoctrines();
    else if (this.doctrineEl) { this.doctrineEl = null; this.closeDoctrine = null; }
  }

  private updatePacts(g: Game, adv: Adv, me: number): void {
    const list = pactsOf(adv, me);
    const sig = list.map(p => `${p.id}:${p.untilTick ? Math.ceil((p.untilTick - g.tick) / 10) : 0}`).join(',');
    if (sig === this.pactSig) return;
    this.pactSig = sig;
    if (!list.length) { this.pactsEl.replaceChildren(); return; }
    this.pactsEl.replaceChildren(
      h('div', { class: 'adv-lbl' }, 'Patti', h('span', { class: 'adv-lbl-r' }, String(list.length))),
      ...list.map(p => {
        const other = p.a === me ? p.b : p.a, op = g.players[other];
        const left = p.untilTick > 0 ? clock(Math.max(0, p.untilTick - g.tick)) : '∞';
        const kind = p.kind === 'tribute' ? (p.a === me ? 'Vassallo' : 'Signore') : p.kind === 'nap' ? 'Non aggressione' : PACT_LABEL[p.kind];
        return h('div', { class: 'adv-pact' },
          h('span', { class: 'sw', style: `background:${op ? hexColor(op.color) : 'transparent'}` }),
          h('span', { class: 'an', title: `${PACT_LABEL[p.kind]} con ${name(g, other)}`, onclick: () => this.c.focusPlayer(other) }, name(g, other)),
          h('small', null, kind),
          h('b', null, left),
          h('button', { class: 'btn xs danger', title: `Rompi (reputazione ${ADV.reputation.breakPact})`, onclick: () => this.aa.breakPact(other, p.kind) }, 'Rompi'));
      }));
  }

  private updateObjectives(g: Game, adv: Adv): void {
    const act = adv.objectives.filter(o => o.state === 'active');
    const sig = act.map(o => `${o.id}:${Math.round(o.progress * 100)}:${Math.ceil((o.deadlineTick - g.tick) / 10)}`).join(',');
    if (sig === this.objSig) return;
    this.objSig = sig;
    this.objEl.classList.toggle('hidden', !act.length);
    if (!act.length) { this.objEl.replaceChildren(); return; }
    this.objEl.replaceChildren(
      h('div', { class: 'ph' }, h('span', null, 'Obiettivi'), h('span', { class: 'dim' }, String(act.length))),
      ...act.map(o => {
        const jump = o.x !== undefined && o.y !== undefined;
        const el = h('div', { class: `adv-o${jump ? ' jump' : ''}`, title: o.text },
          h('div', { class: 'adv-o-h' }, h('b', null, o.title), h('span', { class: 'adv-o-t' }, clock(Math.max(0, o.deadlineTick - g.tick)))),
          h('small', null, o.text),
          h('div', { class: 'adv-o-f' }, h('span', { class: 'ab' }, h('i', { style: `width:${Math.round(Math.max(0, Math.min(1, o.progress)) * 100)}%` })), h('span', { class: 'adv-o-r' }, `+${fmt(o.reward)}`)));
        if (jump) el.addEventListener('click', () => this.c.jumpTo(o.x!, o.y!));
        return el;
      }));
  }

  // ── doctrine modal ─────────────────────────────────────────────────────────
  openDoctrines(): void {
    const g = this.game;
    if (!g?.adv || !this.c.me()) return;
    if (this.doctrineEl?.isConnected) { this.closeDoctrinePanel(); return; }
    this.doctrineEl = h('div', { class: 'modal panel adv-docs' });
    this.renderDoctrines();
    this.closeDoctrine = this.c.showPanel(this.doctrineEl);
  }

  closeDoctrinePanel(): void {
    const close = this.closeDoctrine;
    this.closeDoctrine = null;
    this.doctrineEl = null;
    close?.();
  }

  private renderDoctrines(): void {
    const g = this.game, me = this.c.me(), el = this.doctrineEl;
    if (!g?.adv || !el) return;
    if (!me) { this.closeDoctrinePanel(); return; }
    const adv = g.adv, d = adv.players[me.id].doctrine;
    const prog = d.researching ? Math.max(0, Math.min(1, (g.tick - d.startTick) / Math.max(1, d.doneTick - d.startTick))) : 0;
    const sig = `${me.gold > 0 ? Math.floor(me.gold / 50) : 0}|${JSON.stringify(d.level)}|${d.researching}|${Math.round(prog * 100)}|${DOCTRINE_BRANCHES.map(b => adv.q.canResearch(me.id, b)).join('/')}`;
    if (el.dataset.sig === sig) return;
    el.dataset.sig = sig;
    const cols = DOCTRINE_BRANCHES.map(b => {
      const lvl = d.level[b];
      const cost = adv.q.doctrineCost(me.id, b);
      const why = adv.q.canResearch(me.id, b);
      const busy = d.researching === b;
      const levels = [1, 2, 3].map(l => {
        const state = l <= lvl ? 'done' : l === lvl + 1 ? (busy ? 'busy' : 'next') : 'lock';
        return h('div', { class: `adv-lv ${state}` },
          h('div', { class: 'adv-lv-h' }, h('b', null, ROMAN[l]),
            h('small', null, state === 'done' ? 'Acquisita' : state === 'busy' ? `In ricerca · ${Math.round(prog * 100)}%` : `${fmt(ADV.doctrineCost[l - 1])}+ oro · ${Math.round(ADV.doctrineTicks[l - 1] / TICKS_PER_SEC)} s`)),
          h('span', null, DOCTRINE_EFFECT[b][l - 1]),
          state === 'busy' ? h('span', { class: 'ab' }, h('i', { style: `width:${prog * 100}%` })) : null);
      });
      const btn = lvl >= 3
        ? h('button', { class: 'btn sm', disabled: true }, 'Completata')
        : h('button', { class: `btn sm${why ? '' : ' primary'}`, disabled: !!why, title: why ?? '', onclick: () => { this.aa.research(b); el.dataset.sig = ''; this.renderDoctrines(); } },
          busy ? 'In ricerca' : `Ricerca ${ROMAN[lvl + 1]} · ${isFinite(cost) ? fmt(cost) : '—'}`);
      return h('div', { class: `adv-br br-${b}` },
        h('div', { class: 'adv-br-h' }, h('b', null, DOCTRINE_LABEL[b]), h('small', null, DOCTRINE_SUB[b])),
        levels,
        h('div', { class: 'adv-br-f' }, btn, why && lvl < 3 && !busy ? h('small', { class: 'cm-why' }, why) : null));
    });
    el.replaceChildren(
      h('div', { class: 'help-head' }, h('h2', null, 'Dottrine'), h('button', { class: 'ib', title: 'Chiudi (Esc)', onclick: () => this.closeDoctrinePanel() }, '✕')),
      h('p', { class: 'lead' }, `Una ricerca alla volta. Ogni livello già preso negli altri rami aumenta il costo del ${pctTxt(ADV.doctrineCrossPenalty)}. Oro: `, h('b', null, fmt(me.gold))),
      h('div', { class: 'adv-brs' }, cols));
  }
}
