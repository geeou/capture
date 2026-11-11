// Right-click / long-press context menu for a tile.
import { STRUCTURE_TYPES, type NukeKind, type StructureType, type Tile } from '../sim/types';
import { STRUCTURE_HINT, STRUCTURE_KEY, STRUCTURE_LABEL, glyphURL } from '../render/icons';
import { hexColor, fmt, KIND_LABEL } from './format';
import { h } from './dom';
import { safeInsets } from './safearea';
import type { Actions, Ctl } from './actions';

export class ContextMenu {
  private el: HTMLElement | null = null;
  private openedAt = 0;
  private anchor: [number, number] = [0, 0];
  /** Pointer that dismissed the menu and is still down (its release must not act on the map either). */
  private closingPointer: number | null = null;
  private closedStamp = 0;
  private onDown = (e: PointerEvent) => {
    if (this.el && !this.el.contains(e.target as Node)) {
      this.closedStamp = performance.now();
      this.closingPointer = e.pointerId;
      window.addEventListener('pointerup', this.onUpAfterClose, true);
      window.addEventListener('pointercancel', this.onUpAfterClose, true);
      this.close();
    }
  };
  private onUpAfterClose = (e: PointerEvent) => {
    if (e.pointerId !== this.closingPointer) return;
    this.closingPointer = null;
    this.closedStamp = performance.now();
    window.removeEventListener('pointerup', this.onUpAfterClose, true);
    window.removeEventListener('pointercancel', this.onUpAfterClose, true);
  };
  /** Swallow the synthetic click a finger lift can produce right after a long-press opened the menu. */
  private guardClick = (e: Event) => {
    if (document.body.classList.contains('touch-ui') && performance.now() - this.openedAt < 380) { e.stopPropagation(); e.preventDefault(); }
  };
  /** Time the menu was dismissed by an outside press (so that press does not also act on the map).
   *  While the dismissing pointer is still down this reads as "now". */
  get closedAt(): number { return this.closingPointer !== null ? performance.now() : this.closedStamp; }

  constructor(private c: Ctl, private act: Actions, private host: HTMLElement) {}

  get open(): boolean { return this.el !== null; }

  close(): void {
    if (!this.el) return;
    const el = this.el;
    this.el = null;
    el.classList.add('out');
    setTimeout(() => el.remove(), 120);
    window.removeEventListener('pointerdown', this.onDown, true);
  }

