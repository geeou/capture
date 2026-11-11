// Advanced diplomacy / scenario / objectives checks:  npx tsx tools/adv-diplo-test.ts
import { createGame, PLAINS, WATER, type Game, type GameEvent, type MapData } from '../src/sim/index';
import { generateMap, loadWorldMap } from '../src/map/index';

let fails = 0, passes = 0;
const ok = (cond: unknown, what: string) => {
  if (cond) { passes++; console.log('  ok   ' + what); } else { fails++; console.log('  FAIL ' + what); }
};
const it = /[àèéìòù]|Patto|Tregua|vassallo|tributo/;

/** Three nations in a row on a plain: A | C | B, A and B both border C. */
function lineMap(): MapData {
  const W = 100, H = 60;
  const terrain = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) terrain[y * W + x] = x < 2 || y < 2 || x >= W - 2 || y >= H - 2 ? WATER : PLAINS;
  return { name: 'Linea', width: W, height: H, terrain, nations: [
    { name: 'Avalon', x: 20, y: 30, strength: 1 }, { name: 'Borgo', x: 60, y: 30, strength: 0.9 },
  ] };
}
/** A = Avalon, B = Borgo (bots), C = the human between them. Bot AIs are removed so nothing moves by itself. */
function mk(): { g: Game; A: number; B: number; C: number; ev: GameEvent[] } {
  const g = createGame(lineMap(), { seed: 1, humanSpawn: { x: 40, y: 30 }, tribes: 0, advanced: true, fog: false });
  g.systems = g.systems.filter(s => s.name !== 'ai' && s.name !== 'advAI');
  const A = g.players.find(p => p.name === 'Avalon')!.id, B = g.players.find(p => p.name === 'Borgo')!.id, C = g.humanId;
  g.claimDisc(A, 20, 30, 11); g.claimDisc(C, 40, 30, 11); g.claimDisc(B, 60, 30, 11);
  for (const id of [A, B, C]) { g.players[id].troops = 5000; g.players[id].gold = 1000; }
  const ev: GameEvent[] = [];
  g.on(e => ev.push(e));
  return { g, A, B, C, ev };
}
const run = (g: Game, n: number) => { for (let k = 0; k < n; k++) g.step(); };
const adv = (g: Game) => g.adv!;
const lastOffer = (g: Game) => adv(g).offers[adv(g).offers.length - 1];

console.log('NAP');
{
  const { g, A, C, ev } = mk();
  ok(adv(g).cmd.offer(A, C, 'nap'), 'offer nap accepted as command');
  ok(ev.some(e => e.type === 'message' && e.to === C && /propone/.test(e.text)), 'receiver gets an Italian message');
  ok(adv(g).cmd.respondOffer(lastOffer(g).id, true), 'human accepts');
  const pact = adv(g).q.pact(A, C, 'nap');
  ok(pact && pact.untilTick > g.tick, 'pact active with expiry');
  const r1 = g.hwhy(g.hooks.forbidAttack, A, C), r2 = g.hwhy(g.hooks.forbidAttack, C, A);
  ok(r1 && r2 && it.test(r1) && it.test(r2), `forbidAttack both ways (“${r1}”)`);
  ok(!g.cmd.attack(A, C, 500) && !g.cmd.attack(C, A, 500), 'cmd.attack refused both ways');
  pact!.untilTick = g.tick + 15;
  const repBefore = adv(g).players[A].reputation;
  run(g, 30);
  ok(!adv(g).q.pact(A, C), 'nap expired');
  ok(ev.some(e => e.type === 'pactEnded' && e.brokenBy === 0), 'pactEnded brokenBy 0 on expiry');
  ok(adv(g).players[A].reputation > repBefore, 'honoured pact raises reputation');
  ok(g.cmd.attack(A, C, 500), 'attack allowed again after expiry');
}

console.log('TRUCE');
{
  const { g, A, C } = mk();
  ok(adv(g).q.canOffer(C, A, 'truce') !== null, 'no truce without a war');
  ok(g.cmd.attack(A, C, 1500), 'A attacks C');
  run(g, 5);
  ok(g.attacks.some(a => a.alive && a.attacker === A && a.target === C), 'attack is active');
  ok(adv(g).cmd.offer(C, A, 'truce'), 'human offers truce');
  // the bot answers on its own after a delay; force it to accept for the test
  ok(adv(g).cmd.respondOffer(lastOffer(g).id, true), 'truce accepted');
  ok(!g.attacks.some(a => a.alive && ((a.attacker === A && a.target === C) || (a.attacker === C && a.target === A))), 'truce ended all attacks between them');
  ok(!g.cmd.attack(A, C, 500), 'new attacks refused during the truce');
}

