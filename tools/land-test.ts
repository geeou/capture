// Land-war test driver (economy / attacks / buildings) with simple scripted bots.
//   npx tsx tools/land-test.ts [econ|test|big|all] [ticks]
import { createGame, Game, WATER, PLAINS, HILLS, MOUNTAIN, TICKS_PER_SEC, type MapData, type NationSeed } from '../src/sim/index';
import { mulberry32 } from '../src/sim/game';
import { testMap } from '../src/sim/testmap';

const mode = process.argv[2] ?? 'all';
const TICKS = Number(process.argv[3] ?? 0);
let failures = 0;
const check = (ok: boolean, what: string) => { if (!ok) { failures++; console.log('  FAIL ' + what); } };

// ── synthetic maps ──────────────────────────────────────────────────────────
function flatMap(w: number, h: number): MapData {
  const terrain = new Uint8Array(w * h).fill(PLAINS);
  for (let x = 0; x < w; x++) { terrain[x] = WATER; terrain[(h - 1) * w + x] = WATER; }
  return { name: 'flat', width: w, height: h, terrain, nations: [] };
}
function bigMap(seed: number, w = 1600, h = 800): MapData {
  const rng = mulberry32(seed);
  const terrain = new Uint8Array(w * h);
  const waves: [number, number, number, number][] = [];
  for (let k = 0; k < 14; k++) waves.push([rng() * 0.02 + 0.003, rng() * 0.02 + 0.003, rng() * 6.28, rng() * 6.28]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (const [fx, fy, px, py] of waves) v += Math.sin(x * fx + px) * Math.cos(y * fy + py);
    v /= 3.2;
    if (x < 4 || y < 4 || x >= w - 4 || y >= h - 4) v = -1;
    terrain[y * w + x] = v < 0.12 ? WATER : v > 0.75 ? MOUNTAIN : v > 0.5 ? HILLS : PLAINS;
  }
  const nations: NationSeed[] = [];
  let tries = 20000;
  while (nations.length < 100 && tries-- > 0) {
    const x = (rng() * w) | 0, y = (rng() * h) | 0;
    if (terrain[y * w + x] === WATER) continue;
    nations.push({ name: 'N' + nations.length, x, y, strength: rng() });
  }
  return { name: 'big', width: w, height: h, terrain, nations };
}

