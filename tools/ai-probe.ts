// Diagnostics: per-player gains/losses in a window.  npx tsx tools/ai-probe.ts [start=4000] [len=600] [map=world] [seed=1]
import { createGame } from '../src/sim/index';
import { testMap } from '../src/sim/testmap';
import { generateMap, loadWorldMap } from '../src/map/index';
const start = Number(process.argv[2] ?? 4000), len = Number(process.argv[3] ?? 600);
const which = process.argv[4] ?? 'world', seed = Number(process.argv[5] ?? 1);
const map = which === 'world' ? await loadWorldMap() : which === 'proc' ? generateMap(seed) : testMap(seed);
const game = createGame(map, { seed, humanSpawn: null, tribes: which === 'test' ? 30 : 150 });
for (let t = 0; t < start; t++) game.step();
const P = game.players.length;
const gain = new Float64Array(P), lost = new Float64Array(P), spent = new Float64Array(P), launched = new Float64Array(P);
const troopSum = new Float64Array(P), capSum = new Float64Array(P);
const orig = game.setOwner.bind(game);
(game as any).setOwner = (i: number, to: number) => { const f = game.owner[i]; if (f !== to) { if (to) gain[to]++; if (f) lost[f]++; } orig(i, to); };
game.on(ev => { if (ev.type === 'attackStarted') { launched[ev.attack.attacker]++; spent[ev.attack.attacker] += ev.attack.troops; } });
const t0tiles = game.players.map(p => p.tiles);
const att = game.cmd.attack;
game.cmd.attack = (a, t, n) => { const before = game.players[a].troops; const r = att(a, t, n); if (r) spent[a] += 0; return r; };
for (let t = 0; t < len; t++) {
  game.step();
  for (const p of game.players) if (p.alive && p.id) { troopSum[p.id] += p.troops; capSum[p.id] += game.q.maxTroops(p.id); }
}
const top = game.alivePlayers().sort((a, b) => b.tiles - a.tiles).slice(0, 12);
for (const p of top) {
  const nb = [...game.neighborsOf(p.id).keys()].filter(k => k).length;
  const cities = game.structures.filter(s => s.owner === p.id && s.type === 'city').length;
  console.log(`${p.name.padEnd(14)} tiles ${t0tiles[p.id]}→${p.tiles} gain=${gain[p.id]} lost=${lost[p.id]} newAttacks=${launched[p.id]} fill=${(troopSum[p.id] / capSum[p.id]).toFixed(2)} cap=${Math.round(capSum[p.id] / len)} cities=${cities} nb=${nb} allies=${p.allies.size} atkNow=${game.attacks.filter(a => a.attacker === p.id).map(a => a.target + ':' + Math.round(a.troops)).join(',')}`);
}
