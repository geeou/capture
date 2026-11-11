// CAPTURE — economy: troop growth, troop cap, gold income. Owner: land-war agent.
//
// Formulas (per player, `n` = owned tiles):
//   cap      = (700 + 72·n^0.79) · (1 + 0.25·finishedCities) · kindMul       (tribes: kindMul 0.4)
//   growth/s = 0.018 · cap · g(x) · diffMul,  x = troops/cap,  g(x) = (x+0.2)(1−x)/0.36
//              → peaks at 40 % full, ≈75 s from 5 % to 95 %; above the cap troops decay 0.4 %/tick
//   gold/s   = (3.5 + 0.048·n^0.79) · goldKindMul + 12·factories + 3·ports  (finished only)
// Reference: 80 tiles → cap ≈3,000, ≈5 g/s · 5,000 → ≈61k, ≈40 g/s · 20,000 → ≈180k, ≈120 g/s.
import type { Game } from './game';
import { TICKS_PER_SEC, type PlayerId } from './types';

export const ECON = {
  capBase: 700,
  capMul: 72,
  exp: 0.79,
  cityBonus: 0.25,
  tribeMul: 0.4,
  /** Growth constant per second (fraction of cap at the curve peak). */
  growth: 0.018,
  /** Fraction of the excess above the cap lost per tick. */
  decay: 0.004,
  goldBase: 3.5,
  goldMul: 0.048,
  tribeGoldMul: 0.5,
  factoryGold: 12,
  portGold: 3,
};

/** First 6 cities count in full, further ones (mostly captured) give sharply diminishing returns. */
function cityWeight(n: number): number { return n <= 6 ? n : 6 + Math.log2(1 + (n - 6) / 4); }

export function installEconomy(game: Game): void {
  // Per-player cached counts of finished structures, refreshed every tick (structures list is small).
  let cities = new Uint16Array(256), factories = new Uint16Array(256), ports = new Uint16Array(256);
  const ensure = () => {
    const n = game.players.length;
    if (cities.length < n) {
      const m = Math.max(n, cities.length * 2);
      cities = new Uint16Array(m); factories = new Uint16Array(m); ports = new Uint16Array(m);
    }
  };
  const countStructures = () => {
    ensure();
    cities.fill(0); factories.fill(0); ports.fill(0);
    const tick = game.tick;
    for (const s of game.structures) {
      if (s.readyTick > tick) continue;
      if (s.type === 'city') cities[s.owner]++;
      else if (s.type === 'factory') factories[s.owner]++;
      else if (s.type === 'port') ports[s.owner]++;
    }
  };
  let countedAt = -1;
  const fresh = () => { if (countedAt !== game.tick) { countStructures(); countedAt = game.tick; } };

  const landPow = (tiles: number) => (tiles > 0 ? Math.pow(tiles, ECON.exp) : 0);

  const maxTroops = (id: PlayerId): number => {
    const p = game.players[id];
    if (!p || !p.alive) return 0;
    fresh();
    const kind = p.kind === 'tribe' ? ECON.tribeMul : 1;
    // hook troopCapMul: ×1 exactly in classic matches
    return (ECON.capBase + ECON.capMul * landPow(p.tiles)) * (1 + ECON.cityBonus * cityWeight(cities[id])) * kind *
      game.hmul(game.hooks.troopCapMul, id);
  };

  const diffMul = (id: PlayerId): number => {
    if (id === game.humanId) return 1;
    return game.difficulty === 'easy' ? 0.75 : game.difficulty === 'hard' ? 1.25 : 1;
  };

  /** Troop change per tick (negative when above the cap). */
  const troopRate = (id: PlayerId): number => {
    const p = game.players[id];
    if (!p || !p.alive) return 0;
    const cap = maxTroops(id);
    if (cap <= 0) return 0;
    if (p.troops >= cap) return -(p.troops - cap) * ECON.decay;
    const x = Math.max(0, p.troops / cap);
    const g = ((x + 0.2) * (1 - x)) / 0.36;
    // hook troopRateMul (growth only, not the decay above the cap): ×1 exactly in classic matches
    return (ECON.growth * cap * g * diffMul(id) * game.hmul(game.hooks.troopRateMul, id)) / TICKS_PER_SEC;
  };

  const goldRate = (id: PlayerId): number => {
    const p = game.players[id];
    if (!p || !p.alive) return 0;
    fresh();
    const kind = p.kind === 'tribe' ? ECON.tribeGoldMul : 1;
    const perSec = (ECON.goldBase + ECON.goldMul * landPow(p.tiles)) * kind +
      ECON.factoryGold * factories[id] + ECON.portGold * ports[id];
    // hooks goldRateMul (×1) and goldRateAdd (+0, per tick: upkeep, deposits, tribute) — neutral in classic matches
    return (perSec * game.hmul(game.hooks.goldRateMul, id)) / TICKS_PER_SEC + game.hadd(game.hooks.goldRateAdd, id);
  };

  game.q.maxTroops = maxTroops;
  game.q.troopRate = troopRate;
  game.q.goldRate = goldRate;

  game.systems.push({
    name: 'economy',
    tick() {
      fresh();
      const ps = game.players;
      for (let id = 1; id < ps.length; id++) {
        const p = ps[id];
        if (!p.alive) continue;
        p.troops += troopRate(id);
        if (p.troops < 0) p.troops = 0;
        p.gold += goldRate(id);
        if (game.advanced && p.gold < 0) p.gold = 0; // upkeep can make income negative; gold never goes below 0
      }
    },
  });
}
