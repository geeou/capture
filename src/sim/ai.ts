// CAPTURE — bot AI for nations and tribes. Owner: diplomacy/AI agent.
//
// Every bot acts only through game.cmd.* / game.q.*, exactly like the human. Each bot "thinks" every
// DIFF.period ticks on its own phase (tribes every TRIBE_PERIOD), so per tick only ~1/period of them work.
// One think, in order: defend (counter incoming attacks, pull troops home) → grab free land → war
// (score land neighbours, open up to 1–4 fronts: land attacks are frontier-limited, so several fronts beat
// one big push) → boats → build → nukes → diplomacy (every 4th think).
// Boats: short hops normally; when a bot has had no land target for a while (or is the leader) it crosses
// oceans, landing at random points of a big rival's coast so each beachhead becomes a new front.
//
// Personality (seeded, per nation): aggr · greed · loyal · naval · nuke, 0..1. Tribes: passive.
// Leader pressure: once someone owns ≥ COALITION_SHARE of the land, everybody else leans towards
// allying with each other, refuses the leader, and prefers it as war/boat/nuke target.
import type { Game } from './game';
import { SAM_RANGE } from './nukes';
import {
  WATER,
  type Attack, type AllianceRequest, type NukeKind, type Player, type PlayerId, type Structure, type StructureType, type Tile,
} from './types';

// ── tuning ──────────────────────────────────────────────────────────────────
const DIFF = {
  easy: { period: 20, minRatio: 1.3, commit: 0.75, humanBias: -0.9, humanCap: 1, coalition: 0.7, humanAccept: 0.8, hesitate: 0.3, humanFriend: 15 },
  normal: { period: 15, minRatio: 1.0, commit: 1.0, humanBias: 0, humanCap: 2, coalition: 1.0, humanAccept: 0, hesitate: 0.1, humanFriend: 0 },
  hard: { period: 10, minRatio: 0.9, commit: 1.1, humanBias: 0.25, humanCap: 3, coalition: 1.5, humanAccept: -0.5, hesitate: 0, humanFriend: -5 },
};
const TRIBE_PERIOD = 25;
/** Land grab: send this share of troops whenever troops > GRAB_MIN of cap. */
const GRAB_SHARE = 0.4;
const GRAB_MIN = 0.25;
const COALITION_SHARE = 0.35;
/** No silos before ≈5.5 min, no nukes before 7 min. */
const NUKE_MIN_TICK = 4200;
const SILO_MIN_TICK = 3300;
/** Global spacing between bot proposals to the human (ticks), and per bot. */
const HUMAN_PROPOSE_GLOBAL = 900;
const HUMAN_PROPOSE_BOT = 2400;
/** Bot boat launches: min ticks between any two (route searches are costly), max straight distance. */
const BOAT_GLOBAL_GAP = 4;
const BOAT_MAX_DIST = 450;
const TYPE_IDX: Record<StructureType, number> = { city: 0, port: 1, fort: 2, factory: 3, silo: 4, sam: 5 };

interface Pers { aggr: number; greed: number; loyal: number; naval: number; nuke: number }
interface AIState {
  pers: Pers;
  phase: number;
  thinks: number;
  war: PlayerId;
  lastBuild: number;
  lastBoat: number;
  lastNuke: number;
  lastRetreat: number;
  lastHumanPropose: number;
  coastComps: number[];
  coastTick: number;
  threat: PlayerId;
  /** Consecutive thinks without any land target (free land or a viable enemy). */
  idle: number;
}

const EMPTY: Attack[] = [];
const cand: { k: PlayerId; s: number }[] = [];

