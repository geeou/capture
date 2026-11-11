// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE — ADVANCED MODE shared contract (core-owned: modules must not edit it).
// Design and rules: docs/ADVANCED.md. Numbers: ./rules.ts.
// ─────────────────────────────────────────────────────────────────────────────
import type { Attack, NukeKind, PlayerId, Structure, StructureType, Tile } from '../types';

export type ScenarioId = 'libero' | '1939' | 'guerrafredda';
export const SCENARIO_LABEL: Record<ScenarioId, string> = { libero: 'Mondo libero', '1939': '1939', guerrafredda: 'Guerra fredda' };

export type ResourceKind = 'oil' | 'iron' | 'uranium';
export const RESOURCE_KINDS: ResourceKind[] = ['oil', 'iron', 'uranium'];
export const RESOURCE_LABEL: Record<ResourceKind, string> = { oil: 'Petrolio', iron: 'Ferro', uranium: 'Uranio' };
/** A deposit belongs to whoever owns its tile (game.owner[tile]). */
export interface Deposit { id: number; kind: ResourceKind; x: number; y: number; tile: Tile }

export type Stance = 'offense' | 'balanced' | 'defense';
export const STANCES: Stance[] = ['offense', 'balanced', 'defense'];
export const STANCE_LABEL: Record<Stance, string> = { offense: 'Offensiva', balanced: 'Bilanciata', defense: 'Difensiva' };

export type DoctrineBranch = 'blitz' | 'fortress' | 'projection';
export const DOCTRINE_BRANCHES: DoctrineBranch[] = ['blitz', 'fortress', 'projection'];
export const DOCTRINE_LABEL: Record<DoctrineBranch, string> = { blitz: 'Guerra lampo', fortress: 'Fortezza', projection: 'Proiezione' };
export interface DoctrineState {
  /** 0..3 per branch. */
  level: Record<DoctrineBranch, number>;
  researching: DoctrineBranch | null;
  startTick: number;
  doneTick: number;
}

/** nap = non-aggression pact, truce = cease-fire, tribute = `a` is the overlord, `b` the vassal. */
export type PactKind = 'nap' | 'truce' | 'tribute';
export const PACT_LABEL: Record<PactKind, string> = { nap: 'Patto di non aggressione', truce: 'Tregua', tribute: 'Tributo' };
export interface Pact { id: number; kind: PactKind; a: PlayerId; b: PlayerId; startTick: number; /** 0 = no expiry */ untilTick: number }
export type OfferKind = 'nap' | 'truce' | 'tribute' | 'jointWar';
export const OFFER_LABEL: Record<OfferKind, string> = { nap: 'Patto di non aggressione', truce: 'Tregua', tribute: 'Richiesta di tributo', jointWar: 'Guerra congiunta' };
/** `target` = the common enemy for jointWar, otherwise 0. For tribute, `from` asks `to` to become its vassal. */
export interface DiploOffer { id: number; kind: OfferKind; from: PlayerId; to: PlayerId; target: PlayerId; tick: number }

/** Timed mission for the human player. Text is Italian. */
export interface Objective {
  id: number; title: string; text: string;
  /** Optional map position to jump to. */
  x?: number; y?: number;
  startTick: number; deadlineTick: number;
  /** Gold. */
  reward: number;
  /** 0..1 */
  progress: number;
  state: 'active' | 'done' | 'failed';
}

/** Per-player advanced state: game.adv.players[id]. Each field is written by the module named in brackets. */
export interface AdvPlayer {
  /** Capital tile, -1 = none. [supply] */
  capital: Tile;
  /** Owned tiles currently out of supply. [supply] */
  cutTiles: number;
  /** [front] */
  stance: Stance;
  /** Tick from which the stance may change again. [front] */
  stanceReadyTick: number;
  /** 0..1 share of the population working (gold) instead of fighting (troop growth). [economy] */
  workers: number;
  /** Gold per tick currently paid for structure upkeep. [economy] */
  upkeep: number;
  /** Deposits owned per kind. [resources] */
  res: Record<ResourceKind, number>;
  /** [doctrine] */
  doctrine: DoctrineState;
  /** -100..100, how much the world trusts this player. [diplomacy] */
  reputation: number;
}

/** Fog of war for the human player (null when off or no human). [fog] */
export interface Fog {
  /** 1 = currently visible. */
  visible: Uint8Array;
  /** Last owner seen on each tile (what the map shows outside vision). */
  seenOwner: Uint16Array;
  /** Tiles whose `visible` flag or `seenOwner` changed since the renderer last drained this list. */
  changed: Tile[];
}

