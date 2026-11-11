// ADVANCED MODE — scenarios and objectives (docs/ADVANCED.md §8). Owner: DIPLO agent.
//
// Scenarios (world map only; any other map, or a world map where too few of the named nations spawned, falls
// back to 'libero'):
//   1939          Asse / Alleati / Sovietici: alliance blocs, NAPs (Molotov–Ribbentrop), opening wars
//                 (Germania→Polonia, Giappone→Cina, Italia→Etiopia, Russia→Finlandia, Alleati→Germania) and
//                 starting bonuses (land, troops, gold) for the great powers.
//   guerrafredda  NATO / Patto di Varsavia: blocs, embargoes and hostility between them, superpowers start
//                 with a missile silo, gold for a bomb and a land corridor to the nearest uranium deposit.
// Blocs: the first members found (≤ 5) form a full alliance mesh (classic alliances, max 4 allies each); the
// other members get a NAP with every core member. The human (if any) joins the bloc of the nearest member
// nation when it spawned within 80 tiles of it; otherwise it starts neutral.
// Objectives (human only): about every ADV.objectivePeriod ticks a timed mission (capture a deposit, take an
// enemy capital, reach a land share, own N cities, build a fleet), checked every 10 ticks, paid in gold.
//
// Extra API: game.ext.advScenario = { enemiesOf(id), blocOf(id), blocs }.
import type { Game } from '../game';
import { mulberry32 } from '../game';
import type { GameOptions, Player, PlayerId, Tile } from '../types';
import { WATER } from '../types';
import { ADV } from './rules';
import { RESOURCE_LABEL, type Objective, type ScenarioId } from './types';

interface BlocDef { name: string; core: string[]; extra: string[] }
interface ScenarioDef {
  blocs: BlocDef[];
  /** [a, b]: a starts at war with b. */
  wars: [string, string][];
  naps: [string, string][];
  /** name → [extra disc radius, troop ×, gold +] */
  bonus: Record<string, [number, number, number]>;
  /** Superpowers: silo + uranium corridor. */
  nuclear: string[];
  /** Blocs hostile to each other (embargo + bad relations). */
  hostileBlocs: [number, number][];
  intro: string;
}

export const SCENARIOS: Record<Exclude<ScenarioId, 'libero'>, ScenarioDef> = {
  '1939': {
    blocs: [
      { name: 'Asse', core: ['Germania', 'Italia', 'Giappone', 'Romania', 'Ungheria'], extra: ['Bulgaria'] },
      { name: 'Alleati', core: ['Regno Unito', 'Francia', 'Polonia', 'Canada', 'Australia'], extra: ['Sudafrica', 'Nuova Zelanda', 'India'] },
      { name: 'Unione Sovietica', core: ['Russia', 'Mongolia'], extra: [] },
    ],
    wars: [['Germania', 'Polonia'], ['Giappone', 'Cina'], ['Italia', 'Etiopia'], ['Russia', 'Finlandia'], ['Regno Unito', 'Germania'], ['Francia', 'Germania']],
    naps: [['Russia', 'Germania'], ['Russia', 'Giappone']],
    bonus: {
      Germania: [9, 2, 3000], Giappone: [8, 1.6, 2000], Italia: [7, 1.4, 1500], 'Regno Unito': [7, 1.5, 3000],
      Francia: [7, 1.5, 2000], Russia: [9, 1.8, 2000], 'Stati Uniti': [7, 1.2, 5000], Cina: [6, 1.5, 0],
    },
    nuclear: [],
    hostileBlocs: [[0, 1]],
    intro: 'Scenario 1939: l\'Europa è in fiamme',
  },
  guerrafredda: {
    blocs: [
      { name: 'NATO', core: ['Stati Uniti', 'Regno Unito', 'Francia', 'Germania', 'Italia'], extra: ['Canada', 'Turchia', 'Norvegia', 'Spagna', 'Portogallo', 'Grecia', 'Paesi Bassi', 'Danimarca', 'Islanda'] },
      { name: 'Patto di Varsavia', core: ['Russia', 'Polonia', 'Romania', 'Bielorussia', 'Ucraina'], extra: ['Kazakistan', 'Mongolia', 'Cina', 'Vietnam', 'Uzbekistan', 'Turkmenistan', 'Kirghizistan', 'Corea del Nord', 'Cuba', 'Ungheria', 'Bulgaria', 'Cechia'] },
    ],
    wars: [['Corea del Nord', 'Corea del Sud'], ['Vietnam', 'Laos']],
    naps: [],
    bonus: { 'Stati Uniti': [9, 1.8, 6000], Russia: [9, 1.8, 5000], 'Regno Unito': [6, 1.3, 2000], Francia: [6, 1.3, 2000], Cina: [7, 1.5, 1000] },
    nuclear: ['Stati Uniti', 'Russia'],
    hostileBlocs: [[0, 1]],
    intro: 'Scenario Guerra fredda: due blocchi, un mondo',
  },
};

