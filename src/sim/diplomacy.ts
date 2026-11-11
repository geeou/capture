// CAPTURE — diplomacy: alliances (proposal → accept, fixed term, expiry), betrayal, embargoes, donations,
// and the relation memory every bot reads. Owner: diplomacy/AI agent.
//
// Relation: attitude of `a` towards `b`, −100..100, stored sparse per ordered pair in
// players[a].ext.dip.rel (Map<b, {v, t}>), decaying lazily towards 0 (time constant DIP.relTau).
//   b attacks a −22 · b nukes a −55 · b embargoes a −15 · b betrays a −70 (bystander nations −10)
//   alliance formed +30 both · donation up to +30 · fighting the same aggressor +6 both · rejected proposal −8
// Alliances: last DIP.term ticks (warning DIP.warn before), cap DIP.maxAllies per player, rejected proposals
// put the pair on a cooldown, requests expire after DIP.requestTtl.
//
// Extra API for UI/AI on game.ext.diplomacy: canPropose(from,to) → Italian reason | null,
// allianceEndsAt(a,b) → tick | 0, adjust(a,b,delta), maxAllies.
import type { Game } from './game';
import type { AllianceRequest, PlayerId } from './types';

export const DIP = {
  /** Alliance duration (ticks): 4 minutes. */
  term: 2400,
  /** Expiry warning (ticks before the end). */
  warn: 300,
  requestTtl: 300,
  /** After a rejection, the same proposer cannot ask the same player again for this long. */
  rejectCooldown: 600,
  maxAllies: 4,
  /** An alliance can be renewed (new proposal) during its last minute. */
  renewWindow: 600,
  traitorTicks: 600,
  /** Relation decay time constant (ticks): e^(−dt/τ). */
  relTau: 1500,
  attackHit: -22,
  nukeHit: -55,
  embargoHit: -15,
  embargoLift: 6,
  betrayVictim: -70,
  betrayBystander: -10,
  betrayAllyOfVictim: -30,
  allianceBonus: 30,
  rejectHit: -8,
  commonEnemy: 6,
  donateMax: 30,
  minDonateTroops: 10,
  minDonateGold: 10,
};

interface Rel { v: number; t: number }

const pairKey = (a: PlayerId, b: PlayerId) => (a < b ? a * 65536 + b : b * 65536 + a);
const dirKey = (a: PlayerId, b: PlayerId) => a * 65536 + b;