// ── economy table ───────────────────────────────────────────────────────────
function econ(): void {
  console.log('\n== economy reference ==');
  for (const kind of ['nation', 'tribe'] as const) {
    for (const tiles of [80, 1000, 5000, 20000]) {
      const g = createGame(flatMap(400, 400), { humanSpawn: null, nations: 0, tribes: 0 });
      const p = g.addPlayer('P', kind, 0xff0000, 200, 200, 0, 0)!;
      g.addPlayer('dummy', 'tribe', 0xff, 395, 395, 1, 0); // keeps the match from ending
      const r = Math.round(Math.sqrt(tiles / Math.PI));
      // claim exactly `tiles` tiles by spiral of rings
      g.claimDisc(p.id, 200, 200, r);
      const cap = g.q.maxTroops(p.id);
      const gold = g.q.goldRate(p.id) * TICKS_PER_SEC;
      // regrow 5% → 95%
      p.troops = cap * 0.05;
      let t = 0, best = 0, bestX = 0;
      while (p.troops < cap * 0.95 && t < 5000) {
        const r = g.q.troopRate(p.id);
        if (r > best) { best = r; bestX = p.troops / cap; }
        g.step(); t++;
      }
      console.log(`${kind.padEnd(6)} tiles=${String(p.tiles).padStart(5)} cap=${Math.round(cap).toString().padStart(6)} gold=${gold.toFixed(1)}/s regrow5→95%=${(t / TICKS_PER_SEC).toFixed(0)}s peakGrowthAt=${(bestX * 100).toFixed(0)}%`);
      if (kind === 'nation' && tiles === 80) check(cap > 2000 && cap < 4500 && gold > 3 && gold < 8, 'start cap/gold');
      if (kind === 'nation' && tiles === 5000) check(cap > 40000 && cap < 90000 && gold > 25 && gold < 60, '5k cap/gold');
      if (kind === 'nation') check(t > 500 && t < 1000, 'regrow time 50-100s');
    }
  }
  // cities / factories / difficulty / decay
  const g = createGame(flatMap(400, 400), { humanSpawn: { x: 100, y: 100 }, nations: 0, tribes: 0, difficulty: 'hard' });
  const h = g.human!;
  const bot = g.addPlayer('B', 'nation', 0xff, 300, 300, 5, 1200)!;
  g.addPlayer('dummy', 'tribe', 0xff, 395, 395, 1, 0);
  h.gold = 1e6;
  const cap0 = g.q.maxTroops(h.id), g0 = g.q.goldRate(h.id);
  const tile = g.idx(100, 100);
  check(g.cmd.build(h.id, 'city', tile), 'build city');
  check(g.q.canBuild(h.id, 'city', g.idx(102, 100)) === "Troppo vicino a un'altra struttura", 'spacing reason');
  check(g.q.canBuild(h.id, 'port', g.idx(104, 100)) === 'Deve essere sulla costa', 'coast reason');
  check(g.q.canBuild(h.id, 'city', g.idx(300, 300)) === 'Non è il tuo territorio', 'territory reason');
  check(g.q.buildCost(h.id, 'city') === 700, 'city cost +40%');
  check(g.cmd.build(h.id, 'factory', g.idx(100, 96)) === false, 'spacing blocks build');
  check(g.cmd.build(h.id, 'factory', g.idx(100, 95)), 'build factory at distance 5');
  check(g.q.maxTroops(h.id) === cap0, 'city inactive while building');
  for (let i = 0; i < 70; i++) g.step();
  check(Math.abs(g.q.maxTroops(h.id) / cap0 - 1.25) < 1e-6, 'city +25% cap');
  check(Math.abs((g.q.goldRate(h.id) - g0) * 10 - 12) < 1e-6, 'factory +12 g/s');
  h.troops = bot.troops = 600;
  const rh = g.q.troopRate(h.id) / (g.q.maxTroops(h.id));
  bot.troops = 600 * g.q.maxTroops(bot.id) / g.q.maxTroops(h.id);
  const rb = g.q.troopRate(bot.id) / g.q.maxTroops(bot.id);
  check(Math.abs(rb / rh - 1.25) < 0.02, 'hard: bots +25% growth');
  h.troops = g.q.maxTroops(h.id) * 2;
  const before = h.troops; g.step();
  check(h.troops < before && h.troops > before * 0.98, 'gentle decay above cap');
  console.log(failures ? `economy: ${failures} failures` : 'economy: all checks ok');
}

// ── scripted bots ───────────────────────────────────────────────────────────
function driveBots(g: Game): void {
  const t = g.tick;
  for (let id = 1; id < g.players.length; id++) {
    const p = g.players[id];
    if (!p.alive || (t + id) % 10 !== 0) continue;
    const cap = g.q.maxTroops(id);
    const nb = g.neighborsOf(id);
    if (nb.has(0) && p.troops > cap * 0.25) { g.cmd.attack(id, 0, p.troops * 0.4); }
    else if (p.kind !== 'tribe' && p.troops > cap * 0.5) {
      let best = -1, bestD = Infinity;
      for (const [o] of nb) {
        if (!o) continue;
        const q = g.players[o];
        const d = q.troops / Math.max(1, q.tiles);
        if (d < bestD) { bestD = d; best = o; }
      }
      if (best > 0) g.cmd.attack(id, best, p.troops * 0.5);
    }
    // build sometimes
    if (p.kind !== 'tribe' && p.tiles > 300 && (t + id) % 50 === 0) {
      const types = ['city', 'factory', 'fort', 'port'] as const;
      const type = types[(t / 50 + id) % 4 | 0];
      if (p.gold >= g.q.buildCost(id, type)) {
        let tries = 30;
        const it = p.border.values();
        while (tries-- > 0) {
          const cx = Math.round(p.sumX / p.tiles + (g.rng() - 0.5) * 40), cy = Math.round(p.sumY / p.tiles + (g.rng() - 0.5) * 40);
          let tile = g.inBounds(cx, cy) ? g.idx(cx, cy) : -1;
          if (type === 'port') { const n = it.next(); if (n.done) break; tile = n.value; }
          if (tile >= 0 && g.q.canBuild(id, type, tile) === null) { g.cmd.build(id, type, tile); break; }
        }
      }
    }
  }
}

