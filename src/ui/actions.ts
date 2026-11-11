// Player actions: everything the human does goes through game.cmd, with Italian feedback on refusal.
import type { Game } from '../sim/game';
import type { NukeKind, Player, StructureType, Tile } from '../sim/types';
import type { Renderer } from '../render/renderer';
import { STRUCTURE_LABEL } from '../render/icons';
import { rgbCss } from '../render/colors';
import { toast } from './dom';
import { fmt } from './format';

/** What the UI modules need from the app shell. */
export interface Ctl {
  game: Game;
  renderer: Renderer;
  /** Attack ratio 0.01..1 */
  ratio: number;
  speed: number;
  setSpeed(n: number): void;
  setRatio(r: number): void;
  /** The human player if alive, else null. */
  me(): Player | null;
  selectPlayer(id: number): void;
  focusPlayer(id: number): void;
  jumpTo(x: number, y: number): void;
  openHelp(): void;
  openPause(): void;
  newGame(): void;
}

export class Actions {
  private stamp: Uint32Array | null = null;
  private gen = 1;
  private queue: Int32Array | null = null;

  constructor(private c: Ctl) {}

  get game(): Game { return this.c.game; }

  troops(): number {
    const me = this.c.me();
    return me ? Math.floor(me.troops * this.c.ratio) : 0;
  }

  /** Can the human reach `tile` over land (shared border with its owner / its unclaimed region)? */
  landReachable(tile: Tile): boolean {
    const g = this.game, me = this.c.me();
    if (!me) return false;
    const o = g.owner[tile];
    if (o !== 0) return g.sharesBorder(me.id, o);
    if (!g.sharesBorder(me.id, 0)) return false;
    // flood the unclaimed land region containing `tile`, looking for a tile of ours next to it
    if (!this.stamp || this.stamp.length !== g.N) { this.stamp = new Uint32Array(g.N); this.queue = new Int32Array(g.N); this.gen = 1; }
    const st = this.stamp, q = this.queue!, gen = ++this.gen;
    const W = g.W, N = g.N, ow = g.owner, ter = g.terrain, mine = me.id;
    let qh = 0, qt = 0;
    q[qt++] = tile; st[tile] = gen;
    const CAP = 250_000;
    while (qh < qt) {
      const i = q[qh++];
      const x = i % W;
      const nb0 = x > 0 ? i - 1 : -1, nb1 = x < W - 1 ? i + 1 : -1, nb2 = i >= W ? i - W : -1, nb3 = i < N - W ? i + W : -1;
      for (const n of [nb0, nb1, nb2, nb3]) {
        if (n < 0 || ter[n] === 0) continue;
        if (ow[n] === mine) return true;
        if (ow[n] !== 0 || st[n] === gen) continue;
        st[n] = gen;
        q[qt++] = n;
      }
      if (qt > CAP) return true; // huge region: assume connected
    }
    return false;
  }

  private feedback(tile: Tile, ok: boolean): void {
    const g = this.game;
    const me = this.c.me();
    if (ok && me) this.c.renderer.fx.splash(g.xOf(tile), g.yOf(tile), performance.now(), rgbCss(me.color));
  }

  /** Left click: attack / expand / boat with the slider's troops. */
  primary(tile: Tile): void {
    const g = this.game, me = this.c.me();
    if (tile < 0) return;
    const o = g.owner[tile];
    if (!me) { if (o) this.c.selectPlayer(o); return; }
    if (g.isWater(tile)) { this.c.selectPlayer(0); return; }
    if (o === me.id) { this.c.selectPlayer(me.id); return; }
    if (o && g.areAllied(me.id, o)) { toast(`${g.players[o].name} è tuo alleato: non puoi attaccarlo`); return; }
    const troops = this.troops();
    if (troops < 1) { toast('Truppe insufficienti'); return; }
    if (this.landReachable(tile)) {
      const ok = g.cmd.attack(me.id, o, troops);
      if (!ok) toast(o ? `Impossibile attaccare ${g.players[o].name}` : 'Impossibile espandersi qui');
      this.feedback(tile, ok);
    } else this.boat(tile);
  }

