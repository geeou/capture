// Headless bot-only match:  npx tsx tools/headless.ts [ticks=3000] [map=test|world|proc] [seed=1]
// Prints a leaderboard every 500 ticks plus ms/tick. Use it to test and balance sim systems.
import { createGame } from '../src/sim/index';
import { testMap } from '../src/sim/testmap';
import { generateMap, loadWorldMap } from '../src/map/index';

const ticks = Number(process.argv[2] ?? 3000);
const which = process.argv[3] ?? 'test';
const seed = Number(process.argv[4] ?? 1);

const map = which === 'world' ? await loadWorldMap() : which === 'proc' ? generateMap(seed) : testMap(seed);
const game = createGame(map, { seed, humanSpawn: null, tribes: which === 'test' ? 30 : 150 });
const counts: Record<string, number> = {};
game.on(ev => { counts[ev.type] = (counts[ev.type] ?? 0) + 1; });

console.log(`map ${map.name} ${map.width}x${map.height} land=${game.landTiles} players=${game.players.length - 1}`);
let worst = 0;
const t0 = performance.now();
for (let t = 1; t <= ticks && !game.over; t++) {
  const a = performance.now();
  game.step();
  worst = Math.max(worst, performance.now() - a);
  if (t % 500 === 0 || game.over) {
    const top = game.alivePlayers().sort((a, b) => b.tiles - a.tiles).slice(0, 5)
      .map(p => `${p.name} ${(game.share(p.id) * 100).toFixed(1)}% t=${Math.round(p.troops)} g=${Math.round(p.gold)}`).join(' | ');
    const owned = game.alivePlayers().reduce((s, p) => s + p.tiles, 0);
    console.log(`t=${t} alive=${game.alivePlayers().length} owned=${(owned / game.landTiles * 100).toFixed(0)}% attacks=${game.attacks.length} units=${game.units.length} structs=${game.structures.length} :: ${top}`);
  }
}
const ms = performance.now() - t0;
console.log(`done tick=${game.tick} over=${game.over} winner=${game.winner ? game.players[game.winner].name : '-'} avg=${(ms / game.tick).toFixed(2)}ms/tick worst=${worst.toFixed(1)}ms`);
console.log('events', counts);
