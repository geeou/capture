// Touch / phone layer: on-screen twins of every keyboard action, placement & aim banner, rotate overlay,
// fullscreen toggle and phone hygiene. Active only when `body.touch-ui` is set (coarse pointer, or ?touch=1).
import { STRUCTURE_TYPES, type NukeKind, type StructureType, type Tile } from '../sim/types';
import type { Aim } from '../render/renderer';
import { STRUCTURE_HINT, STRUCTURE_LABEL, glyphURL } from '../render/icons';
import { h, setText, toast } from './dom';
import { fmt } from './format';
import type { Actions, Ctl } from './actions';
import type { Hud } from './hud';
import type { Input } from './input';
import { aimOf, warshipsOf, type AdvActions, type AdvHud } from './adv';
import { ADV } from '../sim/adv/rules';

export interface MobileApp extends Ctl {
  readonly act: Actions;
  readonly hud: Hud;
  readonly input: Input;
  readonly ctxMenu: { open: boolean; close(): void };
  readonly screens: { modalOpen: boolean };
  readonly advHud: AdvHud;
  readonly aa: AdvActions;
}

export interface MobileHooks {
  setAim(a: Aim): void;
  phase(): string;
}

const SHORT: Record<StructureType, string> = { city: 'Città', port: 'Porto', fort: 'Forte', factory: 'Fabbrica', silo: 'Silo', sam: 'SAM' };
const NUKE_LABEL: Record<NukeKind, string> = { atom: 'Atomica', hydrogen: 'Bomba H' };

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(d: string): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'm-svg');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  s.appendChild(p);
  return s;
}
const ICON = {
  build: 'M4 20V10l8-6 8 6v10h-5v-6H9v6z',
  arms: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18zm0 6a3 3 0 1 1 0 6a3 3 0 1 1 0-6zM12 3v4M12 17v4M3 12h4M17 12h4',
  boat: 'M3 15h18l-3 5H6zM12 4v10M12 5l6 7h-6',
  log: 'M5 6h14M5 11h14M5 16h9',
  fsIn: 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5',
  fsOut: 'M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5',
  cmd: 'M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4 6.8 19.1l1-5.8L3.5 9.2l5.9-.9z',
  phone: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 19h2',
};

/** Glyph rendered through a CSS mask so it takes the skin's text colour (works on light skins too). */
function glyph(t: StructureType): HTMLElement {
  const el = h('span', { class: 'm-glyph' });
  const u = `url("${glyphURL(t, '#fff')}")`;
  el.style.setProperty('-webkit-mask-image', u);
  el.style.setProperty('mask-image', u);
  return el;
}

function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches || (navigator as any).standalone === true;
}
function fsSupported(): boolean {
  const d = document as any;
  return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled) && !!(document.documentElement.requestFullscreen || (document.documentElement as any).webkitRequestFullscreen);
}
function fsActive(): boolean {
  const d = document as any;
  return !!(d.fullscreenElement || d.webkitFullscreenElement);
}
function toggleFullscreen(): void {
  const d = document as any, el = document.documentElement as any;
  try {
    if (fsActive()) { (d.exitFullscreen || d.webkitExitFullscreen)?.call(d); return; }
    const p = (el.requestFullscreen || el.webkitRequestFullscreen)?.call(el, { navigationUI: 'hide' });
    Promise.resolve(p).then(() => { try { (screen.orientation as any)?.lock?.('landscape')?.catch?.(() => {}); } catch { /* unsupported */ } }).catch(() => {});
  } catch { /* refused */ }
}

export class MobileUI {
  /** Structure armed for placement (tap the map to build), or null. */
  placing: StructureType | null = null;
  /** Touch nuke aim: first tap previews here, a second tap (or "Lancia") fires. */
  private pending: Tile = -1;
  private tray: 'build' | 'arms' | null = null;
  /** A map press that only dismissed an open tray must not also attack. */
  private trayClosedAt = 0;

  private dock: HTMLElement;
  private trayEl: HTMLElement;
  private buildBtns = new Map<StructureType, { el: HTMLElement; cost: HTMLElement }>();
  private nukeBtns = new Map<NukeKind, { el: HTMLElement; cost: HTMLElement }>();
  private dockBtn: Record<'build' | 'arms' | 'boat' | 'log' | 'cmd', HTMLButtonElement>;
  private banner: HTMLElement;
  private bnIcon = h('span', { class: 'm-bn-ic' });
  private bnTitle = h('b');
  private bnText = h('small');
  private bnFire: HTMLButtonElement;
  private namesBtn: HTMLButtonElement;
  private fsBtns: HTMLElement[] = [];
  private rotateEl: HTMLElement;
  private rotatePaused = false;
  private rotateResume = 1;
  private bannerSig = '';

