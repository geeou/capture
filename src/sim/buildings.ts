// CAPTURE — structure construction. Owner: land-war agent.
// Cost = base · (1 + 0.4 · already owned of that type, unfinished included).
// Effects live in economy.ts (city/factory/port) and attacks.ts (fort); silo/sam belong to nukes.ts.
import type { Game } from './game';
import { WATER, type PlayerId, type Structure, type StructureType, type Tile } from './types';

export const BUILD = {
  base: { city: 500, port: 400, fort: 300, factory: 600, silo: 3000, sam: 1800 } as Record<StructureType, number>,
  /** Construction time in ticks. */
  ticks: { city: 50, port: 40, fort: 40, factory: 60, silo: 100, sam: 80 } as Record<StructureType, number>,
  scale: 0.4,
  /** Minimum distance (tiles, Euclidean) from any other structure. */
  spacing: 5,
};

export function installBuildings(game: Game): void {
  const W = game.W, H = game.H;
  // spatial index of every structure, for the spacing rule
  const CELL = 8;
  const CW = Math.ceil(W / CELL), CH = Math.ceil(H / CELL);
  const cells: (Structure[] | undefined)[] = new Array(CW * CH);
  const cellOf = (s: Structure) => ((s.y / CELL) | 0) * CW + ((s.x / CELL) | 0);
  const add = (s: Structure) => { (cells[cellOf(s)] ??= []).push(s); };
  const remove = (s: Structure) => {
    const arr = cells[cellOf(s)];
    if (!arr) return;
    const k = arr.indexOf(s);
    if (k >= 0) arr.splice(k, 1);
  };
  for (const s of game.structures) add(s);
  game.on(ev => {
    if (ev.type === 'structureBuilt') add(ev.structure);
    else if (ev.type === 'structureDestroyed') remove(ev.structure);
  });

  const crowded = (x: number, y: number): boolean => {
    const r = BUILD.spacing, r2 = r * r;
    const cx0 = Math.max(0, ((x - r) / CELL) | 0), cx1 = Math.min(CW - 1, ((x + r) / CELL) | 0);
    const cy0 = Math.max(0, ((y - r) / CELL) | 0), cy1 = Math.min(CH - 1, ((y + r) / CELL) | 0);
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) {
      const arr = cells[cy * CW + cx];
      if (!arr) continue;
      for (const s of arr) { const dx = s.x - x, dy = s.y - y; if (dx * dx + dy * dy < r2) return true; }
    }
    return false;
  };

  const buildCost = (p: PlayerId, type: StructureType): number => {
    const base = BUILD.base[type];
    if (base === undefined) return Infinity;
    // hook buildCostMul: ×1 exactly in classic matches
    return Math.round(base * (1 + BUILD.scale * game.countStructures(p, type)) * game.hmul(game.hooks.buildCostMul, p, type));
  };

  const canBuild = (p: PlayerId, type: StructureType, tile: Tile): string | null => {
    const pl = game.players[p];
    if (!pl || !pl.alive) return 'Giocatore eliminato';
    if (BUILD.base[type] === undefined) return 'Struttura sconosciuta';
    if (!Number.isInteger(tile) || tile < 0 || tile >= game.N || game.terrain[tile] === WATER) return 'Non è terra';
    if (game.owner[tile] !== p) return 'Non è il tuo territorio';
    if (game.structureAt.has(tile)) return "C'è già una struttura";
    if (type === 'port' && !game.isCoast(tile)) return 'Deve essere sulla costa';
    if (crowded(tile % W, (tile / W) | 0)) return "Troppo vicino a un'altra struttura";
    if (pl.gold < buildCost(p, type)) return 'Oro insufficiente';
    return null;
  };

  game.q.buildCost = buildCost;
  game.q.canBuild = canBuild;
  game.cmd.build = (p, type, tile) => {
    if (canBuild(p, type, tile) !== null) return false;
    game.players[p].gold -= buildCost(p, type);
    game.addStructure(type, p, tile, BUILD.ticks[type]);
    return true;
  };
}