function conserved(g: Game): boolean {
  const cnt = new Int32Array(g.players.length);
  for (let i = 0; i < g.N; i++) if (g.owner[i]) cnt[g.owner[i]]++;
  for (let id = 1; id < g.players.length; id++) {
    const p = g.players[id];
    if (cnt[id] !== p.tiles) { console.log(`  mismatch ${p.name}: grid ${cnt[id]} vs tiles ${p.tiles}`); return false; }
    if (!p.alive && p.tiles) return false;
    if (!Number.isFinite(p.troops) || p.troops < 0 || !Number.isFinite(p.gold)) { console.log(`  bad numbers ${p.name}`, p.troops, p.gold); return false; }
  }
  return true;
}

function match(label: string, map: MapData, ticks: number, opts: { nations: number; tribes: number }): void {
  console.log(`\n== match ${label} ${map.width}x${map.height} ==`);
  const g = createGame(map, { seed: 3, humanSpawn: null, ...opts });
  // per-system timing
  const sysMs: Record<string, [number, number]> = {};
  for (const sys of g.systems) {
    const inner = sys.tick.bind(sys);
    const rec = (sysMs[sys.name] = [0, 0]);
    sys.tick = () => { const a = performance.now(); inner(); const d = performance.now() - a; rec[0] += d; if (d > rec[1]) rec[1] = d; };
  }
  let died = 0, annex = 0, started = 0;
  g.on(ev => {
    if (ev.type === 'playerDied') died++;
    if (ev.type === 'attackStarted') started++;
    if (ev.type === 'message' && ev.text.includes('annesso')) annex++;
  });
  console.log(`land=${g.landTiles} players=${g.players.length - 1}`);
  const first = g.players.find(p => p.kind === 'nation')!;
  let peak = 0;
  let simMs = 0, botMs = 0, worst = 0, maxAtk = 0;
  for (let t = 1; t <= ticks && !g.over; t++) {
    const a = performance.now();
    driveBots(g);
    const b = performance.now();
    g.step();
    const c = performance.now();
    botMs += b - a; simMs += c - b; worst = Math.max(worst, c - b);
    maxAtk = Math.max(maxAtk, g.attacks.length);
    if (t % 300 === 0 || g.over) {
      const top = g.alivePlayers().sort((x, y) => y.tiles - x.tiles)[0];
      const owned = g.alivePlayers().reduce((s, p) => s + p.tiles, 0);
      console.log(`t=${String(t / 10).padStart(4)}s alive=${g.alivePlayers().length} owned=${(owned / g.landTiles * 100).toFixed(0)}% atk=${g.attacks.length} structs=${g.structures.length} | ` +
        `${first.name}: ${first.tiles}t ${Math.round(first.troops)}/${Math.round(g.q.maxTroops(first.id))} ${(g.q.goldRate(first.id) * 10).toFixed(0)}g/s | ` +
        `top ${top.name} ${top.tiles}t ${Math.round(top.troops)}tr | sim ${(simMs / t).toFixed(2)}ms/tick`);
      check(conserved(g), `conservation at t=${t}`);
    }
    if (t <= 1500) peak = Math.max(peak, first.tiles);
    if (t === 1500) check(peak > 1500, `land grab: first nation peaked at ${peak} tiles in 150s`);
  }
  console.log(`done tick=${g.tick} over=${g.over} died=${died} annexed=${annex} attacksStarted=${started} maxConcurrentAttacks=${maxAtk}`);
  console.log(`sim avg ${(simMs / g.tick).toFixed(3)} ms/tick (worst ${worst.toFixed(1)}), bot driver ${(botMs / g.tick).toFixed(3)} ms/tick`);
  console.log('per system: ' + Object.entries(sysMs).map(([k, [tot, w]]) => `${k} ${(tot / g.tick).toFixed(3)}ms (worst ${w.toFixed(1)})`).join(' · '));
  check(died > 0, 'someone was eliminated');
  check(conserved(g), 'final conservation');
}

