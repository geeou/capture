// LAND agent tests for advanced fronts / supply / economy.   npx tsx tools/adv-land-test.ts
// Builds a tiny all-plains map with two nations (A = left half, B = right half), keeps only the systems under
// test (no AI, no diplomacy) and checks each rule of docs/ADVANCED.md §1–3.
import { createGame } from '../src/sim/index';
import { PLAINS, WATER, type MapData } from '../src/sim/types';
import { ADV } from '../src/sim/adv/rules';
import type { Attack, GameEvent } from '../src/sim/types';

let fails = 0, passes = 0;
const ok = (cond: boolean, what: string, extra = '') => {
  if (cond) passes++; else fails++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${what}${extra ? '  (' + extra + ')' : ''}`);
};

const MW = 200, MH = 100;
function flatMap(): MapData {
  const terrain = new Uint8Array(MW * MH);
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++)
    terrain[y * MW + x] = x < 2 || y < 2 || x >= MW - 2 || y >= MH - 2 ? WATER : PLAINS;
  return { name: 'flat', width: MW, height: MH, terrain, nations: [
    { name: 'Alfa', x: 30, y: 50, strength: 1 }, { name: 'Beta', x: 170, y: 50, strength: 0.9 },
  ] };
}
const KEEP = new Set(['economy', 'attacks', 'adv-supply', 'adv-economy']);
function setup() {
  const g = createGame(flatMap(), { seed: 3, humanSpawn: null, nations: 2, tribes: 0, advanced: true, fog: false });
  g.systems = g.systems.filter(s => KEEP.has(s.name));
  const A = g.players[1], B = g.players[2];
  for (let y = 2; y < MH - 2; y++) for (let x = 2; x < MW - 2; x++) g.setOwner(g.idx(x, y), x < 100 ? A.id : B.id);
  const events: GameEvent[] = [];
  g.on(e => events.push(e));
  return { g, A, B, adv: g.adv!, events };
}
const run = (g: ReturnType<typeof setup>['g'], n: number) => { for (let k = 0; k < n; k++) g.step(); };

// ── 1. focused attack only takes tiles inside the radius ────────────────────
{
  const { g, A, B, adv } = setup();
  A.troops = 60000; B.troops = 2000;
  const fx = 110, fy = 50, focus = g.idx(fx, fy);
  ok(adv.q.canAttackAt(A.id, focus) === null, 'canAttackAt allows a focus near the border');
  ok(adv.q.canAttackAt(A.id, g.idx(170, 50)) !== null, 'canAttackAt refuses a focus far from the border', String(adv.q.canAttackAt(A.id, g.idx(170, 50))));
  const before = new Uint16Array(g.owner);
  ok(adv.cmd.attackAt(A.id, focus, 30000), 'attackAt accepted');
  const atk = g.attacks.find(a => a.attacker === A.id && a.target === B.id);
  ok(!!atk && atk.ext.focus?.x === fx && atk.ext.focus?.y === fy, 'attack.ext.focus is set');
  run(g, 150);
  let taken = 0, outside = 0;
  const R2 = ADV.focusRadius * ADV.focusRadius;
  for (let i = 0; i < g.N; i++) if (before[i] === B.id && g.owner[i] === A.id) {
    taken++;
    const dx = i % MW - fx, dy = ((i / MW) | 0) - fy;
    if (dx * dx + dy * dy > R2) outside++;
  }
  ok(taken > 100 && outside === 0, 'focused attack takes tiles only inside the focus radius', `taken=${taken} outside=${outside}`);
  // classic cmd.attack clears the focus
  if (atk && atk.alive) { g.cmd.attack(A.id, B.id, 100); ok(!atk.ext.focus, 'classic cmd.attack clears the focus'); }
}

// ── 2. stance multipliers + cooldown ────────────────────────────────────────
{
  const { g, A, B, adv } = setup();
  const t = g.idx(150, 30);
  const fake = (): Attack => ({ id: 999999, attacker: A.id, target: B.id, troops: 1, startTroops: 1, alive: true, ext: {} });
  const d0 = g.q.defenseAt(t), a0 = g.hmul(g.hooks.attackMul, fake(), t);
  ok(adv.cmd.setStance(B.id, 'defense'), 'setStance(defense) accepted');
  ok(Math.abs(g.q.defenseAt(t) / d0 - ADV.stance.defense.def) < 1e-9, 'defence stance multiplies tile defence', `${(g.q.defenseAt(t) / d0).toFixed(3)}`);
  ok(adv.cmd.setStance(A.id, 'offense'), 'setStance(offense) accepted');
  ok(Math.abs(g.hmul(g.hooks.attackMul, fake(), t) / a0 - ADV.stance.offense.atk) < 1e-9, 'offense stance multiplies attack strength');
  ok(!adv.cmd.setStance(A.id, 'balanced'), 'stance change refused during cooldown');
  run(g, ADV.stanceCooldown - 2);
  ok(!adv.cmd.setStance(A.id, 'balanced'), 'still refused just before the cooldown ends');
  run(g, 3);
  ok(adv.cmd.setStance(A.id, 'balanced'), 'stance change allowed after the cooldown');
  // focus bonus via attackMul
  const f = fake(); f.ext.focus = { x: 150, y: 30 };
  ok(Math.abs(g.hmul(g.hooks.attackMul, f, t) / g.hmul(g.hooks.attackMul, fake(), t) - ADV.focusBonus) < 1e-9, 'focused attack gets focusBonus');
}

// ── 3. supply falls with distance ───────────────────────────────────────────
{
  const { g, A, adv } = setup();
  const s = [10, 60, 100, 140, 167].map(x => adv.q.supply(A.id, g.idx(30 + x, 50)));
  ok(s[0] === 1 && s[1] === 1, 'full supply near the capital', s.map(v => v.toFixed(3)).join(' '));
  ok(s[2] < 1 && s[3] < s[2] && s[4] < s[3] && s[4] >= ADV.supplyMin, 'supply falls with distance, not below supplyMin');
  adv.players[A.id].doctrine.level.blitz = 2;
  g.step(); // hub cache
  ok(adv.q.supply(A.id, g.idx(130, 50)) > s[2], 'Blitz II extends supply range');
}

// ── 4. encircled pocket: flagged cut, defends worse, surrenders ─────────────
{
  const { g, A, B, adv, events } = setup();
  const pocket: number[] = [];
  for (let y = 20; y < 26; y++) for (let x = 160; x < 166; x++) { const t = g.idx(x, y); g.setOwner(t, A.id); pocket.push(t); }
  const d0 = g.q.defenseAt(pocket[0]);
  run(g, ADV.supplyScanPeriod + 1);
  ok(pocket.every(t => adv.q.isCut(t)) && adv.cut[pocket[0]] === 1, 'pocket is flagged cut', `cutTiles=${adv.players[A.id].cutTiles}`);
  ok(!adv.q.isCut(g.idx(30, 50)), 'main territory is not cut');
  ok(Math.abs(g.q.defenseAt(pocket[0]) / d0 - ADV.cutDefense) < 1e-9, 'cut tiles defend at ×cutDefense');
  const troops0 = A.troops;
  run(g, ADV.cutSurrenderTicks + ADV.supplyScanPeriod);
  const ev = events.find(e => e.type === 'pocketLost');
  ok(pocket.every(t => g.owner[t] === B.id), 'pocket surrendered to the surrounding neighbour');
  ok(!!ev && ev.type === 'pocketLost' && ev.owner === A.id && ev.to === B.id && ev.tiles === pocket.length, 'pocketLost event emitted');
  ok(pocket.every(t => !adv.cut[t]), 'cut flags cleared after surrender');
  ok(A.troops < troops0 + 1e6, 'owner still alive', `troops ${Math.round(troops0)}→${Math.round(A.troops)}`);
}
{ // Fortress III: holds twice as long
  const { g, A, adv } = setup();
  adv.players[A.id].doctrine.level.fortress = 3;
  const pocket: number[] = [];
  for (let y = 20; y < 26; y++) for (let x = 160; x < 166; x++) { const t = g.idx(x, y); g.setOwner(t, A.id); pocket.push(t); }
  run(g, ADV.cutSurrenderTicks + 2 * ADV.supplyScanPeriod);
  ok(pocket.every(t => g.owner[t] === A.id), 'Fortress III pocket still holds after cutSurrenderTicks');
}

// ── 5. capital capture ──────────────────────────────────────────────────────
{
  const { g, A, B, adv, events } = setup();
  const cap = adv.players[A.id].capital;
  ok(cap === g.idx(30, 50), 'capital starts at the spawn', `cap=${cap}`);
  const city = g.addStructure('city', A.id, g.idx(60, 70), 0);
  g.step();
  A.troops = 20000; A.gold = 10000; B.gold = 0;
  ok(adv.q.canMoveCapital(A.id, city.tile) === null, 'canMoveCapital ok for a finished own city');
  g.setOwner(cap, B.id);
  g.step();
  const ev = events.find(e => e.type === 'capitalLost');
  ok(!!ev && ev.type === 'capitalLost' && ev.owner === A.id && ev.by === B.id && ev.tile === cap, 'capitalLost event');
  ok(A.troops < 20000 * (1 - ADV.capitalLossTroops) + 200, 'capital loss costs troops', `${Math.round(A.troops)}`);
  ok(Math.abs(B.gold - 10000 * ADV.capitalLootGold) < 200, 'captor loots gold', `${Math.round(B.gold)}`);
  ok(adv.players[A.id].capital === city.tile, 'capital moved to the remaining city');
  ok(events.some(e => e.type === 'capitalMoved' && e.owner === A.id), 'capitalMoved event');
  // manual move back requires gold and a city
  ok(adv.q.canMoveCapital(A.id, city.tile) !== null, 'cannot move capital onto the current capital');
  const c2 = g.addStructure('city', A.id, g.idx(40, 20), 0); g.step();
  const gold0 = A.gold;
  ok(adv.cmd.moveCapital(A.id, c2.tile) && adv.players[A.id].capital === c2.tile && Math.abs(gold0 - A.gold - ADV.capitalMoveCost) < 50, 'moveCapital relocates for capitalMoveCost');
}

// ── 6. workers slider ───────────────────────────────────────────────────────
{
  const { g, A, adv } = setup();
  A.troops = 1000;
  const at = (w: number) => { adv.cmd.setWorkers(A.id, w); return { g: g.q.goldRate(A.id), t: g.q.troopRate(A.id) }; };
  const mid = at(0.5), hi = at(1), lo = at(0);
  ok(hi.g > mid.g && mid.g > lo.g, 'more workers = more gold', `${lo.g.toFixed(2)} ${mid.g.toFixed(2)} ${hi.g.toFixed(2)}`);
  ok(hi.t < mid.t && mid.t < lo.t, 'more workers = less troop growth', `${lo.t.toFixed(1)} ${mid.t.toFixed(1)} ${hi.t.toFixed(1)}`);
  ok(Math.abs(hi.t / mid.t - 0.5) < 1e-9 && Math.abs(lo.t / mid.t - 1.5) < 1e-9, 'troop growth ×(1.5 − w)');
}

// ── 7. upkeep ───────────────────────────────────────────────────────────────
{
  const { g, A, adv } = setup();
  g.step();
  const g0 = g.q.goldRate(A.id);
  for (let k = 0; k < 6; k++) g.addStructure('city', A.id, g.idx(20 + k * 8, 80), 0);
  run(g, 11);
  const expect = (6 - ADV.upkeepFree) * ADV.upkeep.city;
  ok(Math.abs(adv.players[A.id].upkeep - expect) < 1e-9, 'upkeep charged only beyond the free allowance', `${adv.players[A.id].upkeep}`);
  ok(Math.abs(g0 - g.q.goldRate(A.id) - expect) < 1e-6, 'upkeep lowers the gold rate');
  // bankrupt: gold clamps at 0 and troop growth halves
  for (let k = 0; k < 60; k++) g.addStructure('silo', A.id, g.idx(10 + (k % 20) * 4, 10 + ((k / 20) | 0) * 4), 0);
  A.gold = 50; A.troops = 1000;
  run(g, 30); // upkeep is refreshed every 10 ticks
  ok(g.q.goldRate(A.id) < 0 && A.gold === 0, 'gold never goes below 0', `rate=${g.q.goldRate(A.id).toFixed(2)} gold=${A.gold}`);
  A.troops = 1000;
  const tBroke = g.q.troopRate(A.id);
  A.gold = 1e6; g.step(); A.troops = 1000;
  const tRich = g.q.troopRate(A.id);
  ok(Math.abs(tBroke / tRich - 0.5) < 0.02, 'troop growth halved while broke', `${(tBroke / tRich).toFixed(3)}`);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
