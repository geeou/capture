// CAPTURE — game factory. Owned by the core: system modules must NOT edit this file.
import { Game } from './game';
import type { GameOptions, MapData } from './types';
import { installEconomy } from './economy';
import { installAttacks } from './attacks';
import { installBuildings } from './buildings';
import { installNaval } from './naval';
import { installNukes } from './nukes';
import { installDiplomacy } from './diplomacy';
import { installAI } from './ai';
import { installAdvanced } from './adv/index';

export * from './types';
export { Game } from './game';

export const START_TROOPS = 1200;
export const TRIBE_START_TROOPS = 350;
const SPAWN_RADIUS = 5;
const TRIBE_RADIUS = 3;

function hsl(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

const SYL_A = ['Ar', 'Bel', 'Cor', 'Dun', 'El', 'Fen', 'Gal', 'Hor', 'Is', 'Kar', 'Lom', 'Mar', 'Nor', 'Or', 'Per', 'Quil', 'Ros', 'Sar', 'Tor', 'Ul', 'Val', 'Zan'];
const SYL_B = ['a', 'e', 'i', 'o', 'u', 'ae', 'ia', 'or', 'an', 'en'];
const SYL_C = ['dor', 'gar', 'lia', 'mir', 'nia', 'ros', 'tan', 'var', 'wen', 'zia', 'th', 'ria', 'kos', 'nd'];
function tribeName(rng: () => number): string {
  const pick = (a: string[]) => a[(rng() * a.length) | 0];
  return pick(SYL_A) + pick(SYL_B) + pick(SYL_C);
}

/** Builds a ready-to-run game: players spawned, all systems installed. Call game.step() 10×/s. */
export function createGame(map: MapData, opts: GameOptions = {}): Game {
  const g = new Game(map, opts.seed ?? 1);
  g.difficulty = opts.difficulty ?? 'normal';
  const rng = g.rng;

  if (opts.humanSpawn) {
    const h = g.addPlayer(opts.humanName || 'Tu', 'human', opts.humanColor ?? 0x2f7bff, opts.humanSpawn.x, opts.humanSpawn.y, SPAWN_RADIUS, START_TROOPS);
    if (h) g.humanId = h.id;
  }

  // Nations: strongest first, skipping any whose spawn is taken or too close to another capital.
  const maxNations = opts.nations ?? 88;
  const seeds = [...map.nations].sort((a, b) => b.strength - a.strength);
  const minDist2 = 14 * 14;
  let hue = rng() * 360;
  let made = 0;
  for (const s of seeds) {
    if (made >= maxNations) break;
    const near = g.players.some(p => p.id !== 0 && (p.spawnX - s.x) ** 2 + (p.spawnY - s.y) ** 2 < minDist2);
    if (near) continue;
    hue = (hue + 137.508) % 360;
    const color = hsl(hue, 0.55 + rng() * 0.3, 0.42 + rng() * 0.18);
    if (g.addPlayer(s.name, 'nation', color, s.x, s.y, SPAWN_RADIUS, START_TROOPS)) made++;
  }

  // Tribes: random free land, muted colours.
  const wantTribes = opts.tribes ?? 150;
  let tries = wantTribes * 40, tribes = 0;
  const used = new Set<string>(g.players.map(p => p.name));
  while (tribes < wantTribes && tries-- > 0) {
    const x = (rng() * g.W) | 0, y = (rng() * g.H) | 0;
    const i = g.idx(x, y);
    if (!g.isLand(i) || g.owner[i] !== 0) continue;
    let crowded = false;
    for (let dy = -7; dy <= 7 && !crowded; dy += 7) for (let dx = -7; dx <= 7; dx += 7) {
      const nx = x + dx, ny = y + dy;
      if (g.inBounds(nx, ny) && g.owner[g.idx(nx, ny)] !== 0) { crowded = true; break; }
    }
    if (crowded) continue;
    let name = tribeName(rng);
    if (used.has(name)) name += ' ' + (tribes + 1);
    used.add(name);
    hue = (hue + 137.508) % 360;
    const color = hsl(hue, 0.18 + rng() * 0.14, 0.5 + rng() * 0.14);
    if (g.addPlayer(name, 'tribe', color, x, y, TRIBE_RADIUS, TRIBE_START_TROOPS)) tribes++;
  }

  // Order matters: economy first, AI last.
  installEconomy(g);
  installAttacks(g);
  installBuildings(g);
  installNaval(g);
  installNukes(g);
  installDiplomacy(g);
  installAI(g);
  // Advanced mode: extra systems on top of the classic ones (docs/ADVANCED.md). Classic matches skip this entirely.
  if (opts.advanced) installAdvanced(g, opts);
  return g;
}
