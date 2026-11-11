// Map module check: npx tsx tools/map-test.ts [outDir] [seeds…]
// Builds the world map and some procedural seeds, prints stats, writes PNG previews.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { generateMap, loadWorldMap } from '../src/map/index';
import { components } from '../src/map/raster';
import { HILLS, MOUNTAIN, PLAINS, WATER, type MapData } from '../src/sim/types';

const OUT = process.argv[2] ?? '/private/tmp/claude-501/-Users-giordanomattar--claude-spares-spare-k9CXjg/548790d3-0bde-4e8d-b4bd-4049932ce812/scratchpad/maps';
const SEEDS = process.argv.length > 3 ? process.argv.slice(3).map(Number) : [1, 1234, 98765];
mkdirSync(OUT, { recursive: true });

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

const COLORS: Record<number, [number, number, number]> = {
  [WATER]: [38, 70, 110], [PLAINS]: [120, 160, 90], [HILLS]: [165, 150, 95], [MOUNTAIN]: [235, 235, 235],
};

function report(map: MapData, ms: number, file: string): void {
  const { width: W, height: H, terrain } = map;
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < terrain.length; i++) counts[terrain[i]]++;
  const land = counts[PLAINS] + counts[HILLS] + counts[MOUNTAIN];
  const { sizes } = components(W, H, i => terrain[i] !== WATER);
  const masses = sizes.slice(1).sort((a, b) => b - a);
  const onWater = map.nations.filter(n => terrain[n.y * W + n.x] === WATER).length;
  const names = new Set(map.nations.map(n => n.name));
  let minSpacing = Infinity;
  for (let a = 0; a < map.nations.length; a++) for (let b = a + 1; b < map.nations.length; b++) {
    const A = map.nations[a], B = map.nations[b];
    minSpacing = Math.min(minSpacing, Math.hypot(A.x - B.x, A.y - B.y));
  }
  let edgeLand = 0;
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) if (terrain[y * W + x]) edgeLand++;
  const pct = (n: number) => (n / land * 100).toFixed(1) + '%';
  console.log(`\n== ${map.name}  ${W}x${H} (${(W * H / 1e6).toFixed(2)}M tiles)  built in ${ms.toFixed(0)} ms`);
  console.log(`land ${land} (${(land / (W * H) * 100).toFixed(1)}%)  plains ${pct(counts[PLAINS])} hills ${pct(counts[HILLS])} mountains ${pct(counts[MOUNTAIN])}`);
  console.log(`landmasses ${masses.length}; largest ${masses.slice(0, 6).map(m => `${m} (${(m / land * 100).toFixed(1)}%)`).join(', ')}; smallest ${masses[masses.length - 1]}`);
  console.log(`seeds ${map.nations.length} (unique names ${names.size}), on water ${onWater}, min spacing ${minSpacing.toFixed(1)}, edge-row land ${edgeLand}`);
  console.log(`top seeds: ${map.nations.slice(0, 12).map(n => `${n.name} ${n.strength}`).join(', ')}`);

  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < terrain.length; i++) rgb.set(COLORS[terrain[i]], i * 3);
  for (const n of map.nations) {
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = n.x + dx, y = n.y + dy;
      if (x < 0 || y < 0 || x >= W || y >= H || (Math.abs(dx) < 2 && Math.abs(dy) < 2 && (dx || dy))) continue;
      rgb.set([220, 30, 30], (y * W + x) * 3);
    }
  }
  writeFileSync(`${OUT}/${file}`, png(W, H, rgb));
  // optional zoomed crop: CROP="x,y,w,h" (world only) → 2x nearest-neighbour
  if (process.env.CROP && file === 'world.png') {
    const [cx, cy, cw, ch] = process.env.CROP.split(',').map(Number);
    const z = new Uint8Array(cw * ch * 12);
    for (let y = 0; y < ch * 2; y++) for (let x = 0; x < cw * 2; x++) {
      const si = ((cy + (y >> 1)) * W + cx + (x >> 1)) * 3;
      z.set(rgb.subarray(si, si + 3), (y * cw * 2 + x) * 3);
    }
    writeFileSync(`${OUT}/world-crop.png`, png(cw * 2, ch * 2, z));
  }
  console.log(`→ ${OUT}/${file}`);
}

let t = performance.now();
const world = await loadWorldMap();
report(world, performance.now() - t, 'world.png');
if (process.env.NAMES) console.log(world.nations.map(n => `${n.name}:${n.strength}`).join(' | '));

for (const s of SEEDS) {
  t = performance.now();
  const m = generateMap(s);
  report(m, performance.now() - t, `proc-${s}.png`);
  if (process.env.NAMES) console.log(m.nations.map(n => n.name).join(', '));
}
