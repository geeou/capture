// Small hand-shaped map for the guided tutorial ("Partita tutorial"): one continent with a mountain ridge
// (and a hilly pass) between the player and its land neighbour, a strait, and an island across the sea.
// Pure TS, deterministic (no Math.random), runs in Node too.
import { HILLS, MOUNTAIN, PLAINS, WATER, type MapData, type NationSeed } from '../sim/types';
import { ValueNoise } from './noise';

export const TUTORIAL_W = 260;
export const TUTORIAL_H = 150;

/** Fixed spots the tutorial relies on (tile coordinates). */
export const TUTORIAL_SPOTS = {
  human: { x: 52, y: 78 },
  /** Land neighbour, east of the ridge. */
  borea: { x: 124, y: 62 },
  /** Southern neighbour (ally, pacts). */
  corvia: { x: 110, y: 121 },
  /** Island nation across the strait. */
  marea: { x: 222, y: 50 },
  /** Small tribes. */
  ulda: { x: 34, y: 50 },
  sarn: { x: 152, y: 98 },
  /** Centre of the mountain ridge / hilly pass. */
  ridge: { x: 95, y: 52 },
  pass: { x: 96, y: 76 },
  /** Free land on the island (landing spot). */
  islandFree: { x: 214, y: 98 },
};

export function tutorialMap(): MapData {
  const W = TUTORIAL_W, H = TUTORIAL_H;
  const terrain = new Uint8Array(W * H);
  const n1 = new ValueNoise(41017), n2 = new ValueNoise(9203), n3 = new ValueNoise(5521);
  const fbm = (x: number, y: number) => n1.noise(x / 24, y / 24) * 0.6 + n2.noise(x / 9, y / 9) * 0.28 + n3.noise(x / 4, y / 4) * 0.12;
  const blob = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;

  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (x < 4 || y < 4 || x >= W - 4 || y >= H - 4) { terrain[i] = WATER; continue; }
    const f = fbm(x, y);
    const cont = blob(x, y, 88, 77, 79, 61) + f * 0.32;
    const isl = blob(x, y, 220, 72, 29, 44) + f * 0.3;
    const islet = blob(x, y, 186, 131, 13, 8) + f * 0.4;
    if (cont >= 1 && isl >= 1 && islet >= 1) { terrain[i] = WATER; continue; }
    let t = PLAINS;
    if (cont < 1) {
      // mountain ridge running north–south at x ≈ 95, with a hilly pass in the middle
      const rx = 95 + Math.sin(y / 13) * 5 + n2.noise(x / 6, y / 6) * 2;
      const d = Math.abs(x - rx);
      const inPass = y > 66 && y < 86;
      if (y > 24 && y < 124) {
        if (!inPass && d < 2.6) t = MOUNTAIN;
        else if (d < (inPass ? 4.5 : 5.5)) t = HILLS;
      }
      // a few scattered hills elsewhere
      if (t === PLAINS && n3.noise(x / 7 + 40, y / 7) > 0.62) t = HILLS;
    } else if (isl < 1) {
      if (blob(x, y, 224, 62, 8, 12) < 1) t = HILLS;
    }
    terrain[i] = t;
  }

  const nations: NationSeed[] = [
    { name: 'Borea', ...TUTORIAL_SPOTS.borea, strength: 1 },
    { name: 'Corvia', ...TUTORIAL_SPOTS.corvia, strength: 0.9 },
    { name: 'Marea', ...TUTORIAL_SPOTS.marea, strength: 0.8 },
  ];
  return { name: 'Tutorial', width: W, height: H, terrain, nations };
}