  constructor(private app: MobileApp, private hooks: MobileHooks) {
    const params = new URLSearchParams(location.search);
    const forced = params.get('touch') === '1';
    const coarse = matchMedia('(pointer: coarse)');
    const applyTouch = () => document.body.classList.toggle('touch-ui', forced || coarse.matches);
    applyTouch();
    coarse.addEventListener?.('change', applyTouch);
    document.documentElement.classList.toggle('standalone', isStandalone());

    // ── bottom-left dock + trays ───────────────────────────────────────────
    const dbtn = (cls: string, label: string, ic: string, fn: () => void) =>
      h('button', { class: `m-db ${cls}`, type: 'button', 'aria-label': label, onclick: fn }, icon(ic), h('span', null, label)) as HTMLButtonElement;
    this.dockBtn = {
      build: dbtn('bld', 'Costruisci', ICON.build, () => this.toggleTray('build')),
      arms: dbtn('arm', 'Armi', ICON.arms, () => this.toggleTray('arms')),
      boat: dbtn('nav', 'Nave', ICON.boat, () => this.armBoat()),
      log: dbtn('evt', 'Eventi', ICON.log, () => { this.app.hud.setLogExpanded(!this.app.hud.logExpanded); this.sync(); }),
      // advanced matches only (hidden by CSS otherwise): opens the command sheet
      cmd: dbtn('cmd', 'Comando', ICON.cmd, () => { this.closeTray(); this.app.advHud.setSheet(!this.app.advHud.sheetOpen); this.sync(); }),
    };
    this.trayEl = h('div', { class: 'm-tray panel hidden' });
    for (const t of STRUCTURE_TYPES) {
      const cost = h('span', { class: 'm-cost' });
      const el = h('button', { class: 'm-tb', type: 'button', title: STRUCTURE_HINT[t], onclick: () => this.armBuild(t) },
        glyph(t), h('span', { class: 'm-tn' }, SHORT[t]), cost);
      this.buildBtns.set(t, { el, cost });
    }
    for (const k of ['atom', 'hydrogen'] as NukeKind[]) {
      const cost = h('span', { class: 'm-cost' });
      const el = h('button', { class: 'm-tb nuke', type: 'button', onclick: () => this.armNuke(k) },
        h('span', { class: 'm-nk' }, k === 'atom' ? '☢' : '✹'), h('span', { class: 'm-tn' }, NUKE_LABEL[k]), cost);
      this.nukeBtns.set(k, { el, cost });
    }
    this.dock = h('div', { class: 'm-dock' },
      this.trayEl,
      h('div', { class: 'm-dock-row panel' }, this.dockBtn.build, this.dockBtn.arms, this.dockBtn.boat, this.dockBtn.cmd, this.dockBtn.log));
    app.hud.root.appendChild(this.dock);

    // ── placement / aim banner (replaces the ratio slider while armed) ─────
    this.bnFire = h('button', { class: 'btn danger m-fire', type: 'button', onclick: () => this.fire() }, 'Lancia') as HTMLButtonElement;
    this.banner = h('div', { class: 'm-banner panel hidden', role: 'status' },
      this.bnIcon,
      h('div', { class: 'm-bn-t' }, this.bnTitle, this.bnText),
      this.bnFire,
      h('button', { class: 'btn m-cancel', type: 'button', onclick: () => this.cancel() }, 'Annulla'));
    app.hud.root.appendChild(this.banner);

    // ── top bar extras (names, fullscreen) ──────────────────────────────────
    this.namesBtn = h('button', { class: 'ib tb-names', type: 'button', title: 'Mostra / nascondi i nomi', 'aria-label': 'Nomi', onclick: () => {
      app.renderer.showLabels = !app.renderer.showLabels; this.sync();
    } }, 'Aa') as HTMLButtonElement;
    app.hud.touchSlot.append(this.namesBtn, this.makeFsButton('ib tb-fs'));
    // floating fullscreen button for title / setup / spawn screens
    document.body.appendChild(this.makeFsButton('ib m-fs-float'));

    // ── rotate overlay ──────────────────────────────────────────────────────
    this.rotateEl = h('div', { class: 'm-rotate hidden', role: 'alert' },
      h('div', { class: 'm-rot-ic' }, icon(ICON.phone)),
      h('b', null, 'Ruota il telefono in orizzontale'),
      h('small', null, 'CAPTURE si gioca con il telefono in orizzontale. La partita è in pausa.'));
    document.body.appendChild(this.rotateEl);
    const onLayout = () => { this.checkRotate(); this.syncFs(); };
    window.addEventListener('resize', onLayout);
    window.addEventListener('orientationchange', onLayout);
    document.addEventListener('fullscreenchange', () => this.syncFs());
    document.addEventListener('webkitfullscreenchange', () => this.syncFs());

    // phones start with leaderboard + log collapsed
    if (document.body.classList.contains('touch-ui') && matchMedia('(max-height: 520px), (max-width: 700px)').matches) app.hud.collapsePanels();

    this.installHygiene();
    this.watchHelp();
    window.addEventListener('pointerdown', e => {
      if (this.tray && !this.dock.contains(e.target as Node)) { this.trayClosedAt = performance.now(); this.closeTray(); }
    }, true);
    setInterval(() => this.sync(), 150);
    this.checkRotate();
    this.syncFs();
    this.sync();
  }

