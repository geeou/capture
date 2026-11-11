// ADVANCED MODE — doctrines (research). See docs/ADVANCED.md §6. Owner: SEA agent.
// Applies through hooks the effects assigned to this module: Fortress II (fort radius, troop cap),
// Projection I (boat speed and capacity), Projection III (nuke cost, SAM odds). The other effects are applied
// by the module owning the affected system, which reads doctrineLevel().
import type { Game } from '../game';
import type { GameOptions, PlayerId } from '../types';
import { ADV, doctrineLevel } from './rules';
import { DOCTRINE_BRANCHES, DOCTRINE_LABEL, type DoctrineBranch } from './types';

const ROMAN = ['', 'I', 'II', 'III'];

export function installDoctrine(game: Game, _opts: GameOptions): void {
  const adv = game.adv!;
  /** Players with a research in progress. */
  const active = new Set<PlayerId>();
  const valid = (b: string): b is DoctrineBranch => (DOCTRINE_BRANCHES as string[]).includes(b);

  function doctrineCost(p: PlayerId, branch: DoctrineBranch): number {
    const ap = adv.players[p];
    if (!ap || !valid(branch)) return Infinity;
    const lv = ap.doctrine.level[branch];
    if (lv >= 3) return Infinity;
    let others = 0;
    for (const b of DOCTRINE_BRANCHES) if (b !== branch) others += ap.doctrine.level[b];
    return Math.round(ADV.doctrineCost[lv] * (1 + ADV.doctrineCrossPenalty * others));
  }

  function canResearch(p: PlayerId, branch: DoctrineBranch): string | null {
    const pl = game.players[p], ap = adv.players[p];
    if (!pl || !pl.alive || !ap) return 'Non sei in gioco';
    if (!valid(branch)) return 'Dottrina sconosciuta';
    if (ap.doctrine.researching) return 'Ricerca già in corso';
    if (ap.doctrine.level[branch] >= 3) return 'Livello massimo';
    if (pl.gold < doctrineCost(p, branch)) return 'Oro insufficiente';
    return null;
  }

  function research(p: PlayerId, branch: DoctrineBranch): boolean {
    if (canResearch(p, branch) !== null) return false;
    const pl = game.players[p], d = adv.players[p].doctrine;
    pl.gold -= doctrineCost(p, branch);
    d.researching = branch;
    d.startTick = game.tick;
    d.doneTick = game.tick + ADV.doctrineTicks[d.level[branch]];
    active.add(p);
    return true;
  }

  game.systems.push({
    name: 'adv.doctrine',
    tick() {
      // pick up research started by someone else writing the state directly (e.g. a scenario)
      if (game.tick % 20 === 0) {
        for (let p = 1; p < adv.players.length; p++) if (adv.players[p].doctrine.researching) active.add(p);
      }
      if (!active.size) return;
      for (const p of active) {
        const d = adv.players[p].doctrine;
        if (!game.players[p].alive || !d.researching) { d.researching = null; active.delete(p); continue; }
        if (game.tick < d.doneTick) continue;
        const branch = d.researching;
        d.level[branch] = Math.min(3, d.level[branch] + 1);
        d.researching = null;
        active.delete(p);
        game.emit({ type: 'doctrineDone', player: p, branch, level: d.level[branch] });
        game.msg(`📜 Dottrina completata: ${DOCTRINE_LABEL[branch]} ${ROMAN[d.level[branch]]}`, 'good', p);
      }
    },
  });
  game.on(ev => {
    if (ev.type === 'playerDied') {
      const d = adv.players[ev.id]?.doctrine;
      if (d) d.researching = null;
      active.delete(ev.id);
    }
  });

  // ── hook-based effects owned by this module ──────────────────────────────
  game.hooks.fortRadiusMul.push(o => doctrineLevel(game, o, 'fortress') >= 2 ? ADV.fortressFortRadius : 1);
  game.hooks.troopCapMul.push(p => doctrineLevel(game, p, 'fortress') >= 2 ? ADV.fortressTroopCap : 1);
  game.hooks.boatSpeedMul.push(p => doctrineLevel(game, p, 'projection') >= 1 ? ADV.projectionBoatSpeed : 1);
  game.hooks.boatCapAdd.push(p => doctrineLevel(game, p, 'projection') >= 1 ? 1 : 0);
  game.hooks.nukeCostMul.push(p => doctrineLevel(game, p, 'projection') >= 3 ? ADV.projectionNukeCost : 1);
  game.hooks.samChanceAdd.push(o => doctrineLevel(game, o, 'projection') >= 3 ? ADV.projectionSam : 0);

  adv.cmd.research = research;
  adv.q.doctrineCost = doctrineCost;
  adv.q.canResearch = canResearch;
}
