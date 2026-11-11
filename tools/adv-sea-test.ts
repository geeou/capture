// SEA agent test (advanced resources, fleet, doctrines + classic hook plumbing):  npx tsx tools/adv-sea-test.ts
// Builds games by hand with only naval + nukes + the three SEA advanced modules, so it does not depend on
// the other agents' systems (no economy/attacks/AI/supply/diplomacy).
import { Game } from '../src/sim/game';
import { testMap } from '../src/sim/testmap';
import { installNaval, BOAT_SPEED } from '../src/sim/naval';
import { installNukes, NUKE_COST } from '../src/sim/nukes';
import { installResources } from '../src/sim/adv/resources';
import { installFleet } from '../src/sim/adv/fleet';
import { installDoctrine } from '../src/sim/adv/doctrine';
import { ADV } from '../src/sim/adv/rules';
import type { Adv, AdvPlayer, ResourceKind } from '../src/sim/adv/types';
import { WATER, type Attack, type GameEvent, type Player, type Structure, type Unit } from '../src/sim/types';

let fails = 0;
function check(cond: boolean, what: string): void {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) fails++;
}

function newPlayer(g: Game, name: string, troops: number, gold: number, sx: number, sy: number): Player {
  const p: Player = {
    id: g.players.length, name, kind: 'nation', color: 0x888888, alive: true, troops, gold, tiles: 0, sumX: 0, sumY: 0,
    border: new Set(), spawnX: sx, spawnY: sy, allies: new Set(), embargoes: new Set(), traitorUntil: 0, ext: {},
  };
  g.players.push(p);
  return p;
}
function advPlayer(): AdvPlayer {
  return {
    capital: -1, cutTiles: 0, stance: 'balanced', stanceReadyTick: 0, workers: 0.5, upkeep: 0,
    res: { oil: 0, iron: 0, uranium: 0 },
    doctrine: { level: { blitz: 0, fortress: 0, projection: 0 }, researching: null, startTick: 0, doneTick: 0 },
    reputation: 0,
  };
}
const NO = 'Non disponibile';
/** Same shape as adv/index.ts installAdvanced, but only the SEA modules. */
function installSea(g: Game, seed: number): Adv {
  const adv: Adv = {
    scenario: 'libero', deposits: [], players: g.players.map(advPlayer), cut: new Uint8Array(g.N),
    pacts: [], offers: [], objectives: [], fog: null,
    cmd: {
      attackAt: () => false, setStance: () => false, moveCapital: () => false, setWorkers: () => false,
      buildWarship: () => false, sendFleet: () => false, research: () => false,
      offer: () => false, respondOffer: () => false, breakPact: () => false,
    },
    q: {
      canAttackAt: () => NO, supply: () => 1, isCut: () => false, canMoveCapital: () => NO, depositAt: () => null,
      warshipCost: () => Infinity, fleetCap: () => 0, canBuildWarship: () => NO, canSendFleet: () => NO, isBlockaded: () => false,
      doctrineCost: () => Infinity, canResearch: () => NO, canOffer: () => NO, pact: () => null, visible: () => true,
    },
  };
  g.advanced = true; g.adv = adv;
  installResources(g, { seed });
  installFleet(g, { seed });
  installDoctrine(g, { seed });
  return adv;
}

// ── world: testMap, A owns the west (x < 150), B the east (x > 250) ─────────
const SEED = 5;
const map = testMap(7);
const g = new Game(map, SEED);
const A = newPlayer(g, 'Aurelia', 50000, 1_000_000, 80, 120);
const B = newPlayer(g, 'Borea', 50000, 1_000_000, 320, 120);
for (let i = 0; i < g.N; i++) {
  if (!g.isLand(i)) continue;
  const x = g.xOf(i);
  if (x < 150) g.setOwner(i, A.id); else if (x > 250) g.setOwner(i, B.id);
}
installNaval(g);
installNukes(g);
const attackLog: [number, number, number][] = [];
g.cmd.attack = (a, t, troops) => { attackLog.push([a, t, troops]); g.players[a].troops -= troops; return true; };
const adv = installSea(g, SEED);
const events: GameEvent[] = [];
g.on(ev => { if (ev.type !== 'message') events.push(ev); });
const res = (p: Player) => adv.players[p.id].res;