  private get touch(): boolean { return document.body.classList.contains('touch-ui'); }
  private get inMatch(): boolean { return this.hooks.phase() === 'match'; }

  // ── arming ─────────────────────────────────────────────────────────────────
  private toggleTray(t: 'build' | 'arms'): void {
    if (this.tray === t) { this.closeTray(); return; }
    this.tray = t;
    this.trayEl.replaceChildren(...(t === 'build' ? [...this.buildBtns.values()] : [...this.nukeBtns.values()]).map(b => b.el));
    this.trayEl.classList.remove('hidden');
    this.trayEl.classList.toggle('arms', t === 'arms');
    this.sync();
  }
  private closeTray(): void {
    this.tray = null;
    this.trayEl.classList.add('hidden');
    this.sync();
  }

  private clearAll(): void {
    this.placing = null;
    this.pending = -1;
    if (this.app.renderer.aim) this.hooks.setAim(null);
  }

  armBuild(t: StructureType): void {
    if (!this.app.me()) return;
    this.app.ctxMenu.close();
    this.clearAll();
    this.placing = t;
    this.closeTray();
    this.app.renderer.hoverTile = -1;
    this.sync();
  }

  armNuke(k: NukeKind): void {
    if (!this.app.me()) return;
    this.app.ctxMenu.close();
    this.clearAll();
    this.hooks.setAim({ kind: 'nuke', nuke: k });
    this.app.renderer.hoverTile = -1;
    this.closeTray();
    this.sync();
  }

  armBoat(): void {
    if (!this.app.me()) return;
    this.app.ctxMenu.close();
    const was = this.app.renderer.aim?.kind === 'boat';
    this.clearAll();
    this.closeTray();
    if (!was) { this.hooks.setAim({ kind: 'boat' }); this.app.renderer.hoverTile = -1; }
    this.sync();
  }

  cancel(): void {
    this.clearAll();
    this.sync();
  }

  private nukeReason(kind: NukeKind, tile: Tile): string | null {
    const g = this.app.game, me = this.app.me();
    if (!me) return 'Modalità spettatore';
    const o = g.owner[tile];
    return o && g.areAllied(me.id, o) ? 'Bersaglio alleato' : g.q.canNuke(me.id, kind, tile);
  }

  private fire(): void {
    const aim = this.app.renderer.aim;
    if (!aim || aim.kind !== 'nuke' || this.pending < 0) return;
    if (this.app.act.nuke(aim.nuke, this.pending)) { this.pending = -1; this.hooks.setAim(null); }
    this.sync();
  }

  /** Map tap hook (called by the app before its own tap handling). Returns true when consumed. */
  tap(tile: Tile): boolean {
    if (!this.inMatch) return false;
    if (performance.now() - this.trayClosedAt < 450) return true;
    if (this.tray) { this.closeTray(); return true; }
    if (this.placing) {
      if (tile >= 0 && this.app.act.build(this.placing, tile)) this.placing = null;
      this.sync();
      return true;
    }
    const aim = this.app.renderer.aim;
    if (aim && aim.kind === 'nuke' && this.app.input.lastPointerType !== 'mouse') {
      if (tile < 0) return true;
      const g = this.app.game, cam = this.app.renderer.cam;
      if (this.pending >= 0) {
        const near = Math.hypot(g.xOf(tile) - g.xOf(this.pending), g.yOf(tile) - g.yOf(this.pending)) <= Math.max(1.5, 26 / cam.scale);
        if (near) { this.fire(); return true; }
      }
      this.pending = tile;
      this.app.renderer.hoverTile = tile;
      const why = this.nukeReason(aim.nuke, tile);
      if (why) toast(why);
      this.sync();
      return true;
    }
    return false;
  }