console.log('TRIBUTE');
{
  const { g, A, C } = mk();
  ok(adv(g).cmd.offer(A, C, 'tribute'), 'A demands tribute from C');
  ok(adv(g).cmd.respondOffer(lastOffer(g).id, true), 'C accepts vassalage');
  const pact = adv(g).q.pact(A, C, 'tribute');
  ok(pact && pact.a === A && pact.b === C && pact.untilTick === 0, 'tribute pact: A overlord, C vassal, no expiry');
  const st = g.ext.advDiplo.stats;
  let every = true;
  for (let k = 0; k < 10; k++) {
    const before = st.tributeGold, ga = g.players[A].gold;
    g.step();
    if (!(st.tributeGold > before)) every = false;
    void ga;
  }
  ok(every, `gold moves every tick (${st.tributeGold.toFixed(2)} paid in 10 ticks)`);
  ok(g.ext.advDiplo.tributeRate(A) > 0 && g.ext.advDiplo.tributeRate(C) < 0, 'tributeRate exposed (+overlord / −vassal)');
  const why = g.hwhy(g.hooks.forbidAttack, A, C);
  ok(why && it.test(why) && !g.cmd.attack(A, C, 500), `overlord cannot attack the vassal (“${why}”)`);
}

console.log('BREAK PACT');
{
  const { g, A, C, ev } = mk();
  adv(g).cmd.offer(A, C, 'nap'); adv(g).cmd.respondOffer(lastOffer(g).id, true);
  const rep0 = adv(g).players[A].reputation;
  ok(adv(g).cmd.breakPact(A, C, 'nap'), 'A breaks the nap');
  ok(adv(g).players[A].reputation < rep0, `reputation falls (${rep0} → ${adv(g).players[A].reputation})`);
  ok(ev.some(e => e.type === 'pactEnded' && e.brokenBy === A), 'pactEnded brokenBy A');
  ok(ev.some(e => e.type === 'message' && e.to === C && /rotto/.test(e.text)), 'victim warned');
  ok(g.cmd.attack(A, C, 500), 'attack possible after breaking');
  // betraying an alliance also costs reputation
  g.cmd.proposeAlliance(A, C); g.cmd.proposeAlliance(C, A);
  ok(g.areAllied(A, C), 'alliance formed');
  const rep1 = adv(g).players[C].reputation;
  g.cmd.breakAlliance(C, A);
  ok(adv(g).players[C].reputation < rep1, 'alliance betrayal lowers reputation');
}

console.log('JOINT WAR');
{
  const { g, A, B, C } = mk();
  g.cmd.proposeAlliance(A, B); g.cmd.proposeAlliance(B, A);
  ok(g.areAllied(A, B), 'A and B allied');
  g.players[B].troops = 9000; g.players[C].troops = 2000;
  g.ext.diplomacy.adjust(B, C, -60);
  ok(adv(g).cmd.offer(A, B, 'jointWar', C), 'A calls B to war against C');
  let started = false;
  g.on(e => { if (e.type === 'attackStarted' && e.attack.attacker === B && e.attack.target === C) started = true; });
  run(g, 60);
  ok(started, `allied bot attacked the target (jointWarAttacks=${g.ext.advDiplo.stats.jointWarAttacks})`);
  ok(g.ext.advAI.stats.attackAt.ok + g.ext.advAI.stats.fallbackAttack.ok > 0, 'went through the advanced AI attack helper');
}

console.log('OFFER EXPIRY + VISIBLE ANSWERS');
{
  const { g, A, B, C, ev } = mk();
  ok(adv(g).cmd.offer(A, C, 'nap'), 'bot offers nap to the human');
  const id = lastOffer(g).id;
  run(g, 320);
  ok(!adv(g).offers.some(o => o.id === id), 'unanswered offer expired');
  ok(g.ext.advDiplo.stats.expired >= 1, 'expiry counted');
  // the human always gets an answer from a bot
  ev.length = 0;
  ok(adv(g).cmd.offer(C, B, 'nap'), 'human offers nap to a bot');
  run(g, 45);
  ok(ev.some(e => e.type === 'message' && e.to === C && /(accetta|rifiuta)/.test(e.text)), 'human got a visible accept/refuse message');
  ok(adv(g).q.canOffer(C, B, 'nap') !== null || !adv(g).q.pact(C, B), 'no duplicate offer while pact/cooldown');
}

