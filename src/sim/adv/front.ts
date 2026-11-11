// ADVANCED MODE — fronts: focused attacks and stance. See docs/ADVANCED.md §1. Owner: LAND agent.
//
// Focused attack: attacks.ts keeps one attack per (attacker, target); `attack.ext.focus = {x, y}` marks it as
// focused. This module restricts its frontier through hook attackTileCost (Infinity outside focusRadius) and
// boosts it through attackMul (focusBonus, focusBonusBlitz with Blitz III). attacks.ts rebuilds the frontier
// whenever the focus is set, moved or cleared (classic cmd.attack clears it).
// Stance: attackMul ×stance.atk on every attack of the player, defenseMul ×stance.def on every owned tile.
// Doctrines applied here: Blitz I (attack ×blitzAttack), Blitz III (focus bonus, stance cooldown halved),
// Fortress I (defence ×fortressDefense).
import type { Game } from '../game';
import { WATER, type Attack, type GameOptions, type PlayerId, type Tile } from '../types';
import { ADV, doctrineLevel } from './rules';
import { STANCES, type Stance } from './types';

const MIN_TROOPS = 10; // = ATK.minTroops in attacks.ts

interface AttacksApi {
  launch(attacker: PlayerId, target: PlayerId, troops: number, focus: { x: number; y: number } | null): boolean;
  attackOf(attacker: PlayerId, target: PlayerId): Attack | null;
}

export function installFront(game: Game, _opts: GameOptions): void {
  const adv = game.adv!;
  const W = game.W, H = game.H, N = game.N, owner = game.owner, terrain = game.terrain;
  const R = ADV.focusRadius, R2 = R * R;
  const api = game.ext.attacks as AttacksApi;

  const touches = (t: number, who: PlayerId): boolean => {
    const x = t % W;
    return (x > 0 && owner[t - 1] === who) || (x < W - 1 && owner[t + 1] === who) ||
      (t >= W && owner[t - W] === who) || (t < N - W && owner[t + W] === who);
  };

  /** True if `attacker` touches a land tile of `target` within the focus radius of (fx, fy). */
  const borderNear = (attacker: PlayerId, target: PlayerId, fx: number, fy: number): boolean => {
    const y0 = Math.max(0, fy - R), y1 = Math.min(H - 1, fy + R);
    for (let y = y0; y <= y1; y++) {
      const dy = y - fy, rem = R2 - dy * dy;
      const dx = Math.floor(Math.sqrt(rem));
      const x0 = Math.max(0, fx - dx), x1 = Math.min(W - 1, fx + dx);
      for (let x = x0, t = y * W + x0; x <= x1; x++, t++) {
        if (owner[t] === target && terrain[t] !== WATER && touches(t, attacker)) return true;
      }
    }
    return false;
  };

  const canAttackAt = (attacker: PlayerId, tile: Tile): string | null => {
    const A = game.players[attacker];
    if (!A || !A.alive) return 'Giocatore eliminato';
    if (!Number.isInteger(tile) || tile < 0 || tile >= N || terrain[tile] === WATER) return 'Non è terra';
    const target = owner[tile];
    if (target === attacker) return 'È già tuo';
    if (target) {
      const T = game.players[target];
      if (!T || !T.alive) return 'Bersaglio non valido';
      if (game.areAllied(attacker, target)) return 'Siete alleati';
      const why = game.hwhy(game.hooks.forbidAttack, attacker, target);
      if (why) return why;
    }
    if (A.troops < MIN_TROOPS) return 'Truppe insufficienti';
    if (!borderNear(attacker, target, tile % W, (tile / W) | 0)) return 'Nessun confine vicino';
    return null;
  };

  adv.q.canAttackAt = canAttackAt;
  adv.cmd.attackAt = (attacker, tile, troops) => {
    if (canAttackAt(attacker, tile) !== null) return false;
    return api.launch(attacker, owner[tile], troops, { x: tile % W, y: (tile / W) | 0 });
  };

  adv.cmd.setStance = (p, stance: Stance) => {
    const P = game.players[p], ap = adv.players[p];
    if (!P || !P.alive || !ap || !STANCES.includes(stance)) return false;
    if (ap.stance === stance || game.tick < ap.stanceReadyTick) return false;
    const cd = doctrineLevel(game, p, 'blitz') >= 3 ? ADV.stanceCooldown / 2 : ADV.stanceCooldown;
    ap.stance = stance;
    ap.stanceReadyTick = game.tick + cd;
    return true;
  };

  // ── hooks ────────────────────────────────────────────────────────────────
  game.hooks.attackTileCost.push((a, t) => {
    const f = a.ext.focus as { x: number; y: number } | undefined;
    if (!f) return 0;
    const dx = t % W - f.x, dy = ((t / W) | 0) - f.y;
    return dx * dx + dy * dy > R2 ? Infinity : 0;
  });
  game.hooks.attackMul.push((a) => {
    const p = a.attacker, ap = adv.players[p];
    let m = ap ? ADV.stance[ap.stance].atk : 1;
    const blitz = doctrineLevel(game, p, 'blitz');
    if (blitz >= 1) m *= ADV.blitzAttack;
    if (a.ext.focus) m *= blitz >= 3 ? ADV.focusBonusBlitz : ADV.focusBonus;
    return m;
  });
  game.hooks.defenseMul.push((_t, o) => {
    if (!o) return 1;
    const ap = adv.players[o];
    let m = ap ? ADV.stance[ap.stance].def : 1;
    if (doctrineLevel(game, o, 'fortress') >= 1) m *= ADV.fortressDefense;
    return m;
  });
}