  boat(tile: Tile): void {
    const g = this.game, me = this.c.me();
    if (!me || tile < 0) return;
    const troops = this.troops();
    const reason = g.q.canBoat(me.id, tile);
    if (reason) { toast(reason); return; }
    if (troops < 1) { toast('Truppe insufficienti'); return; }
    const ok = g.cmd.sendBoat(me.id, tile, troops);
    if (!ok) toast('Sbarco non possibile');
    else toast(`Nave salpata con ${fmt(troops)} truppe`, 'info');
    this.feedback(tile, ok);
  }

  attack(target: number): void {
    const g = this.game, me = this.c.me();
    if (!me) return;
    if (target && g.areAllied(me.id, target)) { toast('Siete alleati: rompi prima l’alleanza'); return; }
    const troops = this.troops();
    if (troops < 1) { toast('Truppe insufficienti'); return; }
    if (!g.sharesBorder(me.id, target)) { toast('Nessun confine via terra: usa una nave'); return; }
    if (!g.cmd.attack(me.id, target, troops)) toast('Attacco non possibile');
  }

  build(type: StructureType, tile: Tile): boolean {
    const g = this.game, me = this.c.me();
    if (!me || tile < 0) return false;
    const reason = g.q.canBuild(me.id, type, tile);
    if (reason) { toast(reason); return false; }
    const ok = g.cmd.build(me.id, type, tile);
    if (!ok) toast('Costruzione non riuscita');
    else toast(`${STRUCTURE_LABEL[type]} in costruzione`, 'good');
    this.feedback(tile, ok);
    return ok;
  }

  nuke(kind: NukeKind, tile: Tile): boolean {
    const g = this.game, me = this.c.me();
    if (!me || tile < 0) return false;
    const reason = g.q.canNuke(me.id, kind, tile);
    if (reason) { toast(reason); return false; }
    const ok = g.cmd.launchNuke(me.id, kind, tile);
    if (!ok) toast('Lancio non riuscito');
    return ok;
  }

  propose(other: number): void {
    const g = this.game, me = this.c.me();
    if (!me) return;
    if (g.cmd.proposeAlliance(me.id, other)) toast(`Proposta inviata a ${g.players[other].name}`, 'info');
    else toast('Proposta non possibile ora');
  }

  breakAlliance(other: number): void {
    const g = this.game, me = this.c.me();
    if (!me) return;
    if (g.cmd.breakAlliance(me.id, other)) toast(`Alleanza con ${g.players[other].name} rotta`, 'danger');
    else toast('Impossibile rompere l’alleanza');
  }

  embargo(other: number, on: boolean): void {
    const g = this.game, me = this.c.me();
    if (!me) return;
    if (g.cmd.setEmbargo(me.id, other, on)) toast(on ? `Embargo contro ${g.players[other].name}` : 'Embargo revocato', 'info');
    else toast('Embargo non disponibile');
  }

  donate(other: number, kind: 'troops' | 'gold'): void {
    const g = this.game, me = this.c.me();
    if (!me) return;
    const amount = Math.floor((kind === 'troops' ? me.troops : me.gold) * this.c.ratio);
    if (amount < 1) { toast(kind === 'troops' ? 'Truppe insufficienti' : 'Oro insufficiente'); return; }
    if (g.cmd.donate(me.id, other, kind, amount)) toast(`Donati ${fmt(amount)} ${kind === 'troops' ? 'truppe' : 'oro'} a ${g.players[other].name}`, 'good');
    else toast('Donazione non possibile');
  }

  retreat(attackId: number): void {
    if (!this.game.cmd.retreat(attackId)) toast('Ritirata non possibile');
  }

  respond(requestId: number, accept: boolean): void {
    if (!this.game.cmd.respondAlliance(requestId, accept)) toast('Richiesta non più valida');
  }
}
