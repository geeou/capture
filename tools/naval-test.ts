// Naval + nukes test:  npx tsx tools/naval-test.ts
// Builds games by hand (no economy/attacks/AI) so it does not depend on the other systems.
import { Game } from '../src/sim/game';
import { testMap } from '../src/sim/testmap';
import { installNaval, WaterNav, MIN_BOAT_TROOPS } from '../src/sim/naval';
import { installNukes, SAM_RANGE } from '../src/sim/nukes';
import { WATER, PLAINS, type MapData, type Player, type Unit } from '../src/sim/types';

let fails = 0;
function check(cond: boolean, what: string): void {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
  if (!cond) fails++;
}

function newPlayer(g: Game, name: string, troops: number, gold = 0): Player {
  const p: Player = {
    id: g.players.length, name, kind: 'nation', color: 0x888888, alive: true, troops, gold, tiles: 0, sumX: 0, sumY: 0,
    border: new Set(), spawnX: 0, spawnY: 0, allies: new Set(), embargoes: new Set(), traitorUntil: 0, ext: {},
  };
  g.players.push(p);
  return p;
}
function tilesConsistent(g: Game): boolean {
  const cnt = new Array(g.players.length).fill(0);
  for (let i = 0; i < g.N; i++) cnt[g.owner[i]]++;
  for (let id = 1; id < g.players.length; id++) if (cnt[id] !== g.players[id].tiles) return false;
  return true;
}
function boatsOnWater(g: Game): boolean {
  for (const u of g.units) {
    if (!u.alive || (u.type !== 'transport' && u.type !== 'trade')) continue;
    const i = Math.round(u.y) * g.W + Math.round(u.x);
    if (g.terrain[i] !== WATER) return false;
  }
  return true;
}
function setup(map: MapData, seed = 3): Game {
  const g = new Game(map, seed);
  g.trackChanges = true;
  return g;
}
function finishInstall(g: Game, attackLog: [number, number, number][]): void {
  installNaval(g);
  installNukes(g);
  g.cmd.attack = (a, t, troops) => {
    attackLog.push([a, t, troops]);
    const p = g.players[a];
    if (p.troops < troops) return false;
    p.troops -= troops; // the real engine subtracts and keeps them in an attack
    return true;
  };
  g.cmd.breakAlliance = (a, b) => {
    g.players[a].allies.delete(b); g.players[b].allies.delete(a);
    g.players[a].traitorUntil = g.tick + 600;
    return true;
  };
}
function coastTileOf(g: Game, p: number, nearX: number): number {
  let best = -1, bd = Infinity;
  for (const i of g.players[p].border) if (g.isCoast(i)) {
    const d = Math.abs(g.xOf(i) - nearX);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('== testMap: boats ==');
{
  const map = testMap(7);
  const g = setup(map);
  const A = newPlayer(g, 'Aurelia', 20000, 100000);
  const B = newPlayer(g, 'Borea', 20000, 100000);
  for (let i = 0; i < g.N; i++) {
    if (!g.isLand(i)) continue;
    const x = g.xOf(i);
    if (x < 150) g.setOwner(i, A.id); else if (x > 250) g.setOwner(i, B.id);
  }
  const attacks: [number, number, number][] = [];
  finishInstall(g, attacks);
  console.log(`water components: ${(g.ext.naval.nav as WaterNav).compSize.length - 1}, A tiles ${A.tiles}, B tiles ${B.tiles}`);

  // pick a B tile in the middle of B's land
  let target = -1;
  for (const i of B.border) if (g.isCoast(i) && g.xOf(i) > 280) { target = i; break; }
  check(target >= 0, 'found B target');
  check(g.q.canBoat(A.id, target) === null, `canBoat A→B ok (${g.q.canBoat(A.id, target)})`);
  check(g.q.canBoat(A.id, coastTileOf(g, A.id, 100)) === 'È già tuo', 'own tile refused');
  check(g.q.canBoat(A.id, g.idx(1, 1)) === 'Scegli una terra', 'water refused');

  const t0 = performance.now();
  const ok = g.cmd.sendBoat(A.id, target, 3000);
  console.log(`  sendBoat (route search) ${(performance.now() - t0).toFixed(2)} ms`);
  check(ok, 'sendBoat accepted');
  check(A.troops === 17000, 'troops subtracted at launch');
  const boat = g.units.find(u => u.type === 'transport')!;
  check(!!boat && Array.isArray(boat.ext.path) && boat.ext.path.length >= 2, `boat has a route (${boat?.ext.path.length} waypoints, ${boat?.ext.length?.toFixed(0)} tiles)`);
  let landed: any = null, onWater = true, ticks = 0;
  g.on(ev => { if (ev.type === 'boatLanded') landed = ev; });
  const beforeA = A.tiles;
  while (!landed && ticks < 2000) { g.step(); ticks++; if (!boatsOnWater(g)) onWater = false; }
  check(onWater, 'boat never on land');
  check(!!landed, `boat landed after ${ticks} ticks`);
  check(A.tiles > beforeA && A.tiles - beforeA <= 7, `beachhead +${A.tiles - beforeA} tiles`);
  check(g.owner[boat.toTile] === A.id, 'landing tile captured');
  check(attacks.length === 1 && attacks[0][0] === A.id && attacks[0][1] === B.id && attacks[0][2] > 0,
    `land hand-off attack(${attacks[0]?.join(', ')})`);
  check(g.units.every(u => u.type !== 'transport'), 'transport removed');

  // limits (new target: the old one is now ours)
  for (const i of B.border) if (g.isCoast(i) && g.xOf(i) > 300) { target = i; break; }
  A.troops = 10;
  check(g.q.canBoat(A.id, target) === 'Truppe insufficienti', 'low troops refused');
  A.troops = 100000;
  let sent = 0;
  for (let k = 0; k < 5; k++) if (g.cmd.sendBoat(A.id, target, 500)) sent++;
  check(sent === 3, `max 3 boats without ports (sent ${sent})`);
  check(g.q.canBoat(A.id, target) === 'Troppe navi in mare', 'too many boats refused');
  // ally landing: make allies mid-trip → troops join pool
  A.allies.add(B.id); B.allies.add(A.id);
  check(g.q.canBoat(A.id, g.idx(300, 120)) === 'È un tuo alleato' || !g.isLand(g.idx(300, 120)) || g.owner[g.idx(300, 120)] !== B.id, 'ally target refused');
  const poolBefore = A.troops, nAtt = attacks.length;
  for (let k = 0; k < 2000 && g.units.some(u => u.type === 'transport'); k++) g.step();
  check(A.troops === poolBefore + 1500 && attacks.length === nAtt, `allied landing joins pool (+${A.troops - poolBefore})`);
  A.allies.clear(); B.allies.clear();
  // unclaimed land target
  let free = -1;
  for (let i = 0; i < g.N; i++) if (g.isLand(i) && g.owner[i] === 0) { free = i; break; }
  check(free < 0 || g.q.canBoat(A.id, free) === null, 'unclaimed land target allowed');
  check(tilesConsistent(g), 'sum(player.tiles) matches owner grid');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('== unreachable seas ==');
{
  // two seas separated by a land wall; A on the west sea, B island in the east sea
  const W = 200, H = 100;
  const terrain = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let land = x >= 60 && x < 140;
    if (x >= 165 && x < 180 && y >= 40 && y < 60) land = true; // island in the east sea
    terrain[y * W + x] = land ? PLAINS : WATER;
  }
  const g = setup({ name: 'seas', width: W, height: H, terrain, nations: [] });
  const A = newPlayer(g, 'A', 5000);
  const B = newPlayer(g, 'B', 5000);
  for (let y = 0; y < H; y++) for (let x = 60; x < 75; x++) g.setOwner(y * W + x, A.id);
  for (let y = 40; y < 60; y++) for (let x = 165; x < 180; x++) g.setOwner(y * W + x, B.id);
  finishInstall(g, []);
  check(g.q.canBoat(A.id, g.idx(170, 50)) === 'Nessuna costa raggiungibile', `unreachable island refused (${g.q.canBoat(A.id, g.idx(170, 50))})`);
  check(!g.cmd.sendBoat(A.id, g.idx(170, 50), 1000), 'sendBoat refused');
  const C = newPlayer(g, 'C', 5000);
  for (let y = 0; y < 30; y++) for (let x = 125; x < 140; x++) g.setOwner(y * W + x, C.id);
  check(g.q.canBoat(A.id, g.idx(130, 10)) === 'Nessuna costa raggiungibile', 'east coast unreachable from west coast');
  check(g.q.canBoat(C.id, g.idx(170, 50)) === null, 'C (east coast) can reach the island');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('== trade ==');
{
  const g = setup(testMap(7));
  const A = newPlayer(g, 'A', 1000, 0);
  const B = newPlayer(g, 'B', 1000, 0);
  for (let i = 0; i < g.N; i++) {
    if (!g.isLand(i)) continue;
    const x = g.xOf(i);
    if (x < 150) g.setOwner(i, A.id); else if (x > 250) g.setOwner(i, B.id);
  }
  finishInstall(g, []);
  // two ports each, on coast tiles far apart
  const pick = (p: Player, xs: number[]) => xs.map(x => coastTileOf(g, p.id, x));
  for (const t of pick(A, [20, 140])) g.addStructure('port', A.id, t, 0);
  for (const t of pick(B, [260, 380])) g.addStructure('port', B.id, t, 0);
  const pairs = new Map<string, number>();
  let onWater = true, maxShips = 0;
  const seen = new Set<number>();
  for (let k = 0; k < 2000; k++) {
    g.step();
    if (!boatsOnWater(g)) onWater = false;
    for (const u of g.units) if (u.type === 'trade' && !seen.has(u.id)) {
      seen.add(u.id);
      const key = `${u.owner}->${(u.ext.dstPort as any).owner}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
    maxShips = Math.max(maxShips, g.units.filter(u => u.type === 'trade').length);
  }
  console.log('  trade launches', Object.fromEntries(pairs), 'gold A', A.gold, 'B', B.gold);
  check(onWater, 'trade ships never on land');
  check(A.gold > 0 && B.gold > 0, 'trade pays both sides');
  check(maxShips <= 8, `per-port cap respected (max ${maxShips} ships for 4 ports)`);
  check((pairs.get('1->2') ?? 0) + (pairs.get('2->1') ?? 0) > (pairs.get('1->1') ?? 0) + (pairs.get('2->2') ?? 0), 'foreign trade preferred');
  // embargo
  A.embargoes.add(B.id);
  for (let k = 0; k < 400; k++) g.step(); // let in-flight ships finish
  const pairs2 = new Map<string, number>();
  const gA = A.gold, gB = B.gold;
  for (let k = 0; k < 2000; k++) {
    g.step();
    for (const u of g.units) if (u.type === 'trade' && !seen.has(u.id)) {
      seen.add(u.id);
      const key = `${u.owner}->${(u.ext.dstPort as any).owner}`;
      pairs2.set(key, (pairs2.get(key) ?? 0) + 1);
    }
  }
  console.log('  after embargo', Object.fromEntries(pairs2), 'gold +A', A.gold - gA, '+B', B.gold - gB);
  check(!pairs2.has('1->2') && !pairs2.has('2->1'), 'embargo stops A↔B trade');
  check((pairs2.get('1->1') ?? 0) > 0, 'own-port trade continues');
  // destroyed destination mid-trip
  const ship = g.units.find(u => u.type === 'trade');
  if (ship) {
    g.removeStructure(ship.ext.dstPort);
    g.step();
    check(!ship.alive, 'ship to a destroyed port is dropped');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('== nukes ==');
{
  const g = setup(testMap(7));
  const A = newPlayer(g, 'A', 20000, 1e6);
  const B = newPlayer(g, 'B', 20000, 0);
  for (let i = 0; i < g.N; i++) {
    if (!g.isLand(i)) continue;
    const x = g.xOf(i);
    if (x < 150) g.setOwner(i, A.id); else if (x > 250) g.setOwner(i, B.id);
  }
  finishInstall(g, []);
  // target: B tile with plenty of land around
  let target = -1, bestLand = 0;
  for (let y = 20; y < 220; y += 4) for (let x = 270; x < 380; x += 4) {
    let n = 0;
    for (let dy = -12; dy <= 12; dy += 2) for (let dx = -12; dx <= 12; dx += 2) if (g.owner[g.idx(x + dx, y + dy)] === B.id) n++;
    if (n > bestLand) { bestLand = n; target = g.idx(x, y); }
  }
  check(g.q.canNuke(A.id, 'atom', target) === 'Nessun silo', 'no silo refused');
  let siloTile = -1;
  for (const i of A.border) { siloTile = i; break; }
  for (let i = 0; i < g.N; i++) if (g.owner[i] === A.id && g.xOf(i) > 60 && g.xOf(i) < 100) { siloTile = i; break; }
  const silo = g.addStructure('silo', A.id, siloTile, 0);
  check(g.q.canNuke(A.id, 'atom', target) === null, 'canNuke ok');
  check(g.q.canNuke(A.id, 'atom', siloTile) === 'È il tuo territorio', 'own land refused');
  A.allies.add(B.id); B.allies.add(A.id);
  check(g.q.canNuke(A.id, 'atom', target) === 'È un tuo alleato', 'ally refused');
  A.allies.clear(); B.allies.clear();
  // structure + boat in the blast
  const city = g.addStructure('city', B.id, target + 2, 0);
  const tx = g.xOf(target), ty = g.yOf(target);
  // a fake ship parked on water near the target (or at the target position if none)
  let wt = -1;
  for (let r = 0; r < 10 && wt < 0; r++) for (let dx = -r; dx <= r && wt < 0; dx++) {
    const i = g.idx(tx + dx, ty + r);
    if (g.isWater(i)) wt = i;
  }
  const fakeShip: Unit = g.addUnit('trade', B.id, target, target, 0);
  fakeShip.x = wt >= 0 ? g.xOf(wt) : tx; fakeShip.y = wt >= 0 ? g.yOf(wt) : ty;
  fakeShip.ext.path = [wt >= 0 ? wt : target]; fakeShip.ext.pathIndex = 1;
  const bTiles = B.tiles, bTroops = B.troops, gold0 = A.gold;
  let explosion: any = null, launched = false;
  g.on(ev => { if (ev.type === 'explosion') explosion = ev; if (ev.type === 'nukeLaunched') launched = true; });
  const msgs: any[] = [];
  g.on(ev => { if (ev.type === 'message') msgs.push(ev); });
  check(g.cmd.launchNuke(A.id, 'atom', target), 'launchNuke accepted');
  check(launched && A.gold === gold0 - 1500 && silo.cooldownUntil > g.tick, 'gold spent, silo on cooldown, event');
  check(msgs.some(m => m.to === B.id && m.level === 'danger'), 'target owner warned');
  check(g.q.canNuke(A.id, 'atom', target) === 'Silo in ricarica', 'silo reload refused');
  const nuke = g.units.find(u => u.type === 'atom')!;
  let ticks = 0;
  while (!explosion && ticks < 500) { g.step(); ticks++; }
  const dist = Math.hypot(tx - silo.x, ty - silo.y);
  check(!!explosion, `nuke arrived after ${ticks} ticks (dist ${dist.toFixed(0)}, ~${Math.ceil(dist / 3)} expected)`);
  check(!nuke.alive && !g.units.includes(nuke), 'nuke unit removed');
  const lostTiles = bTiles - B.tiles;
  check(lostTiles > 300 && lostTiles < 600, `blast cleared ${lostTiles} B tiles (πr²≈452)`);
  check(g.owner[target] === 0 && g.fallout[target] > 200, 'ground zero unowned with fallout');
  const expTroops = bTroops * (1 - lostTiles / bTiles);
  check(Math.abs(B.troops - expTroops) < 1, `B troops ${bTroops} → ${B.troops.toFixed(0)} (proportional)`);
  check(!g.structures.includes(city), 'city in blast destroyed');
  check(!fakeShip.alive, 'ship in blast sunk');
  check(explosion.victims.length === 1 && explosion.victims[0] === B.id, 'victims = [B]');
  check(tilesConsistent(g), 'sum(player.tiles) matches owner grid');

  // betrayal: nuke an ally's neighbour land, catching ally tiles
  silo.cooldownUntil = 0;
  const C = newPlayer(g, 'C', 1000, 0);
  // give C a strip next to remaining B land near target
  let cTarget = -1;
  for (let i = 0; i < g.N; i++) if (g.owner[i] === B.id && Math.abs(g.yOf(i) - ty) > 30) { cTarget = i; break; }
  const cx = g.xOf(cTarget), cy = g.yOf(cTarget);
  for (let dy = -3; dy <= 3; dy++) for (let dx = 3; dx <= 8; dx++) { const i = g.idx(cx + dx, cy + dy); if (g.owner[i] === B.id) g.setOwner(i, C.id); }
  A.allies.add(C.id); C.allies.add(A.id);
  check(g.cmd.launchNuke(A.id, 'atom', cTarget), 'launch next to ally');
  for (let k = 0; k < 400 && g.units.some(u => u.type === 'atom'); k++) g.step();
  check(!A.allies.has(C.id), 'hitting an ally breaks the alliance');

  // fallout decay
  let t2 = 0;
  const falloutAny = () => { for (let i = 0; i < g.N; i++) if (g.fallout[i]) return true; return false; };
  check(falloutAny(), 'fallout present');
  const hasBands = new Set<number>();
  while (falloutAny() && t2 < 2000) { g.step(); t2++; if (t2 === 300) hasBands.add(g.fallout[target]); }
  check(!falloutAny(), `fallout decayed to zero after ${(t2 / 10).toFixed(0)} s`);
  check(g.ext.nukes.falloutTiles() === 0, 'fallout list empty');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('== SAM odds ==');
for (const kind of ['atom', 'hydrogen'] as const) {
  const g = setup(testMap(7));
  const A = newPlayer(g, 'A', 1e6, 1e9);
  const B = newPlayer(g, 'B', 1e6, 0);
  for (let i = 0; i < g.N; i++) {
    if (!g.isLand(i)) continue;
    const x = g.xOf(i);
    if (x < 150) g.setOwner(i, A.id); else if (x > 250) g.setOwner(i, B.id);
  }
  finishInstall(g, []);
  let siloTile = -1;
  for (let i = 0; i < g.N; i++) if (g.owner[i] === A.id && g.xOf(i) > 60) { siloTile = i; break; }
  const silo = g.addStructure('silo', A.id, siloTile, 0);
  // SAM on B land, target 38 tiles away (in range, outside both blast radii... hydrogen 30)
  let samTile = -1;
  for (let i = 0; i < g.N; i++) if (g.owner[i] === B.id && g.xOf(i) > 330 && g.yOf(i) > 100) { samTile = i; break; }
  const sam = g.addStructure('sam', B.id, samTile, 0);
  const target = g.idx(g.xOf(samTile) - 38, g.yOf(samTile)); // out to sea/land west of the SAM: still within range
  let inter = 0, boom = 0;
  g.on(ev => { if (ev.type === 'nukeIntercepted') inter++; if (ev.type === 'explosion') boom++; });
  const trials = 600;
  for (let k = 0; k < trials; k++) {
    silo.cooldownUntil = 0; sam.cooldownUntil = 0;
    if (!g.cmd.launchNuke(A.id, kind, target)) { console.log('launch refused', g.q.canNuke(A.id, kind, target)); break; }
    while (g.units.some(u => u.type === kind)) g.step();
  }
  const rate = inter / (inter + boom);
  const want = kind === 'atom' ? 0.7 : 0.35;
  check(Math.abs(rate - want) < 0.06 && inter + boom === trials, `${kind}: intercepted ${(rate * 100).toFixed(1)}% of ${trials} (target ${want * 100}%)`);
  check(g.structures.includes(sam), 'SAM survived (outside blast)');
  void SAM_RANGE;
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('== timing: 1600×800 ==');
{
  const tI = performance.now();
  const map = testMap(11, 1600, 800);
  const g = setup(map, 5);
  g.trackChanges = false;
  // 24 players: partition land by nearest of 24 random seeds
  const P = 24;
  const seeds: [number, number][] = [];
  for (let k = 0; k < P; k++) seeds.push([Math.floor(g.rng() * 1600), Math.floor(g.rng() * 800)]);
  const players = seeds.map((_, k) => newPlayer(g, 'P' + k, 1e6, 1e9));
  for (let i = 0; i < g.N; i++) {
    if (!g.isLand(i)) continue;
    const x = g.xOf(i), y = g.yOf(i);
    let best = 0, bd = Infinity;
    for (let k = 0; k < P; k++) { const d = (x - seeds[k][0]) ** 2 + (y - seeds[k][1]) ** 2; if (d < bd) { bd = d; best = k; } }
    g.setOwner(i, players[best].id);
  }
  const tA = performance.now();
  const attacks: [number, number, number][] = [];
  finishInstall(g, attacks);
  console.log(`  land ${g.landTiles}, water comps ${(g.ext.naval.nav as WaterNav).compSize.length - 1}, install ${(performance.now() - tA).toFixed(1)} ms (setup ${(tA - tI).toFixed(0)} ms)`);
  // ports: 5 per player on coast tiles
  for (const p of players) {
    const coast = [...p.border].filter(i => g.isCoast(i));
    for (let k = 0; k < 5 && coast.length; k++) {
      const t = coast[Math.floor(g.rng() * coast.length)];
      if (!g.structureAt.has(t)) g.addStructure('port', p.id, t, 0);
    }
  }
  // canBoat spam
  let tc = performance.now(), calls = 0;
  const landList: number[] = [];
  for (let i = 0; i < g.N; i += 97) if (g.isLand(i)) landList.push(i);
  let refused = 0;
  for (let k = 0; k < 20000; k++) {
    if (k % 500 === 0) g.tick += 10; // expire the caches like a running game would
    const p = players[k % P].id;
    if (g.q.canBoat(p, landList[Math.floor(g.rng() * landList.length)]) !== null) refused++;
    calls++;
  }
  g.tick = 0;
  console.log(`  canBoat spam: ${((performance.now() - tc) * 1000 / calls).toFixed(1)} µs/call over land targets, ${refused} refused`);
  for (let k = 0; k < 900; k++) g.step(); // trade ramp-up
  // 60 transports, long routes
  let sent = 0, sendMs = 0, worstSend = 0;
  for (let k = 0; k < 400 && sent < 60; k++) {
    const p = players[k % P];
    // farthest-ish target: pick random land owned by someone else at > 500 tiles
    let t = -1;
    for (let tries = 0; tries < 50; tries++) {
      const c = Math.floor(g.rng() * g.N);
      if (g.isLand(c) && g.owner[c] !== p.id && Math.abs(g.xOf(c) - p.sumX / p.tiles) > 500) { t = c; break; }
    }
    if (t < 0) continue;
    const a = performance.now();
    if (g.cmd.sendBoat(p.id, t, 2000)) sent++;
    const dt = performance.now() - a; sendMs += dt; worstSend = Math.max(worstSend, dt);
  }
  console.log(`  ${sent} transports launched, sendBoat avg ${(sendMs / Math.max(1, sent)).toFixed(2)} ms worst ${worstSend.toFixed(1)} ms`);
  check(sent >= 50, 'launched ~60 transports');
  // 20 silos far west, targets far east
  const west = players.filter(p => p.sumX / p.tiles < 500);
  const east = players.filter(p => p.sumX / p.tiles > 1100);
  let launched = 0;
  for (let k = 0; k < 20; k++) {
    const p = west[k % west.length];
    const tiles = [...p.border];
    const st = tiles[Math.floor(g.rng() * tiles.length)];
    if (!g.structureAt.has(st)) g.addStructure('silo', p.id, st, 0);
  }
  for (const p of east) { // a few SAMs
    const tiles = [...p.border];
    for (let k = 0; k < 3; k++) { const st = tiles[Math.floor(g.rng() * tiles.length)]; if (!g.structureAt.has(st)) g.addStructure('sam', p.id, st, 0); }
  }
  // wait for trade to ramp up first, then fire nukes and measure
  let onWater = true;
  for (let k = 0; k < 20; k++) { g.step(); if (k % 10 === 0 && !boatsOnWater(g)) onWater = false; }
  for (let k = 0; k < 200 && launched < 20; k++) {
    const p = west[k % west.length], e = east[k % east.length];
    const tiles = [...e.border];
    if (g.cmd.launchNuke(p.id, k % 3 ? 'atom' : 'hydrogen', tiles[Math.floor(g.rng() * tiles.length)])) launched++;
    for (const s of g.structures) if (s.type === 'silo') s.cooldownUntil = 0;
  }
  const count = (t: string) => g.units.filter(u => u.type === t && u.alive).length;
  console.log(`  in flight: trade ${count('trade')} transports ${count('transport')} nukes ${count('atom') + count('hydrogen')}`);
  const T = 100;
  const t0 = performance.now();
  let worst = 0;
  for (let k = 0; k < T; k++) { const a = performance.now(); g.step(); worst = Math.max(worst, performance.now() - a); }
  const avg = (performance.now() - t0) / T;
  console.log(`  after: trade ${count('trade')} transports ${count('transport')} nukes ${count('atom') + count('hydrogen')}`);
  check(avg < 1, `ms/tick ${avg.toFixed(3)} (worst ${worst.toFixed(2)}) with trade+transports+nukes`);
  // run to the end: boats keep to water, all nukes land
  for (let k = 0; k < 1500; k++) { g.step(); if (k % 5 === 0 && !boatsOnWater(g)) onWater = false; }
  check(onWater, 'no boat on land on the big map');
  check(tilesConsistent(g), 'sum(player.tiles) matches owner grid (big map)');
  let peakFall = 0;
  const t1 = performance.now();
  for (let k = 0; k < 100; k++) g.step();
  peakFall = g.ext.nukes.falloutTiles();
  console.log(`  steady tail ${((performance.now() - t1) / 100).toFixed(3)} ms/tick, fallout tiles ${peakFall}, landings→attack calls ${attacks.length}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