/** Advanced commands. Like game.cmd: return true if accepted, spend troops/gold themselves, valid for bots and human. */
export interface AdvCommands {
  /** Focused land attack on the owner of `tile` (0 = free land), concentrated around that tile. [front] */
  attackAt(attacker: PlayerId, tile: Tile, troops: number): boolean;
  /** [front] */
  setStance(p: PlayerId, stance: Stance): boolean;
  /** Move the capital to one of your finished cities. Costs gold. [supply] */
  moveCapital(p: PlayerId, cityTile: Tile): boolean;
  /** ratio 0..1. [economy] */
  setWorkers(p: PlayerId, ratio: number): boolean;
  /** Build a warship at one of your finished ports. [fleet] */
  buildWarship(p: PlayerId, portTile: Tile): boolean;
  /** Order your nearest free warship to patrol around a water tile. [fleet] */
  sendFleet(p: PlayerId, seaTile: Tile): boolean;
  /** Start researching the next level of a branch. [doctrine] */
  research(p: PlayerId, branch: DoctrineBranch): boolean;
  /** [diplomacy] */
  offer(from: PlayerId, to: PlayerId, kind: OfferKind, target?: PlayerId): boolean;
  respondOffer(offerId: number, accept: boolean): boolean;
  /** Break the pact of that kind between the two (reputation hit). [diplomacy] */
  breakPact(by: PlayerId, other: PlayerId, kind: PactKind): boolean;
}

/** Advanced read-only queries. `can*` return null = allowed, otherwise a short Italian reason. */
export interface AdvQueries {
  /** [front] */
  canAttackAt(attacker: PlayerId, tile: Tile): string | null;
  /** Attack-strength multiplier (supplyMin..1) the player would have when fighting at `tile`. [supply] */
  supply(p: PlayerId, tile: Tile): number;
  /** True if the (owned) tile is cut off from every supply hub of its owner. [supply] */
  isCut(tile: Tile): boolean;
  canMoveCapital(p: PlayerId, cityTile: Tile): string | null;
  /** Deposit on this tile, or null. [resources] */
  depositAt(tile: Tile): Deposit | null;
  /** [fleet] */
  warshipCost(p: PlayerId): number;
  fleetCap(p: PlayerId): number;
  canBuildWarship(p: PlayerId, portTile: Tile): string | null;
  canSendFleet(p: PlayerId, seaTile: Tile): string | null;
  isBlockaded(port: Structure): boolean;
  /** [doctrine] Gold price of the next level of the branch (Infinity when maxed). */
  doctrineCost(p: PlayerId, branch: DoctrineBranch): number;
  canResearch(p: PlayerId, branch: DoctrineBranch): string | null;
  /** [diplomacy] */
  canOffer(from: PlayerId, to: PlayerId, kind: OfferKind, target?: PlayerId): string | null;
  /** Active pact between the two (of that kind, or any kind when omitted). */
  pact(a: PlayerId, b: PlayerId, kind?: PactKind): Pact | null;
  /** [fog] True when the human currently sees the tile (always true when fog is off). */
  visible(tile: Tile): boolean;
}

export interface Adv {
  scenario: ScenarioId;
  /** [resources] */
  deposits: Deposit[];
  /** Indexed by PlayerId (0 is a dummy). */
  players: AdvPlayer[];
  /** 1 = tile is out of supply. [supply] */
  cut: Uint8Array;
  /** [diplomacy] */
  pacts: Pact[];
  offers: DiploOffer[];
  /** [scenario] */
  objectives: Objective[];
  /** [fog] */
  fog: Fog | null;
  cmd: AdvCommands;
  q: AdvQueries;
}

/**
 * Modifier hooks (game.hooks). Empty in classic matches. The classic system named in brackets calls each
 * hook; any advanced module may push functions onto them.
 */
export interface Hooks {
  /** Multiplies the attacker's strength when it conquers `tile`. [attacks.ts] */
  attackMul: ((attack: Attack, tile: Tile) => number)[];
  /** Multiplies the defence of `tile` (owned by `owner`, 0 = free land) against `attacker`. [attacks.ts] */
  defenseMul: ((tile: Tile, owner: PlayerId, attacker: PlayerId) => number)[];
  /** Extra frontier cost (>= 0) of taking `tile` in this attack; Infinity = this attack never takes it. [attacks.ts] */
  attackTileCost: ((attack: Attack, tile: Tile) => number)[];
  /** [economy.ts] */
  troopCapMul: ((p: PlayerId) => number)[];
  troopRateMul: ((p: PlayerId) => number)[];
  goldRateMul: ((p: PlayerId) => number)[];
  /** Gold per tick added after the multipliers (negative = upkeep, tribute). [economy.ts] */
  goldRateAdd: ((p: PlayerId) => number)[];
  /** Why `a` may not attack `b` (land attack, boat landing, nuke aimed at b). [attacks.ts, naval.ts, nukes.ts] */
  forbidAttack: ((a: PlayerId, b: PlayerId) => string | null)[];
  /** [buildings.ts] */
  buildCostMul: ((p: PlayerId, type: StructureType) => number)[];
  /** Multiplies the protection radius of the forts of `owner`. [attacks.ts] */
  fortRadiusMul: ((owner: PlayerId) => number)[];
  /** [naval.ts] */
  boatCapAdd: ((p: PlayerId) => number)[];
  boatSpeedMul: ((p: PlayerId) => number)[];
  /** True = the port earns no trade income and neither sends nor receives trade ships. [naval.ts] */
  portBlocked: ((port: Structure) => boolean)[];
  /** [nukes.ts] */
  forbidNuke: ((p: PlayerId, kind: NukeKind) => string | null)[];
  nukeCostMul: ((p: PlayerId, kind: NukeKind) => number)[];
  /** Added to the intercept probability of the SAMs of `owner`. [nukes.ts] */
  samChanceAdd: ((owner: PlayerId) => number)[];
}
