// ADVANCED MODE — diplomacy (docs/ADVANCED.md §7). Owner: DIPLO agent.
//
// Offers (nap, truce, tribute, jointWar) → bot answers after a short delay (the human always gets a visible
// accept/refuse message) → pacts. Pacts are enforced through hook `forbidAttack`. Tribute moves
// ADV.tributeShare of the vassal's gold income to the overlord every tick by direct transfer (this system
// runs after the classic economy), exposed for the UI as game.ext.advDiplo.tributeRate(p).
// Reputation (adv.players[id].reputation): betraying an alliance, breaking a pact, nuking a player you were
// not at war with lower it; pacts run to their end raise it; negative reputation slowly heals.
// Bots also take the initiative: truce when losing a war, tribute demands on much weaker neighbours,
// NAP with strong neighbours, joint-war calls to allies, and (treacherous ones) breaking pacts.
//
// Extra API on game.ext.advDiplo (see the bottom of the file).
import type { Game } from '../game';
import type { GameOptions, Player, PlayerId } from '../types';
import { ADV } from './rules';
import { OFFER_LABEL, PACT_LABEL, type DiploOffer, type OfferKind, type Pact, type PactKind } from './types';

/** Local tuning (only this module reads it). */
export const ADIP = {
  /** Two players are "at war" while an attack between them is active or ended less than this ago. */
  warMemory: 600,
  /** After a refusal, the same proposer cannot offer the same kind to the same player for this long. */
  rejectCooldown: 600,
  /** Bot answer delay range (ticks). */
  replyMin: 10, replyMax: 40,
  /** Each nation bot considers taking a diplomatic initiative every `botPeriod` ticks (staggered). */
  botPeriod: 60,
  /** Minimum ticks between two initiatives of the same bot. */
  botGap: 300,
  /** Minimum ticks between two bot offers addressed to the human (global). */
  humanGap: 900,
  /** Max vassals per overlord. */
  maxVassals: 3,
  /** Negative reputation heals by +1 every this many ticks. */
  repHealPeriod: 600,
  /** Relation (classic) effect of pacts. */
  relPactFormed: 15, relPactBroken: -40,
};

const pairKey = (a: PlayerId, b: PlayerId) => (a < b ? a * 65536 + b : b * 65536 + a);
const dirKey = (a: PlayerId, b: PlayerId, kind: OfferKind) => (a * 65536 + b) * 4 + ['nap', 'truce', 'tribute', 'jointWar'].indexOf(kind);

interface Pending { offer: DiploOffer; due: number }

