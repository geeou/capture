// AI / diplomacy match checker:  npx tsx tools/ai-test.ts [ticks=6000] [test|world|proc] [seed=1] [difficulty=normal] [human]
// Prints alive-count / top shares over time, event counts, structures by type, per-system ms, and checks invariants.
import { createGame, type Difficulty, type StructureType } from '../src/sim/index';
import { testMap } from '../src/sim/testmap';
import { generateMap, loadWorldMap } from '../src/map/index';

const ticks = Number(process.argv[2] ?? 6000);
const which = process.argv[3] ?? 'test';
const seed = Number(process.argv[4] ?? 1);
const difficulty = (process.argv[5] ?? 'normal') as Difficulty;
const withHuman = process.argv[6] === 'human';

const map = which === 'world' ? await loadWorldMap() : which === 'proc' ? generateMap(seed) : testMap(seed);
const game = createGame(map, {
  seed, difficulty, tribes: which === 'test' ? 30 : 150,
  humanSpawn: withHuman ? { x: map.nations[3].x, y: map.nations[3].y } : null,
});
const counts: Record<string, number> = {};
const kinds: Record<string, number> = {};
let betrayals = 0, expiries = 0, humanMsgs = 0, humanProposals = 0;
let freeGoneAt = 0;
const humanLog: string[] = [];
let maxOnHuman = 0;
/** A simple scripted "human": grabs land, attacks the weakest neighbour now and then, answers proposals 50/50. */
const humanAct = () => {
  const h = game.human;
  if (!h || !h.alive || game.tick % 10 !== 0) return;
  const cap = game.q.maxTroops(h.id), nb = game.neighborsOf(h.id);
  if (nb.has(0) && h.troops > cap * 0.25) game.cmd.attack(h.id, 0, h.troops * 0.4);
  else if (h.troops > cap * 0.5 && game.tick % 100 === 0) {
    let w = 0, wt = Infinity;
    for (const k of nb.keys()) if (k && !game.areAllied(h.id, k) && game.players[k].troops < wt) { wt = game.players[k].troops; w = k; }
    if (w) game.cmd.attack(h.id, w, h.troops * 0.4);
  }
  for (const r of [...game.allianceRequests]) if (r.to === h.id && game.tick - r.tick > 30) game.cmd.respondAlliance(r.id, game.rng() < 0.5);
};
game.on(ev => {
  counts[ev.type] = (counts[ev.type] ?? 0) + 1;
  if (ev.type === 'structureBuilt') kinds[ev.structure.type] = (kinds[ev.structure.type] ?? 0) + 1;
  if (ev.type === 'nukeLaunched') kinds['nuke:' + ev.unit.type] = (kinds['nuke:' + ev.unit.type] ?? 0) + 1;
  if (ev.type === 'allianceBroken') { if (ev.betrayal) betrayals++; else expiries++; }
  if (ev.type === 'message' && ev.to === game.humanId && game.humanId) { humanMsgs++; if (humanLog.length < 60) humanLog.push(`${(game.tick / 600).toFixed(1)}m ${ev.text}`); }
  if (ev.type === 'playerDied' && ev.id === game.humanId) humanLog.push(`${(game.tick / 600).toFixed(1)}m HUMAN DIED`);
  if (ev.type === 'allianceRequest' && ev.request.to === game.humanId) humanProposals++;
  if (ev.type === 'attackStarted' && ev.attack.target && game.areAllied(ev.attack.attacker, ev.attack.target)) {
    console.log(`INVARIANT ally attack at t=${game.tick}`); fail++;
  }
});

// per-system timing
const sysMs: Record<string, number> = {};
for (const s of game.systems) {
  const orig = s.tick.bind(s);
  sysMs[s.name] = 0;
  s.tick = () => { const a = performance.now(); orig(); sysMs[s.name] += performance.now() - a; };
}
let aiWorst = 0;
{
  const ai = game.systems.find(s => s.name === 'ai')!;
  const orig = ai.tick;
  ai.tick = () => { const a = performance.now(); orig(); aiWorst = Math.max(aiWorst, performance.now() - a); };
}

// worst-case timing of the calls the AI makes into other systems
const callMs: Record<string, { n: number; total: number; worst: number }> = {};
const wrap = (obj: any, key: string, label: string) => {
  const orig = obj[key].bind(obj);
  callMs[label] = { n: 0, total: 0, worst: 0 };
  obj[key] = (...args: any[]) => {
    const a = performance.now(); const r = orig(...args); const d = performance.now() - a;
    const c = callMs[label]; c.n++; c.total += d; if (d > c.worst) c.worst = d;
    return r;
  };
};
wrap(game.q, 'canBoat', 'q.canBoat'); wrap(game.cmd, 'sendBoat', 'cmd.sendBoat'); wrap(game.cmd, 'attack', 'cmd.attack');
wrap(game, 'neighborsOf', 'neighborsOf'); wrap(game.q, 'canBuild', 'q.canBuild'); wrap(game.cmd, 'launchNuke', 'cmd.launchNuke');
wrap(game.cmd, 'retreat', 'cmd.retreat');

