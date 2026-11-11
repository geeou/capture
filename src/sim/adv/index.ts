// ADVANCED MODE — factory (core-owned). Creates game.adv with neutral defaults, then installs every module.
import type { Game } from '../game';
import type { GameOptions } from '../types';
import { ADV } from './rules';
import type { Adv, AdvPlayer } from './types';
import { installResources } from './resources';
import { installSupply } from './supply';
import { installAdvEconomy } from './economy';
import { installFront } from './front';
import { installFleet } from './fleet';
import { installDoctrine } from './doctrine';
import { installAdvDiplomacy } from './diplomacy';
import { installScenario } from './scenario';
import { installFog } from './fog';
import { installAdvAI } from './ai';

export * from './types';
export { ADV, doctrineLevel } from './rules';

function makeAdvPlayer(): AdvPlayer {
  return {
    capital: -1, cutTiles: 0,
    stance: 'balanced', stanceReadyTick: 0,
    workers: ADV.workersDefault, upkeep: 0,
    res: { oil: 0, iron: 0, uranium: 0 },
    doctrine: { level: { blitz: 0, fortress: 0, projection: 0 }, researching: null, startTick: 0, doneTick: 0 },
    reputation: 0,
  };
}

const NO = 'Non disponibile';

/** Called by createGame() after the classic systems (including the classic AI) are installed. */
export function installAdvanced(game: Game, opts: GameOptions): void {
  const adv: Adv = {
    scenario: opts.scenario ?? 'libero',
    deposits: [],
    players: game.players.map(makeAdvPlayer),
    cut: new Uint8Array(game.N),
    pacts: [], offers: [], objectives: [],
    fog: null,
    cmd: {
      attackAt: () => false, setStance: () => false, moveCapital: () => false, setWorkers: () => false,
      buildWarship: () => false, sendFleet: () => false, research: () => false,
      offer: () => false, respondOffer: () => false, breakPact: () => false,
    },
    q: {
      canAttackAt: () => NO, supply: () => 1, isCut: () => false, canMoveCapital: () => NO, depositAt: () => null,
      warshipCost: () => Infinity, fleetCap: () => 0, canBuildWarship: () => NO, canSendFleet: () => NO, isBlockaded: () => false,
      doctrineCost: () => Infinity, canResearch: () => NO, canOffer: () => NO, pact: () => null, visible: () => true,
    },
  };
  game.advanced = true;
  game.adv = adv;
  // Order matters: resources and capitals first, AI last.
  installResources(game, opts);
  installSupply(game, opts);
  installAdvEconomy(game, opts);
  installFront(game, opts);
  installFleet(game, opts);
  installDoctrine(game, opts);
  installAdvDiplomacy(game, opts);
  installScenario(game, opts);
  installFog(game, opts);
  installAdvAI(game, opts);
}
