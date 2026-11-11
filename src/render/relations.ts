// Relation of every player to the human (me / ally / enemy / neutral / tribe), used for skin colouring.
//
// Enemy rule (cheap, stable, no flicker): a nation is ENEMY while an attack is active between it and the
// human in either direction, or a nuke was launched between them, and for WAR_TICKS (30 s) after the
// last such contact. Tribes only turn ENEMY when they attack the human (the human eats tribes all game
// long, that is not a war). Allies are never enemies; forming an alliance clears the war memory.
// No human, or a dead human (spectating), means no relations: nations use their per-nation colours.
// Advanced mode: a pact partner of the human (nap / truce / tribute, adv.q.pact) is never coloured as an enemy,
// and forming a pact clears the war memory like an alliance does.
import type { Game } from '../sim/game';
import { R_ALLY, R_ENEMY, R_ME, R_NEUTRAL, R_NONE, R_TRIBE } from './skins';

const WAR_TICKS = 300;
const RECHECK_TICKS = 5;

export class Relations {
  rel = new Uint8Array(0);
  private warUntil = new Int32Array(0);
  private lastTick = -1e9;
  private dirty = true;

  constructor(private game: Game) {
    this.ensure();
    game.on(ev => {
      const me = game.humanId;
      switch (ev.type) {
        case 'attackStarted':
          if (me && (ev.attack.attacker === me || ev.attack.target === me)) this.dirty = true;
          break;
        case 'allianceFormed':
          if (ev.a === me || ev.b === me) { this.ensure(); this.warUntil[ev.a === me ? ev.b : ev.a] = 0; this.dirty = true; }
          break;
        case 'allianceBroken':
          if (ev.by === me || ev.other === me) this.dirty = true;
          break;
        case 'nukeLaunched': {
          if (!me) break;
          const tgt = game.owner[ev.unit.toTile];
          this.ensure();
          if (ev.unit.owner === me && tgt && tgt !== me) { this.warUntil[tgt] = game.tick + WAR_TICKS; this.dirty = true; }
          else if (tgt === me && ev.unit.owner !== me) { this.warUntil[ev.unit.owner] = game.tick + WAR_TICKS; this.dirty = true; }
          break;
        }
        case 'playerDied':
          this.dirty = true;
          break;
        case 'pactFormed':
          if (ev.pact.a === me || ev.pact.b === me) { this.ensure(); this.warUntil[ev.pact.a === me ? ev.pact.b : ev.pact.a] = 0; this.dirty = true; }
          break;
        case 'pactEnded':
          if (ev.pact.a === me || ev.pact.b === me) this.dirty = true;
          break;
      }
    });
  }

  private ensure(): void {
    const n = this.game.players.length;
    if (this.rel.length >= n) return;
    const r = new Uint8Array(n + 16), w = new Int32Array(n + 16);
    r.set(this.rel); w.set(this.warUntil);
    this.rel = r; this.warUntil = w;
  }

  /** Recompute (throttled). Returns ids whose relation changed, or null when nothing changed. */
  update(force = false): number[] | null {
    const g = this.game;
    if (!force && !this.dirty && g.tick - this.lastTick < RECHECK_TICKS && g.tick >= this.lastTick) return null;
    this.dirty = false;
    this.lastTick = g.tick;
    this.ensure();
    const ps = g.players;
    const human = g.humanId ? ps[g.humanId] : null;
    const me = human && human.alive ? human.id : 0;
    if (me) {
      for (const a of g.attacks) {
        if (!a.alive) continue;
        if (a.attacker === me && a.target && ps[a.target].kind !== 'tribe') this.warUntil[a.target] = g.tick + WAR_TICKS;
        else if (a.target === me && a.attacker) this.warUntil[a.attacker] = g.tick + WAR_TICKS;
      }
    }
    let changed: number[] | null = null;
    const adv = g.advanced ? g.adv : null;
    for (let id = 1; id < ps.length; id++) {
      const p = ps[id];
      let r: number;
      if (!p.alive) r = R_NONE;
      else if (!me) r = p.kind === 'tribe' ? R_TRIBE : R_NEUTRAL;
      else if (id === me) r = R_ME;
      else if (human!.allies.has(id)) r = R_ALLY;
      else if (this.warUntil[id] > g.tick && !(adv && adv.q.pact(me, id))) r = R_ENEMY;
      else r = p.kind === 'tribe' ? R_TRIBE : R_NEUTRAL;
      if (this.rel[id] !== r) {
        // tiles of a dead player are already gone: no repaint needed
        const wasDrawn = this.rel[id] !== R_NONE || r !== R_NONE;
        this.rel[id] = r;
        if (wasDrawn) (changed ??= []).push(id);
      }
    }
    return changed;
  }
}