console.log('== deposits ==');
{
  const d = adv.deposits;
  const kinds = (k: ResourceKind) => d.filter(x => x.kind === k).length;
  console.log(`  ${d.length} deposits: oil ${kinds('oil')}, iron ${kinds('iron')}, uranium ${kinds('uranium')}, land ${g.landTiles}`);
  check(d.length >= 3 && kinds('oil') >= 1 && kinds('iron') >= 1 && kinds('uranium') >= 1, 'deposits of every kind placed');
  check(d.every(x => g.isLand(x.tile) && x.tile === g.idx(x.x, x.y)), 'all on land, coords consistent');
  check(d.every(x => adv.q.depositAt(x.tile) === x) && adv.q.depositAt(g.idx(1, 1)) === null, 'depositAt');
  check(d.every(x => g.players.slice(1).every(p => (p.spawnX - x.x) ** 2 + (p.spawnY - x.y) ** 2 >= 81)), 'not on spawn points');
  let minD = Infinity;
  for (let a = 0; a < d.length; a++) for (let b = a + 1; b < d.length; b++) minD = Math.min(minD, Math.hypot(d[a].x - d[b].x, d[a].y - d[b].y));
  check(minD >= ADV.depositMinDist / 2, `spread out (min distance ${minD.toFixed(0)})`);
  // every big land mass has one
  const mass = g.ext.advResources.landMass as Int32Array;
  const size = new Map<number, number>();
  for (let i = 0; i < g.N; i++) if (mass[i]) size.set(mass[i], (size.get(mass[i]) ?? 0) + 1);
  const big = [...size].filter(([, s]) => s >= 1500).map(([m]) => m);
  check(big.every(m => d.some(x => mass[x.tile] === m)), `every land mass >= 1500 tiles has a deposit (${big.length} masses)`);
  // determinism, and game.rng untouched
  const g2 = new Game(map, SEED);
  newPlayer(g2, 'a', 0, 0, 80, 120); newPlayer(g2, 'b', 0, 0, 320, 120);
  installNaval(g2); installNukes(g2);
  const before = new Game(map, SEED).rng();
  const adv2 = installSea(g2, SEED);
  check(JSON.stringify(adv2.deposits) === JSON.stringify(d), 'placement deterministic from the seed');
  check(g2.rng() === before, 'game.rng not consumed by placement');
  // counts per owner
  const count = (p: Player, k: ResourceKind) => d.filter(x => x.kind === k && g.owner[x.tile] === p.id).length;
  const ok = (p: Player) => (['oil', 'iron', 'uranium'] as ResourceKind[]).every(k => res(p)[k] === count(p, k));
  check(ok(A) && ok(B), `counted per owner (A ${JSON.stringify(res(A))}, B ${JSON.stringify(res(B))})`);
}

/** Gives player p exactly n deposits of kind k (the rest of that kind become free land). */
function setDeposits(p: Player, k: ResourceKind, n: number): void {
  let given = 0;
  for (const d of adv.deposits) {
    if (d.kind !== k) continue;
    if (given < n) { g.setOwner(d.tile, p.id); given++; }
    else if (g.owner[d.tile] === p.id) g.setOwner(d.tile, 0);
  }
  g.step();
}

console.log('== deposits change hands ==');
{
  const dep = adv.deposits[0];
  const to = g.owner[dep.tile] === A.id ? B : A;
  const before = res(to)[dep.kind];
  events.length = 0;
  g.setOwner(dep.tile, to.id);
  g.step();
  check(res(to)[dep.kind] === before + 1, 'new owner count +1');
  const ev = events.find(e => e.type === 'depositCaptured') as any;
  check(!!ev && ev.deposit === dep && ev.owner === to.id, 'depositCaptured event');
  const goldAdd = g.hadd(g.hooks.goldRateAdd, to.id);
  const tot = res(to).oil + res(to).iron + res(to).uranium;
  check(Math.abs(goldAdd - tot * ADV.depositGold) < 1e-9, `deposit gold via goldRateAdd (${goldAdd.toFixed(2)}/tick)`);
}