console.log('OBJECTIVES');
{
  const { g, C, ev } = mk();
  g.ext.advScenario.nextObjectiveAt(g.tick + 1);
  run(g, 20);
  const o = adv(g).objectives[0];
  ok(o && o.state === 'active' && ev.some(e => e.type === 'objective' && e.state === 'new'), `objective issued: “${o?.text}”`);
  if (o) {
    const h = g.players[C];
    const gold0 = h.gold;
    // satisfy any kind: land share, cities, the target tile (deposit / capital)
    let n = 0;
    for (let i = 0; i < g.N && n < 1500; i++) if (g.isLand(i) && g.owner[i] === 0) { g.setOwner(i, C); n++; }
    if (o.x !== undefined && o.y !== undefined) g.setOwner(g.idx(o.x, o.y), C);
    for (let k = 0; k < 4; k++) {
      const t = [...h.border][k * 7];
      if (t !== undefined && !g.structureAt.has(t)) g.addStructure('city', C, t, 0);
    }
    run(g, 20);
    if (/navi/.test(o.text)) console.log('  (fleet objective: not completable on the test map, skipped)');
    else {
      ok(o.state === 'done', `objective completed (${o.title})`);
      ok(h.gold >= gold0 + o.reward - 1, `reward paid (+${o.reward})`);
    }
    // a new one comes later, and an unfinished one fails at its deadline
    g.ext.advScenario.nextObjectiveAt(g.tick + 1);
    run(g, 20);
    const o2 = adv(g).objectives[adv(g).objectives.length - 1];
    if (o2 && o2 !== o && o2.state === 'active') {
      o2.deadlineTick = g.tick + 5;
      // undo nothing: if it is already satisfied it completes, else it fails
      run(g, 20);
      const s2 = o2.state as string;
      ok(s2 === 'done' || s2 === 'failed', `second objective resolved (${s2})`);
    }
  }
}

console.log('SCENARIOS');
{
  const world = await loadWorldMap();
  const names = (g: Game, id: number) => g.players[id].name;
  const pid = (g: Game, n: string) => g.players.find(p => p.name === n)?.id ?? 0;
  {
    const g = createGame(world, { seed: 1, humanSpawn: null, advanced: true, scenario: '1939' });
    ok(g.adv!.scenario === '1939', '1939 installed on the world map');
    const ge = pid(g, 'Germania'), it_ = pid(g, 'Italia'), jp = pid(g, 'Giappone'), uk = pid(g, 'Regno Unito'), fr = pid(g, 'Francia'), ru = pid(g, 'Russia'), pl = pid(g, 'Polonia');
    ok(g.areAllied(ge, it_) && g.areAllied(ge, jp), 'Asse: Germania–Italia–Giappone allied');
    ok(g.areAllied(uk, fr) && g.areAllied(uk, pl), 'Alleati: Regno Unito–Francia–Polonia allied');
    ok(!!g.adv!.q.pact(ru, ge, 'nap'), 'Molotov–Ribbentrop NAP');
    ok(g.ext.advScenario.enemiesOf(ge).includes(pl), 'Germania at war with Polonia');
    ok(g.players[ge].ext.ai?.war === pl, 'classic AI war target set');
    console.log('  blocs:', g.ext.advScenario.blocs.map((b: { name: string; members: number[] }) => `${b.name}: ${b.members.map(m => names(g, m)).join(', ')}`).join(' | '));
    run(g, 5);
  }
  {
    const g = createGame(world, { seed: 1, humanSpawn: null, advanced: true, scenario: 'guerrafredda' });
    ok(g.adv!.scenario === 'guerrafredda', 'guerrafredda installed on the world map');
    const us = pid(g, 'Stati Uniti'), uk = pid(g, 'Regno Unito'), ru = pid(g, 'Russia'), pl = pid(g, 'Polonia');
    ok(g.areAllied(us, uk) && g.areAllied(ru, pl), 'NATO and Warsaw cores allied');
    ok(g.players[us].embargoes.has(ru), 'embargo between the blocs');
    ok(g.structuresOf(us, 'silo').length === 1 && g.structuresOf(ru, 'silo').length === 1, 'superpowers start with a silo');
    const ur = (id: number) => g.adv!.deposits.filter(d => d.kind === 'uranium' && g.owner[d.tile] === id).length;
    console.log(`  uranium deposits owned at start: Stati Uniti ${ur(us)}, Russia ${ur(ru)} (deposits: ${g.adv!.deposits.length})`);
    console.log('  blocs:', g.ext.advScenario.blocs.map((b: { name: string; members: number[] }) => `${b.name}: ${b.members.map(m => names(g, m)).join(', ')}`).join(' | '));
    run(g, 5);
  }
  {
    const g = createGame(generateMap(3), { seed: 3, humanSpawn: null, advanced: true, scenario: '1939', tribes: 20 });
    ok(g.adv!.scenario === 'libero', 'procedural map falls back to libero');
    ok(g.ext.advScenario.blocs.length === 0, 'no blocs on fallback');
    run(g, 5);
  }
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
