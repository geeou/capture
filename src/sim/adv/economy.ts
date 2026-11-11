// ADVANCED MODE — economy: workers slider and structure upkeep. See docs/ADVANCED.md §3. Owner: LAND agent.
//
// workers w (0..1): hook goldRateMul ×(0.5 + w), hook troopRateMul ×(1.5 − w). Default 0.5 → both exactly 1.
// Upkeep: every finished structure beyond the first ADV.upkeepFree (in build order) costs ADV.upkeep[type]
// gold per tick, through hook goldRateAdd; stored in adv.players[id].upkeep (refreshed every UPKEEP_PERIOD ticks).
// economy.ts clamps gold at 0 in advanced matches; while a player sits at 0 gold with a negative income its
// troop growth is halved (troopRateMul).
import type { Game } from '../game';
import type { GameOptions, PlayerId } from '../types';
import { ADV } from './rules';

const UPKEEP_PERIOD = 10;

export function installAdvEconomy(game: Game, _opts: GameOptions): void {
  const adv = game.adv!;
  let count = new Uint16Array(game.players.length + 1);
  let broke = new Uint8Array(game.players.length + 1);

  const refreshUpkeep = () => {
    const n = game.players.length;
    if (count.length < n) { count = new Uint16Array(n); broke = new Uint8Array(n); }
    count.fill(0);
    for (let id = 0; id < n; id++) if (adv.players[id]) adv.players[id].upkeep = 0;
    const tick = game.tick;
    for (const s of game.structures) {
      if (s.readyTick > tick) continue;
      if (++count[s.owner] <= ADV.upkeepFree) continue;
      const ap = adv.players[s.owner];
      if (ap) ap.upkeep += ADV.upkeep[s.type] ?? 0;
    }
  };
  refreshUpkeep();

  adv.cmd.setWorkers = (p: PlayerId, ratio: number) => {
    const P = game.players[p], ap = adv.players[p];
    if (!P || !P.alive || !ap || !Number.isFinite(ratio)) return false;
    ap.workers = Math.min(1, Math.max(0, ratio));
    return true;
  };

  game.hooks.goldRateMul.push(p => 0.5 + (adv.players[p]?.workers ?? ADV.workersDefault));
  game.hooks.goldRateAdd.push(p => -(adv.players[p]?.upkeep ?? 0));
  game.hooks.troopRateMul.push(p => (1.5 - (adv.players[p]?.workers ?? ADV.workersDefault)) * (broke[p] ? 0.5 : 1));

  game.systems.push({
    name: 'adv-economy',
    tick() {
      if (game.tick % UPKEEP_PERIOD === 0) refreshUpkeep();
      // "broke" flag: at 0 gold and losing money. Runs after the classic economy, used from the next tick.
      const ps = game.players;
      for (let id = 1; id < ps.length; id++) {
        const P = ps[id];
        broke[id] = P.alive && P.gold <= 0 && game.q.goldRate(id) < 0 ? 1 : 0;
      }
    },
  });
}