console.log('== uranium & nukes ==');
{
  setDeposits(A, 'uranium', 0);
  let siloTile = -1;
  for (let i = 0; i < g.N; i++) if (g.owner[i] === A.id && !adv.q.depositAt(i) && !g.structureAt.has(i)) { siloTile = i; break; }
  g.addStructure('silo', A.id, siloTile, 0);
  let target = -1;
  for (const i of B.border) { target = i; break; }
  const why = g.q.canNuke(A.id, 'atom', target);
  check(why !== null && /uranio/i.test(why), `no uranium → refused ("${why}")`);
  check(!g.cmd.launchNuke(A.id, 'atom', target), 'launch refused');
  setDeposits(A, 'uranium', 1);
  check(g.q.canNuke(A.id, 'atom', target) === null, 'with uranium → atom allowed');
  const nh = adv.deposits.filter(d => d.kind === 'uranium').length;
  if (nh >= 2) {
    check(g.q.canNuke(A.id, 'hydrogen', target) !== null, 'hydrogen needs 2 uranium');
    setDeposits(A, 'uranium', 2);
    check(g.q.canNuke(A.id, 'hydrogen', target) === null, 'with 2 uranium → hydrogen allowed');
  }
  check(g.q.nukeCost(A.id, 'atom') === NUKE_COST.atom, 'nuke cost unchanged without doctrine');
}

console.log('== iron & oil ==');
{
  const fake: Attack = { id: 1, attacker: A.id, target: B.id, troops: 1, startTroops: 1, alive: true, ext: {} };
  setDeposits(A, 'iron', 0);
  check(g.hmul(g.hooks.attackMul, fake, 0) === 1, 'no iron → attack ×1');
  setDeposits(A, 'iron', 1);
  const m = g.hmul(g.hooks.attackMul, fake, 0);
  check(Math.abs(m - (1 + ADV.ironAttack)) < 1e-9, `iron raises attack (×${m.toFixed(2)})`);

  const nav = g.ext.naval;
  setDeposits(A, 'oil', 0);
  const base = nav.maxBoats(A.id);
  setDeposits(A, 'oil', 1);
  check(nav.maxBoats(A.id) === base + 1, `oil raises boat capacity (${base} → ${nav.maxBoats(A.id)})`);
  // boat speed: no oil → ×0.8
  setDeposits(A, 'oil', 0);
  let tgt = -1;
  for (const i of B.border) if (g.isCoast(i)) { tgt = i; break; }
  check(g.cmd.sendBoat(A.id, tgt, 500), 'boat sent');
  const boat = g.units.find(u => u.type === 'transport' && u.owner === A.id)!;
  check(Math.abs(boat.ext.speed - BOAT_SPEED * ADV.noOilBoatSpeed) < 1e-9, `no oil → boat speed ×${ADV.noOilBoatSpeed}`);
  boat.alive = false; // discard
  for (let k = 0; k < 2; k++) g.step();
}

console.log('== forbidAttack plumbing ==');
{
  let tgt = -1;
  for (const i of B.border) if (g.isCoast(i)) { tgt = i; break; }
  const hook = (a: number, b: number) => (a === A.id && b === B.id ? 'Patto in vigore' : null);
  g.hooks.forbidAttack.push(hook);
  setDeposits(A, 'uranium', 2);
  check(g.q.canBoat(A.id, tgt) === 'Patto in vigore' && !g.cmd.sendBoat(A.id, tgt, 500), 'boat landing refused by forbidAttack');
  check(g.q.canNuke(A.id, 'atom', tgt) === 'Patto in vigore', 'nuke at a protected player refused');
  g.hooks.forbidAttack.pop();
  check(g.q.canBoat(A.id, tgt) === null, 'allowed again once the hook is gone');
}