  // ── per-tick sync (banner, tray costs, button states) ──────────────────────
  private sync(): void {
    const r = this.app.renderer, me = this.app.me(), g = this.app.game;
    const live = this.inMatch && !!me;
    if (!this.inMatch && (this.placing || this.pending >= 0)) { this.placing = null; this.pending = -1; }
    if (this.inMatch && !me && this.placing) this.placing = null;
    if (!r.aim || r.aim.kind !== 'nuke') this.pending = -1;
    // keep the nuke preview pinned on the chosen target while the player pans
    if (this.pending >= 0 && r.hoverTile !== this.pending) r.hoverTile = this.pending;

    this.dockBtn.build.classList.toggle('on', this.tray === 'build' || !!this.placing);
    this.dockBtn.arms.classList.toggle('on', this.tray === 'arms' || r.aim?.kind === 'nuke');
    this.dockBtn.boat.classList.toggle('on', r.aim?.kind === 'boat');
    this.dockBtn.log.classList.toggle('on', this.app.hud.logExpanded);
    const ah = this.app.advHud;
    this.dockBtn.cmd.classList.toggle('on', ah.sheetOpen);
    this.dockBtn.cmd.classList.toggle('attn', !ah.sheetOpen && (ah.attention || (!!g?.adv && !!me && g.adv.players[me.id].cutTiles > 0)));
    this.namesBtn.classList.toggle('on', r.showLabels);

    if (live && this.tray) {
      if (this.tray === 'build') for (const [t, b] of this.buildBtns) {
        const c = g.q.buildCost(me!.id, t);
        setText(b.cost, isFinite(c) ? fmt(c) : '—');
        b.el.classList.toggle('poor', !isFinite(c) || me!.gold < c);
      } else for (const [k, b] of this.nukeBtns) {
        const c = g.q.nukeCost(me!.id, k);
        setText(b.cost, isFinite(c) ? fmt(c) : '—');
        b.el.classList.toggle('poor', !isFinite(c) || me!.gold < c);
      }
    }

    // banner
    let sig = '';
    let title = '', text = '', ic = '', fire = false, fireOk = false, bad = false;
    if (live && this.placing) {
      const c = g.q.buildCost(me!.id, this.placing);
      title = `${STRUCTURE_LABEL[this.placing]} · ${isFinite(c) ? fmt(c) + ' oro' : '—'}`;
      text = 'Tocca un tuo territorio per costruire';
      ic = 'build';
    } else if (live && r.aim?.kind === 'boat') {
      title = `Nave pronta · ${fmt(this.app.act.troops())} truppe`;
      text = 'Tocca la costa da invadere';
      ic = 'boat';
    } else if (live && g.adv && aimOf(r)?.kind === 'fleet') {
      const cap = g.adv.q.fleetCap(me!.id);
      title = `Flotta · ${warshipsOf(g, me!.id)}/${isFinite(cap) ? cap : 0} navi da guerra`;
      const t = r.hoverTile;
      const why = t >= 0 ? (g.isLand(t) ? null : g.adv.q.canSendFleet(me!.id, t)) : null;
      text = why ?? 'Tocca il mare dove pattugliare';
      bad = !!why;
      ic = 'boat';
    } else if (live && g.adv && aimOf(r)?.kind === 'capital') {
      title = `Sposta la capitale · ${fmt(ADV.capitalMoveCost)} oro`;
      text = 'Tocca una tua città';
      ic = 'cmd';
    } else if (live && r.aim?.kind === 'nuke') {
      const k = r.aim.nuke;
      const c = g.q.nukeCost(me!.id, k);
      title = `${NUKE_LABEL[k]} armata · ${isFinite(c) ? fmt(c) + ' oro' : '—'}`;
      ic = 'nuke';
      fire = true;
      if (this.pending < 0) text = 'Tocca il bersaglio sulla mappa';
      else {
        const why = this.nukeReason(k, this.pending);
        fireOk = !why;
        bad = !!why;
        text = why ?? 'Tocca di nuovo il bersaglio o premi Lancia';
      }
    }
    const show = !!title && this.touch;
    sig = `${show}|${title}|${text}|${ic}|${fire}|${fireOk}|${bad}`;
    if (sig !== this.bannerSig) {
      this.bannerSig = sig;
      this.banner.classList.toggle('hidden', !show);
      document.body.classList.toggle('m-armed', show);
      if (show) {
        setText(this.bnTitle, title);
        setText(this.bnText, text);
        this.bnText.classList.toggle('why', bad);
        this.bnIcon.replaceChildren(ic === 'build' && this.placing ? glyph(this.placing) : icon(ic === 'boat' ? ICON.boat : ic === 'cmd' ? ICON.cmd : ICON.arms));
        this.banner.classList.toggle('nuke', ic === 'nuke');
        this.bnFire.classList.toggle('hidden', !fire);
        this.bnFire.disabled = !fireOk;
      }
    }
  }