const OBJ_FIRST = 600;
const HUMAN_JOIN_DIST = 80;
const CORRIDOR_MAX = 180;

export function installScenario(game: Game, opts: GameOptions): void {
  const adv = game.adv!;
  const P = game.players, W = game.W, H = game.H, owner = game.owner;
  const blocOf = new Map<PlayerId, number>();
  const enemies = new Map<PlayerId, Set<PlayerId>>();
  const blocNames: string[] = [];
  const blocMembers: PlayerId[][] = [];
  const alive = (id: PlayerId) => id > 0 && id < P.length && P[id].alive;
  const byName = new Map<string, PlayerId>();
  for (const p of P) if (p.id && p.kind === 'nation') byName.set(p.name, p.id);

  const addEnemy = (a: PlayerId, b: PlayerId) => {
    let s = enemies.get(a); if (!s) { s = new Set(); enemies.set(a, s); } s.add(b);
  };
  const ally = (a: PlayerId, b: PlayerId) => {
    if (game.areAllied(a, b)) return;
    if (game.cmd.proposeAlliance(a, b)) game.cmd.proposeAlliance(b, a); // the reverse proposal forms it
    const adj = game.ext.diplomacy?.adjust as undefined | ((a: PlayerId, b: PlayerId, d: number) => void);
    adj?.(a, b, 40); adj?.(b, a, 40);
  };
  const diplo = () => game.ext.advDiplo as undefined | { formPact: (k: 'nap', a: PlayerId, b: PlayerId, silent?: boolean) => unknown; markWar: (a: PlayerId, b: PlayerId) => void };

  /** Claim a land corridor (3 wide) from p's spawn to tile, only over land that is free, own or a tribe's. */
  const corridor = (p: Player, to: Tile): boolean => {
    const x0 = p.spawnX, y0 = p.spawnY, x1 = to % W, y1 = (to / W) | 0;
    const len = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
    if (len > CORRIDOR_MAX) return false;
    const tiles: Tile[] = [];
    for (let s = 0; s <= len; s++) {
      const x = Math.round(x0 + (x1 - x0) * s / Math.max(1, len)), y = Math.round(y0 + (y1 - y0) * s / Math.max(1, len));
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const i = yy * W + xx;
        const o = owner[i], free = o === 0 || o === p.id || P[o].kind === 'tribe';
        if (dx === 0 && dy === 0 && (game.terrain[i] === WATER || !free)) return false;
        if (game.terrain[i] !== WATER && free) tiles.push(i);
      }
    }
    for (const i of tiles) game.setOwner(i, p.id);
    game.claimDisc(p.id, x1, y1, 3);
    return true;
  };

  // ── scenario install ─────────────────────────────────────────────────────
  let scenario: ScenarioId = adv.scenario;
  if (scenario !== 'libero') {
    const def = SCENARIOS[scenario];
    const found = def ? def.blocs.reduce((n, b) => n + b.core.filter(c => byName.has(c)).length, 0) : 0;
    if (!def || game.map.name !== 'Mondo' || found < 5) {
      if (game.humanId) game.msg('Scenario disponibile solo sulla mappa del mondo: Mondo libero', 'warn', game.humanId);
      scenario = 'libero';
      adv.scenario = 'libero';
    } else {
      const id = (n: string) => byName.get(n) ?? 0;
      // blocs
      def.blocs.forEach((b, bi) => {
        const core = b.core.map(id).filter(alive).slice(0, 5);
        const extra = [...b.core.map(id).filter(alive).slice(5), ...b.extra.map(id).filter(alive)];
        blocNames.push(b.name);
        blocMembers.push([...core, ...extra]);
        for (const m of [...core, ...extra]) blocOf.set(m, bi);
        for (let i = 0; i < core.length; i++) for (let j = i + 1; j < core.length; j++) ally(core[i], core[j]);
        for (const e of extra) for (const c of core) diplo()?.formPact('nap', e, c, true);
      });
      for (const [a, b] of def.naps) if (alive(id(a)) && alive(id(b))) diplo()?.formPact('nap', id(a), id(b), true);
      const adj = game.ext.diplomacy?.adjust as undefined | ((a: PlayerId, b: PlayerId, d: number) => void);
      for (const [a, b] of def.wars) {
        const A = id(a), B = id(b);
        if (!alive(A) || !alive(B)) continue;
        addEnemy(A, B); addEnemy(B, A);
        adj?.(A, B, -70); adj?.(B, A, -70);
        diplo()?.markWar(A, B);
        const st = P[A].ext.ai as undefined | { war: PlayerId };
        if (st) st.war = B;
      }
      for (const [x, y] of def.hostileBlocs) {
        for (const a of blocMembers[x] ?? []) for (const b of blocMembers[y] ?? []) {
          adj?.(a, b, -35); adj?.(b, a, -35);
        }
        // embargoes between the core powers
        for (const a of (blocMembers[x] ?? []).slice(0, 5)) for (const b of (blocMembers[y] ?? []).slice(0, 5)) {
          game.cmd.setEmbargo(a, b, true); game.cmd.setEmbargo(b, a, true);
        }
      }
      // starting bonuses
      for (const [n, [r, tm, g]] of Object.entries(def.bonus)) {
        const p = P[id(n)];
        if (!p || !p.alive) continue;
        game.claimDisc(p.id, p.spawnX, p.spawnY, r);
        p.troops = Math.round(p.troops * tm);
        p.gold += g;
      }
      // nuclear powers: a silo and a corridor to the nearest uranium deposit
      for (const n of def.nuclear) {
        const p = P[id(n)];
        if (!p || !p.alive) continue;
        const ur = adv.deposits
          .filter(d => d.kind === 'uranium' && (!owner[d.tile] || owner[d.tile] === p.id))
          .map(d => ({ t: d.tile, d: (d.x - p.spawnX) ** 2 + (d.y - p.spawnY) ** 2 }))
          .sort((a, b) => a.d - b.d);
        for (const u of ur.slice(0, 4)) if (corridor(p, u.t)) break;
        for (let r = 2; r <= 6; r++) {
          const i = game.idx(Math.min(W - 1, p.spawnX + r), p.spawnY);
          if (owner[i] === p.id && !game.structureAt.has(i) && game.terrain[i] !== WATER) { game.addStructure('silo', p.id, i, 0); break; }
        }
        p.gold += game.q.nukeCost(p.id, 'atom') || 1500;
      }
      // the human joins the bloc of the nearest member nation
      const h = game.human;
      if (h) {
        let near = 0, nd = HUMAN_JOIN_DIST * HUMAN_JOIN_DIST;
        for (const [m] of blocOf) {
          const d = (P[m].spawnX - h.spawnX) ** 2 + (P[m].spawnY - h.spawnY) ** 2;
          if (d < nd) { nd = d; near = m; }
        }
        if (near) {
          const bi = blocOf.get(near)!;
          blocOf.set(h.id, bi);
          blocMembers[bi].push(h.id);
          if (P[near].allies.size < 4) ally(h.id, near);
          else diplo()?.formPact('nap', h.id, near, true);
          for (const e of enemies.get(near) ?? []) { addEnemy(h.id, e); addEnemy(e, h.id); }
          game.msg(`${def.intro}. Sei con ${blocNames[bi]} (${P[near].name})`, 'info', h.id);
        } else game.msg(`${def.intro}. Sei neutrale`, 'info', h.id);
      }
    }
  }

  // ── objectives (human only) ──────────────────────────────────────────────
  const orng = mulberry32(((opts.seed ?? 1) * 2654435761 ^ 0x0b1ec7) >>> 0);
  type Check = () => number; // progress 0..1
  let active: { o: Objective; check: Check } | null = null;
  let nextObj = OBJ_FIRST;
  let tookCapitalOf = 0;
  game.on(ev => { if (ev.type === 'capitalLost' && ev.by === game.humanId) tookCapitalOf = ev.owner; });

  const cityCount = (id: PlayerId) => game.structuresOf(id, 'city').length;
  const shipCount = (id: PlayerId) => {
    const f = game.ext.fleet as undefined | { count: (p: PlayerId) => number };
    if (f) return f.count(id);
    let n = 0; for (const u of game.units) if (u.alive && u.type === 'warship' && u.owner === id) n++; return n;
  };

  const makeObjective = (h: Player): { o: Objective; check: Check } | null => {
    const hx = h.sumX / Math.max(1, h.tiles), hy = h.sumY / Math.max(1, h.tiles);
    const t = game.tick;
    const reward = Math.round(Math.max(1000, game.q.goldRate(h.id) * 900) / 50) * 50;
    const base = { id: game.newId(), startTick: t, deadlineTick: t + ADV.objectiveDuration, reward, progress: 0, state: 'active' as const };
    const kinds = ['deposit', 'capital', 'share', 'cities', 'fleet'];
    const start = Math.floor(orng() * kinds.length);
    for (let k = 0; k < kinds.length; k++) {
      switch (kinds[(start + k) % kinds.length]) {
        case 'deposit': {
          let best = -1, bd = 300 * 300;
          for (const d of adv.deposits) {
            if (owner[d.tile] === h.id) continue;
            const dd = (d.x - hx) ** 2 + (d.y - hy) ** 2;
            if (dd < bd) { bd = dd; best = d.id; }
          }
          const d = adv.deposits.find(x => x.id === best);
          if (!d) break;
          return { o: { ...base, title: `Conquista: ${RESOURCE_LABEL[d.kind]}`, text: `Conquista il giacimento di ${RESOURCE_LABEL[d.kind].toLowerCase()} indicato`, x: d.x, y: d.y },
            check: () => (owner[d.tile] === h.id ? 1 : 0) };
        }
        case 'capital': {
          // a neighbour's capital, preferring scenario enemies
          let pick = 0, ps = -Infinity;
          for (const [k] of game.neighborsOf(h.id)) {
            if (!k || !alive(k) || game.areAllied(h.id, k) || P[k].kind !== 'nation') continue;
            const c = adv.players[k]?.capital ?? -1;
            if (c < 0) continue;
            const s = (enemies.get(h.id)?.has(k) ? 2 : 0) - P[k].troops / Math.max(1, h.troops);
            if (s > ps) { ps = s; pick = k; }
          }
          if (!pick) break;
          const c = adv.players[pick].capital;
          tookCapitalOf = 0;
          const target = pick;
          return { o: { ...base, title: `Capitale di ${P[pick].name}`, text: `Prendi la capitale di ${P[pick].name}`, x: c % W, y: (c / W) | 0 },
            check: () => (tookCapitalOf === target || owner[adv.players[target]?.capital ?? 0] === h.id ? 1 : 0) };
        }
        case 'share': {
          const now = game.share(h.id);
          const goal = Math.max(now * 1.5, now + 0.01);
          const pct = Math.round(goal * 1000) / 10;
          return { o: { ...base, title: `Espansione ${pct}%`, text: `Raggiungi il ${pct}% delle terre emerse` },
            check: () => Math.min(1, game.share(h.id) / goal) };
        }
        case 'cities': {
          const goal = cityCount(h.id) + 2;
          return { o: { ...base, title: `${goal} città`, text: `Possiedi ${goal} città completate` },
            check: () => Math.min(1, cityCount(h.id) / goal) };
        }
        case 'fleet': {
          if (!game.structuresOf(h.id, 'port').length || (adv.players[h.id]?.res.oil ?? 0) < 1) break;
          const goal = shipCount(h.id) + 2;
          return { o: { ...base, title: `Flotta di ${goal}`, text: `Schiera ${goal} navi da guerra` },
            check: () => Math.min(1, shipCount(h.id) / goal) };
        }
      }
    }
    return null;
  };

  game.systems.push({
    name: 'advScenario',
    tick() {
      const t = game.tick;
      if (t % 10 !== 0) return;
      const h = game.human;
      if (!h) return;
      if (active) {
        const a = active;
        if (!h.alive) { a.o.state = 'failed'; active = null; return; }
        a.o.progress = Math.max(0, Math.min(1, a.check()));
        if (a.o.progress >= 1) {
          a.o.state = 'done';
          h.gold += a.o.reward;
          game.emit({ type: 'objective', objective: a.o, state: 'done' });
          game.msg(`Obiettivo completato: ${a.o.title} (+${a.o.reward} oro)`, 'good', h.id, a.o.x, a.o.y);
          active = null;
        } else if (t >= a.o.deadlineTick) {
          a.o.state = 'failed';
          game.emit({ type: 'objective', objective: a.o, state: 'failed' });
          game.msg(`Obiettivo fallito: ${a.o.title}`, 'warn', h.id);
          active = null;
        }
        return;
      }
      if (t < nextObj || !h.alive) return;
      nextObj = t + ADV.objectivePeriod;
      const made = makeObjective(h);
      if (!made) return;
      active = made;
      adv.objectives.push(made.o);
      if (adv.objectives.length > 12) adv.objectives.splice(0, adv.objectives.length - 12);
      game.emit({ type: 'objective', objective: made.o, state: 'new' });
      game.msg(`Nuovo obiettivo: ${made.o.text} (+${made.o.reward} oro)`, 'info', h.id, made.o.x, made.o.y);
    },
  });

  game.ext.advScenario = {
    scenario,
    blocs: blocNames.map((name, i) => ({ name, members: blocMembers[i] })),
    blocOf: (id: PlayerId) => (blocOf.has(id) ? blocNames[blocOf.get(id)!] : null),
    enemiesOf: (id: PlayerId): PlayerId[] => [...(enemies.get(id) ?? [])],
    /** Force the next objective check now (tests). */
    nextObjectiveAt: (tick: number) => { nextObj = tick; },
  };
}