export function installAdvDiplomacy(game: Game, _opts: GameOptions): void {
  const adv = game.adv!;
  const P = game.players;
  /** pairKey → active pacts of that pair (at most one per kind). */
  const byPair = new Map<number, Pact[]>();
  /** pairKey → last tick the two were seen fighting. */
  const lastWar = new Map<number, number>();
  const cooldown = new Map<number, number>();
  const pending: Pending[] = [];
  let lastHumanOffer = -1e9;
  const lastBotInit = new Map<PlayerId, number>();
  const stats = {
    offers: 0, botOffers: 0, accepted: 0, refused: 0, expired: 0,
    pactsFormed: 0, pactsBroken: 0, pactsExpired: 0, jointWarAttacks: 0, tributeGold: 0,
    byKind: { nap: 0, truce: 0, tribute: 0, jointWar: 0 } as Record<OfferKind, number>,
  };

  const alive = (id: PlayerId) => id > 0 && id < P.length && P[id].alive;
  const name = (id: PlayerId) => P[id].name;
  const cxy = (p: Player): [number, number] => [Math.round(p.sumX / Math.max(1, p.tiles)), Math.round(p.sumY / Math.max(1, p.tiles))];
  const relAdjust = (a: PlayerId, b: PlayerId, d: number) => (game.ext.diplomacy?.adjust as undefined | ((a: PlayerId, b: PlayerId, d: number) => void))?.(a, b, d);
  const pers = (id: PlayerId) => (game.ext.ai?.personality?.(id) as undefined | { aggr: number; greed: number; loyal: number; naval: number; nuke: number })
    ?? { aggr: 0.5, greed: 0.5, loyal: 0.5, naval: 0.5, nuke: 0.5 };
  const aiState = (id: PlayerId) => P[id].ext.ai as undefined | { war: PlayerId; threat: PlayerId };

  // ── reputation ───────────────────────────────────────────────────────────
  const rep = (id: PlayerId) => adv.players[id]?.reputation ?? 0;
  const addRep = (id: PlayerId, d: number) => {
    const a = adv.players[id];
    if (!a) return;
    a.reputation = Math.max(ADV.reputation.min, Math.min(ADV.reputation.max, a.reputation + d));
  };

  // ── war memory ───────────────────────────────────────────────────────────
  const markWar = (a: PlayerId, b: PlayerId) => { if (a && b && a !== b) lastWar.set(pairKey(a, b), game.tick); };
  const atWar = (a: PlayerId, b: PlayerId): boolean => {
    const t = lastWar.get(pairKey(a, b));
    return t !== undefined && game.tick - t < ADIP.warMemory;
  };

  // ── pacts ────────────────────────────────────────────────────────────────
  const pactOf = (a: PlayerId, b: PlayerId, kind?: PactKind): Pact | null => {
    if (!adv.pacts.length) return null;
    const l = byPair.get(pairKey(a, b));
    if (!l) return null;
    if (!kind) return l[0] ?? null;
    for (const p of l) if (p.kind === kind) return p;
    return null;
  };
  const overlordOf = (v: PlayerId): PlayerId => {
    for (const p of adv.pacts) if (p.kind === 'tribute' && p.b === v) return p.a;
    return 0;
  };
  const vassalsOf = (o: PlayerId): PlayerId[] => adv.pacts.filter(p => p.kind === 'tribute' && p.a === o).map(p => p.b);

  /** Retreat every active attack between the two. */
  const stopFighting = (a: PlayerId, b: PlayerId) => {
    const ids: number[] = [];
    for (const x of game.attacks) if (x.alive && ((x.attacker === a && x.target === b) || (x.attacker === b && x.target === a))) ids.push(x.id);
    for (const id of ids) game.cmd.retreat(id);
  };

  const formPact = (kind: PactKind, a: PlayerId, b: PlayerId, silent = false): Pact | null => {
    if (!alive(a) || !alive(b) || a === b) return null;
    const old = pactOf(a, b, kind);
    const t = game.tick;
    const until = kind === 'nap' ? t + ADV.napTicks : kind === 'truce' ? t + ADV.truceTicks : 0;
    if (old) { old.untilTick = until; old.startTick = t; return old; } // renewal
    const pact: Pact = { id: game.newId(), kind, a, b, startTick: t, untilTick: until };
    adv.pacts.push(pact);
    const k = pairKey(a, b);
    let l = byPair.get(k); if (!l) { l = []; byPair.set(k, l); }
    l.push(pact);
    stats.pactsFormed++;
    stopFighting(a, b);
    relAdjust(a, b, ADIP.relPactFormed); relAdjust(b, a, ADIP.relPactFormed);
    game.emit({ type: 'pactFormed', pact });
    if (!silent) {
      const mins = until ? ` (${Math.round((until - t) / 600)} min)` : '';
      if (kind === 'tribute') {
        game.msg(`${name(b)} è ora tuo vassallo: ti paga tributo`, 'good', a);
        game.msg(`Paghi tributo a ${name(a)}: non può attaccarti`, 'warn', b);
      } else {
        game.msg(`${PACT_LABEL[kind]} con ${name(b)}${mins}`, 'good', a, P[b].spawnX, P[b].spawnY);
        game.msg(`${PACT_LABEL[kind]} con ${name(a)}${mins}`, 'good', b, P[a].spawnX, P[a].spawnY);
      }
    }
    return pact;
  };

  const removePact = (pact: Pact) => {
    const k = adv.pacts.indexOf(pact);
    if (k >= 0) adv.pacts.splice(k, 1);
    const pk = pairKey(pact.a, pact.b);
    const l = byPair.get(pk);
    if (l) { const j = l.indexOf(pact); if (j >= 0) l.splice(j, 1); if (!l.length) byPair.delete(pk); }
  };

  const endPact = (pact: Pact, brokenBy: PlayerId) => {
    removePact(pact);
    const label = PACT_LABEL[pact.kind];
    if (brokenBy) {
      stats.pactsBroken++;
      const other = brokenBy === pact.a ? pact.b : pact.a;
      // a vassal shaking off its overlord is half as shameful; an overlord releasing is still a broken word
      addRep(brokenBy, ADV.reputation.breakPact * (pact.kind === 'tribute' && brokenBy === pact.b ? 0.5 : 1));
      relAdjust(other, brokenBy, ADIP.relPactBroken);
      if (alive(other)) {
        const [x, y] = cxy(P[brokenBy]);
        game.msg(`${name(brokenBy)} ha rotto: ${label}!`, 'danger', other, x, y);
      }
      game.msg(`Hai rotto: ${label} con ${name(other)}`, 'warn', brokenBy);
    } else {
      stats.pactsExpired++;
      if (pact.untilTick && alive(pact.a) && alive(pact.b)) {
        addRep(pact.a, ADV.reputation.pactHonoured); addRep(pact.b, ADV.reputation.pactHonoured);
        game.msg(`${label} con ${name(pact.b)} terminato`, 'info', pact.a);
        game.msg(`${label} con ${name(pact.a)} terminato`, 'info', pact.b);
      }
    }
    game.emit({ type: 'pactEnded', pact, brokenBy });
  };

  // ── hook: pacts forbid attacks ───────────────────────────────────────────
  game.hooks.forbidAttack.push((a, b) => {
    if (!adv.pacts.length || !a || !b) return null;
    const l = byPair.get(pairKey(a, b));
    if (!l || !l.length) return null;
    for (const p of l) {
      if (p.kind === 'nap') return 'Patto di non aggressione in vigore';
      if (p.kind === 'truce') return 'Tregua in vigore';
      if (p.kind === 'tribute') return p.a === a ? 'È tuo vassallo: rompi prima il tributo' : 'Gli paghi tributo: rompi prima il patto';
    }
    return null;
  });

  // ── offers ───────────────────────────────────────────────────────────────
  const canOffer = (from: PlayerId, to: PlayerId, kind: OfferKind, target = 0): string | null => {
    if (!alive(from)) return 'Non sei in gioco';
    if (!alive(to) || from === to) return 'Giocatore non valido';
    if (!(kind in OFFER_LABEL)) return 'Offerta non valida';
    const allied = game.areAllied(from, to);
    if (adv.offers.some(o => o.from === from && o.to === to && o.kind === kind)) return 'Offerta già inviata';
    const cd = cooldown.get(dirKey(from, to, kind));
    if (cd !== undefined && cd > game.tick) return 'Ha rifiutato da poco';
    switch (kind) {
      case 'nap': {
        if (allied) return 'Siete già alleati';
        const p = pactOf(from, to, 'nap');
        if (p && p.untilTick - game.tick > 600) return 'Patto già in vigore';
        if (pactOf(from, to, 'tribute')) return 'Esiste già un tributo';
        return null;
      }
      case 'truce':
        if (allied) return 'Siete già alleati';
        if (pactOf(from, to)) return 'Patto già in vigore';
        if (!atWar(from, to)) return 'Non siete in guerra';
        return null;
      case 'tribute':
        if (allied) return 'Siete alleati';
        if (pactOf(from, to, 'tribute')) return 'Tributo già in vigore';
        if (overlordOf(to)) return 'Paga già tributo a un altro';
        if (overlordOf(from)) return 'Sei tu a pagare tributo';
        if (vassalsOf(from).length >= ADIP.maxVassals) return `Massimo ${ADIP.maxVassals} vassalli`;
        return null;
      case 'jointWar': {
        if (!allied && !pactOf(from, to)) return 'Serve un alleato o un patto';
        if (!alive(target) || target === from || target === to) return 'Bersaglio non valido';
        if (game.areAllied(to, target)) return 'È suo alleato';
        if (game.areAllied(from, target)) return 'È tuo alleato';
        if (game.hwhy(game.hooks.forbidAttack, to, target)) return 'Ha un patto con il bersaglio';
        return null;
      }
    }
    return 'Offerta non valida';
  };

  const describe = (o: DiploOffer) => o.kind === 'jointWar' ? `${OFFER_LABEL.jointWar} contro ${name(o.target)}` : OFFER_LABEL[o.kind];

  const offer = (from: PlayerId, to: PlayerId, kind: OfferKind, target = 0): boolean => {
    if (canOffer(from, to, kind, target) !== null) return false;
    // a matching reverse offer is accepted on the spot (both want the same thing)
    if (kind !== 'tribute' && kind !== 'jointWar') {
      const rev = adv.offers.find(o => o.from === to && o.to === from && o.kind === kind);
      if (rev) return respond(rev.id, true);
    }
    const o: DiploOffer = { id: game.newId(), kind, from, to, target: kind === 'jointWar' ? target : 0, tick: game.tick };
    adv.offers.push(o);
    stats.offers++; stats.byKind[kind]++;
    if (P[from].kind !== 'human') stats.botOffers++;
    game.emit({ type: 'diploOffer', offer: o });
    const F = P[from];
    const [x, y] = cxy(F);
    const text = kind === 'tribute' ? `${F.name} chiede un tributo: diventa suo vassallo`
      : kind === 'jointWar' ? `${F.name} chiede guerra congiunta contro ${name(target)}`
      : `${F.name} propone: ${OFFER_LABEL[kind]}`;
    game.msg(text, kind === 'tribute' ? 'warn' : 'info', to, x, y);
    if (P[to].kind !== 'human') {
      const delay = ADIP.replyMin + ((o.id * 2654435761) >>> 0) % (ADIP.replyMax - ADIP.replyMin);
      pending.push({ offer: o, due: game.tick + delay });
    }
    return true;
  };

  /** Bot `to` answers jointWar: attack the target now. */
  const jointAttack = (me: PlayerId, target: PlayerId): boolean => {
    const M = P[me];
    const amt = M.troops * 0.35;
    if (amt < 30) return false;
    const st = aiState(me);
    if (st) st.war = target;
    const nb = game.neighborsOf(me);
    let ok = false;
    if (nb.has(target)) {
      const ai = game.ext.advAI as undefined | { attack: (a: PlayerId, b: PlayerId, n: number) => boolean };
      ok = ai ? ai.attack(me, target, amt) : game.cmd.attack(me, target, amt);
    } else {
      const T = P[target];
      const [x, y] = cxy(T);
      const tile = game.idx(Math.max(0, Math.min(game.W - 1, x)), Math.max(0, Math.min(game.H - 1, y)));
      if (game.owner[tile] === target && game.q.canBoat(me, tile) === null) ok = game.cmd.sendBoat(me, tile, amt);
    }
    if (ok) stats.jointWarAttacks++;
    return ok;
  };

  const respond = (offerId: number, accept: boolean): boolean => {
    const k = adv.offers.findIndex(o => o.id === offerId);
    if (k < 0) return false;
    const o = adv.offers[k];
    adv.offers.splice(k, 1);
    if (!alive(o.from) || !alive(o.to)) return false;
    const label = describe(o);
    if (accept) {
      // still valid? (state may have changed while the offer waited)
      const why = canOffer(o.from, o.to, o.kind, o.target);
      if (why !== null) {
        game.msg(`${label} con ${name(o.to)} non più possibile: ${why}`, 'info', o.from);
        game.msg(`${label} con ${name(o.from)} non più possibile: ${why}`, 'info', o.to);
        return false;
      }
      stats.accepted++;
      game.msg(`${name(o.to)} accetta: ${label}`, 'good', o.from);
      if (o.kind === 'tribute') formPact('tribute', o.from, o.to);
      else if (o.kind === 'jointWar') {
        relAdjust(o.from, o.to, 10);
        relAdjust(o.to, o.target, -20);
        if (P[o.to].kind !== 'human') jointAttack(o.to, o.target);
        else game.msg(`Guerra congiunta contro ${name(o.target)}: attacca!`, 'info', o.to);
        game.msg(`${name(o.to)} entra in guerra contro di te`, 'danger', o.target);
      } else formPact(o.kind, o.from, o.to);
      return true;
    }
    stats.refused++;
    cooldown.set(dirKey(o.from, o.to, o.kind), game.tick + ADIP.rejectCooldown);
    relAdjust(o.from, o.to, -5);
    game.msg(`${name(o.to)} rifiuta: ${label}`, 'info', o.from);
    return true;
  };

  const breakPact = (by: PlayerId, other: PlayerId, kind: PactKind): boolean => {
    if (!alive(by)) return false;
    const p = pactOf(by, other, kind);
    if (!p) return false;
    endPact(p, by);
    return true;
  };

  // ── bot answers ──────────────────────────────────────────────────────────
  /** Troops actively committed by a against b. */
  const pressure = (a: PlayerId, b: PlayerId): number => {
    let s = 0;
    for (const x of game.attacks) if (x.alive && x.attacker === a && x.target === b) s += x.troops;
    return s;
  };

  const botAccepts = (o: DiploOffer): boolean => {
    const me = P[o.to], f = P[o.from];
    const id = me.id;
    const ps = pers(id);
    const st = aiState(id);
    const rel = game.q.relation(id, f.id);
    const trust = rel / 40 + rep(f.id) / 50;
    const fStrong = f.troops / Math.max(1, me.troops);
    const nb = game.neighborsOf(id);
    const jitter = (((o.id * 40503) >>> 0) % 1000) / 1000 - 0.5; // deterministic, no rng draw
    switch (o.kind) {
      case 'nap': {
        let s = trust + ps.loyal * 0.4 - 0.2;
        if (fStrong > 1.3) s += 0.8;                         // a strong neighbour: better at peace
        if (st?.threat && st.threat !== f.id) s += 0.5;      // busy elsewhere
        if (st?.war === f.id && fStrong < 0.7) s -= 1.2;     // we are about to eat them
        if (!nb.has(f.id)) s += 0.2;
        s -= ps.aggr * 0.4;
        return s + jitter * 0.3 > 0.2;
      }
      case 'truce': {
        const theirs = pressure(f.id, id), ours = pressure(id, f.id);
        let s = trust * 0.5 + (fStrong - 1) * 0.8 + (theirs > ours ? 0.6 : -0.4);
        if (me.troops < game.q.maxTroops(id) * 0.25) s += 0.6;
        if (fStrong < 0.5 && ours > 0) s -= 1.5;             // winning big: no mercy
        s -= ps.aggr * 0.3;
        return s + jitter * 0.3 > 0;
      }
      case 'tribute': {
        if (f.troops < me.troops * ADV.tributeMinRatio) return false;
        if (!nb.has(f.id) && !atWar(id, f.id)) return false; // empty threat
        let s = (fStrong - ADV.tributeMinRatio) * 0.3 + trust * 0.3 - ps.aggr * 0.6 + 0.2;
        if (me.kind === 'tribe') s += 0.4;
        if (pressure(f.id, id) > me.troops * 0.5) s += 0.6;  // they are already crushing us
        return s + jitter * 0.3 > 0;
      }
      case 'jointWar': {
        const T = P[o.target];
        if (!T.alive || game.hwhy(game.hooks.forbidAttack, id, T.id)) return false;
        if (!nb.has(T.id) && game.neighborsOf(id).size > 0 && me.troops < T.troops * 0.8) return false;
        let s = trust + (game.areAllied(id, f.id) ? 0.6 : 0.2) + ps.aggr * 0.5 - 0.3;
        s += (me.troops / Math.max(1, T.troops) - 1) * 0.5;
        s -= game.q.relation(id, T.id) / 40;
        if (st?.war === T.id || st?.threat === T.id) s += 0.8;
        if (!nb.has(T.id)) s -= 0.5;
        return s + jitter * 0.3 > 0.2;
      }
    }
    return false;
  };

  // ── bot initiatives ──────────────────────────────────────────────────────
  const tryOffer = (from: PlayerId, to: PlayerId, kind: OfferKind, target = 0): boolean => {
    if (to === game.humanId && game.tick - lastHumanOffer < ADIP.humanGap) return false;
    if (canOffer(from, to, kind, target) !== null) return false;
    if (!offer(from, to, kind, target)) return false;
    if (to === game.humanId) lastHumanOffer = game.tick;
    lastBotInit.set(from, game.tick);
    return true;
  };

  const botInitiative = (p: Player) => {
    const id = p.id, t = game.tick;
    if (t - (lastBotInit.get(id) ?? -1e9) < ADIP.botGap) return;
    if (adv.offers.some(o => o.from === id)) return;
    const ps = pers(id);
    const st = aiState(id);
    const nb = game.neighborsOf(id);
    const cap = Math.max(1, game.q.maxTroops(id));

    // 0) treachery: a disloyal, aggressive bot breaks a NAP with a much weaker neighbour, or a grown vassal
    //    throws off its overlord
    if (ps.loyal < 0.25 && ps.aggr > 0.6 && rep(id) > -60) {
      for (const k of nb.keys()) {
        if (!k) continue;
        const pc = pactOf(id, k, 'nap');
        if (pc && P[k].troops * 2.5 < p.troops && p.troops > cap * 0.5) {
          endPact(pc, id);
          if (st) st.war = k;
          lastBotInit.set(id, t);
          return;
        }
      }
    }
    const ov = overlordOf(id);
    if (ov && P[ov].troops < p.troops * 1.5 && ps.loyal < 0.7) {
      const pc = pactOf(id, ov, 'tribute');
      if (pc) { endPact(pc, id); lastBotInit.set(id, t); return; }
    }

    // 1) truce when losing a war
    let worst = 0, worstP = 0;
    for (const x of game.attacks) {
      if (!x.alive || x.target !== id || !x.attacker) continue;
      if (x.troops > worstP) { worstP = x.troops; worst = x.attacker; }
    }
    if (worst && alive(worst)) {
      const E = P[worst];
      const losing = E.troops > p.troops * 1.3 || worstP > p.troops * 0.8;
      if (losing && pressure(id, worst) < worstP && tryOffer(id, worst, 'truce')) return;
      if (losing && E.troops > p.troops * 1.3 && !ov && tryOffer(id, worst, 'nap')) return;
    }

    // 2) joint war: ask an ally (or pact partner) bordering our enemy to join
    const enemy = st?.war && alive(st.war) ? st.war : worst;
    if (enemy && alive(enemy)) {
      for (const a of p.allies) {
        if (!alive(a) || !game.neighborsOf(a).has(enemy)) continue;
        if (pressure(a, enemy) > 0) continue;
        if (tryOffer(id, a, 'jointWar', enemy)) return;
      }
    }

    // 3) tribute demands on much weaker neighbours / 4) NAP with strong neighbours
    let weak = 0, weakS = 0, strong = 0, strongS = 0;
    for (const [k, shared] of nb) {
      if (!k || !alive(k) || game.areAllied(id, k) || pactOf(id, k)) continue;
      const E = P[k];
      const ratio = p.troops / Math.max(1, E.troops);
      if (ratio >= ADV.tributeMinRatio * 1.2 && !overlordOf(k) && E.tiles > 20) {
        const s = (ps.greed + ps.aggr) * 0.5 + Math.min(1, shared / 40) + (E.kind === 'tribe' ? 0.2 : 0) - game.q.relation(id, k) / 100;
        if (s > weakS) { weakS = s; weak = k; }
      }
      if (ratio < 0.7 && game.q.relation(id, k) > -40 && st?.war !== k) {
        const s = 1 / Math.max(0.1, ratio) + rep(k) / 50;
        if (s > strongS) { strongS = s; strong = k; }
      }
    }
    if (weak && weakS > 0.6 && !ov && tryOffer(id, weak, 'tribute')) return;
    if (strong && (1 - ps.aggr) * strongS > 0.8 && tryOffer(id, strong, 'nap')) return;
  };

  // ── events ───────────────────────────────────────────────────────────────
  game.on(ev => {
    switch (ev.type) {
      case 'attackStarted': {
        const a = ev.attack;
        if (a.target) {
          markWar(a.attacker, a.target);
          // drop pending peace offers made by the aggressor to its victim (it just chose war)
        }
        break;
      }
      case 'allianceBroken':
        if (ev.betrayal) addRep(ev.by, ADV.reputation.betrayAlliance);
        break;
      case 'explosion': {
        let neutral = false;
        for (const v of ev.victims) if (v && v !== ev.owner && !atWar(ev.owner, v)) neutral = true;
        if (neutral) addRep(ev.owner, ADV.reputation.nukeNeutral);
        for (const v of ev.victims) if (v && v !== ev.owner) markWar(ev.owner, v);
        break;
      }
      case 'playerDied': {
        const id = ev.id;
        for (const pc of adv.pacts.filter(x => x.a === id || x.b === id)) endPact(pc, 0);
        for (let k = adv.offers.length - 1; k >= 0; k--) {
          const o = adv.offers[k];
          if (o.from !== id && o.to !== id && o.target !== id) continue;
          adv.offers.splice(k, 1);
          if (o.to !== id && o.from !== id) continue;
          const other = o.from === id ? o.to : o.from;
          if (alive(other) && o.from === other) game.msg(`Offerta a ${name(id)} decaduta`, 'info', other);
        }
        for (let k = pending.length - 1; k >= 0; k--) if (!adv.offers.includes(pending[k].offer)) pending.splice(k, 1);
        for (const k of [...lastWar.keys()]) if (Math.floor(k / 65536) === id || k % 65536 === id) lastWar.delete(k);
        lastBotInit.delete(id);
        break;
      }
    }
  });

  // ── tick ─────────────────────────────────────────────────────────────────
  game.systems.push({
    name: 'advDiplomacy',
    tick() {
      const t = game.tick;
      // tribute: direct gold transfer every tick (economy already ran this tick)
      for (let k = 0; k < adv.pacts.length; k++) {
        const pc = adv.pacts[k];
        if (pc.kind !== 'tribute') continue;
        const V = P[pc.b], O = P[pc.a];
        if (!V.alive || !O.alive) continue;
        const amt = Math.min(V.gold, Math.max(0, game.q.goldRate(pc.b)) * ADV.tributeShare);
        if (amt > 0) { V.gold -= amt; O.gold += amt; stats.tributeGold += amt; }
      }
      // bot replies
      if (pending.length) {
        for (let k = pending.length - 1; k >= 0; k--) {
          const pd = pending[k];
          if (pd.due > t) continue;
          pending.splice(k, 1);
          if (!adv.offers.includes(pd.offer)) continue;
          if (!alive(pd.offer.to) || !alive(pd.offer.from)) continue;
          respond(pd.offer.id, botAccepts(pd.offer));
        }
      }
      if (t % 10 !== 0) return;
      // war memory from live attacks
      for (const x of game.attacks) if (x.alive && x.target) lastWar.set(pairKey(x.attacker, x.target), t);
      // offer expiry
      for (let k = adv.offers.length - 1; k >= 0; k--) {
        const o = adv.offers[k];
        if (t - o.tick < ADV.offerExpiry) continue;
        adv.offers.splice(k, 1);
        stats.expired++;
        if (alive(o.from) && alive(o.to)) game.msg(`${name(o.to)} non ha risposto: ${describe(o)}`, 'info', o.from);
      }
      // pact expiry
      for (let k = adv.pacts.length - 1; k >= 0; k--) {
        const pc = adv.pacts[k];
        if (pc.untilTick && t >= pc.untilTick) endPact(pc, 0);
        else if (pc.untilTick && pc.untilTick - t === 300) {
          game.msg(`${PACT_LABEL[pc.kind]} con ${name(pc.b)} scade tra 30 s`, 'warn', pc.a);
          game.msg(`${PACT_LABEL[pc.kind]} con ${name(pc.a)} scade tra 30 s`, 'warn', pc.b);
        }
      }
      if (t % ADIP.repHealPeriod === 0) for (let id = 1; id < P.length; id++) if (P[id].alive && rep(id) < 0) addRep(id, 1);
      if (t % 600 === 0) for (const [k, until] of cooldown) if (until <= t) cooldown.delete(k);
      // bot initiatives (nations only, staggered: each considers every botPeriod ticks)
      if (t < 300) return;
      const slot = (t / 10) % (ADIP.botPeriod / 10);
      for (let id = 1 + slot; id < P.length; id += ADIP.botPeriod / 10) {
        const p = P[id];
        if (!p.alive || p.kind !== 'nation') continue;
        botInitiative(p);
      }
    },
  });

  adv.cmd.offer = offer;
  adv.cmd.respondOffer = respond;
  adv.cmd.breakPact = breakPact;
  adv.q.canOffer = canOffer;
  adv.q.pact = pactOf;

  game.ext.advDiplo = {
    /** Gold per tick the player gains (>0, overlord) or pays (<0, vassal) in tribute right now. */
    tributeRate: (p: PlayerId): number => {
      let r = 0;
      for (const pc of adv.pacts) {
        if (pc.kind !== 'tribute') continue;
        if (pc.b === p) r -= Math.max(0, game.q.goldRate(p)) * ADV.tributeShare;
        else if (pc.a === p) r += Math.max(0, game.q.goldRate(pc.b)) * ADV.tributeShare;
      }
      return r;
    },
    atWar, markWar, overlordOf, vassalsOf, formPact, reputation: rep, addReputation: addRep, botAccepts, stats,
  };
}