export function installAI(game: Game): void {
  const W = game.W, H = game.H, N = game.N, owner = game.owner;
  const q = game.q, cmd = game.cmd, rng = game.rng;
  let D = DIFF[game.difficulty] ?? DIFF.normal;

  // ── per-player structure index (events keep it in sync) ──────────────────
  const owned = new Map<PlayerId, Structure[]>();
  const listOf = (id: PlayerId) => { let l = owned.get(id); if (!l) { l = []; owned.set(id, l); } return l; };
  const drop = (id: PlayerId, s: Structure) => { const l = owned.get(id); if (!l) return; const k = l.indexOf(s); if (k >= 0) { l[k] = l[l.length - 1]; l.pop(); } };
  for (const s of game.structures) listOf(s.owner).push(s);
  const count = (id: PlayerId, type: StructureType) => { let n = 0; for (const s of owned.get(id) ?? []) if (s.type === type) n++; return n; };

  // ── global coast list (for "free land across the sea") ───────────────────
  let coastN = 0;
  const coastTiles = (() => {
    const tmp: number[] = [];
    for (let i = 0; i < N; i++) if (game.terrain[i] !== WATER && game.isCoast(i)) tmp.push(i);
    coastN = tmp.length;
    return Int32Array.from(tmp);
  })();
  const naval = () => game.ext.naval as undefined | {
    waterCompsOf: (i: Tile) => number[]; boatsAtSea: (p: PlayerId) => number; maxBoats: (p: PlayerId) => number;
  };

  // ── personalities ────────────────────────────────────────────────────────
  const S = (p: Player): AIState => {
    let st = p.ext.ai as AIState | undefined;
    if (!st) {
      const r = () => rng();
      const tribe = p.kind === 'tribe';
      const pers: Pers = tribe
        ? { aggr: 0.1, greed: 0, loyal: 0.6, naval: 0, nuke: 0 }
        : { aggr: 0.2 + 0.8 * r(), greed: r(), loyal: r(), naval: r(), nuke: r() };
      st = {
        pers, phase: Math.floor(r() * 1000), thinks: 0, war: 0,
        lastBuild: 0, lastBoat: -1e9, lastNuke: -1e9, lastRetreat: -1e9, lastHumanPropose: -1e9,
        coastComps: [], coastTick: -1e9, threat: 0, idle: 0,
      };
      p.ext.ai = st;
    }
    return st;
  };
  for (const p of game.players) if (p.id && p.kind !== 'human') S(p);

  const stats = { thinks: 0, eligible: 0, ratioFail: 0, noCand: 0, lowScore: 0, launched: 0, busy: 0, amtFail: 0, fracSum: 0 };
  // ── per-tick indexes ─────────────────────────────────────────────────────
  let idxTick = -1;
  const outAtt = new Map<PlayerId, Attack[]>();
  const inAtt = new Map<PlayerId, Attack[]>();
  let humanAttackers = 0;
  const index = () => {
    if (idxTick === game.tick) return;
    idxTick = game.tick;
    outAtt.clear(); inAtt.clear(); humanAttackers = 0;
    const seen = new Set<PlayerId>();
    for (const a of game.attacks) {
      if (!a.alive) continue;
      let l = outAtt.get(a.attacker); if (!l) { l = []; outAtt.set(a.attacker, l); } l.push(a);
      if (a.target) {
        let m = inAtt.get(a.target); if (!m) { m = []; inAtt.set(a.target, m); } m.push(a);
        if (a.target === game.humanId && !seen.has(a.attacker)) { seen.add(a.attacker); humanAttackers++; }
      }
    }
  };

  let leader: PlayerId = 0, leaderShare = 0;
  /** Living player ids, refreshed with the leader (every 20 ticks). */
  const living: PlayerId[] = [];
  const updateLeader = () => {
    let best = 0, bt = -1;
    living.length = 0;
    for (let id = 1; id < game.players.length; id++) {
      const p = game.players[id];
      if (!p.alive) continue;
      living.push(id);
      if (p.tiles > bt) { bt = p.tiles; best = id; }
    }
    leader = best; leaderShare = best ? bt / game.landTiles : 0;
  };
  const coalition = () => leaderShare >= COALITION_SHARE;

  // ── helpers ──────────────────────────────────────────────────────────────
  const cx = (p: Player) => p.sumX / Math.max(1, p.tiles);
  const cy = (p: Player) => p.sumY / Math.max(1, p.tiles);
  const alive = (id: PlayerId) => id > 0 && game.players[id].alive;
  // ── advanced-mode helpers (never used in classic matches: game.advanced is false there) ──
  /** Advanced: a pact (or other hook) forbids `a` from attacking `b`. */
  const forbidden = (a: PlayerId, b: PlayerId): boolean => game.advanced && !!b && game.hwhy(game.hooks.forbidAttack, a, b) !== null;
  /** Advanced: reputation of a player (-100..100), 0 in classic matches. */
  const repOf = (id: PlayerId): number => (game.advanced && game.adv ? game.adv.players[id]?.reputation ?? 0 : 0);
  /** Attack a player: in advanced matches through the advanced AI (focused attack at a sensible point). */
  const atk = (id: PlayerId, k: PlayerId, amt: number): boolean => {
    const ax = game.advanced && k ? game.ext.advAI as undefined | { attack: (a: PlayerId, b: PlayerId, n: number) => boolean } : undefined;
    return ax ? ax.attack(id, k, amt) : cmd.attack(id, k, amt);
  };
  const idxClamp = (x: number, y: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= H) return -1;
    return yi * W + xi;
  };

  /** Owned tile near the centroid that accepts `type`, or -1. */
  const interiorSpot = (p: Player, type: StructureType, tries = 10, spread = 0.75): Tile => {
    const r = Math.sqrt(p.tiles / Math.PI) * spread + 2;
    const x0 = cx(p), y0 = cy(p);
    for (let k = 0; k < tries; k++) {
      const a = rng() * 6.2832, d = Math.sqrt(rng()) * r;
      const i = idxClamp(x0 + Math.cos(a) * d, y0 + Math.sin(a) * d);
      if (i >= 0 && owner[i] === p.id && q.canBuild(p.id, type, i) === null) return i;
    }
    return -1;
  };
  const nearSpot = (p: Player, x: number, y: number, type: StructureType, rmin: number, rmax: number, tries = 8): Tile => {
    for (let k = 0; k < tries; k++) {
      const a = rng() * 6.2832, d = rmin + rng() * (rmax - rmin);
      const i = idxClamp(x + Math.cos(a) * d, y + Math.sin(a) * d);
      if (i >= 0 && owner[i] === p.id && q.canBuild(p.id, type, i) === null) return i;
    }
    return -1;
  };
  /** Coast tile of mine for a port. */
  const coastSpot = (p: Player): Tile => {
    const skip = Math.floor(rng() * Math.max(1, p.border.size));
    let k = 0, tested = 0;
    for (const i of p.border) {
      if (k++ < skip) continue;
      if (!game.isCoast(i)) continue;
      if (q.canBuild(p.id, 'port', i) === null) return i;
      if (++tested > 12) break;
    }
    return -1;
  };
  /** Tile of mine a few tiles inside the border facing `e`. */
  const frontSpot = (p: Player, e: Player): Tile => {
    const x0 = cx(e), y0 = cy(e), x1 = cx(p), y1 = cy(p);
    const len = Math.hypot(x1 - x0, y1 - y0);
    if (len < 1) return -1;
    const steps = Math.min(200, Math.ceil(len / 2));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const i = idxClamp(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t);
      if (i < 0 || owner[i] !== p.id) continue;
      // hit our land: go ~4 tiles further in, try a few jittered spots
      const t2 = Math.min(1, t + 4 / len);
      return nearSpot(p, x0 + (x1 - x0) * t2, y0 + (y1 - y0) * t2, 'fort', 0, 4, 6);
    }
    return -1;
  };

  const myCoastComps = (p: Player, st: AIState): number[] => {
    if (game.tick - st.coastTick < 300) return st.coastComps;
    st.coastTick = game.tick;
    const nv = naval();
    const out: number[] = [];
    if (nv) {
      let k = 0;
      for (const i of p.border) {
        if (!game.isCoast(i)) continue;
        for (const c of nv.waterCompsOf(i)) if (!out.includes(c)) out.push(c);
        if (++k > 3000) break;
      }
    }
    st.coastComps = out;
    return out;
  };
  const reachable = (comps: number[], tile: Tile): boolean => {
    const nv = naval();
    if (!nv) return false;
    for (const c of nv.waterCompsOf(tile)) if (comps.includes(c)) return true;
    return false;
  };

  // ── think ────────────────────────────────────────────────────────────────
  const think = (p: Player): void => {
    const id = p.id, st = S(p), t = game.tick;
    const tribe = p.kind === 'tribe';
    st.thinks++;
    index();
    const cap = q.maxTroops(id);
    if (cap <= 0) return;
    const nb = game.neighborsOf(id);
    const mine = outAtt.get(id) ?? EMPTY;
    const incoming = inAtt.get(id) ?? EMPTY;
    if (st.war && (!alive(st.war) || game.areAllied(id, st.war))) st.war = 0;

    // 1. defence ------------------------------------------------------------
    let incomingTroops = 0;
    st.threat = 0;
    let bigThreat = 0;
    for (const a of incoming) {
      const X = a.attacker;
      if (!alive(X) || game.areAllied(id, X)) continue;
      incomingTroops += a.troops;
      if (game.advanced && forbidden(id, X)) continue;
      if (a.troops > bigThreat) { bigThreat = a.troops; st.threat = X; }
      if (a.troops < 20) continue;
      const counter = mine.find(m => m.target === X);
      if (counter && counter.troops >= a.troops * 0.6) continue;
      if (p.troops < a.troops * 0.6) continue;
      // Density already defends; countering cancels troop for troop, so only do it to punish a weaker
      // aggressor or to blunt an attack big enough to hurt.
      const weaker = game.players[X].troops < p.troops * 0.8;
      const big = a.troops > p.troops * 0.35;
      if (!weaker && !big) continue;
      const amt = Math.min(p.troops * 0.5, weaker ? a.troops * 1.2 + 20 : a.troops * 0.8);
      if (amt >= 20) atk(id, X, amt);
    }
    // pull troops home: overwhelmed while busy elsewhere
    if (incomingTroops > p.troops * 1.5 && t - st.lastRetreat > 50) {
      let worst: Attack | null = null;
      for (const a of mine) {
        if (!a.target || a.troops < 50) continue;
        if (incoming.some(x => x.attacker === a.target)) continue; // this one is the counter
        if (!worst || a.troops > worst.troops) worst = a;
      }
      if (worst && cmd.retreat(worst.id)) st.lastRetreat = t;
    }
    // retreat from hopeless wars
    for (const a of mine) {
      if (!a.target || !alive(a.target)) continue;
      const E = game.players[a.target];
      if (E.troops > 4 * (a.troops + p.troops) && a.troops > 30 && t - st.lastRetreat > 50) {
        if (cmd.retreat(a.id)) { st.lastRetreat = t; if (st.war === a.target) st.war = 0; }
        break;
      }
    }

    // 2. land grab ----------------------------------------------------------
    const free = nb.get(0) ?? 0;
    if (free > 0 && p.troops > cap * GRAB_MIN) {
      const ex = mine.find(a => a.target === 0);
      if (!ex || ex.troops < p.troops * 0.25) cmd.attack(id, 0, p.troops * (tribe ? 0.35 : GRAB_SHARE));
    }

    // 3. war ----------------------------------------------------------------
    let warLaunched = false;
    const frac = p.troops / cap;
    const pers = st.pers;
    const startFrac = tribe ? 0.6 : 0.47 - 0.15 * pers.aggr + (game.difficulty === 'easy' ? 0.08 : 0);
    if (!tribe) { stats.thinks++; stats.fracSum += frac; if (frac >= startFrac) stats.eligible++; }
    if (frac >= startFrac && (!tribe || rng() < 0.08) && rng() >= D.hesitate) {
      // Attacks are frontier-limited (a front advances ~0.5 tile/s whatever the troops), so a strong bot
      // opens several fronts at once instead of piling everything on one.
      let hostileStrong = 0;
      cand.length = 0;
      for (const [k, shared] of nb) {
        if (!k || !alive(k) || game.areAllied(id, k)) continue;
        if (game.advanced && forbidden(id, k)) continue;
        const E = game.players[k];
        if (tribe && E.kind !== 'tribe') continue;
        const ratio = p.troops / Math.max(1, E.troops);
        const rel = q.relation(id, k);
        if (E.troops > p.troops * 0.8 && (rel < -10 || st.threat === k)) hostileStrong = Math.max(hostileStrong, E.troops);
        const isLeader = k === leader && coalition();
        let minR = (tribe ? 3 : 1.1 - 0.5 * pers.aggr) * D.minRatio;
        if (isLeader) minR *= 0.6 / D.coalition;
        if (E.traitorUntil > t) minR *= 0.8;
        const eff = (p.troops / Math.max(1, p.tiles)) / Math.max(0.05, E.troops / Math.max(1, E.tiles));
        if (ratio < minR && !(eff >= 1.6 && ratio >= minR * 0.6)) { if (!tribe) stats.ratioFail++; continue; }
        if (k === game.humanId) {
          const already = mine.some(a => a.target === k);
          if (!already && humanAttackers >= D.humanCap) continue;
        }
        let sc = (0.5 + pers.aggr) * Math.log2(ratio) + 0.6 * Math.log2(Math.min(8, eff));
        sc += Math.min(1, shared / Math.max(4, Math.sqrt(p.tiles))) * 0.6;
        if (E.traitorUntil > t) sc += 0.7;
        if ((inAtt.get(k) ?? EMPTY).some(a => a.attacker !== id)) sc += 0.6;
        const efrac = E.troops / Math.max(1, q.maxTroops(k));
        if (efrac < 0.25) sc += (0.25 - efrac) * 4; // drained: strike now
        sc -= rel / 50;
        if (E.tiles < p.tiles * 0.35) sc += 0.5;
        if (E.tiles < p.tiles * 0.15 && ratio > 1.5) sc += 1.0;
        if (isLeader) sc += 1.0 * D.coalition + (leaderShare > 0.5 ? 1 : 0);
        if (k === game.humanId) sc += D.humanBias;
        if (E.kind === 'tribe') sc += 0.3;
        if (st.war === k) sc += 0.8;
        if (game.advanced) sc -= repOf(k) / 100; // the untrustworthy make good targets
        // opposing attacks cancel troop for troop: hit someone else unless we clearly outgun them
        const theirs = incoming.find(x => x.attacker === k);
        if (theirs && ratio < 1.5) sc -= 1.2;
        else if (st.threat === k) sc += 0.5;
        if (free > 0 && free * 3 > p.border.size) sc -= 0.8; // still plenty of free land to grab
        sc += (rng() - 0.5) * 0.5;
        if (sc > 0) cand.push({ k, s: sc });
      }
      if (!tribe && !cand.length) stats.noCand++;
      st.idle = cand.length || free > 0 ? 0 : st.idle + 1;
      cand.sort((a, b) => b.s - a.s);
      const maxFronts = tribe ? 1 : 1 + Math.round(pers.aggr * 2) + (frac > 0.65 ? 1 : 0);
      const share = (tribe ? 0.3 : 0.3 + 0.25 * pers.aggr) * D.commit;
      const reserve = hostileStrong ? p.troops * 0.3 * (1 - 0.4 * pers.aggr) : 0;
      const floor = Math.max(reserve, cap * startFrac * 0.5);
      let fronts = 0;
      for (const c of cand) {
        if (fronts >= maxFronts) break;
        const E = game.players[c.k];
        const ex = mine.find(a => a.target === c.k);
        const dens = E.troops / Math.max(1, E.tiles);
        if (ex) {
          // enough fuel for ~15 s at the front's current width?
          const F = (ex.ext.frontier as number | undefined) ?? 50;
          if (ex.troops >= Math.min(p.troops * 0.3, F * 7.5 * (1 + dens))) { fronts++; if (!tribe) stats.busy++; continue; }
        }
        const amt = Math.min(p.troops * share * (fronts ? 0.7 : 1), p.troops - floor);
        if (amt >= 30 && amt / (1 + dens * 1.2) >= 12 && atk(id, c.k, amt)) {
          if (!fronts || st.war === 0) st.war = c.k;
          fronts++;
          if (!tribe) stats.launched++;
          warLaunched = true;
        } else { if (!tribe) stats.amtFail++; break; }
      }
    }
    if (tribe) { if (st.thinks % 4 === 0) diplomacyTribe(p); return; }

    // 4. boats --------------------------------------------------------------
    if (st.thinks % 2 === 0) boats(p, st, cap, free > 0, warLaunched);
    // 5. build --------------------------------------------------------------
    build(p, st, nb);
    // 6. nukes --------------------------------------------------------------
    if (st.thinks % 3 === 1) nukes(p, st);
    // 7. diplomacy ----------------------------------------------------------
    if (st.thinks % 4 === 2) diplomacy(p, st, nb);
  };

  // ── boats ────────────────────────────────────────────────────────────────
  let lastAnyBoat = -1e9;
  const boats = (p: Player, st: AIState, cap: number, freeHere: boolean, warLaunched: boolean): void => {
    const nv = naval();
    if (!nv) return;
    const id = p.id, t = game.tick, pers = st.pers;
    if (p.troops < cap * 0.45) return;
    const cd = (450 - 300 * pers.naval) * (game.difficulty === 'easy' ? 1.5 : 1) * (p.troops > cap * 0.7 ? 0.5 : 1);
    if (t - st.lastBoat < cd) return;
    if (nv.boatsAtSea(id) >= nv.maxBoats(id)) return;
    // sendBoat may run a long route search: at most one bot launch every few ticks overall
    if (t - lastAnyBoat < BOAT_GLOBAL_GAP) return;
    const idle = !freeHere && !warLaunched;
    if (rng() > (idle ? 0.5 + 0.5 * pers.naval : 0.1 * pers.naval)) return;
    const comps = myCoastComps(p, st);
    if (!comps.length) return;
    const force = p.troops * (0.22 + 0.15 * pers.naval);
    if (force < 60) return;
    const x0 = cx(p), y0 = cy(p);
    // short hops normally; once there has been nothing to fight on land for a while, cross any ocean
    const maxD = st.idle > 8 ? 1e9 : BOAT_MAX_DIST;

    // a) unclaimed coast reachable by sea
    let bestTile = -1, bestD = Infinity;
    if (coastN) for (let k = 0; k < 10; k++) {
      const i = coastTiles[Math.floor(rng() * coastN)];
      if (owner[i] !== 0 || game.fallout[i]) continue;
      const d = (i % W - x0) ** 2 + (((i / W) | 0) - y0) ** 2;
      if (d > maxD * maxD || d >= bestD || !reachable(comps, i)) continue;
      if (d < bestD) { bestD = d; bestTile = i; }
    }
    // b) a weak or hated player across the water (also the leader)
    if (bestTile < 0 || rng() < 0.4) {
      let bestS = -Infinity, pick = -1;
      const ps = game.players;
      for (let k = 0; k < 6 && living.length; k++) {
        // the leader is always a candidate under coalition pressure; else a random living player
        const o = k === 0 && coalition() ? leader : living[Math.floor(rng() * living.length)];
        const E = ps[o];
        if (!E.alive || o === id || game.areAllied(id, o) || E.tiles < 10) continue;
        if (game.advanced && forbidden(id, o)) continue;
        if (o === game.humanId && humanAttackers >= D.humanCap) continue;
        const dens = E.troops / Math.max(1, E.tiles);
        if (force < dens * 1.5 * 7 * 2 + E.troops * 0.25) continue;
        // weakness, hatred, and how much land there is to take (big rivals matter in the end game)
        let s = Math.min(2, force / (E.troops + 50)) - q.relation(id, o) / 40 + (E.tiles / game.landTiles) * (st.idle > 8 || id === leader ? 8 : 3);
        if (o === leader && coalition()) s += 1.5 * D.coalition;
        if (o === game.humanId) s += D.humanBias;
        const dist = Math.hypot(cx(E) - x0, cy(E) - y0);
        if (dist > maxD * 1.3) continue;
        s -= dist / (st.idle > 8 || id === leader ? 1200 : 400);
        if (s <= bestS) continue;
        // aim at their heartland: the centroid if it is theirs (the landing is then the nearest reachable
        // coast), else the reachable coast tile closest to it (a tiny exclave would end the attack at once)
        // A big rival is invaded at random points of its coast instead: every beachhead is a new front.
        const ex = cx(E), ey = cy(E);
        let tile = idxClamp(ex, ey);
        if (E.tiles > game.landTiles * 0.05) {
          tile = -1;
          const skip = Math.floor(rng() * E.border.size);
          let n = 0, tested = 0;
          for (const b of E.border) {
            if (n++ < skip || !game.isCoast(b)) continue;
            if (reachable(comps, b)) { tile = b; break; }
            if (++tested > 300) break;
          }
        } else if (tile < 0 || owner[tile] !== o) {
          tile = -1;
          let n = 0, bd = Infinity;
          for (const b of E.border) {
            if (++n > 600) break;
            if (!game.isCoast(b)) continue;
            const d = (b % W - ex) ** 2 + (((b / W) | 0) - ey) ** 2;
            if (d < bd && reachable(comps, b)) { bd = d; tile = b; }
          }
        }
        if (tile >= 0) { bestS = s; pick = tile; }
      }
      if (pick >= 0 && (bestTile < 0 || bestS > 0.5)) bestTile = pick;
    }
    if (bestTile < 0) return;
    if (q.canBoat(id, bestTile) !== null) return;
    lastAnyBoat = t;
    if (cmd.sendBoat(id, bestTile, force)) st.lastBoat = t;
  };

  // ── economy ──────────────────────────────────────────────────────────────
  const build = (p: Player, st: AIState, nb: Map<PlayerId, number>): void => {
    const id = p.id, t = game.tick, pers = st.pers;
    const gap = (70 - 40 * pers.greed) * (game.difficulty === 'easy' ? 1.4 : game.difficulty === 'hard' ? 0.8 : 1);
    if (t - st.lastBuild < gap) return;
    const n = p.tiles;
    const c = [0, 0, 0, 0, 0, 0];
    for (const s of owned.get(id) ?? []) c[TYPE_IDX[s.type]]++;
    const [cities, ports, forts, factories, silos, sams] = c;
    const coastal = myCoastComps(p, st).length > 0;
    // hostile border: strong neighbour that dislikes us or attacks us
    let hostile: Player | null = null, hs = 0;
    for (const [k] of nb) {
      if (!k || !alive(k) || game.areAllied(id, k)) continue;
      const E = game.players[k];
      const danger = E.troops / Math.max(1, p.troops) + (st.threat === k ? 1 : 0) - q.relation(id, k) / 50;
      if (E.troops > p.troops * 0.7 && danger > hs) { hs = danger; hostile = E; }
    }
    const wantCities = Math.min(10, 1 + Math.floor(Math.sqrt(n / 250)));
    const wantFactories = Math.min(5, 1 + Math.floor(n / 2500) + (pers.greed > 0.7 ? 1 : 0));
    const wantPorts = coastal ? Math.min(3, 1 + Math.floor(n / 6000)) : 0;
    const wantForts = hostile && hs > 1.2 ? Math.min(6, 1 + Math.floor(n / 2500)) : 0;
    const siloOk = pers.nuke > 0.2 && t >= SILO_MIN_TICK && n >= Math.max(1200, game.landTiles * 0.02);
    const wantSilos = siloOk ? (n > game.landTiles * 0.08 && pers.nuke > 0.6 ? 2 : 1) : 0;
    const wantSams = t >= SILO_MIN_TICK && n >= Math.max(1500, game.landTiles * 0.025) ? Math.min(3, 1 + Math.floor(n / 8000)) : 0;

    const order: StructureType[] = [];
    if (pers.greed > 0.5) { if (factories < 1) order.push('factory'); if (cities < 1) order.push('city'); }
    else { if (cities < 1) order.push('city'); if (factories < 1) order.push('factory'); }
    if (ports < 1 && wantPorts) order.push('port');
    if (forts < 1 && wantForts) order.push('fort');
    if (cities < Math.min(2, wantCities)) order.push('city');
    if (factories < Math.min(2, wantFactories)) order.push('factory');
    if (silos < wantSilos) order.push('silo');
    if (cities < wantCities) order.push('city');
    if (sams < wantSams && (silos > 0 || !siloOk)) order.push('sam');
    if (factories < wantFactories) order.push('factory');
    if (forts < wantForts) order.push('fort');
    if (ports < wantPorts) order.push('port');
    if (!order.length) { st.lastBuild = t; return; }
    const type = order[0];
    const cost = q.buildCost(id, type);
    // keep money for a bomb once a silo stands
    const reserve = silos > 0 && type !== 'sam' ? q.nukeCost(id, 'atom') * pers.nuke : 0;
    if (p.gold < cost + reserve) return;
    let tile = -1;
    if (type === 'port') tile = coastSpot(p);
    else if (type === 'fort') tile = hostile ? frontSpot(p, hostile) : -1;
    else if (type === 'sam') {
      const l = (owned.get(id) ?? []).filter(s => s.type === 'silo' || s.type === 'city' || s.type === 'factory');
      const anchor = l.length ? l[Math.floor(rng() * l.length)] : null;
      tile = anchor ? nearSpot(p, anchor.x, anchor.y, 'sam', 5, 12) : interiorSpot(p, 'sam');
    } else tile = interiorSpot(p, type, 10, type === 'silo' ? 0.45 : 0.75);
    st.lastBuild = t; // failed placement also waits a beat
    if (tile >= 0) cmd.build(id, type, tile);
  };

  // ── nukes ────────────────────────────────────────────────────────────────
  const blastSafe = (p: Player, tile: Tile, r: number): boolean => {
    const x = tile % W, y = (tile / W) | 0;
    for (const f of [0.5, 1.15]) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * 6.2832;
        const i = idxClamp(x + Math.cos(a) * r * f, y + Math.sin(a) * r * f);
        if (i < 0) continue;
        const o = owner[i];
        if (o === p.id || (o && game.areAllied(p.id, o))) return false;
      }
    }
    return true;
  };
  const samCovered = (E: PlayerId, x: number, y: number): boolean => {
    for (const s of owned.get(E) ?? []) {
      if (s.type !== 'sam') continue;
      if ((s.x - x) ** 2 + (s.y - y) ** 2 <= (SAM_RANGE + 2) ** 2) return true;
    }
    return false;
  };
  const nukes = (p: Player, st: AIState): void => {
    const id = p.id, t = game.tick, pers = st.pers;
    if (t < NUKE_MIN_TICK || pers.nuke < 0.15) return;
    if (p.gold < q.nukeCost(id, 'atom') * 1.2) return;
    if (t - st.lastNuke < 500 / (0.3 + pers.nuke)) return;
    let silo = false;
    for (const s of owned.get(id) ?? []) if (s.type === 'silo' && s.readyTick <= t && s.cooldownUntil <= t) { silo = true; break; }
    if (!silo) return;
    if (rng() > 0.3 + 0.6 * pers.nuke) return;
    // target player: leader (coalition) > war target > strongest hostile neighbour
    let X: PlayerId = 0;
    if (coalition() && leader !== id && !game.areAllied(id, leader) && !(game.advanced && forbidden(id, leader))) X = leader;
    else {
      let bs = 0;
      for (const [k] of game.neighborsOf(id)) {
        if (!k || !alive(k) || game.areAllied(id, k)) continue;
        if (game.advanced && forbidden(id, k)) continue;
        const E = game.players[k];
        const rel = q.relation(id, k);
        if (rel > -15 && k !== st.war) continue;
        if (k === game.humanId && game.difficulty === 'easy' && rel > -60) continue;
        const s = E.tiles * (E.troops / Math.max(1, p.troops)) * (k === st.war ? 1.5 : 1) * (1 - rel / 100);
        if (s > bs) { bs = s; X = k; }
      }
    }
    if (!X) return;
    const E = game.players[X];
    if (E.tiles < 300) return;
    const kind: NukeKind = p.gold > q.nukeCost(id, 'hydrogen') * 2 + 1000 && pers.nuke > 0.6 && E.tiles > game.landTiles * 0.02 ? 'hydrogen' : 'atom';
    const r = q.nukeRadius(kind);
    // candidate aim points: their structures outside SAM cover, then their centroid
    const cands: Tile[] = [];
    for (const s of owned.get(X) ?? []) if (s.type !== 'fort' && !samCovered(X, s.x, s.y)) cands.push(s.tile);
    const cTile = idxClamp(cx(E), cy(E));
    if (cTile >= 0 && owner[cTile] === X) cands.push(cTile);
    for (const s of owned.get(X) ?? []) if (s.type !== 'fort' && samCovered(X, s.x, s.y)) cands.push(s.tile);
    for (let k = 0; k < Math.min(cands.length, 6); k++) {
      const tile = cands[k];
      if (owner[tile] !== X || !blastSafe(p, tile, r)) continue;
      if (q.canNuke(id, kind, tile) !== null) continue;
      if (cmd.launchNuke(id, kind, tile)) { st.lastNuke = t; return; }
    }
    st.lastNuke = t - 100; // nothing safe: look again a bit later
  };

  // ── diplomacy ────────────────────────────────────────────────────────────
  let lastHumanProposal = -1e9;
  const dipx = () => game.ext.diplomacy as undefined | {
    canPropose: (a: PlayerId, b: PlayerId) => string | null; allianceEndsAt: (a: PlayerId, b: PlayerId) => number;
  };

  /** Shared enemy of `id` and `k`: the coalition leader or `id`'s current threat bordering k. */
  const sharedThreat = (id: PlayerId, k: PlayerId, st: AIState): boolean => {
    if (coalition() && leader !== id && leader !== k) return true;
    const th = st.threat;
    return !!th && th !== k && alive(th) && game.neighborsOf(k).has(th);
  };

  const diplomacy = (p: Player, st: AIState, nb: Map<PlayerId, number>): void => {
    const id = p.id, t = game.tick, pers = st.pers;
    const dx = dipx();
    // embargoes on players we hate
    const rels = p.ext.dip?.rel as Map<PlayerId, unknown> | undefined;
    if (rels) for (const k of rels.keys()) {
      if (!alive(k)) continue;
      const r = q.relation(id, k);
      if (r < -60 && !p.embargoes.has(k)) cmd.setEmbargo(id, k, true);
      else if (r > -20 && p.embargoes.has(k)) cmd.setEmbargo(id, k, false);
    }
    // betrayal: treacherous bots stab a much weaker neighbouring ally
    if (pers.loyal < 0.2 && pers.aggr > 0.5) {
      for (const k of p.allies) {
        const A = game.players[k];
        if (!nb.has(k) || A.troops > p.troops * 0.2 || A.tiles > p.tiles * 0.5) continue;
        if (k === game.humanId && game.difficulty === 'easy') continue;
        if (rng() < 0.06) {
          if (cmd.breakAlliance(id, k)) { st.war = k; atk(id, k, p.troops * 0.5); }
          return;
        }
      }
    }
    // coalition: drop renewing with the leader
    if (!dx || p.allies.size >= 4) return;
    let best = 0, bestS = 30;
    const consider = (k: PlayerId) => {
      if (!k || k === id || !alive(k)) return;
      const E = game.players[k];
      if (E.kind === 'tribe') return;
      const allied = game.areAllied(id, k);
      if (allied && dx.allianceEndsAt(id, k) - t > 600) return;
      let s = q.relation(id, k) + pers.loyal * 10;
      if (sharedThreat(id, k, st)) s += 25 * (k === game.humanId ? 1 : D.coalition);
      if (E.troops > p.troops * 1.3 && nb.has(k)) s += 15;
      if (st.threat === k || st.war === k) s -= 40;
      if (coalition() && k === leader) s -= 50;
      if (E.traitorUntil > t) s -= 40;
      if (allied) s += 15;
      if (game.advanced) s += repOf(k) / 3;
      if (k === game.humanId) {
        if (t - lastHumanProposal < HUMAN_PROPOSE_GLOBAL || t - st.lastHumanPropose < HUMAN_PROPOSE_BOT) return;
        s += D.humanFriend;
        if (game.difficulty === 'hard' && !sharedThreat(id, k, st)) return;
      }
      if (s > bestS && dx.canPropose(id, k) === null) { bestS = s; best = k; }
    };
    for (const [k] of nb) consider(k);
    for (const k of p.allies) if (!nb.has(k)) consider(k);
    if (best && rng() < 0.6 && cmd.proposeAlliance(id, best)) {
      if (best === game.humanId) { lastHumanProposal = t; st.lastHumanPropose = t; }
    }
  };
  const diplomacyTribe = (_p: Player): void => { /* tribes never propose */ };

  /** Should bot `me` accept an alliance from `f`? */
  const accepts = (me: Player, f: Player): boolean => {
    const st = S(me), pers = st.pers, id = me.id;
    if (!game.areAllied(id, f.id) && me.allies.size >= 4) return false;
    if (coalition() && f.id === leader) return false;
    let s = q.relation(id, f.id) / 40 + pers.loyal * 0.5 - 0.3;
    const nb = game.neighborsOf(id);
    if (nb.has(f.id) && f.troops > me.troops * 1.5) s += 0.8;
    if (sharedThreat(id, f.id, st)) s += 0.8 * D.coalition;
    if (st.war === f.id) s -= f.troops * 1.5 < me.troops ? 1.5 : 0.5;
    if (st.threat === f.id) s += 0.3; // a truce with the one hitting us
    if (f.traitorUntil > game.tick) s -= 1.5;
    if (me.kind === 'tribe') s += f.troops > me.troops * 3 ? 0.4 : -0.6;
    if (f.id === game.humanId) s += D.humanAccept;
    if (game.areAllied(id, f.id)) s += 0.6; // renewal
    if (game.advanced) s += repOf(f.id) / 60; // reputation: −100 → −1.7, +100 → +1.7
    s += (rng() - 0.5) * 0.4;
    return s > 0.3;
  };

  const pending: { req: AllianceRequest; due: number }[] = [];
  game.on(ev => {
    if (ev.type === 'allianceRequest') {
      const to = game.players[ev.request.to];
      if (to && to.alive && to.kind !== 'human') {
        const delay = ev.request.from === game.humanId ? 15 + Math.floor(rng() * 25) : 10 + Math.floor(rng() * 40);
        pending.push({ req: ev.request, due: game.tick + delay });
      }
    } else if (ev.type === 'structureBuilt') listOf(ev.structure.owner).push(ev.structure);
    else if (ev.type === 'structureCaptured') { drop(ev.previousOwner, ev.structure); listOf(ev.structure.owner).push(ev.structure); }
    else if (ev.type === 'structureDestroyed') drop(ev.structure.owner, ev.structure);
    else if (ev.type === 'playerDied') owned.delete(ev.id);
  });

  // ── tick ─────────────────────────────────────────────────────────────────
  game.systems.push({
    name: 'ai',
    tick() {
      const t = game.tick;
      D = DIFF[game.difficulty] ?? DIFF.normal;
      if (t % 20 === 1) updateLeader();
      if (pending.length) {
        for (let k = pending.length - 1; k >= 0; k--) {
          const { req, due } = pending[k];
          if (due > t) continue;
          pending.splice(k, 1);
          if (!game.allianceRequests.some(r => r.id === req.id)) continue;
          const me = game.players[req.to], f = game.players[req.from];
          if (!me.alive || !f.alive) continue;
          cmd.respondAlliance(req.id, accepts(me, f));
        }
      }
      const ps = game.players;
      for (let id = 1; id < ps.length; id++) {
        const p = ps[id];
        if (!p.alive || p.kind === 'human') continue;
        const st = S(p);
        const period = p.kind === 'tribe' ? TRIBE_PERIOD : D.period;
        if ((t + st.phase) % period === 0) think(p);
      }
    },
  });

  game.ext.ai = {
    personality: (id: PlayerId) => (game.players[id]?.ext.ai as AIState | undefined)?.pers,
    leader: () => ({ id: leader, share: leaderShare }),
    stats,
    count,
  };
}
