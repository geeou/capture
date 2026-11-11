// In-match HUD: top bar, attack-ratio slider, leaderboard, player card, event log, alliance requests, attacks.
import type { Game } from '../sim/game';
import { WIN_SHARE, TICKS_PER_SEC, type GameEvent, type Player } from '../sim/types';
import { h, setText } from './dom';
import { clock, fmt, fmtRate, hexColor, KIND_LABEL, pct } from './format';
import type { Actions, Ctl } from './actions';
import { PACT_LABEL } from '../sim/adv/types';
import { advGoldRate, playerSeen, repWord, troopsTxt } from './adv';

interface LogEntry { el: HTMLElement; t: number }

const SPEEDS = [0, 1, 2, 4];

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
  /** Touch-only top-bar buttons (names, fullscreen…), filled by the mobile layer; hidden on desktop by CSS. */
  readonly touchSlot = h('div', { class: 'tb-touch' });
  private stats!: HTMLElement;
  // slider
  private ratioInput!: HTMLInputElement;
  private ratioPct = h('b');
  private ratioAbs = h('span');
  private ratioBox!: HTMLElement;
  /** Head row of the ratio panel (the advanced layer adds its front toggle here). */
  ratioHead!: HTMLElement;
  // leaderboard
  private lbRows: { el: HTMLElement; rank: HTMLElement; sw: HTMLElement; name: HTMLElement; badge: HTMLElement; share: HTMLElement; troops: HTMLElement; id: number }[] = [];
  private lbCount = h('span', { class: 'dim' });
  private lbBody = h('div', { class: 'lb-body' });
  private lbPanel!: HTMLElement;
  // card
  private card = h('div', { class: 'panel pcard hidden' });
  private cardFor = -1;
  // log
  readonly logEl = h('div', { class: 'log' });
  private logs: LogEntry[] = [];
  // requests
  private reqEl = h('div', { class: 'requests' });
  get requestsEl(): HTMLElement { return this.reqEl; }
  private reqs = new Map<number, HTMLElement>();
  // attacks
  private atkEl = h('div', { class: 'panel attacks hidden' });
  get attacksEl(): HTMLElement { return this.atkEl; }
  private alarm = h('div', { class: 'alarm' });
  private atkSig = '';

  hoverPlayer = 0;
  /** Ticks in which a message addressed to the human was logged (the advanced layer avoids duplicating them). */
  readonly msgTicks = new Set<number>();
  /** Owner of the tile under the mouse (set by the app). */
  mapHover = 0;
  private lastTop = 0; private lastLb = 0; private lastAtk = 0; private lastCard = 0; private lastReq = 0;
  private game: Game | null = null;

  constructor(private c: Ctl, private act: Actions, host: HTMLElement) {
    this.root = h('div', { class: 'hud' });
    host.appendChild(this.root);
    this.buildTop();
    this.buildSlider();
    this.buildLeaderboard();
    this.root.append(this.reqEl, this.atkEl, this.logEl, this.alarm);
    // touch: tapping the player card dismisses it (it follows the selection there)
    this.card.addEventListener('click', () => { if (this.touchUI) this.c.selectPlayer(0); });
  }

  // ── construction ───────────────────────────────────────────────────────────
  private buildTop(): void {
    const speed = h('div', { class: 'speed' },
      SPEEDS.map(s => {
        const b = h('button', { class: 'sp', title: s ? `Velocità ${s}× (tasto ${s})` : 'Pausa (Spazio)', onclick: () => this.c.setSpeed(s) },
          s ? `${s}×` : h('span', { class: 'pause-ic' }));
        this.speedBtns.push(b);
        return b;
      }));
    this.stats = h('div', { class: 'stats' },
      h('div', { class: 'stat troops', title: 'Truppe / massimo' },
        h('span', { class: 'lbl' }, 'Truppe'),
        h('div', { class: 'val' }, this.tTroops, this.tCap, this.tTroopRate),
        h('div', { class: 'bar' }, this.tTroopBar)),
      h('div', { class: 'stat gold', title: 'Oro' },
        h('span', { class: 'lbl' }, 'Oro'),
        h('div', { class: 'val' }, this.tGold, this.tGoldRate)),
      h('div', { class: 'stat land', title: `Quota di terre: vince chi arriva all’${WIN_SHARE * 100}%` },
        h('span', { class: 'lbl' }, 'Territorio'),
        h('div', { class: 'val' }, this.tShare, this.tShareLbl),
        h('div', { class: 'bar win' }, this.tShareBar, h('em', { style: `left:${WIN_SHARE * 100}%` }))),
    );
    const top = h('div', { class: 'topbar panel' },
      h('div', { class: 'brand' }, 'CAPTURE'),
      this.tAdv,
      this.tWho,
      this.stats,
      h('div', { class: 'stat time' }, h('span', { class: 'lbl' }, 'Tempo'), h('div', { class: 'val' }, this.tClock)),
      speed,
      this.touchSlot,
      h('div', { class: 'menu-btns' },
        h('button', { class: 'ib', title: 'Come si gioca (?)', onclick: () => this.c.openHelp() }, '?'),
        h('button', { class: 'ib', title: 'Menu (Esc)', onclick: () => this.c.openPause() }, h('span', { class: 'burger' }))),
    );
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
      const row = { el: h('div', { class: 'lb-row' }, rank, sw, h('span', { class: 'nmw' }, name, badge), share, troops), rank, sw, name, badge, share, troops, id: 0 };
      row.el.addEventListener('click', () => { if (row.id) this.c.focusPlayer(row.id); });
      row.el.addEventListener('mouseenter', () => { this.hoverPlayer = row.id; });
      row.el.addEventListener('mouseleave', () => { this.hoverPlayer = 0; });
      this.lbRows.push(row);
      this.lbBody.appendChild(row.el);
    }
    this.lbPanel = h('div', { class: 'panel leaderboard' },
      h('div', { class: 'ph', onclick: () => this.lbPanel.classList.toggle('collapsed') },
        h('span', null, 'Classifica'), this.lbCount, h('span', { class: 'chev' })),
      h('div', { class: 'lb-cols' }, h('span', null, '#'), h('span'), h('span', null, 'Nome'), h('span', null, 'Terre'), h('span', null, 'Truppe')),
      this.lbBody);
    const side = h('div', { class: 'side' }, this.lbPanel, this.card);
    this.root.appendChild(side);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────
  attach(game: Game): void {
    this.game = game;
    this.logEl.textContent = '';
    this.logs = [];
    this.reqEl.textContent = '';
    this.reqs.clear();
    this.cardFor = -1;
    this.atkSig = '';
    this.atkEl.classList.add('hidden');
    this.alarm.classList.remove('on');
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

  syncRatio(): void {
    const v = Math.round(this.c.ratio * 100);
    if (Number(this.ratioInput.value) !== v) this.ratioInput.value = String(v);
    this.ratioInput.style.setProperty('--p', `${v}%`);
    setText(this.ratioPct, `${v}%`);
  }

  syncSpeed(): void {
    this.speedBtns.forEach((b, k) => b.classList.toggle('on', SPEEDS[k] === this.c.speed));
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
    this.logs.push({ el, t: performance.now() });
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

  // ── per-frame update (internally throttled) ────────────────────────────────
  update(now: number, force = false): void {
    const g = this.game;
    if (!g) return;
    if (force || now - this.lastTop > 100) { this.lastTop = now; this.updateTop(g); }
    if (force || now - this.lastLb > 500) { this.lastLb = now; this.updateLeaderboard(g); }
    if (force || now - this.lastAtk > 250) { this.lastAtk = now; this.updateAttacks(g); }
    if (force || now - this.lastCard > 200) { this.lastCard = now; this.updateCard(g); }
    if (force || now - this.lastReq > 400) {
      this.lastReq = now;
      for (const id of [...this.reqs.keys()]) if (!g.allianceRequests.some(r => r.id === id)) this.dropRequest(id);
      // also pick up requests that arrived without an event
      if (g.humanId) for (const r of g.allianceRequests) if (r.to === g.humanId && !this.reqs.has(r.id)) this.addRequest(r.id, r.from);
    }
    // log fading
    for (const l of this.logs) {
      const age = now - l.t;
      const o = age < 9000 ? 1 : Math.max(0, 1 - (age - 9000) / 3000);
      const s = o.toFixed(2);
      if (l.el.style.opacity !== s) l.el.style.opacity = s;
    }
    // expired lines stay in the DOM as history (hidden unless the log is expanded on touch layouts)
    while (this.logs.length && now - this.logs[0].t > 12000) this.logs.shift()!.el.classList.add('old');
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
    this.tWho.style.color = p && !self ? hexColor(p.color) : '';
    if (p) {
      const cap = g.q.maxTroops(p.id);
      setText(this.tTroops, fmt(p.troops));
      setText(this.tCap, cap > 0 ? ` / ${fmt(cap)}` : '');
      setText(this.tTroopRate, `${fmtRate(g.q.troopRate(p.id) * TICKS_PER_SEC)}/s`);
      this.tTroopBar.style.width = `${cap > 0 ? Math.min(100, (p.troops / cap) * 100) : 0}%`;
      setText(this.tGold, fmt(p.gold));
      setText(this.tGoldRate, `${fmtRate((g.adv ? advGoldRate(g, p.id) : g.q.goldRate(p.id)) * TICKS_PER_SEC)}/s`);
      const sh = g.share(p.id);
      setText(this.tShare, pct(sh));
      setText(this.tShareLbl, ` · ${fmt(p.tiles)}`);
      this.tShareBar.style.width = `${Math.min(100, sh * 100)}%`;
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
    if (myRank >= 10) rows.push([myRank + 1, alive[myRank]]);
    for (let k = 0; k < this.lbRows.length; k++) {
      const r = this.lbRows[k];
      const e = rows[k];
      if (!e) { r.el.style.display = 'none'; r.id = 0; continue; }
      r.el.style.display = '';
      const [rank, p] = e;
      r.id = p.id;
      setText(r.rank, String(rank));
      r.sw.style.background = hexColor(p.color);
      setText(r.name, p.name);
      const allied = meId && g.areAllied(meId, p.id);
      const traitor = p.traitorUntil > g.tick;
      setText(r.badge, traitor ? 'TRADITORE' : allied ? 'ALLEATO' : '');
      r.badge.className = `bdg${traitor ? ' tr' : allied ? ' al' : ''}`;
      setText(r.share, pct(g.share(p.id)));
      setText(r.troops, troopsTxt(g, p));
      r.el.classList.toggle('me', p.id === meId);
      r.el.classList.toggle('sel', p.id === this.c.renderer.selected);
      r.el.classList.toggle('gap', k === 10);
    }
  }

  private updateCard(g: Game): void {
    const id = this.touchUI ? this.c.renderer.selected : this.hoverPlayer || this.mapHover || this.c.renderer.selected;
    const p = id ? g.players[id] : null;
    if (!p || !p.alive) {
      if (this.cardFor !== 0) { this.card.classList.add('hidden'); this.cardFor = 0; }
      return;
    }
    this.cardFor = id;
    this.card.classList.remove('hidden');
    const me = g.humanId;
    const rel: HTMLElement[] = [];
    if (me && id !== me && g.players[me].alive) {
      const r = Math.round(g.q.relation(id, me));
      const word = r > 50 ? 'Amichevole' : r > 15 ? 'Cordiale' : r >= -15 ? 'Neutrale' : r >= -50 ? 'Ostile' : 'Nemico giurato';
      const allied = g.areAllied(me, id);
      const pending = g.allianceRequests.some(q => (q.from === me && q.to === id) || (q.from === id && q.to === me));
      rel.push(
        h('div', { class: 'kv' }, h('span', null, 'Verso di te'), h('b', { class: r > 15 ? 'pos' : r < -15 ? 'neg' : '' }, `${word} (${r > 0 ? '+' : ''}${r})`)),
        h('div', { class: 'kv' }, h('span', null, 'Alleanza'), h('b', { class: allied ? 'pos' : '' }, allied ? 'Alleati' : pending ? 'Proposta in attesa' : 'Nessuna')),
      );
      if (g.players[me].embargoes.has(id) || p.embargoes.has(me)) rel.push(h('div', { class: 'kv' }, h('span', null, 'Commercio'), h('b', { class: 'neg' }, 'Embargo')));
    }
    const traitor = p.traitorUntil > g.tick;
    const seen = playerSeen(g, id);
    const atk = seen ? g.attacks.filter(a => a.alive && a.attacker === id).length : 0;
    const adv = g.adv;
    if (adv) {
      const r = Math.round(adv.players[id]?.reputation ?? 0);
      rel.push(h('div', { class: 'kv' }, h('span', null, 'Reputazione'), h('b', { class: r >= 10 ? 'pos' : r <= -10 ? 'neg' : '' }, `${repWord(r)} (${r > 0 ? '+' : ''}${r})`)));
      if (me && id !== me) {
        for (const pk of adv.pacts) {
          if (!((pk.a === me && pk.b === id) || (pk.a === id && pk.b === me))) continue;
          const left = pk.untilTick > 0 ? ` · ${clock(Math.max(0, pk.untilTick - g.tick))}` : '';
          const role = pk.kind === 'tribute' ? (pk.a === me ? ' (tuo vassallo)' : ' (tuo signore)') : '';
          rel.push(h('div', { class: 'kv' }, h('span', null, 'Patto'), h('b', { class: 'pos' }, `${PACT_LABEL[pk.kind]}${role}${left}`)));
        }
      }
    }
    this.card.replaceChildren(
      h('div', { class: 'pc-head' },
        h('span', { class: 'sw big', style: `background:${hexColor(p.color)}` }),
        h('div', null, h('b', null, p.name), h('small', null, KIND_LABEL[p.kind] + (id === me ? ' · tu' : ''))),
        traitor ? h('span', { class: 'bdg tr' }, 'TRADITORE') : null),
      h('div', { class: 'kv' }, h('span', null, 'Terre'), h('b', null, `${fmt(p.tiles)} · ${pct(g.share(id))}`)),
      h('div', { class: 'kv' }, h('span', null, 'Truppe'), h('b', { title: seen ? '' : 'Fuori dalla tua vista' }, troopsTxt(g, p))),
      h('div', { class: 'kv' }, h('span', null, 'Oro'), h('b', null, fmt(p.gold))),
      h('div', { class: 'kv' }, h('span', null, 'Alleati'), h('b', null, String(p.allies.size))),
      ...(atk ? [h('div', { class: 'kv' }, h('span', null, 'Attacchi in corso'), h('b', null, String(atk)))] : []),
      ...rel,
    );
  }

  private updateAttacks(g: Game): void {
    const me = g.humanId;
    if (!me || !g.players[me].alive) { this.atkEl.classList.add('hidden'); this.alarm.classList.remove('on'); return; }
    const out = g.attacks.filter(a => a.alive && a.attacker === me);
    const inc = g.attacks.filter(a => a.alive && a.target === me);
    const sig = out.map(a => `${a.id}:${Math.round(a.troops)}`).join(',') + '|' + inc.map(a => `${a.id}:${Math.round(a.troops)}`).join(',');
    this.alarm.classList.toggle('on', inc.length > 0);
    if (sig === this.atkSig) return;
    this.atkSig = sig;
    if (!out.length && !inc.length) { this.atkEl.classList.add('hidden'); return; }
    this.atkEl.classList.remove('hidden');
    const nameOf = (id: number) => (id ? g.players[id].name : 'Terra libera');
    const colOf = (id: number) => (id ? hexColor(g.players[id].color) : '#7d8a66');
    const bar = (a: { troops: number; startTroops: number }) =>
      h('div', { class: 'ab' }, h('i', { style: `width:${Math.max(3, Math.min(100, (a.troops / Math.max(1, a.startTroops)) * 100))}%` }));
    const kids: HTMLElement[] = [];
    if (out.length) {
      kids.push(h('div', { class: 'ph' }, h('span', null, 'Attacchi'), h('span', { class: 'dim' }, String(out.length))));
      for (const a of out.slice(0, 6)) {
        kids.push(h('div', { class: 'atk' },
          h('span', { class: 'sw', style: `background:${colOf(a.target)}` }),
          h('span', { class: 'an', title: nameOf(a.target), onclick: () => a.target && this.c.focusPlayer(a.target) }, nameOf(a.target)),
          h('b', null, fmt(a.troops)),
          h('button', { class: 'btn xs', title: 'Ritira le truppe', onclick: () => this.act.retreat(a.id) }, 'Ritira'),
          bar(a)));
      }
    }
    if (inc.length) {
      kids.push(h('div', { class: 'ph inc' }, h('span', null, 'Sotto attacco'), h('span', { class: 'dim' }, String(inc.length))));
      for (const a of inc.slice(0, 6)) {
        kids.push(h('div', { class: 'atk inc' },
          h('span', { class: 'sw', style: `background:${colOf(a.attacker)}` }),
          h('span', { class: 'an', onclick: () => this.c.focusPlayer(a.attacker) }, nameOf(a.attacker)),
          h('b', null, fmt(a.troops)),
          h('button', { class: 'btn xs', title: 'Contrattacca con le truppe del cursore', onclick: () => this.act.attack(a.attacker) }, 'Contrattacca'),
          bar(a)));
      }
    }
    this.atkEl.replaceChildren(...kids);
  }
}