  // ── fullscreen ─────────────────────────────────────────────────────────────
  private makeFsButton(cls: string): HTMLElement {
    const b = h('button', { class: cls, type: 'button', title: 'Schermo intero', 'aria-label': 'Schermo intero', onclick: () => toggleFullscreen() });
    this.fsBtns.push(b);
    return b;
  }
  private syncFs(): void {
    const ok = fsSupported() && !isStandalone();
    document.documentElement.classList.toggle('standalone', isStandalone());
    const on = fsActive();
    for (const b of this.fsBtns) {
      b.classList.toggle('hidden', !ok);
      b.classList.toggle('on', on);
      b.replaceChildren(icon(on ? ICON.fsOut : ICON.fsIn));
    }
  }

  // ── rotate overlay (small touch devices in portrait) ───────────────────────
  private checkRotate(): void {
    const portrait = window.innerHeight > window.innerWidth;
    const small = Math.min(window.innerWidth, window.innerHeight) < 600;
    const show = this.touch && portrait && small;
    const was = !this.rotateEl.classList.contains('hidden');
    if (show === was) return;
    this.rotateEl.classList.toggle('hidden', !show);
    document.body.classList.toggle('m-rotate-on', show);
    if (show) {
      this.app.ctxMenu.close();
      if (this.inMatch && this.app.speed > 0) {
        this.rotateResume = this.app.speed;
        this.app.setSpeed(0);
        this.rotatePaused = true;
      }
    } else if (this.rotatePaused) {
      this.rotatePaused = false;
      if (this.inMatch && this.app.speed === 0 && !this.app.screens.modalOpen) this.app.setSpeed(this.rotateResume);
    }
  }

  // ── hygiene: no page zoom / callouts / double-tap zoom on touch ────────────
  private installHygiene(): void {
    const isField = (t: EventTarget | null) => t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    // iOS Safari: pinch-zoom of the page itself
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false } as AddEventListenerOptions);
    document.addEventListener('touchmove', e => { if (this.touch && e.touches.length > 1) e.preventDefault(); }, { passive: false });
    document.addEventListener('dblclick', e => { if (this.touch && !isField(e.target)) e.preventDefault(); }, { passive: false });
    document.addEventListener('contextmenu', e => { if (this.touch && !isField(e.target)) e.preventDefault(); });
  }

  // ── help: add a touch section when the guide opens on a touch device ───────
  private watchHelp(): void {
    const add = (help: Element) => {
      if (!this.touch || help.querySelector('.m-help')) return;
      const col = help.querySelector('.help-cols > div');
      if (!col) return;
      const line = (k: string, t: string) => h('div', { class: 'hl' }, h('span', { class: 'hk' }, h('kbd', null, k)), h('span', null, t));
      col.prepend(h('div', { class: 'm-help' },
        h('h3', null, 'Comandi touch'),
        line('Tocco', 'Attacca o espanditi verso quella casella (nave se non confina).'),
        line('Pressione', 'Tieni premuto: menu azioni della casella.'),
        line('Trascina', 'Sposta la mappa. Due dita: zoom.'),
        line('Costruisci', 'Scegli la struttura, poi tocca un tuo territorio.'),
        line('Armi', 'Arma la bomba, tocca il bersaglio, poi Lancia.'),
        line('− / +', 'Forza d’attacco (in basso).'),
        line('Comando', 'Partita avanzata: postura, lavoratori, capitale, dottrine, flotta, patti e obiettivi.'),
        line('Mirato', 'Partita avanzata: il tocco attacca un punto; tocca il pulsante sopra la forza per il fronte intero.')));
    };
    new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        const help = n.matches('.help') ? n : n.querySelector('.help');
        if (help) add(help);
      }
    }).observe(document.querySelector('.screens') ?? document.body, { childList: true, subtree: true });
  }
}