export function installDiplomacy(game: Game): void {
  /** Unordered pair → tick the alliance ends. */
  const allianceEnd = new Map<number, number>();
  const warned = new Set<number>();
  /** Ordered (from→to) → tick until which `from` cannot propose to `to` again. */
  const cooldown = new Map<number, number>();

  // ── relation memory ──────────────────────────────────────────────────────
  const relMap = (a: PlayerId): Map<PlayerId, Rel> => {
    const p = game.players[a];
    let d = p.ext.dip as { rel: Map<PlayerId, Rel> } | undefined;
    if (!d) { d = { rel: new Map() }; p.ext.dip = d; }
    return d.rel;
  };
  const decayed = (r: Rel): number => {
    const dt = game.tick - r.t;
    return dt > 0 ? r.v * Math.exp(-dt / DIP.relTau) : r.v;
  };
  const relation = (a: PlayerId, b: PlayerId): number => {
    if (!a || !b || a === b) return 0;
    const pa = game.players[a];
    if (!pa || !pa.ext.dip) return 0;
    const r = (pa.ext.dip.rel as Map<PlayerId, Rel>).get(b);
    return r ? decayed(r) : 0;
  };
  const adjust = (a: PlayerId, b: PlayerId, delta: number): void => {
    if (!a || !b || a === b) return;
    const pa = game.players[a], pb = game.players[b];
    if (!pa || !pb || !pa.alive || !pb.alive) return;
    const m = relMap(a);
    const r = m.get(b);
    const v = Math.max(-100, Math.min(100, (r ? decayed(r) : 0) + delta));
    if (Math.abs(v) < 0.5) { m.delete(b); return; }
    if (r) { r.v = v; r.t = game.tick; } else m.set(b, { v, t: game.tick });
  };

  const alive = (id: PlayerId) => id > 0 && id < game.players.length && game.players[id].alive;
  const name = (id: PlayerId) => game.players[id].name;

  // ── alliances ────────────────────────────────────────────────────────────
  const canPropose = (from: PlayerId, to: PlayerId): string | null => {
    if (!alive(from)) return 'Non sei in gioco';
    if (!alive(to) || from === to) return 'Giocatore non valido';
    const renewing = game.areAllied(from, to);
    if (renewing && (allianceEnd.get(pairKey(from, to)) ?? 0) - game.tick > DIP.renewWindow) return 'Siete già alleati';
    // a reverse pending request is fine: proposing accepts it
    if (game.allianceRequests.some(r => r.to === from && r.from === to)) return null;
    if (game.allianceRequests.some(r => r.from === from && r.to === to)) return 'Proposta già inviata';
    const cd = cooldown.get(dirKey(from, to));
    if (cd !== undefined && cd > game.tick) return 'Ha rifiutato da poco';
    if (renewing) return null;
    if (game.players[from].allies.size >= DIP.maxAllies) return `Massimo ${DIP.maxAllies} alleanze`;
    if (game.players[to].allies.size >= DIP.maxAllies) return 'Ha già troppi alleati';
    return null;
  };

  const form = (a: PlayerId, b: PlayerId): void => {
    const A = game.players[a], B = game.players[b];
    const renew = A.allies.has(b);
    A.allies.add(b); B.allies.add(a);
    const k = pairKey(a, b);
    allianceEnd.set(k, game.tick + DIP.term);
    warned.delete(k);
    adjust(a, b, DIP.allianceBonus * (renew ? 0.3 : 1)); adjust(b, a, DIP.allianceBonus * (renew ? 0.3 : 1));
    // drop any other pending request between the two
    game.allianceRequests = game.allianceRequests.filter(r => !((r.from === a && r.to === b) || (r.from === b && r.to === a)));
    if (!renew) game.emit({ type: 'allianceFormed', a, b });
    const w = renew ? 'Alleanza rinnovata' : 'Alleanza';
    game.msg(`${w} con ${B.name} (4 min)`, 'good', a, B.spawnX, B.spawnY);
    game.msg(`${w} con ${A.name} (4 min)`, 'good', b, A.spawnX, A.spawnY);
  };

  const unlink = (a: PlayerId, b: PlayerId): void => {
    game.players[a].allies.delete(b);
    game.players[b].allies.delete(a);
    const k = pairKey(a, b);
    allianceEnd.delete(k);
    warned.delete(k);
  };

  game.cmd.proposeAlliance = (from, to) => {
    if (canPropose(from, to) !== null) return false;
    const rev = game.allianceRequests.find(r => r.to === from && r.from === to);
    if (rev) { form(from, to); return true; }
    const req: AllianceRequest = { id: game.newId(), from, to, tick: game.tick };
    game.allianceRequests.push(req);
    game.emit({ type: 'allianceRequest', request: req });
    const F = game.players[from];
    game.msg(`${F.name} propone un'alleanza`, 'info', to, Math.round(F.sumX / Math.max(1, F.tiles)), Math.round(F.sumY / Math.max(1, F.tiles)));
    return true;
  };

  game.cmd.respondAlliance = (id, accept) => {
    const k = game.allianceRequests.findIndex(r => r.id === id);
    if (k < 0) return false;
    const r = game.allianceRequests[k];
    game.allianceRequests.splice(k, 1);
    if (!alive(r.from) || !alive(r.to)) return false;
    if (!accept) {
      cooldown.set(dirKey(r.from, r.to), game.tick + DIP.rejectCooldown);
      adjust(r.from, r.to, DIP.rejectHit);
      game.msg(`${name(r.to)} ha rifiutato l'alleanza`, 'info', r.from);
      return true;
    }
    if (!game.areAllied(r.from, r.to) && (game.players[r.from].allies.size >= DIP.maxAllies || game.players[r.to].allies.size >= DIP.maxAllies)) return false;
    form(r.from, r.to);
    return true;
  };

  game.cmd.breakAlliance = (by, other) => {
    if (!alive(by) || !alive(other) || !game.areAllied(by, other)) return false;
    unlink(by, other);
    const B = game.players[by];
    B.traitorUntil = game.tick + DIP.traitorTicks;
    game.emit({ type: 'allianceBroken', by, other, betrayal: true });
    adjust(other, by, DIP.betrayVictim);
    const victimAllies = game.players[other].allies;
    for (let id = 1; id < game.players.length; id++) {
      const p = game.players[id];
      if (!p.alive || id === by || id === other || p.kind === 'tribe') continue;
      adjust(id, by, victimAllies.has(id) ? DIP.betrayAllyOfVictim : DIP.betrayBystander);
    }
    const cx = Math.round(B.sumX / Math.max(1, B.tiles)), cy = Math.round(B.sumY / Math.max(1, B.tiles));
    game.msg(`${B.name} ha tradito la nostra alleanza!`, 'danger', other, cx, cy);
    game.msg(`Hai rotto l'alleanza con ${name(other)}: sei un traditore`, 'warn', by);
    return true;
  };

  game.cmd.setEmbargo = (by, other, on) => {
    if (!alive(by) || !alive(other) || by === other) return false;
    const E = game.players[by].embargoes;
    if (on === E.has(other)) return false;
    if (on) {
      E.add(other);
      adjust(other, by, DIP.embargoHit);
      game.msg(`${name(by)} ha imposto un embargo contro di noi`, 'warn', other);
    } else {
      E.delete(other);
      adjust(other, by, DIP.embargoLift);
    }
    return true;
  };

  game.cmd.donate = (from, to, kind, amount) => {
    if (!alive(from) || !alive(to) || from === to) return false;
    if (kind !== 'troops' && kind !== 'gold') return false;
    const F = game.players[from], T = game.players[to];
    const have = kind === 'troops' ? F.troops : F.gold;
    amount = Math.floor(Math.min(amount, have));
    if (!(amount >= (kind === 'troops' ? DIP.minDonateTroops : DIP.minDonateGold))) return false;
    let worth: number;
    if (kind === 'troops') {
      F.troops -= amount; T.troops += amount;
      worth = amount / Math.max(500, game.q.maxTroops(to));
    } else {
      F.gold -= amount; T.gold += amount;
      worth = amount / Math.max(500, game.q.goldRate(to) * 600); // vs one minute of their income
    }
    adjust(to, from, Math.min(DIP.donateMax, 3 + 40 * worth));
    game.msg(`${F.name} ci ha donato ${amount} ${kind === 'troops' ? 'truppe' : 'oro'}`, 'good', to);
    return true;
  };

  game.q.relation = relation;

  // ── event-driven relation changes ────────────────────────────────────────
  game.on(ev => {
    switch (ev.type) {
      case 'attackStarted': {
        const a = ev.attack;
        if (!a.target) break;
        adjust(a.target, a.attacker, DIP.attackHit);
        // victims of the same aggressor warm to each other
        for (const o of game.attacks) {
          if (!o.alive || o === a || o.attacker !== a.attacker || !o.target || o.target === a.target) continue;
          adjust(o.target, a.target, DIP.commonEnemy);
          adjust(a.target, o.target, DIP.commonEnemy);
        }
        break;
      }
      case 'explosion':
        for (const v of ev.victims) if (v !== ev.owner) adjust(v, ev.owner, DIP.nukeHit);
        break;
      case 'playerDied': {
        const id = ev.id;
        game.allianceRequests = game.allianceRequests.filter(r => r.from !== id && r.to !== id);
        for (const k of [...allianceEnd.keys()]) {
          const a = Math.floor(k / 65536), b = k % 65536;
          if (a === id || b === id) { allianceEnd.delete(k); warned.delete(k); }
        }
        const p = game.players[id];
        if (p.ext.dip) (p.ext.dip.rel as Map<PlayerId, Rel>).clear();
        for (let j = 1; j < game.players.length; j++) {
          const q = game.players[j];
          if (q.ext.dip) (q.ext.dip.rel as Map<PlayerId, Rel>).delete(id);
          q.embargoes.delete(id);
        }
        p.embargoes.clear();
        break;
      }
    }
  });

  // ── per-tick housekeeping (cheap: every 10 ticks) ────────────────────────
  game.systems.push({
    name: 'diplomacy',
    tick() {
      if (game.tick % 10 !== 0) return;
      const t = game.tick;
      if (game.allianceRequests.length) {
        game.allianceRequests = game.allianceRequests.filter(r =>
          t - r.tick < DIP.requestTtl && alive(r.from) && alive(r.to));
      }
      for (const [k, end] of allianceEnd) {
        const a = Math.floor(k / 65536), b = k % 65536;
        if (!game.areAllied(a, b)) { allianceEnd.delete(k); warned.delete(k); continue; }
        if (t >= end) {
          unlink(a, b);
          game.emit({ type: 'allianceBroken', by: a, other: b, betrayal: false });
          game.msg(`L'alleanza con ${name(b)} è scaduta`, 'info', a);
          game.msg(`L'alleanza con ${name(a)} è scaduta`, 'info', b);
        } else if (end - t <= DIP.warn && !warned.has(k)) {
          warned.add(k);
          const s = Math.round((end - t) / 10);
          game.msg(`L'alleanza con ${name(b)} scade tra ${s} s: rinnovala`, 'warn', a);
          game.msg(`L'alleanza con ${name(a)} scade tra ${s} s: rinnovala`, 'warn', b);
        }
      }
      // forget stale cooldowns occasionally
      if (t % 600 === 0) for (const [k, until] of cooldown) if (until <= t) cooldown.delete(k);
    },
  });

  game.ext.diplomacy = {
    canPropose,
    allianceEndsAt: (a: PlayerId, b: PlayerId) => allianceEnd.get(pairKey(a, b)) ?? 0,
    adjust,
    maxAllies: DIP.maxAllies,
  };
}