// helpers for the fleet part
function coastFor(p: Player, nearX: number): number {
  let best = -1, bd = Infinity;
  for (const i of p.border) if (g.isCoast(i) && !g.structureAt.has(i) && !adv.q.depositAt(i)) {
    const d = Math.abs(g.xOf(i) - nearX) + Math.abs(g.yOf(i) - 120) * 0.2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
/** Water tile in the same sea at distance [dMin, dMax] from (x, y). */
function waterNear(x: number, y: number, dMin: number, dMax: number, comp: number): number {
  const nav = g.ext.naval.nav;
  for (let r = Math.ceil(dMin); r <= dMax; r++) for (let a = 0; a < 64; a++) {
    const tx = Math.round(x + Math.cos(a / 64 * 6.283) * r), ty = Math.round(y + Math.sin(a / 64 * 6.283) * r);
    if (!g.inBounds(tx, ty)) continue;
    const i = g.idx(tx, ty);
    if (g.terrain[i] === WATER && nav.comp[i] === comp) return i;
  }
  return -1;
}
function park(u: Unit, tile: number): void {
  u.x = g.xOf(tile); u.y = g.yOf(tile); u.ext.at = tile; u.ext.path = null; u.ext.wait = 1e9; u.ext.chase = null;
  u.ext.patrol = { x: u.x, y: u.y };
}
const declareWar = () => {
  const a: Attack = { id: g.newId(), attacker: A.id, target: B.id, troops: 1, startTroops: 1, alive: false, ext: {} };
  g.emit({ type: 'attackStarted', attack: a });
};

console.log('== warship construction ==');
let ship: Unit;
const portA = coastFor(A, 145);
const portB = coastFor(B, 255);
{
  setDeposits(A, 'oil', 0);
  check(/porto/i.test(adv.q.canBuildWarship(A.id, portA) ?? ''), `no port → refused ("${adv.q.canBuildWarship(A.id, portA)}")`);
  const sA = g.addStructure('port', A.id, portA, 50);
  check(/costruzione/i.test(adv.q.canBuildWarship(A.id, portA) ?? ''), 'port under construction → refused');
  sA.readyTick = g.tick;
  check(/petrolio/i.test(adv.q.canBuildWarship(A.id, portA) ?? ''), `no oil → refused ("${adv.q.canBuildWarship(A.id, portA)}")`);
  setDeposits(A, 'oil', 1);
  const gold = A.gold;
  A.gold = 10;
  check(/oro/i.test(adv.q.canBuildWarship(A.id, portA) ?? ''), 'no gold → refused');
  A.gold = gold;
  const cost = adv.q.warshipCost(A.id);
  check(cost === ADV.warshipCost, `cost ${cost}`);
  check(adv.q.fleetCap(A.id) === 3, `capacity 1 + 1 port + 1 oil = ${adv.q.fleetCap(A.id)}`);
  check(adv.cmd.buildWarship(A.id, portA), 'warship built');
  check(A.gold === gold - cost, 'gold spent');
  ship = g.units.find(u => u.type === 'warship' && u.owner === A.id)!;
  check(!!ship && ship.ext.hp === ADV.warshipHp && ship.ext.maxHp === ADV.warshipHp && !!ship.ext.patrol, 'Unit warship with hp/maxHp/patrol');
  check(adv.q.warshipCost(A.id) === Math.round(ADV.warshipCost * (1 + ADV.warshipCostGrowth)), 'next one costs more');
  // patrol for a while: stays on water, close to home, classic naval ignores it
  let onWater = true;
  for (let k = 0; k < 300; k++) { g.step(); if (g.terrain[Math.round(ship.y) * g.W + Math.round(ship.x)] !== WATER) onWater = false; }
  const dHome = Math.hypot(ship.x - ship.ext.patrol.x, ship.y - ship.ext.patrol.y);
  check(onWater && ship.alive, `patrols on water (${dHome.toFixed(0)} tiles from patrol point)`);
  check(g.ext.naval.boatsAtSea(A.id) === 0, 'not counted as a transport');
}

console.log('== combat: transport ==');
{
  const nav = g.ext.naval.nav;
  declareWar();
  // B sends a boat to A's coast, the A warship waits in the middle of the route
  const tgt = coastFor(A, 140);
  const bTroops = B.troops;
  check(g.cmd.sendBoat(B.id, tgt, 3000), 'B transport launched');
  const tr = g.units.find(u => u.type === 'transport' && u.owner === B.id)!;
  const path = tr.ext.path as number[];
  const mid = path[Math.floor(path.length / 2)];
  park(ship, mid);
  let landed = false, sunk = false;
  const onEv = (ev: GameEvent) => { if (ev.type === 'boatLanded' && ev.owner === B.id) landed = true; };
  g.on(onEv);
  for (let k = 0; k < 1500 && tr.alive && !landed; k++) g.step();
  sunk = !tr.alive && !landed;
  check(sunk, `hostile transport sunk (troops left ${tr.troops})`);
  check(B.troops === bTroops - 3000, 'its troops are lost');
  void nav;
}

console.log('== blockade ==');
{
  // a second A port and a B port in the same sea → trade between them
  const sB = g.addStructure('port', B.id, portB, 0);
  const tradeTouches = () => g.units.some(u => u.type === 'trade' && u.alive && (u.ext.srcPort === sB || u.ext.dstPort === sB));
  let tradedBefore = false;
  for (let k = 0; k < 600; k++) { g.step(); if (tradeTouches()) tradedBefore = true; }
  check(tradedBefore, 'control: the port trades when free');
  // peace first: no blockade without war
  park(ship, waterNear(sB.x, sB.y, 4, 10, g.ext.naval.nav.comp[portWaterOf(sB.tile)]));
  for (let k = 0; k < 700; k++) g.step(); // let the war memory expire
  check(!adv.q.isBlockaded(sB), 'no war → not blockaded');
  declareWar();
  for (let k = 0; k < 5; k++) g.step(); // blockade status is cached for a few ticks
  check(adv.q.isBlockaded(sB) && g.hany(g.hooks.portBlocked, sB), 'hostile warship near → blockaded (q + hook)');
  // trade stops: no trade ship from/to the blockaded port, no trade gold
  for (const u of g.units) if (u.type === 'trade') u.alive = false; // sink the ones already at sea
  g.step();
  let traded = false;
  for (let k = 0; k < 500; k++) { if (k % 100 === 0) declareWar(); g.step(); if (tradeTouches()) traded = true; }
  check(!traded, 'no trade ship sent to/from a blockaded port');
  // a friendly warship closer than the blockader lifts it
  setDeposits(B, 'oil', 1);
  check(adv.cmd.buildWarship(B.id, portB) === false, 'cannot build at a blockaded port');
  // sink the blockader with a B warship built at a free port
  const portB2 = coastFor(B, 300);
  const sB2 = g.addStructure('port', B.id, portB2, 0);
  void sB2;
  const ok = adv.cmd.buildWarship(B.id, portB2);
  check(ok, `B warship built elsewhere (${adv.q.canBuildWarship(B.id, portB2)})`);
  const bShip = g.units.find(u => u.type === 'warship' && u.owner === B.id)!;
  // B ship within range of A's ship but farther from the port than A's ship
  const dA = Math.hypot(ship.x - sB.x, ship.y - sB.y);
  const comp = g.ext.naval.nav.comp[ship.ext.at];
  let spot = -1;
  for (let r = 5; r <= 12 && spot < 0; r++) for (let a = 0; a < 64; a++) {
    const tx = Math.round(ship.x + Math.cos(a / 64 * 6.283) * r), ty = Math.round(ship.y + Math.sin(a / 64 * 6.283) * r);
    if (!g.inBounds(tx, ty)) continue;
    const i = g.idx(tx, ty);
    if (g.terrain[i] === WATER && g.ext.naval.nav.comp[i] === comp && Math.hypot(tx - sB.x, ty - sB.y) > dA + 2) { spot = i; break; }
  }
  check(spot >= 0, 'found a duel spot');
  park(bShip, spot);
  ship.ext.hp = 12;
  g.step();
  check(adv.q.isBlockaded(sB), 'still blockaded while the defender is farther away');
  let sunkEv: any = null;
  g.on(ev => { if (ev.type === 'warshipSunk') sunkEv = ev; });
  for (let k = 0; k < 60 && ship.alive; k++) g.step();
  check(!ship.alive && sunkEv && sunkEv.unit === ship && sunkEv.by === B.id, 'blockader sunk (warshipSunk event)');
  for (let k = 0; k < 6; k++) g.step();
  check(!adv.q.isBlockaded(sB) && !g.hany(g.hooks.portBlocked, sB), 'blockade lifted once sunk');
  check(!g.units.some(u => u === ship), 'sunk ship removed from game.units');
}
function portWaterOf(tile: number): number {
  for (const n of [tile - 1, tile + 1, tile - g.W, tile + g.W]) if (g.terrain[n] === WATER) return n;
  return 0;
}

console.log('== doctrines ==');
{
  const d = adv.players[A.id].doctrine;
  A.gold = 100_000;
  const c1 = adv.q.doctrineCost(A.id, 'projection');
  check(c1 === ADV.doctrineCost[0], `level I costs ${c1}`);
  check(adv.cmd.research(A.id, 'projection'), 'research started');
  check(A.gold === 100_000 - c1, 'gold spent');
  check(/corso/i.test(adv.q.canResearch(A.id, 'fortress') ?? ''), 'one research at a time');
  check(!adv.cmd.research(A.id, 'fortress'), 'second research refused');
  const capBefore = g.ext.naval.maxBoats(A.id);
  for (let k = 0; k < ADV.doctrineTicks[0] - 1; k++) g.step();
  check(d.level.projection === 0, 'not done before its time');
  let done: any = null;
  g.on(ev => { if (ev.type === 'doctrineDone') done = ev; });
  g.step(); g.step();
  check(d.level.projection === 1 && !d.researching && done?.branch === 'projection' && done.level === 1, 'Projection I done (event)');
  check(g.ext.naval.maxBoats(A.id) === capBefore + 1, 'Projection I: +1 boat capacity');
  const sp = g.hmul(g.hooks.boatSpeedMul, A.id);
  check(Math.abs(sp - ADV.projectionBoatSpeed * (res(A).oil ? 1 : ADV.noOilBoatSpeed)) < 1e-9, `Projection I: boat speed ×${sp.toFixed(2)}`);
  const c2 = adv.q.doctrineCost(A.id, 'fortress');
  check(c2 === Math.round(ADV.doctrineCost[0] * (1 + ADV.doctrineCrossPenalty)), `cross-branch penalty: Fortress I costs ${c2}`);
  A.gold = 10;
  check(/oro/i.test(adv.q.canResearch(A.id, 'fortress') ?? ''), 'not enough gold → refused');
  A.gold = 1_000_000;
  // Fortress I, II
  for (let lv = 0; lv < 2; lv++) { check(adv.cmd.research(A.id, 'fortress'), `fortress ${lv + 1} started`); for (let k = 0; k <= ADV.doctrineTicks[lv] + 1; k++) g.step(); }
  check(d.level.fortress === 2, 'Fortress II reached');
  check(g.hmul(g.hooks.troopCapMul, A.id) === ADV.fortressTroopCap && g.hmul(g.hooks.fortRadiusMul, A.id) === ADV.fortressFortRadius, 'Fortress II: troop cap ×1.1, fort radius ×1.5');
  check(g.hmul(g.hooks.troopCapMul, B.id) === 1, 'others unaffected');
  // Projection II, III
  setDeposits(A, 'oil', 1);
  const wcBefore = adv.q.warshipCost(A.id);
  for (let lv = 1; lv < 3; lv++) { check(adv.cmd.research(A.id, 'projection'), `projection ${lv + 1} started`); for (let k = 0; k <= ADV.doctrineTicks[lv] + 1; k++) g.step(); }
  check(d.level.projection === 3, 'Projection III reached');
  check(adv.q.warshipCost(A.id) === Math.round(wcBefore * 0.75) || Math.abs(adv.q.warshipCost(A.id) - wcBefore * 0.75) <= 1, `Projection II: warship cost ${wcBefore} → ${adv.q.warshipCost(A.id)}`);
  check(adv.cmd.buildWarship(A.id, portA), 'warship built after Projection II');
  const s2 = g.units.find(u => u.type === 'warship' && u.owner === A.id && u.alive)!;
  check(s2.ext.maxHp === ADV.warshipHp * ADV.warshipHpProjection, `Projection II: HP ${s2.ext.maxHp}`);
  check(g.q.nukeCost(A.id, 'atom') === NUKE_COST.atom * ADV.projectionNukeCost, `Projection III: atom costs ${g.q.nukeCost(A.id, 'atom')}`);
  check(Math.abs(g.hadd(g.hooks.samChanceAdd, A.id) - ADV.projectionSam) < 1e-9, 'Projection III: SAM +0.15');
  check(adv.q.doctrineCost(A.id, 'projection') === Infinity && /massimo/i.test(adv.q.canResearch(A.id, 'projection') ?? ''), 'maxed branch');
}

console.log('== player death ==');
{
  const n = g.units.filter(u => u.type === 'warship' && u.owner === A.id).length;
  check(n > 0, 'A has warships');
  for (const i of [...Array(g.N).keys()]) if (g.owner[i] === A.id) g.setOwner(i, 0);
  g.step(); g.step();
  check(!A.alive && !g.units.some(u => u.type === 'warship' && u.owner === A.id), 'warships removed on playerDied');
  check(res(A).oil + res(A).iron + res(A).uranium === 0, 'resources cleared');
}

console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
