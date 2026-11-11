// ADVANCED MODE — bot use of the advanced systems (docs/ADVANCED.md rule 6). Owner: DIPLO agent.
//
// The classic AI (src/sim/ai.ts) keeps deciding WHOM to fight; in advanced matches it routes every attack on a
// player through game.ext.advAI.attack(), which turns it into a focused attack at a sensible point (enemy
// capital, enemy deposit, weakest reachable front tile) and falls back to the classic whole-border attack.
// On top of that each nation bot "thinks advanced" every THINK ticks on its own phase:
//   stance (defence when outnumbered or cut off, offence when pushing) · workers ratio by situation ·
//   doctrine research by personality · warships at a port when coastal with oil · fleet orders (blockade the
//   enemy's port, lift a blockade of ours) · move the capital away from a threat · react to being cut off
//   (focused break-out attack + a city inside the pocket) · scenario enemies become the classic war target.
// Every command is rate-limited per bot and backs off after a refusal, so stubs or "no" never cause spam.
// Statistics on game.ext.advAI.stats (tried / ok / refused per command).
import type { Game } from '../game';
import type { GameOptions, Player, PlayerId, Tile } from '../types';
import { WATER } from '../types';
import { ADV } from './rules';
import type { DoctrineBranch, Stance } from './types';

const THINK = 50;
const FOCUS_TTL = 150;
const NO = 'Non disponibile';

interface Pers { aggr: number; greed: number; loyal: number; naval: number; nuke: number }
interface BotAdv {
  phase: number;
  /** Per target: cached focus tile. */
  focus: Map<PlayerId, { tile: Tile; tick: number }>;
  focusBackoff: number;
  stanceTick: number;
  workersTick: number;
  researchTick: number;
  warshipTick: number;
  fleetTick: number;
  capitalTick: number;
  cutTick: number;
}
interface Stat { tried: number; ok: number; refused: number; stub: number }

