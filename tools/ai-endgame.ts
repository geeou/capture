// Dumps AI state of the top players after N ticks.  npx tsx tools/ai-endgame.ts ticks map seed difficulty [human]
import { createGame, type Difficulty } from '../src/sim/index';
import { testMap } from '../src/sim/testmap';
import { generateMap, loadWorldMap } from '../src/map/index';
const ticks = Number(process.argv[2] ?? 16000), which = process.argv[3] ?? 'world', seed = Number(process.argv[4] ?? 5);
const difficulty = (process.argv[5] ?? 'normal') as Difficulty;
const map = which === 'world' ? await loadWorldMap() : which === 'proc' ? generateMap(seed) : testMap(seed);
const game = createGame(map, { seed, difficulty, humanSpawn: process.argv[6] === 'human' ? { x: map.nations[map.nations.length - 1].x, y: map.nations[map.nations.length - 1].y } : null, tribes: which === 'test' ? 30 : 150 });
console.log('humanId', game.humanId, game.human?.name, game.human?.tiles);
const boats: string[] = [];
const leaderLog: string[] = [];
let watch = 0;
game.on(ev => {
  if (game.tick < ticks - 1200) return;
  if (ev.type === 'boatLanded' && ev.owner === watch) leaderLog.push(`${game.tick} landed tile=${ev.tile} owner=${game.owner[ev.tile]} troops=${ev.troops}`);
  if (ev.type === 'attackStarted' && ev.attack.attacker === watch) leaderLog.push(`${game.tick} attack -> ${ev.attack.target} troops=${Math.round(ev.attack.troops)} id=${ev.attack.id}`);
  if (ev.type === 'message' && ev.to === watch) leaderLog.push(`${game.tick} msg ${ev.text}`);
});
game.on(ev => { if (ev.type === 'boatLaunched' && game.tick > ticks - 1200) boats.push(`${game.tick} ${game.players[ev.unit.owner].name}->${game.owner[ev.unit.toTile]} troops=${ev.unit.troops}`); });
for (let t = 0; t < ticks && !game.over; t++) {
  game.step();
  if (t === ticks - 1201) { watch = game.alivePlayers().sort((a, b) => b.tiles - a.tiles)[0].id; }
  if (watch && t > ticks - 1200 && t % 50 === 0) {
    const a = game.attacks.filter(x => x.attacker === watch).map(x => `${x.target}:${Math.round(x.troops)}:F${x.ext.frontier}`).join(',');
    if (a) leaderLog.push(`${t} attacks ${a} tiles=${game.players[watch].tiles}`);
  }
}
console.log(leaderLog.join('\n'));
const nv = game.ext.naval;
for (const p of game.alivePlayers().sort((a, b) => b.tiles - a.tiles).slice(0, 4)) {
  const st = p.ext.ai;
  console.log(p.name, p.id, 'tiles', p.tiles, 'troops', Math.round(p.troops), 'cap', Math.round(game.q.maxTroops(p.id)), 'gold', Math.round(p.gold),
    'idle', st?.idle, 'lastBoat', st?.lastBoat, 'comps', st?.coastComps?.length, 'boatsAtSea', nv.boatsAtSea(p.id), '/', nv.maxBoats(p.id),
    'nb', [...game.neighborsOf(p.id).entries()].map(([k, v]) => `${k}:${v}`).join(','), 'allies', [...p.allies]);
}
console.log(boats.slice(-20).join('\n'));
