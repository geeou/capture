// ADVANCED MODE numbers shared by several modules (core-owned). The owner of each system may tune values
// that only its own module reads, but keep every cross-module number here so the modules agree.
import type { DoctrineBranch, Stance } from './types';
import type { Game } from '../game';
import type { PlayerId, StructureType } from '../types';

export const ADV = {
  // ── front ────────────────────────────────────────────────────────────────
  /** A focused attack only takes tiles within this distance of its focus point. */
  focusRadius: 28,
  /** Strength multiplier of a focused attack (concentration of force). Blitz III raises it to focusBonusBlitz. */
  focusBonus: 1.25,
  focusBonusBlitz: 1.5,
  stance: {
    offense: { atk: 1.2, def: 0.8 },
    balanced: { atk: 1, def: 1 },
    defense: { atk: 0.75, def: 1.35 },
  } as Record<Stance, { atk: number; def: number }>,
  /** Ticks before the stance can change again (halved by Blitz III). */
  stanceCooldown: 200,

  // ── supply & capital ─────────────────────────────────────────────────────
  /** Attack multiplier is 1 up to supplyFull tiles from the nearest own hub, falling linearly to supplyMin at supplyZero. Blitz II multiplies both distances by 1.5. */
  supplyFull: 70,
  supplyZero: 240,
  supplyMin: 0.45,
  /** Hubs: capital, finished cities, finished ports that are not blockaded. */
  /** Defence multiplier of tiles cut off from every hub. */
  cutDefense: 0.4,
  /** A pocket that stays cut this long surrenders (doubled by Fortress III). */
  cutSurrenderTicks: 300,
  /** Each player is re-scanned for cut-off pockets about this often (stagger players across ticks). */
  supplyScanPeriod: 100,
  /** Defence multiplier within capitalRadius tiles of a capital. */
  capitalDefense: 1.5,
  capitalRadius: 10,
  /** Share of troops lost when the capital falls (Fortress III: capitalLossFortress). */
  capitalLossTroops: 0.5,
  capitalLossFortress: 0.25,
  /** Share of the victim's gold taken by whoever captures the capital. */
  capitalLootGold: 0.3,
  capitalMoveCost: 1500,
  /** Rebellions: empires above rebelShare of the land lose a disc of territory far (> rebelDistance tiles) from every hub. */
  rebelShare: 0.1,
  rebelDistance: 230,
  rebelPeriod: 600,

  // ── economy ──────────────────────────────────────────────────────────────
  /** workers w in 0..1: gold income × (0.5 + w), troop growth × (1.5 − w). Default 0.5 = classic values. */
  workersDefault: 0.5,
  /** Gold per tick per finished structure beyond the first `upkeepFree` structures of a player. */
  upkeep: { city: 0.05, port: 0.04, fort: 0.03, factory: 0.06, silo: 0.3, sam: 0.18 } as Record<StructureType, number>,
  upkeepFree: 4,

  // ── resources ────────────────────────────────────────────────────────────
  /** Deposits per 100,000 land tiles. */
  depositsPer100k: { oil: 4, iron: 4, uranium: 2.5 },
  depositMinDist: 40,
  /** Gold per tick per owned deposit. */
  depositGold: 0.6,
  /** Attack multiplier +ironAttack per iron deposit, counting at most ironMax. */
  ironAttack: 0.08,
  ironMax: 3,
  /** +1 boat/warship capacity per oil deposit (max oilMax). No oil: boats ×noOilBoatSpeed, no warships. */
  oilMax: 3,
  noOilBoatSpeed: 0.8,
  /** Uranium deposits needed to launch. */
  uranium: { atom: 1, hydrogen: 2 },

  // ── fleet ────────────────────────────────────────────────────────────────
  warshipCost: 900,
  /** +35% per warship already owned. Projection II: ×0.75. */
  warshipCostGrowth: 0.35,
  /** Capacity = 1 + finished ports + min(oil, oilMax), capped at warshipCapMax. Needs at least 1 oil. */
  warshipCapMax: 8,
  warshipSpeed: 1.6,
  warshipHp: 100,
  /** Projection II multiplies warship HP. */
  warshipHpProjection: 1.5,
  /** A warship engages hostile ships within this range (tiles). */
  warshipRange: 14,
  patrolRadius: 30,
  /** A port with a hostile warship this close (and no friendly warship closer) is blockaded. */
  blockadeRadius: 16,

  // ── doctrines ────────────────────────────────────────────────────────────
  /** Gold for levels 1..3; each level already owned in the OTHER branches adds +50%. */
  doctrineCost: [1500, 4000, 9000],
  doctrineCrossPenalty: 0.5,
  /** Research time in ticks for levels 1..3. One research at a time. */
  doctrineTicks: [300, 600, 900],
  // Effects (the module that owns the affected system applies them by reading doctrineLevel()):
  //  blitz      1 attack ×1.15 · 2 supply distances ×1.5 · 3 focus bonus 1.25→1.5, stance cooldown halved
  //  fortress   1 defence ×1.2 · 2 fort radius ×1.5, troop cap ×1.1 · 3 pockets hold twice as long, capital loss 50%→25%
  //  projection 1 boats ×1.3 speed and +1 capacity · 2 warship HP ×1.5, cost ×0.75 · 3 nuke cost ×0.75, SAM +0.15
  blitzAttack: 1.15,
  blitzSupply: 1.5,
  fortressDefense: 1.2,
  fortressFortRadius: 1.5,
  fortressTroopCap: 1.1,
  projectionBoatSpeed: 1.3,
  projectionNukeCost: 0.75,
  projectionSam: 0.15,

  // ── diplomacy ────────────────────────────────────────────────────────────
  napTicks: 1800,
  truceTicks: 900,
  /** Share of the vassal's gold income paid to the overlord every tick. */
  tributeShare: 0.2,
  /** An AI only accepts vassalage if the overlord is at least this many times stronger (troops). */
  tributeMinRatio: 3,
  offerExpiry: 300,
  reputation: { betrayAlliance: -40, breakPact: -25, nukeNeutral: -15, pactHonoured: 5, min: -100, max: 100 },

  // ── fog of war (human only; bots are not affected) ───────────────────────
  /** Vision reaches this many tiles beyond own and allied territory. */
  visionBorder: 22,
  visionHub: { capital: 45, city: 35, port: 30, sam: 70, warship: 30 },
  fogPeriod: 10,

  // ── objectives ───────────────────────────────────────────────────────────
  objectivePeriod: 1200,
  objectiveDuration: 1800,
} as const;

/** Doctrine level (0..3) of a player in a branch; 0 in classic matches. */
export function doctrineLevel(game: Game, p: PlayerId, branch: DoctrineBranch): number {
  return game.adv ? game.adv.players[p]?.doctrine.level[branch] ?? 0 : 0;
}