// ownership flux per reporting window
const flux = { pp: 0, fp: 0, p0: 0 };
{
  const orig = game.setOwner.bind(game);
  (game as any).setOwner = (i: number, to: number) => {
    const from = game.owner[i];
    if (from !== to) { if (from && to) flux.pp++; else if (to) flux.fp++; else flux.p0++; }
    orig(i, to);
  };
}
let fail = 0;
const check = () => {
  let sum = 0;
  for (const p of game.players) if (p.id && p.alive) sum += p.tiles;
  let owned = 0;
  for (let i = 0; i < game.N; i++) if (game.owner[i]) owned++;
  if (sum !== owned) { console.log(`INVARIANT tiles ${sum} != owned ${owned} t=${game.tick}`); fail++; }
  for (const a of game.attacks) {
    if (!a.alive) continue;
    if (!game.players[a.attacker].alive || (a.target && !game.players[a.target].alive)) { console.log(`INVARIANT dead in attack t=${game.tick}`); fail++; }
    if (a.target && game.areAllied(a.attacker, a.target)) { console.log(`INVARIANT ally attack live t=${game.tick}`); fail++; }
  }
  for (const p of game.players) {
    if (!p.id) continue;
    for (const x of p.allies) {
      if (!p.alive || !game.players[x].alive) { console.log(`INVARIANT dead ally ${p.id}-${x} t=${game.tick}`); fail++; }
      if (!game.players[x].allies.has(p.id)) { console.log(`INVARIANT one-sided ally t=${game.tick}`); fail++; }
    }
    if (p.allies.size > 4) { console.log(`INVARIANT >4 allies t=${game.tick}`); fail++; }
  }
};

console.log(`map ${map.name} ${map.width}x${map.height} land=${game.landTiles} players=${game.players.length - 1} diff=${difficulty}`);
let worst = 0;
const t0 = performance.now();
const every = which === 'test' ? 600 : 1200;
for (let t = 1; t <= ticks && !game.over; t++) {
  const a = performance.now();
  if (withHuman) {
    humanAct();
    if (game.human?.alive) {
      const set = new Set<number>();
      for (const a of game.attacks) if (a.alive && a.target === game.humanId) set.add(a.attacker);
      maxOnHuman = Math.max(maxOnHuman, set.size);
    }
  }
  game.step();
  worst = Math.max(worst, performance.now() - a);
  if (!freeGoneAt && t % 50 === 0) {
    let owned = 0;
    for (const p of game.alivePlayers()) owned += p.tiles;
    if (owned > game.landTiles * 0.97) freeGoneAt = t;
  }
  if (t % 300 === 0) check();
  if (t % every === 0 || game.over) {
    const al = game.alivePlayers();
    const nations = al.filter(p => p.kind === 'nation').length, tribes = al.filter(p => p.kind === 'tribe').length;
    const top = al.sort((a, b) => b.tiles - a.tiles).slice(0, 5)
      .map(p => `${p.name.slice(0, 10)} ${(game.share(p.id) * 100).toFixed(1)}% a${p.allies.size}`).join(' | ');
    const allyPairs = al.reduce((s, p) => s + p.allies.size, 0) / 2;
    let ownedT = 0, fall = 0;
    for (const p of al) ownedT += p.tiles;
    for (let i = 0; i < game.N; i++) if (game.fallout[i]) fall++;
    console.log(`t=${t} (${(t / 600).toFixed(1)}m) owned=${(ownedT / game.landTiles * 100).toFixed(0)}% fallout=${fall} flux pp/fp/p0=${flux.pp}/${flux.fp}/${flux.p0} alive=${al.length} (n${nations}/t${tribes}) alliances=${allyPairs} att=${game.attacks.length} units=${game.units.length} structs=${game.structures.length} :: ${top}${game.human ? ` || HUMAN ${game.human.alive ? (game.share(game.humanId) * 100).toFixed(1) + '% a' + game.human.allies.size : 'dead'}` : ''}`);
    flux.pp = flux.fp = flux.p0 = 0;
  }
}
const ms = performance.now() - t0;
check();
console.log(`done tick=${game.tick} (${(game.tick / 600).toFixed(1)} min) over=${game.over} winner=${game.winner ? game.players[game.winner].name : '-'} freeLandGone@${freeGoneAt ? (freeGoneAt / 600).toFixed(1) + 'm' : '-'}`);
console.log(`avg=${(ms / game.tick).toFixed(3)}ms/tick worst=${worst.toFixed(1)}ms  ai avg=${(sysMs.ai / game.tick).toFixed(3)}ms worst=${aiWorst.toFixed(1)}ms  diplomacy avg=${(sysMs.diplomacy / game.tick).toFixed(4)}ms`);
console.log('system ms/tick', Object.fromEntries(Object.entries(sysMs).map(([k, v]) => [k, +(v / game.tick).toFixed(3)])));
console.log('calls', Object.fromEntries(Object.entries(callMs).map(([k, c]) => [k, `n=${c.n} avg=${(c.total / Math.max(1, c.n)).toFixed(3)} worst=${c.worst.toFixed(1)}`])));
console.log('events', Object.fromEntries(Object.entries(counts).filter(([k]) => k !== 'message')), 'messages', counts.message ?? 0);
console.log('built', kinds, `betrayals=${betrayals} expiries=${expiries}`, withHuman ? `humanMsgs=${humanMsgs} humanProposals=${humanProposals}` : '');
const byType: Record<string, number> = {};
for (const s of game.structures) byType[s.type] = (byType[s.type] ?? 0) + 1;
console.log('standing structures', byType as Record<StructureType, number>);
if (withHuman) console.log(`max simultaneous bot attackers on human: ${maxOnHuman}`);
if (withHuman) console.log('human log:\n  ' + humanLog.join('\n  '));
console.log(fail ? `FAIL ${fail} invariant violations` : 'invariants OK');
console.log('ai stats', (game.ext.ai as any)?.stats);