  show(tile: Tile, sx: number, sy: number): void {
    this.close();
    const g = this.c.game;
    if (tile < 0) return;
    const me = this.c.me();
    const o = g.owner[tile];
    const land = g.isLand(tile);
    const owner = o ? g.players[o] : null;
    const troops = this.act.troops();

    const items: HTMLElement[] = [];
    const run = (fn: () => void) => () => { this.close(); fn(); };
    const row = (icon: string, label: string, opts: { hint?: string; key?: string; reason?: string | null; danger?: boolean; onClick?: () => void; sub?: boolean } = {}) => {
      const dis = !!opts.reason;
      const b = h('button', {
        class: `cm-row${dis ? ' dis' : ''}${opts.danger ? ' danger' : ''}${opts.sub ? ' sub' : ''}`,
        title: opts.reason ?? '',
        onclick: dis || !opts.onClick ? undefined : opts.onClick,
      },
        h('span', { class: 'cm-ic' }, icon),
        h('span', { class: 'cm-lb' }, label, opts.reason ? h('small', { class: 'cm-why' }, opts.reason) : opts.hint ? h('small', null, opts.hint) : null),
        opts.key ? h('kbd', null, opts.key) : null,
      );
      if (dis) b.setAttribute('aria-disabled', 'true');
      items.push(b);
      return b;
    };

    // header
    const head = h('div', { class: 'cm-head' },
      h('span', { class: 'cm-sw', style: `background:${owner ? hexColor(owner.color) : land ? '#7d8a66' : '#1d4a6b'}` }),
      h('div', null,
        h('b', null, owner ? owner.name : land ? 'Terra libera' : 'Mare aperto'),
        h('small', null, owner ? `${KIND_LABEL[owner.kind]} · ${fmt(owner.tiles)} terre · ${fmt(owner.troops)} truppe` : `${g.xOf(tile)}, ${g.yOf(tile)}`),
      ),
    );

    if (me && land && o !== me.id) {
      const allied = !!o && g.areAllied(me.id, o);
      const byLand = !allied && this.act.landReachable(tile);
      row('⚔', `Attacca${troops ? ' · ' + fmt(troops) : ''}`, {
        reason: allied ? 'Siete alleati' : !byLand ? 'Nessun confine via terra' : troops < 1 ? 'Truppe insufficienti' : null,
        hint: o ? 'Truppe dal cursore in basso' : 'Espanditi nella terra libera', key: 'Clic',
        onClick: run(() => this.act.primary(tile)),
      });
      const br = allied ? 'Siete alleati' : g.q.canBoat(me.id, tile);
      row('⛵', 'Invia nave', { reason: br, hint: `${fmt(troops)} truppe via mare`, key: 'V', onClick: run(() => this.act.boat(tile)) });
    }

    if (me && land && o === me.id) {
      const sub = h('div', { class: 'cm-build' },
        STRUCTURE_TYPES.map((t: StructureType) => {
          const cost = g.q.buildCost(me.id, t);
          const reason = g.q.canBuild(me.id, t, tile);
          const afford = isFinite(cost) && me.gold >= cost;
          return h('button', {
            class: `cm-bt${reason ? ' dis' : ''}`,
            title: reason ?? STRUCTURE_HINT[t],
            onclick: reason ? undefined : run(() => this.act.build(t, tile)),
          },
            h('img', { src: glyphURL(t), alt: '' }),
            h('span', { class: 'cm-bt-n' }, STRUCTURE_LABEL[t].replace(' missilistico', '').replace('Antiaerea (SAM)', 'SAM')),
            h('span', { class: `cm-bt-p${afford ? '' : ' no'}` }, isFinite(cost) ? fmt(cost) : '—'),
            h('kbd', null, STRUCTURE_KEY[t]),
            reason ? h('span', { class: 'cm-bt-r' }, reason) : null,
          );
        }));
      const r = row('▦', 'Costruisci', { hint: 'Strutture su questa casella', sub: true });
      r.appendChild(h('span', { class: 'cm-arrow' }, '▸'));
      r.appendChild(sub);
      r.addEventListener('click', e => { if (!(e.target as HTMLElement).closest('.cm-build')) { r.classList.toggle('opened'); this.place(); } });
    }

    if (me && land) {
      const nk = (kind: NukeKind, label: string, key: string) => {
        const cost = g.q.nukeCost(me.id, kind);
        const reason = (o && g.areAllied(me.id, o)) ? 'Bersaglio alleato' : g.q.canNuke(me.id, kind, tile);
        row(kind === 'atom' ? '☢' : '✹', label, {
          reason, hint: isFinite(cost) ? `${fmt(cost)} oro · raggio ${g.q.nukeRadius(kind)}` : undefined, key, danger: true,
          onClick: run(() => this.act.nuke(kind, tile)),
        });
      };
      nk('atom', 'Lancia atomica', 'N');
      nk('hydrogen', 'Lancia bomba H', 'H');
    }

    if (owner && me && o !== me.id) {
      items.push(h('div', { class: 'cm-sep' }));
      const allied = g.areAllied(me.id, o);
      const pending = g.allianceRequests.some(r => r.from === me.id && r.to === o);
      if (allied) row('✕', 'Rompi alleanza', { hint: 'Diventerai un traditore', danger: true, onClick: run(() => this.act.breakAlliance(o)) });
      else row('⚭', pending ? 'Proposta in attesa' : 'Proponi alleanza', { reason: pending ? 'Già inviata' : null, onClick: run(() => this.act.propose(o)) });
      const emb = me.embargoes.has(o);
      row('⛔', emb ? 'Revoca embargo' : 'Embargo', { hint: emb ? 'Riprendi il commercio' : 'Blocca il commercio', onClick: run(() => this.act.embargo(o, !emb)) });
      const tr = Math.floor(me.troops * this.c.ratio), gd = Math.floor(me.gold * this.c.ratio);
      row('⇢', `Dona truppe · ${fmt(tr)}`, { hint: 'Quota dal cursore in basso', onClick: run(() => this.act.donate(o, 'troops')) });
      row('◎', `Dona oro · ${fmt(gd)}`, { hint: 'Quota dal cursore in basso', onClick: run(() => this.act.donate(o, 'gold')) });
    }
    if (owner) row('ⓘ', 'Info', { hint: 'Mostra la scheda', onClick: run(() => this.c.selectPlayer(o)) });
    if (!items.length) row('·', 'Nessuna azione qui', { reason: me ? null : 'Modalità spettatore' });

    const el = h('div', { class: 'ctxmenu' }, head, h('div', { class: 'cm-list' }, items));
    el.addEventListener('click', this.guardClick, true);
    this.host.appendChild(el);
    this.el = el;
    this.anchor = [sx, sy];
    this.openedAt = performance.now();
    this.place();
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => window.addEventListener('pointerdown', this.onDown, true), 0);
  }

  /** Keep the menu inside the visible (safe-area) viewport; it scrolls when taller than the screen. */
  private place(): void {
    const el = this.el;
    if (!el) return;
    const [sx, sy] = this.anchor;
    const ins = safeInsets();
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = 8 + ins.l, right = vw - 8 - ins.r, top = 8 + ins.t, bottom = vh - 8 - ins.b;
    el.style.maxHeight = Math.max(120, bottom - top) + 'px';
    const r = el.getBoundingClientRect();
    // touch: open beside the finger instead of under it
    const gap = document.body.classList.contains('touch-ui') ? 22 : 6;
    let x = sx + gap, y = sy + 6;
    if (x + r.width > right) x = sx - r.width - gap;
    x = Math.max(left, Math.min(x, right - r.width));
    if (y + r.height > bottom) y = bottom - r.height;
    y = Math.max(top, y);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.classList.toggle('flip', x + r.width + 260 > vw);
  }
}
