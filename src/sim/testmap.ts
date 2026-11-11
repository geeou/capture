// Tiny deterministic map for headless tests. Core-owned.
import { mulberry32 } from './game';
import { HILLS, MOUNTAIN, PLAINS, WATER, type MapData, type NationSeed } from './types';

/** Two continents and some islands, 400×240 by default. */
export function testMap(seed = 7, width = 400, height = 240): MapData {
  const rng = mulberry32(seed);
  const terrain = new Uint8Array(width * height);
  const blobs: [number, number, number][] = [];
  for (let k = 0; k < 26; k++) {
    const side = k % 2 ? 0.27 : 0.73;
    const big = k < 16;
    blobs.push([
      big ? width * (side + (rng() - 0.5) * 0.3) : rng() * width,
      big ? height * (0.5 + (rng() - 0.5) * 0.6) : rng() * height,
      big ? 22 + rng() * 26 : 6 + rng() * 9,
    ]);
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let v = 0;
    for (const [bx, by, r] of blobs) { const d2 = (x - bx) ** 2 + (y - by) ** 2; v += Math.exp(-d2 / (r * r)); }
    v += (Math.sin(x * 0.21) * Math.cos(y * 0.17) + Math.sin((x + y) * 0.09)) * 0.08;
    if (x < 3 || y < 3 || x >= width - 3 || y >= height - 3) v = 0;
    terrain[y * width + x] = v < 0.55 ? WATER : v > 1.9 ? MOUNTAIN : v > 1.45 ? HILLS : PLAINS;
  }
  const nations: NationSeed[] = [];
  const names = ['Aurelia', 'Borea', 'Cimbria', 'Dacia', 'Esperia', 'Frisia', 'Galizia', 'Illiria', 'Lusitania', 'Mesia', 'Norico', 'Pannonia'];
  let tries = 4000;
  while (nations.length < names.length && tries-- > 0) {
    const x = (rng() * width) | 0, y = (rng() * height) | 0;
    if (terrain[y * width + x] === WATER) continue;
    if (nations.some(n => (n.x - x) ** 2 + (n.y - y) ** 2 < 30 * 30)) continue;
    nations.push({ name: names[nations.length], x, y, strength: 1 - nations.length / names.length });
  }
  return { name: 'Test', width, height, terrain, nations };
}