function unitAttack(): void {
  console.log('\n== attack unit checks ==');
  const g = createGame(flatMap(200, 100), { humanSpawn: null, nations: 0, tribes: 0 });
  const A = g.addPlayer('A', 'nation', 1, 50, 50, 5, 5000)!;
  const B = g.addPlayer('B', 'nation', 2, 150, 50, 5, 1200)!;
  const C = g.addPlayer('C', 'nation', 3, 150, 20, 5, 1200)!;
  check(!g.cmd.attack(A.id, B.id, 100), 'no border → refused');
  check(!g.cmd.attack(A.id, A.id, 100), 'self → refused');
  check(!g.cmd.attack(A.id, 0, 5), 'below minimum → refused');
  check(!g.cmd.attack(A.id, 0, 1e9), 'more than owned → refused');
  check(g.cmd.attack(A.id, 0, 2000), 'free land attack');
  check(g.cmd.attack(A.id, 0, 500) && g.attacks.length === 1, 'reinforcement merges');
  for (let i = 0; i < 400; i++) g.step();
  console.log(`A after 40s: ${A.tiles} tiles, attacks=${g.attacks.length}`);
  // beachhead-like contact: give B a 3-tile strip inside reach, reinforcement must pick it up
  let x = 0; while (g.owner[g.idx(x, 50)] !== A.id || g.owner[g.idx(x + 1, 50)] === A.id) x++;
  check(g.q.defenseAt(g.idx(x + 1, 50)) === 1, 'plains defence 1');
  // expand until A touches B, then war
  let tick = 0, warAt = -1;
  const bt = B.tiles;
  B.gold = 1e5;
  const fortTile = g.idx(145, 50);
  check(g.cmd.build(B.id, 'fort', fortTile), 'B builds a fort');
  for (let k = 0; k < 50; k++) g.step();
  check(g.q.defenseAt(g.idx(150, 50)) === 2.5, 'fort ×2.5 in range');
  check(g.q.defenseAt(g.idx(150, 70)) === 1, 'fort out of range');
  B.traitorUntil = g.tick + 100;
  check(g.q.defenseAt(g.idx(150, 50)) === 1.25, 'traitor halves defence');
  B.traitorUntil = 0;
  while (B.alive && tick++ < 3000) {
    if (g.tick % 10 === 0) {
      const nb = g.neighborsOf(A.id);
      if (nb.has(B.id) && A.troops > 2000) { if (warAt < 0) warAt = tick; g.cmd.attack(A.id, B.id, A.troops * 0.8); }
      else if (nb.has(0) && A.troops > 500) g.cmd.attack(A.id, 0, A.troops * 0.4);
    }
    g.step();
    if (tick % 200 === 0) console.log(`  t${tick} A=${A.tiles}/${A.troops.toFixed(0)} B tiles=${B.tiles} troops=${B.troops.toFixed(0)} atks=${g.attacks.map(a => `${a.attacker}->${a.target}:${a.troops.toFixed(0)}/${a.ext.frontier}`).join(',')}`);
  }
  check(!B.alive, `B eliminated (had ${bt}); war from tick ${warAt} to ${tick}`);
  console.log(`  B eliminated=${!B.alive} war ticks=${tick - warAt}`);
  // retreat
  check(g.cmd.attack(A.id, 0, 100), 'new free attack');
  const id = g.attacks[g.attacks.length - 1].id, tr = g.attacks[g.attacks.length - 1].troops, before = A.troops;
  check(g.cmd.retreat(id) && Math.abs(A.troops - before - tr * 0.75) < 1e-6, 'retreat refunds 75%');
  void C;
  console.log(failures ? `attacks: ${failures} failures so far` : 'attacks: all checks ok');
}

if (mode === 'econ' || mode === 'all') econ();
if (mode === 'unit' || mode === 'all') unitAttack();
if (mode === 'test' || mode === 'all') match('testMap', testMap(1), TICKS || 3000, { nations: 12, tribes: 30 });
if (mode === 'big' || mode === 'all') match('synthetic world', bigMap(5), TICKS || 3000, { nations: 88, tribes: 150 });
console.log(failures ? `\n${failures} FAILURES` : '\nALL OK');
