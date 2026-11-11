// In-match HUD: top bar, attack-ratio slider, leaderboard, player card, event log, alliance requests, attacks.
// DOM writes are throttled (≤ 5/s per part) and only happen when a shown value changed.
import type { Game } from '../sim/game';
import { WIN_SHARE, TICKS_PER_SEC, type Attack, type GameEvent, type Player } from '../sim/types';
import { h, setText } from './dom';
import { clock, fmt, fmtRate, hexColor, KIND_LABEL, pct } from './format';
import type { Actions, Ctl } from './actions';
import { PACT_LABEL } from '../sim/adv/types';
import { advGoldRate, playerSeen, repWord, troopsTxt } from './adv';

interface LogEntry { el: HTMLElement; t: number; stage: 0 | 1 | 2 }
interface AtkRow { el: HTMLElement; troops: HTMLElement; bar: HTMLElement; w: string }

const SPEEDS = [0, 1, 2, 4];
/** Phone speed button: 1× → 2× → 4× → pause → 1×. */
const CYCLE: Record<number, number> = { 1: 2, 2: 4, 4: 0, 0: 1 };

/** Log lines: shown for HOLD ms, then fade out in FADE ms (CSS transition), then kept as history only. */
const LOG_HOLD = 9000, LOG_FADE = 3000;
const LOG_HOLD_PHONE = 4000, LOG_FADE_PHONE = 800;

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Small stroke icon (phone top strip; hidden on desktop by CSS). */
function tbIcon(d: string, cls: string): SVGSVGElement {
  const s = document.createElementNS(SVG_NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', `tb-ic ${cls}`);
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', d);
  s.appendChild(p);
  return s;
}
const TB_ICON = {
  troops: 'M12 3l7 3v5c0 4.6-3 8-7 10-4-2-7-5.4-7-10V6z',
  gold: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 8.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z',
  land: 'M6 21V4M6 4h11l-2.5 4 2.5 4H6',
  clock: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16zM12 8v4.5l3 2',
};

export class Hud {
  readonly root: HTMLElement;
  // top bar
  private tTroops = h('b'); private tCap = h('span', { class: 'dim' }); private tTroopRate = h('span', { class: 'rate' });
  private tTroopBar = h('i');
  private tGold = h('b'); private tGoldRate = h('span', { class: 'rate' });
  private tShare = h('b'); private tShareBar = h('i'); private tShareLbl = h('span', { class: 'dim' });
  private tClock = h('b', { class: 'clock' });
  private tWho = h('span', { class: 'who' });
  /** "AVANZATA" tag (advanced matches only). */
  private tAdv = h('span', { class: 'adv-tag top hidden', title: 'Partita avanzata' }, 'Avanzata');
  private speedBtns: HTMLButtonElement[] = [];
  /** Phone: one cycling speed / pause button (hidden elsewhere by CSS). */
  private spCycle!: HTMLButtonElement;
  private spSig = -1;
  /** Touch-only top-bar buttons (names, fullscreen…), filled by the mobile layer; hidden on desktop by CSS. */
  readonly touchSlot = h('div', { class: 'tb-touch' });
  /** Left / right groups of the top bar (display: contents except on phones, where they are two pills). */
  readonly tbL = h('div', { class: 'tb-l' });
  readonly tbR = h('div', { class: 'tb-r' });
  topEl!: HTMLElement;
  private stats!: HTMLElement;
  // slider
  private ratioInput!: HTMLInputElement;
  private ratioPct = h('b');
  private ratioAbs = h('span');
  private ratioBox!: HTMLElement;
  /** Head row of the ratio panel (the advanced layer adds its front toggle here). */
  ratioHead!: HTMLElement;
  // leaderboard
  private lbRows: { el: HTMLElement; rank: HTMLElement; sw: HTMLElement; name: HTMLElement; badge: HTMLElement; share: HTMLElement; troops: HTMLElement; id: number; sig: string }[] = [];
  private lbCount = h('span', { class: 'dim' });
  private lbBody = h('div', { class: 'lb-body' });
  lbPanel!: HTMLElement;
  /** Human's rank by land (0 = none) and number of players alive: the phone strip shows them. */
  myRank = 0;
  aliveCount = 0;
  // card
  private card = h('div', { class: 'panel pcard hidden' });
  private cardFor = -1;
  private cardSig = '';
  // log
  readonly logEl = h('div', { class: 'log' });
  private logs: LogEntry[] = [];
  // requests
  private reqEl = h('div', { class: 'requests' });
  get requestsEl(): HTMLElement { return this.reqEl; }
  private reqs = new Map<number, HTMLElement>();
  /** Phone: compact card for an incoming attack (in the alerts column). */
  private incCard: HTMLElement;
  private incName = h('b'); private incTxt = h('small'); private incSw = h('span', { class: 'sw' });
  private incFrom = 0;
  private incDismissed = new Set<number>();
  // attacks
  private atkEl = h('div', { class: 'panel attacks hidden' });
  get attacksEl(): HTMLElement { return this.atkEl; }
  /** Left column holding alerts + attacks: `display: contents` except on phones. */
  readonly lcol = h('div', { class: 'm-lcol' });
  private alarm = h('div', { class: 'alarm' });
  private atkSig = '';
  private atkRows = new Map<number, AtkRow>();
  /** Live attacks of the human (outgoing / incoming), for the phone badge. */
  atkOut = 0;
  atkInc = 0;

  hoverPlayer = 0;
  /** Ticks in which a message addressed to the human was logged (the advanced layer avoids duplicating them). */
  readonly msgTicks = new Set<number>();
  /** Owner of the tile under the mouse (set by the app). */
  mapHover = 0;
  private lastTop = 0; private lastLb = 0; private lastAtk = 0; private lastCard = 0; private lastReq = 0; private lastLog = 0;
  private game: Game | null = null;
  private lastBars = { troops: '', share: '' };

  constructor(private c: Ctl, private act: Actions, host: HTMLElement) {
    this.root = h('div', { class: 'hud' });
    host.appendChild(this.root);
    this.incCard = h('div', { class: 'req panel m-inc hidden', role: 'alert' },
      this.incSw,
      h('div', { class: 'req-t', onclick: () => { if (this.incFrom) this.c.focusPlayer(this.incFrom); } }, this.incName, this.incTxt),
      h('button', { class: 'btn danger', type: 'button', onclick: () => { if (this.incFrom) this.act.attack(this.incFrom); } }, 'Contrattacca'),
      h('button', { class: 'btn m-x', type: 'button', 'aria-label': 'Chiudi', title: 'Chiudi', onclick: () => this.dismissIncoming() }, '✕'));
    this.buildTop();
    this.buildSlider();
    this.buildLeaderboard();
    this.lcol.append(this.reqEl, this.atkEl);
    this.root.append(this.lcol, this.logEl, this.alarm);
    // touch: tapping the player card dismisses it (it follows the selection there)
    this.card.addEventListener('click', () => { if (this.touchUI) this.c.selectPlayer(0); });
  }

  // ── construction ───────────────────────────────────────────────────────────
  private buildTop(): void {
    this.spCycle = h('button', { class: 'sp sp-cyc', type: 'button', title: 'Velocità / pausa', 'aria-label': 'Velocità', onclick: () => this.c.setSpeed(CYCLE[this.c.speed] ?? 1) }) as HTMLButtonElement;
    const speed = h('div', { class: 'speed' },
      SPEEDS.map(s => {
        const b = h('button', { class: 'sp', title: s ? `Velocità ${s}× (tasto ${s})` : 'Pausa (Spazio)', onclick: () => this.c.setSpeed(s) },
          s ? `${s}×` : h('span', { class: 'pause-ic' }));
        this.speedBtns.push(b);
        return b;
      }),
      this.spCycle);
    this.stats = h('div', { class: 'stats' },
      h('div', { class: 'stat troops', title: 'Truppe / massimo' },
        h('span', { class: 'lbl' }, 'Truppe'),
        h('div', { class: 'val' }, tbIcon(TB_ICON.troops, 'troops'), this.tTroops, this.tCap, this.tTroopRate),
        h('div', { class: 'bar' }, this.tTroopBar)),
      h('div', { class: 'stat gold', title: 'Oro' },
        h('span', { class: 'lbl' }, 'Oro'),
        h('div', { class: 'val' }, tbIcon(TB_ICON.gold, 'gold'), this.tGold, this.tGoldRate)),
      h('div', { class: 'stat land', title: `Quota di terre: vince chi arriva all’${WIN_SHARE * 100}%` },
        h('span', { class: 'lbl' }, 'Territorio'),
        h('div', { class: 'val' }, tbIcon(TB_ICON.land, 'land'), this.tShare, this.tShareLbl),
        h('div', { class: 'bar win' }, this.tShareBar, h('em', { style: `left:${WIN_SHARE * 100}%` }))),
    );
    this.tbL.append(this.stats,
      h('div', { class: 'stat time', title: 'Durata della partita' }, h('span', { class: 'lbl' }, 'Tempo'), h('div', { class: 'val' }, tbIcon(TB_ICON.clock, 'clock'), this.tClock)));
    this.tbR.append(speed,
      this.touchSlot,
      h('div', { class: 'menu-btns' },
        h('button', { class: 'ib', title: 'Come si gioca (?)', onclick: () => this.c.openHelp() }, '?'),
        h('button', { class: 'ib', title: 'Menu (Esc)', 'aria-label': 'Menu', onclick: () => this.c.openPause() }, h('span', { class: 'burger' }))));
    const top = h('div', { class: 'topbar panel' },
      h('div', { class: 'brand' }, 'CAPTURE'),
      this.tAdv,
      this.tWho,
      this.tbL,
      this.tbR,
    );
    this.topEl = top;
    this.root.appendChild(top);
  }

  private buildSlider(): void {
    this.ratioInput = h('input', { type: 'range', min: '1', max: '100', step: '1', value: '25', 'aria-label': 'Forza d’attacco' }) as HTMLInputElement;
    this.ratioInput.addEventListener('input', () => this.c.setRatio(Number(this.ratioInput.value) / 100));
    // −/+ steppers: touch only (hidden on desktop by CSS), the on-screen twin of Q/E
    const step = (d: number, label: string, txt: string) =>
      h('button', { class: 'ib rt-step', type: 'button', 'aria-label': label, onclick: () => this.c.setRatio(this.c.ratio + d) }, txt);
    this.ratioBox = h('div', { class: 'ratio panel' },
      this.ratioHead = h('div', { class: 'ratio-head' },
        h('span', { class: 'lbl' }, 'Forza d’attacco'),
        h('span', { class: 'ratio-val' }, this.ratioPct, this.ratioAbs),
        h('span', { class: 'keys' }, h('kbd', null, 'Q'), h('kbd', null, 'E'))),
      h('div', { class: 'ratio-row' }, step(-0.05, 'Riduci la forza', '−'), this.ratioInput, step(0.05, 'Aumenta la forza', '+')));
    this.root.appendChild(this.ratioBox);
  }

  private buildLeaderboard(): void {
    for (let k = 0; k < 11; k++) {
      const rank = h('span', { class: 'rk' }), sw = h('span', { class: 'sw' }), name = h('span', { class: 'nm' }),
        badge = h('span', { class: 'bdg' }), share = h('span', { class: 'sh' }), troops = h('span', { class: 'tp' });
      const row = { el: h('div', { class: 'lb-row' }, rank, sw, h('span', { class: 'nmw' }, name, badge), share, troops), rank, sw, name, badge, share, troops, id: 0, sig: '' };
      row.el.addEventListener('click', () => { if (row.id) this.c.focusPlayer(row.id); });
      row.el.addEventListener('mouseenter', () => { this.hoverPlayer = row.id; });
      row.el.addEventListener('mouseleave', () => { this.hoverPlayer = 0; });
      this.lbRows.push(row);
      this.lbBody.appendChild(row.el);
    }
    this.lbPanel = h('div', { class: 'panel leaderboard' },
      h('div', { class: 'ph', onclick: () => { if (this.onLbHead) this.onLbHead(); else this.lbPanel.classList.toggle('collapsed'); } },
        h('span', null, 'Classifica'), this.lbCount, h('span', { class: 'chev' })),
      h('div', { class: 'lb-cols' }, h('span', null, '#'), h('span'), h('span', null, 'Nome'), h('span', null, 'Terre'), h('span', null, 'Truppe')),
      this.lbBody);
    const side = h('div', { class: 'side' }, this.lbPanel, this.card);
    this.root.appendChild(side);
  }

  /** Phone layer: a tap on the leaderboard title closes the fly-out instead of collapsing it. */
  onLbHead: (() => void) | null = null;

  // ── lifecycle ──────────────────────────────────────────────────────────────
  attach(game: Game): void {
    this.game = game;
    this.logEl.textContent = '';
    this.logs = [];
    this.reqEl.textContent = '';
    this.reqs.clear();
    this.reqEl.appendChild(this.incCard);
    this.incCard.classList.add('hidden');
    this.incDismissed.clear();
    this.incFrom = 0;
    this.cardFor = -1;
    this.cardSig = '';
    this.atkSig = '';
    this.atkRows.clear();
    this.atkEl.replaceChildren();
    this.atkOut = this.atkInc = 0;
    this.atkEl.classList.add('hidden');
    this.alarm.classList.remove('on');
    for (const r of this.lbRows) r.sig = '';
    this.lastBars = { troops: '', share: '' };
    this.spSig = -1;
    const spectator = !game.humanId;
    this.tAdv.classList.toggle('hidden', !game.advanced);
    this.root.classList.toggle('spectator', spectator);
    this.ratioBox.classList.toggle('hidden', spectator);
    game.on(ev => { if (this.game === game) this.onEvent(ev); });
    this.syncRatio();
    this.update(performance.now(), true);
  }

  setVisible(v: boolean): void { this.root.classList.toggle('hidden', !v); }

  /** Phone defaults: leaderboard and event log start collapsed. */
  collapsePanels(): void {
    this.lbPanel.classList.add('collapsed');
    this.setLogExpanded(false);
  }

  get logExpanded(): boolean { return this.logEl.classList.contains('expanded'); }
  setLogExpanded(v: boolean): void {
    this.logEl.classList.toggle('expanded', v);
    if (v) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** Touch layout: the player card follows the selection only (no hover on touch). */
  private get touchUI(): boolean { return document.body.classList.contains('touch-ui'); }
  private get phone(): boolean { return document.body.classList.contains('m-phone'); }

  syncRatio(): void {
    const v = Math.round(this.c.ratio * 100);
    if (Number(this.ratioInput.value) !== v) this.ratioInput.value = String(v);
    this.ratioInput.style.setProperty('--p', `${v}%`);
    setText(this.ratioPct, `${v}%`);
  }

  syncSpeed(): void {
    const sp = this.c.speed;
    if (sp === this.spSig) return;
    this.spSig = sp;
    this.speedBtns.forEach((b, k) => b.classList.toggle('on', SPEEDS[k] === sp));
    this.spCycle.classList.toggle('paused', sp === 0);
    this.spCycle.replaceChildren(sp ? `${sp}×` : h('span', { class: 'pause-ic' }));
    this.spCycle.setAttribute('aria-label', sp ? `Velocità ${sp}× (tocca per cambiare)` : 'In pausa (tocca per riprendere)');
  }

  private onEvent(ev: GameEvent): void {
    const g = this.game!;
    const me = g.humanId;
    if (ev.type === 'message') {
      if (ev.to !== undefined && ev.to !== me) return;
      if (ev.to === me) { this.msgTicks.add(g.tick); if (this.msgTicks.size > 64) this.msgTicks.delete(this.msgTicks.values().next().value!); }
      this.addLog(ev.text, ev.level, ev.x, ev.y);
    } else if (ev.type === 'allianceRequest' && me && ev.request.to === me) {
      this.addRequest(ev.request.id, ev.request.from);
    }
  }

  addLog(text: string, level: string, x?: number, y?: number): void {
    const jump = x !== undefined && y !== undefined;
    const el = h('div', { class: `lg lvl-${level}${jump ? ' jump' : ''}`, title: jump ? 'Vai sulla mappa' : '' },
      h('span', { class: 'lg-t' }, clock(this.game!.tick)), h('span', null, text));
    if (jump) el.addEventListener('click', () => this.c.jumpTo(x!, y!));
    this.logEl.appendChild(el);
    this.logs.push({ el, t: performance.now(), stage: 0 });
    while (this.logEl.children.length > 7) this.logEl.firstElementChild!.remove();
    while (this.logs.length > 7 || (this.logs.length && !this.logs[0].el.isConnected)) this.logs.shift();
    if (this.logExpanded) this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  private addRequest(id: number, from: number): void {
    const g = this.game!;
    if (this.reqs.has(id)) return;
    const p = g.players[from];
    const el = h('div', { class: 'req panel' },
      h('span', { class: 'sw', style: `background:${hexColor(p.color)}` }),
      h('div', { class: 'req-t' }, h('b', null, p.name), h('small', null, 'propone un’alleanza')),
      h('button', { class: 'btn ok', onclick: () => { this.act.respond(id, true); this.dropRequest(id); } }, 'Accetta'),
      h('button', { class: 'btn', onclick: () => { this.act.respond(id, false); this.dropRequest(id); } }, 'Rifiuta'),
    );
    el.addEventListener('mouseenter', () => { this.hoverPlayer = from; });
    el.addEventListener('mouseleave', () => { this.hoverPlayer = 0; });
    this.reqs.set(id, el);
    this.reqEl.appendChild(el);
    while (this.reqs.size > 4) { const k = this.reqs.keys().next().value!; this.dropRequest(k); }
  }

  private dropRequest(id: number): void {
    const el = this.reqs.get(id);
    if (!el) return;
    this.reqs.delete(id);
    el.classList.add('out');
    setTimeout(() => el.remove(), 180);
  }

  // ── per-frame update (internally throttled, ≤ 5 DOM passes per second per part) ─────────
  update(now: number, force = false): void {
    const g = this.game;
    if (!g) return;
    if (force || now - this.lastTop > 200) { this.lastTop = now; this.updateTop(g); }
    if (force || now - this.lastLb > 500) { this.lastLb = now; this.updateLeaderboard(g); }
    if (force || now - this.lastAtk > 250) { this.lastAtk = now; this.updateAttacks(g); }
    if (force || now - this.lastCard > 250) { this.lastCard = now; this.updateCard(g); }
    if (force || now - this.lastReq > 400) {
      this.lastReq = now;
      for (const id of [...this.reqs.keys()]) if (!g.allianceRequests.some(r => r.id === id)) this.dropRequest(id);
      // also pick up requests that arrived without an event
      if (g.humanId) for (const r of g.allianceRequests) if (r.to === g.humanId && !this.reqs.has(r.id)) this.addRequest(r.id, r.from);
    }
    if (force || now - this.lastLog > 200) { this.lastLog = now; this.updateLog(now); }
  }

  /** Log lines fade through CSS (class changes only): shown, then `.fading`, then `.old` (history). */
  private updateLog(now: number): void {
    const phone = this.phone;
    const hold = phone ? LOG_HOLD_PHONE : LOG_HOLD, fade = phone ? LOG_FADE_PHONE : LOG_FADE;
    for (const l of this.logs) {
      const age = now - l.t;
      if (l.stage === 0 && age > hold) { l.stage = 1; l.el.classList.add('fading'); }
      if (l.stage === 1 && age > hold + fade) { l.stage = 2; l.el.classList.add('old'); }
    }
    // expired lines stay in the DOM as history (hidden unless the log is expanded on touch layouts)
    while (this.logs.length && this.logs[0].stage === 2) this.logs.shift();
  }

  /** The player whose numbers the top bar shows. */
  private focus(g: Game): Player | null {
    if (g.humanId && g.players[g.humanId].alive) return g.players[g.humanId];
    if (this.c.renderer.selected && g.players[this.c.renderer.selected]?.alive) return g.players[this.c.renderer.selected];
    let best: Player | null = null;
    for (let id = 1; id < g.players.length; id++) { const p = g.players[id]; if (p.alive && (!best || p.tiles > best.tiles)) best = p; }
    return best;
  }

  private updateTop(g: Game): void {
    const p = this.focus(g);
    const self = !!p && p.id === g.humanId;
    setText(this.tWho, self || !p ? '' : `Osservi: ${p.name}`);
    const whoCol = p && !self ? hexColor(p.color) : '';
    if (this.tWho.style.color !== whoCol) this.tWho.style.color = whoCol;
    if (p) {
      const cap = g.q.maxTroops(p.id);
      setText(this.tTroops, fmt(p.troops));
      setText(this.tCap, cap > 0 ? ` / ${fmt(cap)}` : '');
      setText(this.tTroopRate, `${fmtRate(g.q.troopRate(p.id) * TICKS_PER_SEC)}/s`);
      const tw = `${cap > 0 ? Math.min(100, (p.troops / cap) * 100) : 0}%`;
      if (tw !== this.lastBars.troops) { this.lastBars.troops = tw; this.tTroopBar.style.width = tw; }
      setText(this.tGold, fmt(p.gold));
      setText(this.tGoldRate, `${fmtRate((g.adv ? advGoldRate(g, p.id) : g.q.goldRate(p.id)) * TICKS_PER_SEC)}/s`);
      const sh = g.share(p.id);
      setText(this.tShare, pct(sh));
      setText(this.tShareLbl, ` · ${fmt(p.tiles)}`);
      const sw = `${Math.min(100, sh * 100)}%`;
      if (sw !== this.lastBars.share) { this.lastBars.share = sw; this.tShareBar.style.width = sw; }
    }
    setText(this.tClock, clock(g.tick));
    const me = this.c.me();
    if (me) setText(this.ratioAbs, ` · ${fmt(Math.floor(me.troops * this.c.ratio))} truppe`);
    this.syncSpeed();
  }

  private updateLeaderboard(g: Game): void {
    const alive: Player[] = [];
    for (let id = 1; id < g.players.length; id++) { const p = g.players[id]; if (p.alive && p.tiles > 0) alive.push(p); }
    alive.sort((a, b) => b.tiles - a.tiles);
    setText(this.lbCount, `${alive.length} in vita`);
    const meId = g.humanId;
    const rows: [number, Player][] = alive.slice(0, 10).map((p, k) => [k + 1, p]);
    const myRank = meId ? alive.findIndex(p => p.id === meId) : -1;
    this.myRank = myRank + 1;
    this.aliveCount = alive.length;
    if (myRank >= 10) rows.push([myRank + 1, alive[myRank]]);
    const sel = this.c.renderer.selected;
    for (let k = 0; k < this.lbRows.length; k++) {
      const r = this.lbRows[k];
      const e = rows[k];
      if (!e) {
        if (r.sig !== '-') { r.sig = '-'; r.el.style.display = 'none'; }
        r.id = 0;
        continue;
      }
      const [rank, p] = e;
      const allied = !!meId && g.areAllied(meId, p.id);
      const traitor = p.traitorUntil > g.tick;
      const share = pct(g.share(p.id)), troops = troopsTxt(g, p);
      const sig = `${rank}|${p.id}|${p.color}|${p.name}|${allied}|${traitor}|${share}|${troops}|${p.id === meId}|${p.id === sel}|${k === 10}`;
      r.id = p.id;
      if (sig === r.sig) continue;
      if (r.sig === '-' || r.sig === '') r.el.style.display = '';
      r.sig = sig;
      setText(r.rank, String(rank));
      r.sw.style.background = hexColor(p.color);
      setText(r.name, p.name);
      setText(r.badge, traitor ? 'TRADITORE' : allied ? 'ALLEATO' : '');
      r.badge.className = `bdg${traitor ? ' tr' : allied ? ' al' : ''}`;
      setText(r.share, share);
      setText(r.troops, troops);
      r.el.classList.toggle('me', p.id === meId);
      r.el.classList.toggle('sel', p.id === sel);
      r.el.classList.toggle('gap', k === 10);
    }
  }

  private updateCard(g: Game): void {
    const id = this.touchUI ? this.c.renderer.selected : this.hoverPlayer || this.mapHover || this.c.renderer.selected;
    const p = id ? g.players[id] : null;
    if (!p || !p.alive) {
      if (this.cardFor !== 0) { this.card.classList.add('hidden'); this.cardFor = 0; this.cardSig = ''; }
      return;
    }
    // rows as plain data first: the DOM is rebuilt only when something shown changed
    type Row = [string, string, string?, string?];
    const rows: Row[] = [];
    const me = g.humanId;
    const traitor = p.traitorUntil > g.tick;
    const seen = playerSeen(g, id);
    const atk = seen ? g.attacks.filter(a => a.alive && a.attacker === id).length : 0;
    rows.push(['Terre', `${fmt(p.tiles)} · ${pct(g.share(id))}`]);
    rows.push(['Truppe', troopsTxt(g, p), '', seen ? '' : 'Fuori dalla tua vista']);
    rows.push(['Oro', fmt(p.gold)]);
    rows.push(['Alleati', String(p.allies.size)]);
    if (atk) rows.push(['Attacchi in corso', String(atk)]);
    if (me && id !== me && g.players[me].alive) {
      const r = Math.round(g.q.relation(id, me));
      const word = r > 50 ? 'Amichevole' : r > 15 ? 'Cordiale' : r >= -15 ? 'Neutrale' : r >= -50 ? 'Ostile' : 'Nemico giurato';
      const allied = g.areAllied(me, id);
      const pending = g.allianceRequests.some(q => (q.from === me && q.to === id) || (q.from === id && q.to === me));
      rows.push(['Verso di te', `${word} (${r > 0 ? '+' : ''}${r})`, r > 15 ? 'pos' : r < -15 ? 'neg' : '']);
      rows.push(['Alleanza', allied ? 'Alleati' : pending ? 'Proposta in attesa' : 'Nessuna', allied ? 'pos' : '']);
      if (g.players[me].embargoes.has(id) || p.embargoes.has(me)) rows.push(['Commercio', 'Embargo', 'neg']);
    }
    const adv = g.adv;
    if (adv) {
      const r = Math.round(adv.players[id]?.reputation ?? 0);
      rows.push(['Reputazione', `${repWord(r)} (${r > 0 ? '+' : ''}${r})`, r >= 10 ? 'pos' : r <= -10 ? 'neg' : '']);
      if (me && id !== me) {
        for (const pk of adv.pacts) {
          if (!((pk.a === me && pk.b === id) || (pk.a === id && pk.b === me))) continue;
          const left = pk.untilTick > 0 ? ` · ${clock(Math.max(0, pk.untilTick - g.tick))}` : '';
          const role = pk.kind === 'tribute' ? (pk.a === me ? ' (tuo vassallo)' : ' (tuo signore)') : '';
          rows.push(['Patto', `${PACT_LABEL[pk.kind]}${role}${left}`, 'pos']);
        }
      }
    }
    const sig = `${id}|${p.name}|${p.color}|${p.kind}|${traitor}|${rows.map(r => r.join('~')).join('|')}`;
    if (this.cardFor === id && sig === this.cardSig) return;
    this.cardFor = id;
    this.cardSig = sig;
    this.card.classList.remove('hidden');
    this.card.replaceChildren(
      h('div', { class: 'pc-head' },
        h('span', { class: 'sw big', style: `background:${hexColor(p.color)}` }),
        h('div', null, h('b', null, p.name), h('small', null, KIND_LABEL[p.kind] + (id === me ? ' · tu' : ''))),
        traitor ? h('span', { class: 'bdg tr' }, 'TRADITORE') : null),
      ...rows.map(([k, v, cls, title]) => h('div', { class: 'kv' }, h('span', null, k), h('b', { class: cls || undefined, title: title || undefined }, v))),
    );
  }

  private updateAttacks(g: Game): void {
    const me = g.humanId;
    if (!me || !g.players[me].alive) {
      if (this.atkSig !== '') { this.atkSig = ''; this.atkRows.clear(); this.atkEl.replaceChildren(); }
      this.atkEl.classList.add('hidden'); this.alarm.classList.remove('on');
      this.atkOut = this.atkInc = 0;
      this.syncIncoming(g, []);
      return;
    }
    const out = g.attacks.filter(a => a.alive && a.attacker === me);
    const inc = g.attacks.filter(a => a.alive && a.target === me);
    this.atkOut = out.length;
    this.atkInc = inc.length;
    this.alarm.classList.toggle('on', inc.length > 0);
    this.syncIncoming(g, inc);
    // structure (which rows) changes rarely; numbers and bars are patched in place
    const shownOut = out.slice(0, 6), shownInc = inc.slice(0, 6);
    const sig = shownOut.map(a => a.id).join(',') + '|' + shownInc.map(a => a.id).join(',') + `|${out.length}|${inc.length}`;
    if (sig !== this.atkSig) {
      this.atkSig = sig;
      if (!out.length && !inc.length) { this.atkEl.classList.add('hidden'); this.atkRows.clear(); this.atkEl.replaceChildren(); return; }
      this.atkEl.classList.remove('hidden');
      const keep = new Map<number, AtkRow>();
      const kids: HTMLElement[] = [];
      const rowFor = (a: Attack, incoming: boolean): HTMLElement => {
        let r = this.atkRows.get(a.id);
        if (!r) r = this.makeAtkRow(g, a, incoming);
        keep.set(a.id, r);
        return r.el;
      };
      if (out.length) {
        kids.push(h('div', { class: 'ph' }, h('span', null, 'Attacchi'), h('span', { class: 'dim' }, String(out.length))));
        for (const a of shownOut) kids.push(rowFor(a, false));
      }
      if (inc.length) {
        kids.push(h('div', { class: 'ph inc' }, h('span', null, 'Sotto attacco'), h('span', { class: 'dim' }, String(inc.length))));
        for (const a of shownInc) kids.push(rowFor(a, true));
      }
      this.atkRows = keep;
      this.atkEl.replaceChildren(...kids);
    }
    for (const a of [...shownOut, ...shownInc]) {
      const r = this.atkRows.get(a.id);
      if (!r) continue;
      setText(r.troops, fmt(a.troops));
      const w = `${Math.round(Math.max(3, Math.min(100, (a.troops / Math.max(1, a.startTroops)) * 100)))}%`;
      if (w !== r.w) { r.w = w; r.bar.style.width = w; }
    }
  }

  private makeAtkRow(g: Game, a: Attack, incoming: boolean): AtkRow {
    const nameOf = (id: number) => (id ? g.players[id].name : 'Terra libera');
    const colOf = (id: number) => (id ? hexColor(g.players[id].color) : '#7d8a66');
    const troops = h('b'), bar = h('i');
    const other = incoming ? a.attacker : a.target;
    const el = incoming
      ? h('div', { class: 'atk inc' },
        h('span', { class: 'sw', style: `background:${colOf(other)}` }),
        h('span', { class: 'an', onclick: () => this.c.focusPlayer(other) }, nameOf(other)),
        troops,
        h('button', { class: 'btn xs', title: 'Contrattacca con le truppe del cursore', onclick: () => this.act.attack(other) }, 'Contrattacca'),
        h('div', { class: 'ab' }, bar))
      : h('div', { class: 'atk' },
        h('span', { class: 'sw', style: `background:${colOf(other)}` }),
        h('span', { class: 'an', title: nameOf(other), onclick: () => other && this.c.focusPlayer(other) }, nameOf(other)),
        troops,
        h('button', { class: 'btn xs', title: 'Ritira le truppe', onclick: () => this.act.retreat(a.id) }, 'Ritira'),
        h('div', { class: 'ab' }, bar));
    return { el, troops, bar, w: '' };
  }

  // ── phone: incoming-attack alert card ──────────────────────────────────────
  private syncIncoming(g: Game, inc: Attack[]): void {
    for (const id of [...this.incDismissed]) if (!inc.some(a => a.id === id)) this.incDismissed.delete(id);
    const live = this.phone ? inc.filter(a => !this.incDismissed.has(a.id)) : [];
    if (!live.length) {
      if (this.incFrom) { this.incFrom = 0; this.incCard.classList.add('hidden'); }
      return;
    }
    let big = live[0];
    for (const a of live) if (a.troops > big.troops) big = a;
    const from = big.attacker, p = g.players[from];
    if (this.incFrom !== from) {
      this.incFrom = from;
      this.incSw.style.background = p ? hexColor(p.color) : '';
      this.incCard.classList.remove('hidden');
      if (this.reqEl.firstChild !== this.incCard) this.reqEl.prepend(this.incCard);
    }
    setText(this.incName, `${p?.name ?? '?'} ti attacca`);
    const more = live.length > 1 ? ` · +${live.length - 1}` : '';
    setText(this.incTxt, `${fmt(big.troops)} truppe${more}`);
  }

  private dismissIncoming(): void {
    const g = this.game;
    if (g) for (const a of g.attacks) if (a.alive && a.target === g.humanId) this.incDismissed.add(a.id);
    this.incFrom = 0;
    this.incCard.classList.add('hidden');
  }
}
