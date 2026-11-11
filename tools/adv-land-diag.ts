// Diagnostic for adv supply/capital events (LAND agent).  npx tsx tools/adv-land-diag.ts [ticks] [map]
import { createGame } from '../src/sim/index';
import { generateMap, loadWorldMap } from '../src/map/index';
const ticks = Number(process.argv[2] ?? 1500);
const map = process.argv[3] === 'proc' ? generateMap(1) : await loadWorldMap();
const g = createGame(map, { seed: 1, humanSpawn: null, tribes: 150, advanced: true });
const per: Record<number, number> = {};
let byZero = 0, survived = 0, kinds: Record<string, number> = {};
const pockets: number[] = []; const rebels: number[] = [];
g.on(ev => {
  if (ev.type === 'capitalLost') {
    per[ev.owner] = (per[ev.owner] ?? 0) + 1;
    if (!ev.by) byZero++;
    if (g.players[ev.owner].tiles > 0) { survived++; kinds[g.players[ev.owner].kind] = (kinds[g.players[ev.owner].kind] ?? 0) + 1; }
  }
  if (ev.type === 'pocketLost') pockets.push(ev.tiles);
  if (ev.type === 'rebellion') rebels.push(ev.tiles);
});
for (let t = 0; t < ticks && !g.over; t++) g.step();
const top = Object.entries(per).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([id, n]) => `${g.players[+id].name}(${g.players[+id].kind},tiles=${g.players[+id].tiles}):${n}`);
console.log({ total: Object.values(per).reduce((a, b) => a + b, 0), byZero, survived, kinds, top });
console.log('pockets', pockets.length, 'sizes', pockets.slice(0, 40).join(','), 'rebellions', rebels.join(','));