export function installAdvAI(game: Game, _opts: GameOptions): void {
  const adv = game.adv!;
  const P = game.players, W = game.W, H = game.H, owner = game.owner;
  const mk = (): Stat => ({ tried: 0, ok: 0, refused: 0, stub: 0 });
  const stats: Record<string, Stat> = {
    attackAt: mk(), setStance: mk(), setWorkers: mk(), research: mk(), buildWarship: mk(), sendFleet: mk(),
    moveCapital: mk(), pocketCity: mk(), fallbackAttack: mk(),
  };
  /** Count a command attempt. `why` = the can* reason when it was asked first. */
  const note = (k: string, ok: boolean, why: string | null = null) => {
    const s = stats[k]; s.tried++;
    if (ok) s.ok++; else { s.refused++; if (why === NO) s.stub++; }
    return ok;
  };

  const S = (id: PlayerId): BotAdv => {
    const p = P[id];
    let s = p.ext.advAI as BotAdv | undefined;
    if (!s) {
      s = {
        phase: (id * 37) % THINK, focus: new Map(), focusBackoff: 0,
        stanceTick: 0, workersTick: 0, researchTick: 1200 + (id * 13) % 300, warshipTick: 0, fleetTick: 0, capitalTick: 0, cutTick: 0,
      };
      p.ext.advAI = s;
    }
    return s;
  };
  const pers = (id: PlayerId): Pers => (game.ext.ai?.personality?.(id) as Pers | undefined) ?? { aggr: 0.5, greed: 0.5, loyal: 0.5, naval: 0.5, nuke: 0.5 };
  const aiState = (id: PlayerId) => P[id].ext.ai as undefined | { war: PlayerId; threat: PlayerId };
  const alive = (id: PlayerId) => id > 0 && id < P.length && P[id].alive;
  const cx = (p: Player) => p.sumX / Math.max(1, p.tiles);
  const cy = (p: Player) => p.sumY / Math.max(1, p.tiles);
  const d2 = (i: Tile, x: number, y: number) => (i % W - x) ** 2 + (((i / W) | 0) - y) ** 2;

  // ── focus point choice ───────────────────────────────────────────────────
  const focusTile = (id: PlayerId, k: PlayerId): Tile => {
    const me = P[id];
    // 1) the enemy capital
    const cap = adv.players[k]?.capital ?? -1;
    if (cap >= 0 && owner[cap] === k && adv.q.canAttackAt(id, cap) === null) return cap;
    // 2) an enemy deposit (the three nearest to us)
    const near: { t: Tile; d: number }[] = [];
    for (const dp of adv.deposits) if (owner[dp.tile] === k) near.push({ t: dp.tile, d: d2(dp.tile, cx(me), cy(me)) });
    near.sort((a, b) => a.d - b.d);
    for (let j = 0; j < Math.min(3, near.length); j++) if (adv.q.canAttackAt(id, near[j].t) === null) return near[j].t;
    // 3) the weakest enemy tile on our common border (sampled)
    const B = me.border;
    if (!B.size) return -1;
    const skip = (game.tick * 7919 + id * 31) % B.size;
    let n = 0, seen = 0, best = -1, bestS = Infinity;
    for (const i of B) {
      if (n++ < skip) continue;
      if (++seen > 400) break;
      const x = i % W;
      const ns = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i >= W ? i - W : -1, i < game.N - W ? i + W : -1];
      for (const t of ns) {
        if (t < 0 || owner[t] !== k) continue;
        const s = game.q.defenseAt(t) * (adv.q.isCut(t) ? 0.4 : 1) / Math.max(0.2, adv.q.supply(id, t));
        if (s < bestS) { bestS = s; best = t; }
      }
      if (best >= 0 && seen > 60) break;
    }
    return best;
  };

  /** Attack player k (0 = free land) with `amt` troops: focused when possible, else whole border. */
  const attack = (id: PlayerId, k: PlayerId, amt: number): boolean => {
    if (!k) return game.cmd.attack(id, 0, amt);
    const s = S(id), t = game.tick;
    if (t >= s.focusBackoff) {
      let f = s.focus.get(k);
      if (!f || t - f.tick > FOCUS_TTL || owner[f.tile] !== k) {
        const tile = focusTile(id, k);
        f = { tile, tick: t };
        s.focus.set(k, f);
      }
      if (f.tile >= 0) {
        const why = adv.q.canAttackAt(id, f.tile);
        if (why === null && note('attackAt', adv.cmd.attackAt(id, f.tile, amt))) return true;
        if (why !== null) note('attackAt', false, why);
        if (why === NO) s.focusBackoff = t + 600;
        f.tile = -1; // re-pick next time
      }
    }
    return note('fallbackAttack', game.cmd.attack(id, k, amt));
  };

  // ── helpers ──────────────────────────────────────────────────────────────
  const waterNear = (tile: Tile, rmax = 8): Tile => {
    const x0 = tile % W, y0 = (tile / W) | 0;
    for (let r = 1; r <= rmax; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x;
      if (game.terrain[i] === WATER) return i;
    }
    return -1;
  };
  const warshipsOf = (id: PlayerId): number => {
    const f = game.ext.fleet as undefined | { count: (p: PlayerId) => number };
    if (f) return f.count(id);
    let n = 0;
    for (const u of game.units) if (u.alive && u.type === 'warship' && u.owner === id) n++;
    return n;
  };

  // ── one advanced think ───────────────────────────────────────────────────
  const think = (p: Player) => {
    const id = p.id, t = game.tick, s = S(id), ap = adv.players[id], ps = pers(id), st = aiState(id);
    if (!ap) return;
    const cap = Math.max(1, game.q.maxTroops(id));
    let incoming = 0, outgoing = 0, worst = 0, worstT = 0;
    for (const a of game.attacks) {
      if (!a.alive) continue;
      if (a.target === id && a.attacker) { incoming += a.troops; if (a.troops > worstT) { worstT = a.troops; worst = a.attacker; } }
      else if (a.attacker === id && a.target) outgoing += a.troops;
    }
    const enemyStrong = worst && alive(worst) ? P[worst].troops > p.troops * 1.5 : false;
    const outnumbered = incoming > p.troops * 0.5 || (incoming > 0 && enemyStrong);
    const cutShare = ap.cutTiles / Math.max(1, p.tiles);
    const pushing = outgoing > Math.max(incoming * 2, p.troops * 0.3);

    // scenario enemies become the classic war target once they are neighbours
    const scen = game.ext.advScenario as undefined | { enemiesOf: (id: PlayerId) => PlayerId[] };
    if (scen && st && !st.war) {
      const nb = game.neighborsOf(id);
      for (const e of scen.enemiesOf(id)) if (alive(e) && nb.has(e) && !game.hwhy(game.hooks.forbidAttack, id, e)) { st.war = e; break; }
    }

    // stance
    if (t >= s.stanceTick && t >= ap.stanceReadyTick) {
      const want: Stance = outnumbered || cutShare > 0.15 ? 'defense'
        : pushing && ps.aggr > 0.3 && incoming < p.troops * 0.2 ? 'offense' : 'balanced';
      if (want !== ap.stance) {
        const ok = note('setStance', adv.cmd.setStance(id, want));
        s.stanceTick = t + (ok ? 200 : 600);
      }
    }

    // workers
    if (t >= s.workersTick) {
      const frac = p.troops / cap;
      let w = 0.5 + 0.3 * (ps.greed - 0.5);
      if (outnumbered) w = 0.2;
      else if (incoming > 0 || outgoing > p.troops * 0.2) w = 0.35 - 0.1 * ps.aggr;
      else if (frac > 0.85) w = 0.8;
      w = Math.round(Math.max(0, Math.min(1, w)) * 20) / 20;
      if (Math.abs(w - ap.workers) >= 0.1) {
        const ok = note('setWorkers', adv.cmd.setWorkers(id, w));
        s.workersTick = t + (ok ? 300 : 900);
      }
    }

    // doctrine
    if (t >= s.researchTick && !ap.doctrine.researching) {
      const coastal = game.structuresOf(id, 'port').length > 0;
      const want: [DoctrineBranch, number][] = [
        ['blitz', ps.aggr],
        ['fortress', (1 - ps.aggr) * 0.8 + ps.loyal * 0.3],
        ['projection', ps.naval * (coastal ? 1 : 0.3) + ps.nuke * 0.4],
      ];
      want.sort((a, b) => b[1] - a[1]);
      let pick: DoctrineBranch | null = null;
      for (const [b] of want) if (ap.doctrine.level[b] < 3) { pick = b; break; }
      // spread a little once the main branch is at level 2
      if (pick && ap.doctrine.level[pick] >= 2 && ap.doctrine.level[want[1][0]] < 1) pick = want[1][0];
      if (pick) {
        const cost = adv.q.doctrineCost(id, pick);
        if (Number.isFinite(cost) && p.gold >= cost * (1.5 - 0.3 * ps.greed) + 300) {
          const why = adv.q.canResearch(id, pick);
          const ok = why === null ? note('research', adv.cmd.research(id, pick)) : note('research', false, why);
          s.researchTick = t + (ok ? 200 : why === NO ? 1200 : 300);
        } else s.researchTick = t + 150;
      } else s.researchTick = t + 6000;
    }

    // warships
    if (t >= s.warshipTick && t > 2400 && ps.naval > 0.25 && ap.res.oil >= 1) {
      s.warshipTick = t + 200;
      const ports = game.structuresOf(id, 'port');
      if (ports.length && warshipsOf(id) < adv.q.fleetCap(id) && p.gold >= adv.q.warshipCost(id) * (1.8 - ps.naval * 0.6)) {
        let why: string | null = 'Nessun porto';
        for (const port of ports) {
          why = adv.q.canBuildWarship(id, port.tile);
          if (why === null) { note('buildWarship', adv.cmd.buildWarship(id, port.tile)); break; }
        }
        if (why !== null) { note('buildWarship', false, why); if (why === NO) s.warshipTick = t + 1200; }
      }
    }

    // fleet orders: lift a blockade of ours, else blockade the enemy's port nearest to us
    if (t >= s.fleetTick && warshipsOf(id) > 0) {
      s.fleetTick = t + 300;
      let sea = -1;
      for (const port of game.structuresOf(id, 'port')) if (adv.q.isBlockaded(port)) { sea = waterNear(port.tile); break; }
      const enemy = st?.war && alive(st.war) ? st.war : worst;
      if (sea < 0 && enemy && alive(enemy)) {
        let bd = Infinity;
        for (const port of game.structuresOf(enemy, 'port')) {
          const d = d2(port.tile, cx(p), cy(p));
          if (d < bd) { bd = d; sea = port.tile; }
        }
        if (sea >= 0) sea = waterNear(sea);
      }
      if (sea >= 0) {
        const why = adv.q.canSendFleet(id, sea);
        if (why === null) note('sendFleet', adv.cmd.sendFleet(id, sea)); else note('sendFleet', false, why);
      }
    }

    // capital under threat: move it to the city farthest from the attacker
    const capT = ap.capital;
    if (capT >= 0 && incoming > 0 && worst && t >= s.capitalTick && p.gold >= ADV.capitalMoveCost + 300) {
      const x0 = capT % W, y0 = (capT / W) | 0, r = ADV.capitalRadius + 8;
      let threatened = false;
      for (let k = 0; k < 16 && !threatened; k++) {
        const a = (k / 16) * 6.2832;
        for (const f of [0.5, 1]) {
          const x = Math.round(x0 + Math.cos(a) * r * f), y = Math.round(y0 + Math.sin(a) * r * f);
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const o = owner[y * W + x];
          if (o && o !== id && !game.areAllied(id, o) && game.attacks.some(z => z.alive && z.attacker === o && z.target === id)) { threatened = true; break; }
        }
      }
      if (threatened) {
        s.capitalTick = t + 300;
        const E = P[worst];
        let best = -1, bd = (40 * 40);
        for (const c of game.structuresOf(id, 'city')) {
          if (c.tile === capT) continue;
          const d = d2(c.tile, cx(E), cy(E));
          if (d > bd && d2(c.tile, x0, y0) > 30 * 30) { bd = d; best = c.tile; }
        }
        if (best >= 0) {
          const why = adv.q.canMoveCapital(id, best);
          const ok = why === null ? note('moveCapital', adv.cmd.moveCapital(id, best)) : note('moveCapital', false, why);
          if (ok) s.capitalTick = t + 1500;
        }
      }
    }

    // cut off: break out with a focused attack and found a city inside the pocket
    if (t >= s.cutTick && ap.cutTiles > Math.max(30, p.tiles * 0.03)) {
      s.cutTick = t + 200;
      let cut = -1, n = 0;
      for (const i of p.border) { if (adv.cut[i]) { cut = i; break; } if (++n > 800) break; }
      if (cut >= 0) {
        const x = cut % W;
        for (const nb of [x > 0 ? cut - 1 : -1, x < W - 1 ? cut + 1 : -1, cut >= W ? cut - W : -1, cut < game.N - W ? cut + W : -1]) {
          if (nb < 0 || game.terrain[nb] === WATER) continue;
          const o = owner[nb];
          if (!o || o === id || game.areAllied(id, o) || game.hwhy(game.hooks.forbidAttack, id, o)) continue;
          const amt = p.troops * 0.3;
          if (amt < 30) break;
          const why = adv.q.canAttackAt(id, nb);
          if (why === null) note('attackAt', adv.cmd.attackAt(id, nb, amt)); else note('attackAt', false, why);
          break;
        }
        // a city is a supply hub: build one inside the pocket
        if (p.gold >= game.q.buildCost(id, 'city')) {
          const x0 = cut % W, y0 = (cut / W) | 0;
          for (let k = 0; k < 8; k++) {
            const i = (y0 + ((k * 3) % 7) - 3) * W + x0 + ((k * 5) % 7) - 3;
            if (i < 0 || i >= game.N || owner[i] !== id || !adv.cut[i]) continue;
            if (game.q.canBuild(id, 'city', i) === null) { note('pocketCity', game.cmd.build(id, 'city', i)); break; }
          }
        }
      }
    }
  };

  game.systems.push({
    name: 'advAI',
    tick() {
      const t = game.tick;
      if (t < 20) return;
      for (let id = 1; id < P.length; id++) {
        const p = P[id];
        if (!p.alive || p.kind !== 'nation') continue;
        if ((t + S(id).phase) % THINK !== 0) continue;
        think(p);
      }
    },
  });
  game.on(ev => { if (ev.type === 'playerDied' && P[ev.id].ext.advAI) (P[ev.id].ext.advAI as BotAdv).focus.clear(); });

  game.ext.advAI = { attack, stats, focusTile };
}
