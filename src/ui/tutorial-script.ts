// "Partita tutorial" — the steps, as data. Engine: ./tutorial.ts.
//
// kind 'info'  : the simulation is held, a card explains (title + 2–4 short sentences), Avanti / Indietro.
// kind 'do'    : "Ora tocca a te": the game runs, a compact bar gives the instruction, `done` is checked
//                ~10×/s; `doIt` ("Fallo per me") performs the action through the real commands.
// kind 'watch' : the game runs while something happens (a ship sails, a bomb flies); "Salta l'attesa".
// Text may contain {mouse wording|touch wording}; '\n' separates paragraphs.
// `prep` must be idempotent: it makes the world ready for the step even when the player jumps straight to it
// (resume, Indietro, ?step=N), and says what it gave ("Ti ho dato…").
import type { PlayerId, StructureType, Tile, Unit } from '../sim/types';
import { ADV } from '../sim/adv/rules';
import type { Ctx, Tutorial } from './tutorial';
import { TUTORIAL_SPOTS as SPOT } from '../map/tutorial';
import { fmt } from './format';
import { warshipsOf } from './adv';
import type { Panel } from './mobile';

export type Role = 'borea' | 'corvia' | 'marea' | 'ulda' | 'sarn';
type XY = { x: number; y: number };
type Txt = string | ((c: Ctx) => string);

export interface Step {
  id: string;
  chapter: 1 | 2;
  kind: 'info' | 'do' | 'watch';
  title: string;
  text: Txt;
  /** Only on this kind of device. */
  only?: 'mouse' | 'touch';
  /** CSS selectors (';' separated, {mouse|touch} allowed) of the HUD parts to spotlight. */
  target?: Txt;
  /** Move the camera here on enter (span = tiles across the short side). */
  focus?: (c: Ctx) => (XY & { span?: number }) | null;
  /** Map marker (tile coords). Evaluated once per step unless markLive. */
  mark?: (c: Ctx) => XY | null;
  markLive?: boolean;
  prep?: (c: Ctx) => void;
  enter?: (c: Ctx) => void;
  leave?: (c: Ctx) => void;
  tick?: (c: Ctx) => void;
  done?: (c: Ctx) => boolean;
  hint?: Txt;
  doIt?: (c: Ctx) => void;
  /** Seconds after "Fallo per me" before the step is completed anyway. */
  doItWait?: number;
  ok?: Txt;
  /** Touch: open the Comando sheet while this step is shown. */
  sheet?: boolean;
  /** Phones: open this fly-out ('mm' = show the minimap) while this step is shown. */
  panel?: Panel | 'mm';
  /** Stay visible while a modal (doctrines) is open. */
  modalOk?: boolean;
  /** Last card of a chapter: custom buttons. */
  final?: (c: Ctx) => { label: string; primary?: boolean; run: (t: Tutorial) => void }[];
}

// ── helpers ──────────────────────────────────────────────────────────────────
const me = (c: Ctx) => c.me.id;
const atk = (c: Ctx, target: PlayerId, by: PlayerId = me(c)) => c.g.attacks.find(a => a.alive && a.attacker === by && a.target === target) ?? null;
const T = (c: Ctx, x: number, y: number) => c.g.idx(x, y);
const spot = (s: XY): XY => ({ x: s.x, y: s.y });
const tileXY = (c: Ctx, t: Tile): XY | null => (t >= 0 ? c.xy(t) : null);
const KEY: Record<StructureType, string> = { city: 'C', port: 'P', fort: 'F', factory: 'B', silo: 'L', sam: 'M' };
const LABEL: Record<StructureType, string> = { city: 'Città', port: 'Porto', fort: 'Forte', factory: 'Fabbrica', silo: 'Silo', sam: 'SAM' };

/** Living tribe to use for the elimination / tribute lessons. */
function tribe(c: Ctx): Role | null {
  if (c.alive('ulda')) return 'ulda';
  if (c.alive('sarn')) return 'sarn';
  return null;
}
/** Raise the attack strength for a lesson, telling the player. */
function raise(c: Ctx, r: number): void {
  if (c.app.ratio >= r - 0.1) return;
  c.app.setRatio(r);
  c.give(`Ho alzato la forza d’attacco al ${Math.round(r * 100)}%.`);
}
function tribe2(c: Ctx): Role | null {
  if (c.alive('sarn')) return 'sarn';
  if (c.alive('ulda')) return 'ulda';
  return null;
}

/** Build step factory (chapter 1): city, factory, fort, port, silo, sam. */
function buildStep(type: StructureType, id: string, title: string, opts: { near?: (c: Ctx) => XY | null; coast?: boolean; extraGold?: number; ok: string }): Step {
  const where = (c: Ctx): Tile => {
    const cached = c.data.spot as Tile | undefined;
    if (cached !== undefined && cached >= 0 && c.g.q.canBuild(me(c), type, cached) === null) return cached;
    const t = c.buildSpot(type, opts.near?.(c) ?? undefined, !!opts.coast);
    c.data.spot = t;
    return t;
  };
  return {
    id, chapter: 1, kind: 'do', title,
    text: `{Clic destro su una tua casella › Costruisci › ${LABEL[type]}, oppure punta il mouse su una tua casella e premi ${KEY[type]}.|Tocca «Costruisci» in basso › ${LABEL[type]}, poi tocca una tua casella.|Tocca la casetta a sinistra (Costruisci) › ${LABEL[type]}, poi tocca una tua casella.}`
      + (opts.coast ? ' Deve stare sulla costa.' : ''),
    target: '{|.m-dock .m-db.bld}',
    prep: c => {
      if (opts.coast) c.ensureCoast();
      if (type === 'fort') c.ensureBorder(me(c), c.id('borea'));
      if (type === 'sam') c.ensureCoast();
      c.gold(c.g.q.buildCost(me(c), type) + (opts.extraGold ?? 0), 'per costruire');
    },
    mark: c => tileXY(c, where(c)),
    done: c => c.saw(e => e.type === 'structureBuilt' && e.structure.owner === me(c) && e.structure.type === type),
    hint: `{Clic destro sul cerchio: nel menu passa su «Costruisci» e scegli ${LABEL[type]}.|Tocca «Costruisci», scegli ${LABEL[type]} e poi tocca il cerchio.|Tocca la casetta nella colonna a sinistra, scegli ${LABEL[type]} e poi tocca il cerchio.}`,
    doIt: c => { c.gold(c.g.q.buildCost(me(c), type)); c.app.act.build(type, where(c)); },
    ok: opts.ok,
  };
}

/** Borea tile far enough from the player to be a safe bomb target. */
function nukeTarget(c: Ctx): Tile {
  if (c.data.nt !== undefined) return c.data.nt;
  const g = c.g, b = c.id('borea');
  const mine = c.tilesOf(me(c));
  const k = c.centroid(b);
  let best = -1, bd = Infinity;
  for (const t of c.tilesOf(b)) {
    const x = g.xOf(t), y = g.yOf(t);
    const d = (x - k.x) ** 2 + (y - k.y) ** 2;
    if (d >= bd) continue;
    let near = false;
    for (let i = 0; i < mine.length; i += 3) { const m = mine[i]; if ((g.xOf(m) - x) ** 2 + (g.yOf(m) - y) ** 2 < 20 * 20) { near = true; break; } }
    if (near) continue;
    bd = d; best = t;
  }
  if (best < 0) { const t = T(c, k.x, k.y); best = g.owner[t] === b ? t : -1; }
  c.data.nt = best;
  return best;
}

function ensureSiloReady(c: Ctx): void {
  let s = c.structure('silo', false);
  if (!s) {
    c.gold(c.g.q.buildCost(me(c), 'silo'));
    const t = c.buildSpot('silo');
    if (t >= 0 && c.raw.build(me(c), 'silo', t)) s = c.structure('silo', false);
  }
  if (s && s.readyTick > c.g.tick) { s.readyTick = c.g.tick; c.give('Ho completato io il silo.'); }
  if (s && s.cooldownUntil > c.g.tick) s.cooldownUntil = c.g.tick;
}

/** A port of `id` on its coast (created ready if missing). */
function portOf(c: Ctx, id: PlayerId, near: XY): Tile {
  const g = c.g;
  const have = g.structures.find(s => s.owner === id && s.type === 'port');
  if (have) return have.tile;
  let best = -1, bd = Infinity;
  for (const t of g.players[id].border) {
    if (!g.isCoast(t) || g.structureAt.has(t)) continue;
    let crowded = false;
    for (const s of g.structures) if ((s.x - g.xOf(t)) ** 2 + (s.y - g.yOf(t)) ** 2 < 25) { crowded = true; break; }
    if (crowded) continue;
    const d = (g.xOf(t) - near.x) ** 2 + (g.yOf(t) - near.y) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  if (best >= 0) g.addStructure('port', id, best, 0);
  return best;
}

function humanShips(c: Ctx): Unit[] {
  return c.g.units.filter(u => u.alive && u.type === 'warship' && u.owner === me(c));
}

function capitalOf(c: Ctx): Tile { return c.adv?.players[me(c)].capital ?? -1; }

/** Nearest oil deposit on the continent (land-reachable) not owned by the player. */
function oilDeposit(c: Ctx) {
  const adv = c.adv;
  if (!adv) return null;
  const k = c.centroid(me(c));
  const mass = c.g.ext.advResources?.landMass as Int32Array | undefined;
  const home = mass ? mass[T(c, SPOT.human.x, SPOT.human.y)] : 0;
  let best = null as null | (typeof adv.deposits)[number], bd = Infinity;
  for (const d of adv.deposits) {
    if (d.kind !== 'oil' || c.g.owner[d.tile] === me(c)) continue;
    if (mass && home && mass[d.tile] !== home) continue;
    const dd = (d.x - k.x) ** 2 + (d.y - k.y) ** 2;
    if (dd < bd) { bd = dd; best = d; }
  }
  return best;
}

/** Bring the player's border within `gap` tiles of `tile` (free land corridor). */
function approach(c: Ctx, tile: Tile, gap: number): boolean {
  const g = c.g, m = me(c);
  const x = g.xOf(tile), y = g.yOf(tile);
  for (const b of g.players[m].border) if ((g.xOf(b) - x) ** 2 + (g.yOf(b) - y) ** 2 <= gap * gap) return false;
  const path = c.corridor(m, n => n === tile, n => g.owner[n] === 0 || g.owner[n] === m);
  if (!path) return false;
  // path[0] is nearest the goal: keep the last `gap` tiles free
  const keep = path.filter(t => (g.xOf(t) - x) ** 2 + (g.yOf(t) - y) ** 2 > gap * gap);
  c.claim(m, keep, 1);
  return true;
}

function ensureOil(c: Ctx): void {
  const ap = c.adv?.players[me(c)];
  if (!ap || ap.res.oil >= 1) return;
  const d = oilDeposit(c);
  if (!d) return;
  approach(c, d.tile, 0);
  c.claim(me(c), [d.tile], 3);
  c.give('Ti ho dato un giacimento di petrolio.');
}

function ensurePort(c: Ctx): Tile {
  const s = c.structure('port', false);
  if (s) { if (s.readyTick > c.g.tick) s.readyTick = c.g.tick; return s.tile; }
  c.ensureCoast();
  c.gold(c.g.q.buildCost(me(c), 'port'));
  const t = c.buildSpot('port', undefined, true);
  if (t >= 0) { c.g.addStructure('port', me(c), t, 0); c.give('Ti ho costruito un porto sulla costa.'); }
  return t;
}

function mareaPort(c: Ctx): Tile {
  const g = c.g, id = c.id('marea');
  if (!g.players[id]?.alive) return -1;
  if (!g.structures.some(s => s.owner === id && s.type === 'port')) c.ensureCoast(id);
  return portOf(c, id, { x: 196, y: 52 });
}

function ensureWarship(c: Ctx): void {
  if (humanShips(c).length) return;
  const port = ensurePort(c);
  ensureOil(c);
  const adv = c.adv;
  if (!adv || port < 0) return;
  c.gold(adv.q.warshipCost(me(c)));
  if (c.raw.adv?.buildWarship(me(c), port)) c.give('Ti ho varato una nave da guerra.');
}

// ═════════════════════════════════════════════════════════════════════════════
// CHAPTER 1 — the base game
// ═════════════════════════════════════════════════════════════════════════════
const C1: Step[] = [
  {
    id: 'c1-welcome', chapter: 1, kind: 'info', title: 'Benvenuto in CAPTURE',
    text: 'Questa è una partita vera, su una mappa piccola. Il gioco si ferma ogni volta che c’è qualcosa da spiegare, poi tocca a te provarlo.\nLo scopo: possedere l’80% di tutte le terre emerse. Qui nessuno può eliminarti, quindi sperimenta senza paura.',
    focus: () => ({ ...spot(SPOT.human), span: 80 }), mark: () => spot(SPOT.human),
  },
  {
    id: 'c1-you', chapter: 1, kind: 'info', title: 'La tua nazione',
    text: 'La macchia di colore nel cerchio è la tua nazione: ogni puntino della mappa è una casella. Le altre macchie colorate sono nazioni e tribù guidate dal computer.\nLe terre senza colore sono terra libera: non sono di nessuno.',
    mark: () => spot(SPOT.human),
  },
  {
    id: 'c1-map', chapter: 1, kind: 'info', title: 'La mappa',
    text: 'Pianure, colline e montagne: colline e montagne sono più difficili da conquistare. Il mare separa il continente dall’isola a est.\nAll’inizio tutti si espandono nella terra libera; poi i confini si toccano e cominciano le guerre.',
    focus: c => ({ x: c.g.W / 2, y: c.g.H / 2, span: 400 }),
  },
  {
    id: 'c1-pan', chapter: 1, kind: 'do', title: 'Sposta la visuale.',
    text: '{Trascina la mappa tenendo premuto il tasto sinistro, oppure usa W A S D o le frecce.|Trascina la mappa con un dito.}',
    enter: c => { const cam = c.r.cam; cam.centerOn(SPOT.human.x, SPOT.human.y, Math.max(cam.fitScale() * 2.5, Math.min(cam.viewW, cam.viewH) / 70), false); c.data.cx = cam.x; c.data.cy = cam.y; },
    done: c => Math.hypot(c.r.cam.x - c.data.cx, c.r.cam.y - c.data.cy) * c.r.cam.scale > 90 && !c.r.cam.moving,
    hint: '{Tieni premuto il tasto sinistro sulla mappa e muovi il mouse, senza fare un semplice clic.|Appoggia un dito sulla mappa e fallo scorrere senza staccarlo.}',
    doIt: c => c.look(SPOT.borea.x, SPOT.borea.y, 120), doItWait: 2,
    ok: 'Visuale spostata.',
  },
  {
    id: 'c1-zoom', chapter: 1, kind: 'do', title: 'Avvicinati e allontanati.',
    text: '{Gira la rotellina del mouse sulla mappa.|Allarga o stringi due dita sulla mappa.}',
    enter: c => { c.data.s = c.r.cam.scale; },
    done: c => !c.r.cam.moving && (c.r.cam.scale / c.data.s > 1.35 || c.r.cam.scale / c.data.s < 0.74),
    hint: '{Punta il mouse sulla mappa e gira la rotellina in avanti o indietro.|Metti due dita sulla mappa e allontanale tra loro.}',
    doIt: c => { const cam = c.r.cam; cam.centerOn(cam.x, cam.y, cam.scale * 1.8); }, doItWait: 2,
    ok: 'Zoom cambiato.',
  },
  {
    id: 'c1-minimap', chapter: 1, kind: 'do', title: 'Usa la minimappa.',
    text: 'In basso a destra c’è tutta la mappa in piccolo, con un riquadro su ciò che stai guardando. {Clicca|Tocca} un punto della minimappa per saltarci.{||\nLa mostri o la nascondi con il pulsante della mappa in alto.}',
    target: '.minimap{||;.m-mmb}', panel: 'mm',
    done: c => c.saw(e => e.type === 'ui' && e.what === 'minimap'),
    hint: '{Clicca dentro il riquadro in basso a destra.|Tocca dentro il riquadro in basso a destra.}',
    doIt: c => { c.look(SPOT.marea.x, SPOT.marea.y, 140); c.t.signal('minimap'); }, doItWait: 1,
    ok: 'Con la minimappa salti subito dove vuoi.',
  },
  {
    id: 'c1-troops', chapter: 1, kind: 'info', title: 'Truppe',
    text: 'Il primo numero sono le tue truppe, il secondo il massimo che puoi avere{; accanto, quante ne guadagni al secondo|}.\nLe truppe ricrescono da sole: in fretta quando sei a metà, piano vicino al massimo. Più terre e più città alzano il massimo.',
    target: '.topbar .stat.troops',
    focus: () => ({ ...spot(SPOT.human), span: 90 }),
  },
  {
    id: 'c1-gold', chapter: 1, kind: 'info', title: 'Oro',
    text: 'Qui c’è il tuo oro{ e quanto ne guadagni al secondo|}. Serve per costruire edifici e lanciare bombe.\nPiù terre hai, più oro entra; fabbriche e porti ne aggiungono altro.',
    target: '.topbar .stat.gold',
  },
  {
    id: 'c1-land', chapter: 1, kind: 'info', title: 'Territorio',
    text: 'La percentuale di tutte le terre emerse che possiedi{, e il numero di caselle|, e il numero di caselle|}. La tacca sulla barra segna l’80%: arrivaci e hai vinto.',
    target: '.topbar .stat.land',
  },
  {
    id: 'c1-clock', chapter: 1, kind: 'info', title: 'Tempo e velocità',
    text: '{L’orologio mostra da quanto dura la partita. I pulsanti qui accanto mettono in pausa o accelerano il gioco a 2× e 4×. Da tastiera: Spazio per la pausa, 1, 2 e 4 per la velocità.|I pulsanti qui accanto mettono in pausa o accelerano il gioco a 2× e 4×.|L’orologio mostra da quanto dura la partita. Il pulsante «1×» in alto a destra cambia la velocità a ogni tocco: 2×, 4×, pausa, di nuovo 1×.}',
    target: '{.topbar .stat.time;|.topbar .speed|.topbar .stat.time;}.topbar .speed',
  },
  {
    id: 'c1-pause', chapter: 1, kind: 'do', title: 'Metti in pausa e riprendi.',
    text: '{Premi Spazio (o il pulsante di pausa), poi riprendi.|Tocca il pulsante di pausa, poi tocca 1× per riprendere.|Tocca il pulsante della velocità finché compare la pausa, poi toccalo ancora per ripartire.}',
    target: '.topbar .speed',
    tick: c => { if (c.app.speed === 0) c.data.paused = true; },
    done: c => !!c.data.paused && c.app.speed > 0,
    hint: '{Premi la barra spaziatrice due volte.|Tocca il primo pulsante (le due barrette), poi «1×».|È il pulsante «1×» in alto a destra: dopo 2× e 4× arriva la pausa (due barrette). Anche ☰ mette in pausa.}',
    doIt: c => { c.data.paused = true; c.app.setSpeed(0); c.app.setSpeed(1); }, doItWait: 1,
    ok: 'Il gioco riparte.',
  },
  {
    id: 'c1-names', chapter: 1, kind: 'do', title: 'Nascondi e mostra i nomi.',
    text: '{Premi T per nascondere i nomi dei paesi, poi di nuovo T per rimetterli.|Tocca «Aa» in alto per nascondere i nomi, poi toccalo di nuovo. Il pulsante accanto mette il gioco a schermo intero.}',
    target: '{|.tb-names}',
    enter: c => { c.data.v = c.r.showLabels; c.data.n = 0; },
    tick: c => { if (c.r.showLabels !== c.data.v) { c.data.v = c.r.showLabels; c.data.n++; } },
    done: c => c.data.n >= 2 || (c.data.n >= 1 && c.secs > 8 && c.r.showLabels),
    hint: '{Premi il tasto T sulla tastiera, due volte.|Il pulsante «Aa» è in alto a destra, accanto alla velocità.|Il pulsante «Aa» è in alto a destra, nella fila di pulsanti.}',
    doIt: c => { c.r.showLabels = !c.r.showLabels; c.r.showLabels = true; c.data.n = 2; }, doItWait: 1,
    leave: c => { c.r.showLabels = true; },
    ok: 'Nomi di nuovo visibili.',
  },
  {
    id: 'c1-expand-info', chapter: 1, kind: 'info', title: 'Espandersi',
    text: 'Per crescere mandi truppe nella terra libera che confina con te: {clicca|tocca} la terra libera e le truppe avanzano casella dopo casella.\nOgni casella conquistata costa truppe: più ne mandi, più lontano arrivi.',
    focus: () => ({ ...spot(SPOT.human), span: 70 }),
    mark: c => tileXY(c, c.freeNear(SPOT.pass.x, SPOT.pass.y, 4)),
  },
  {
    id: 'c1-ratio', chapter: 1, kind: 'info', title: 'Forza d’attacco',
    text: 'Questa barra decide quante delle tue truppe partono a ogni {clic|tocco}: con il 25% di 2.000 truppe ne mandi 500. Il numero accanto mostra quante ne partiranno.\n{Si regola trascinando la barra o con i tasti Q ed E.|Si regola trascinando la barra o con i pulsanti − e +.}',
    target: '.ratio',
  },
  {
    id: 'c1-ratio-do', chapter: 1, kind: 'do', title: 'Alza la forza al 40% o più.',
    text: '{Trascina la barra verso destra o premi E.|Trascina la barra verso destra o tocca +.}',
    target: '.ratio',
    prep: c => { if (c.app.ratio >= 0.4) c.app.setRatio(0.25); },
    done: c => c.app.ratio >= 0.4,
    hint: '{Premi E tre o quattro volte, oppure trascina il pallino della barra in basso.|Tocca il pulsante + tre o quattro volte.}',
    doIt: c => c.app.setRatio(0.5), doItWait: 1,
    ok: c => `Forza al ${Math.round(c.app.ratio * 100)}%.`,
  },
  {
    id: 'c1-expand', chapter: 1, kind: 'do', title: 'Espanditi.',
    text: '{Clicca|Tocca} la terra libera nel cerchio (va bene anche un’altra terra libera che confina con te).',
    prep: c => c.troops(1500),
    mark: c => tileXY(c, c.data.t ??= c.freeNear(SPOT.pass.x, SPOT.pass.y, 4)),
    done: c => c.did('attack', a => a[1] === 0),
    hint: '{Un clic semplice sul cerchio, senza trascinare.|Un tocco breve sul cerchio, senza trascinare.}',
    doIt: c => c.app.act.primary(c.data.t ?? c.freeNear(SPOT.pass.x, SPOT.pass.y, 4)), doItWait: 2,
    ok: 'Le tue truppe avanzano nella terra libera.',
  },
  {
    id: 'c1-expand-watch', chapter: 1, kind: 'watch', title: 'Guarda il confine allargarsi.',
    text: 'Le truppe avanzano finché bastano. Puoi {cliccare|toccare} ancora la terra libera per mandarne altre.',
    done: c => c.secs > 14 || (c.secs > 4 && !atk(c, 0)),
    ok: 'Il tuo territorio è cresciuto.',
  },
  {
    id: 'c1-neighbour', chapter: 1, kind: 'info', title: 'Il tuo vicino: Borea',
    text: 'Questa è Borea, una nazione del computer. Ora confinate via terra: solo così puoi attaccarla a piedi.\nPer attaccare un giocatore {clicchi|tocchi} il suo territorio, proprio come la terra libera.',
    prep: c => { c.ensureBorder(me(c), c.id('borea')); },
    focus: c => ({ ...c.centroid(c.id('borea')), span: 110 }),
    mark: c => tileXY(c, c.frontTileOf(c.id('borea'), 3)),
  },
  {
    id: 'c1-terrain', chapter: 1, kind: 'info', title: 'Colline e montagne',
    text: 'Tra te e Borea corre una catena di montagne. Le colline difendono una volta e mezza, le montagne due volte e mezza: costano più truppe e si prendono più lentamente.\nIl passo di colline al centro è la strada più comoda.',
    focus: () => ({ x: SPOT.ridge.x, y: SPOT.ridge.y + 10, span: 80 }), mark: () => spot(SPOT.pass),
  },
  {
    id: 'c1-attack', chapter: 1, kind: 'do', title: 'Attacca Borea.',
    text: '{Clicca|Tocca} il territorio di Borea nel cerchio.',
    prep: c => { c.ensureBorder(me(c), c.id('borea')); c.troops(2500); raise(c, 0.4); },
    focus: c => ({ ...c.xy(c.frontTileOf(c.id('borea'), 3)), span: 80 }),
    mark: c => tileXY(c, c.data.t ??= c.frontTileOf(c.id('borea'), 3)),
    done: c => c.did('attack', a => a[1] === c.id('borea')),
    hint: '{Un clic semplice sulla terra di Borea, dentro il cerchio.|Un tocco breve sulla terra di Borea, dentro il cerchio.}',
    doIt: c => c.app.act.attack(c.id('borea')), doItWait: 2,
    ok: 'Attacco partito contro Borea.',
  },
  {
    id: 'c1-attacks-panel', chapter: 1, kind: 'info', title: 'Il pannello degli attacchi',
    text: 'Ogni attacco in corso compare qui: contro chi, quante truppe restano e una barra che si svuota man mano che le spendi.{||\nLo apri con il pulsante della spada in alto, che conta gli attacchi in corso.}\nSe {clicchi|tocchi} di nuovo lo stesso nemico, rinforzi l’attacco. «Ritira» richiama le truppe: a casa ne torna il 75%.',
    prep: c => { if (!atk(c, c.id('borea'))) { c.ensureBorder(me(c), c.id('borea')); c.troops(2000); c.raw.attack(me(c), c.id('borea'), c.me.troops * 0.3); } },
    target: '.attacks{||;.m-atkb}', panel: 'atk',
  },
  {
    id: 'c1-reinforce', chapter: 1, kind: 'do', title: 'Rinforza l’attacco.',
    text: '{Clicca|Tocca} di nuovo Borea: le nuove truppe si aggiungono all’attacco in corso.',
    prep: c => { c.ensureBorder(me(c), c.id('borea')); c.troops(1500); },
    mark: c => tileXY(c, c.data.t ??= c.frontTileOf(c.id('borea'), 3)),
    done: c => c.did('attack', a => a[1] === c.id('borea')),
    hint: '{Clicca ancora sul territorio di Borea.|Tocca ancora il territorio di Borea.}',
    doIt: c => c.app.act.attack(c.id('borea')), doItWait: 2,
    ok: 'Attacco rinforzato: guarda il numero di truppe nel pannello.',
  },
  {
    id: 'c1-retreat', chapter: 1, kind: 'do', title: 'Ritira le truppe.',
    text: 'Premi «Ritira» nella riga di Borea, nel pannello degli attacchi.',
    target: '.attacks .atk:not(.inc) .btn', panel: 'atk',
    prep: c => { if (!atk(c, c.id('borea'))) { c.ensureBorder(me(c), c.id('borea')); c.troops(2000); c.raw.attack(me(c), c.id('borea'), c.me.troops * 0.3); } },
    done: c => c.did('retreat'),
    hint: 'Il pulsante «Ritira» è a destra del numero di truppe, nel riquadro «Attacchi».',
    doIt: c => { const a = atk(c, c.id('borea')); if (a) c.app.act.retreat(a.id); }, doItWait: 2,
    ok: 'Truppe richiamate: il 75% è tornato a casa.',
  },
  {
    id: 'c1-incoming', chapter: 1, kind: 'info', title: 'Sei sotto attacco!',
    text: 'Borea ti ha appena attaccato. I bordi dello schermo si colorano di rosso e l’attacco compare nel pannello, sotto «Sotto attacco»{||, e in alto un avviso con «Contrattacca»}.\nLe tue truppe difendono da sole, ma un contrattacco consuma le truppe nemiche una contro una.',
    prep: c => {
      const b = c.id('borea');
      c.ensureBorder(me(c), b, false);
      if (!atk(c, me(c), b)) {
        const B = c.P('borea');
        B.troops = Math.max(B.troops, 1500);
        c.raw.attack(b, me(c), Math.max(200, Math.min(B.troops * 0.35, c.me.troops * 0.3, 900)));
      }
    },
    target: '.attacks', panel: 'atk',
    focus: c => ({ ...c.xy(c.frontTileOf(c.id('borea'), 0)), span: 80 }),
  },
  {
    id: 'c1-counter', chapter: 1, kind: 'do', title: 'Contrattacca.',
    text: 'Premi «Contrattacca» nella riga di Borea (usa la forza scelta in basso), oppure {clicca|tocca} il territorio di Borea.',
    target: '.attacks .atk.inc .btn', panel: 'atk',
    prep: c => {
      const b = c.id('borea');
      c.ensureBorder(me(c), b, false);
      c.troops(1500);
      if (!atk(c, me(c), b)) { const B = c.P('borea'); B.troops = Math.max(B.troops, 1200); c.raw.attack(b, me(c), Math.max(200, Math.min(B.troops * 0.3, 700))); }
    },
    done: c => c.did('attack', a => a[1] === c.id('borea')),
    hint: 'Il pulsante «Contrattacca» è nella riga rossa del pannello, a destra.',
    doIt: c => c.app.act.attack(c.id('borea')), doItWait: 2,
    leave: c => { const a = atk(c, me(c), c.id('borea')); if (a) c.raw.retreat(a.id); },
    ok: 'Contrattacco partito: Borea si ritira.',
  },
  {
    id: 'c1-elim-info', chapter: 1, kind: 'info', title: 'Eliminare un giocatore',
    text: c => {
      const t = tribe(c);
      return t ? `Chi perde tutte le sue terre è eliminato, e il suo oro va a chi l’ha finito. Le tribù come ${c.P(t).name.replace('Tribù di ', '')} sono piccole e deboli: il bersaglio ideale per cominciare.`
        : 'Chi perde tutte le sue terre è eliminato, e il suo oro va a chi l’ha finito. Le tribù sono piccole e deboli: hai già eliminato quelle vicine!';
    },
    prep: c => { const t = tribe(c); if (t) c.ensureBorder(me(c), c.id(t)); },
    focus: c => { const t = tribe(c); return t ? { ...c.centroid(c.id(t)), span: 70 } : null; },
    mark: c => { const t = tribe(c); return t ? c.centroid(c.id(t)) : null; },
  },
  {
    id: 'c1-eliminate', chapter: 1, kind: 'do', title: 'Elimina la tribù.',
    text: c => { const t = tribe(c); return t ? `{Clicca|Tocca} il territorio di ${c.P(t).name}: attacca finché non resta nulla. Se serve, alza la forza e rinforza.` : 'Non ci sono più tribù da eliminare.'; },
    prep: c => {
      const t = tribe(c);
      c.data.role = t;
      if (!t) return;
      c.ensureBorder(me(c), c.id(t));
      c.troops(c.P(t).troops * 4 + 800);
      raise(c, 0.6);
    },
    mark: c => (c.data.role && c.alive(c.data.role) ? c.centroid(c.id(c.data.role)) : null),
    markLive: true,
    done: c => !c.data.role || !c.alive(c.data.role),
    hint: 'Ci vogliono molte truppe: alza la forza al 60% e {clicca|tocca} di nuovo la tribù per rinforzare.',
    doIt: c => {
      const r = c.data.role as Role;
      if (!r || !c.alive(r)) return;
      c.ensureBorder(me(c), c.id(r), false);
      c.troops(c.P(r).troops * 5 + 1000);
      c.raw.attack(me(c), c.id(r), Math.max(c.me.troops * 0.6, c.P(r).troops * 4));
    },
    doItWait: 25,
    ok: 'Tribù eliminata: il suo oro ora è tuo.',
  },
  {
    id: 'c1-build-info', chapter: 1, kind: 'info', title: 'Oro ed edifici',
    text: 'Con l’oro costruisci edifici sulle tue terre. Ogni edificio dello stesso tipo costa il 40% in più del precedente.\nServono alcuni secondi per finirlo e finché è in costruzione non fa nulla. Due edifici devono stare ad almeno 5 caselle.',
    target: '.topbar .stat.gold',
  },
  {
    id: 'c1-howbuild', chapter: 1, kind: 'info', title: 'Come si costruisce',
    text: '{Il clic destro su una casella apre il menu delle azioni: per le tue caselle c’è «Costruisci», con tutti gli edifici e il prezzo.\nPiù veloce: punta il mouse su una tua casella e premi un tasto. C città, B fabbrica, F forte, P porto, M SAM, L silo.|Tocca «Costruisci» in basso a sinistra, scegli l’edificio, poi tocca una tua casella.\nTenendo premuto il dito su una casella si apre anche il menu delle azioni, con «Costruisci».|Tocca la casetta a sinistra (Costruisci), scegli l’edificio, poi tocca una tua casella.\nTenendo premuto il dito su una casella si apre anche il menu delle azioni, con «Costruisci».}',
    target: '{|.m-dock .m-db.bld}',
  },
  {
    id: 'c1-city-info', chapter: 1, kind: 'info', title: 'Città',
    text: 'La città alza del 25% il tuo massimo di truppe, ed è anche un centro di rifornimento nella modalità avanzata. La prima costa 500 oro.',
    target: '{|.m-dock .m-db.bld}',
  },
  buildStep('city', 'c1-city', 'Costruisci una città.', { ok: 'Città in costruzione: tra 5 secondi sarà attiva.' }),
  {
    id: 'c1-factory-info', chapter: 1, kind: 'info', title: 'Fabbrica',
    text: 'La fabbrica produce 12 oro al secondo: è il modo più rapido per arricchirsi. La prima costa 600 oro.',
  },
  buildStep('factory', 'c1-factory', 'Costruisci una fabbrica.', { ok: 'Fabbrica in costruzione.' }),
  {
    id: 'c1-fort-info', chapter: 1, kind: 'info', title: 'Forte',
    text: 'Le tue caselle entro 12 dal forte difendono due volte e mezza. Mettilo vicino al confine con chi ti minaccia. Costa 300 oro.',
    prep: c => { c.ensureBorder(me(c), c.id('borea')); },
    focus: c => ({ ...c.xy(c.frontTileOf(c.id('borea'), 0)), span: 80 }),
    mark: c => c.xy(c.frontTileOf(c.id('borea'), 0)),
  },
  buildStep('fort', 'c1-fort', 'Costruisci un forte verso Borea.', {
    near: c => { const t = c.frontTileOf(c.id('borea'), 0); const k = c.centroid(me(c)); const p = c.xy(t); return { x: Math.round(p.x * 0.75 + k.x * 0.25), y: Math.round(p.y * 0.75 + k.y * 0.25) }; },
    ok: 'Forte in costruzione: il confine con Borea è più sicuro.',
  }),
  {
    id: 'c1-port-info', chapter: 1, kind: 'info', title: 'Porto',
    text: 'Il porto va sulla costa. Produce 3 oro al secondo, ti permette una nave in più in mare e manda navi mercantili verso i porti degli altri. Costa 400 oro.',
    prep: c => { c.ensureCoast(); },
    focus: c => { const t = [...c.me.border].find(x => c.g.isCoast(x)); return t !== undefined ? { ...c.xy(t), span: 90 } : null; },
    mark: c => tileXY(c, [...c.me.border].find(t => c.g.isCoast(t)) ?? -1),
  },
  buildStep('port', 'c1-port', 'Costruisci un porto.', { coast: true, ok: 'Porto in costruzione.' }),
  {
    id: 'c1-silo-sam-info', chapter: 1, kind: 'info', title: 'Silo e SAM',
    text: 'Restano due edifici: il silo, che lancia le bombe atomiche (3.000 oro), e la SAM, che le abbatte (1.800 oro). Li costruirai più avanti, nel capitolo sulle armi.',
  },
  // ── the sea ──
  {
    id: 'c1-sea-info', chapter: 1, kind: 'info', title: 'Il mare',
    text: 'Per raggiungere terre oltre il mare servono navi da sbarco: partono dalla tua costa e non serve un porto. Al massimo 3 navi in mare insieme, più una per ogni porto.\nQuando sbarcano prendono una testa di ponte e l’attacco continua da lì.',
    prep: c => { c.ensureCoast(); },
    focus: () => ({ ...spot(SPOT.islandFree), span: 120 }), mark: () => spot(SPOT.islandFree),
  },
  {
    id: 'c1-boat', chapter: 1, kind: 'do', title: 'Sbarca sull’isola.',
    text: '{Premi V e poi clicca la terra libera dell’isola nel cerchio. Va bene anche un clic diretto: se non confini via terra, parte una nave.|Tocca «Nave» in basso, poi tocca la terra libera dell’isola nel cerchio.|Tocca la barca a sinistra (Nave), poi tocca la terra libera dell’isola nel cerchio.}',
    target: '{|.m-dock .m-db.nav}',
    prep: c => { c.ensureCoast(); c.troops(2000); raise(c, 0.4); },
    mark: () => spot(SPOT.islandFree),
    done: c => c.did('sendBoat'),
    hint: '{Il cerchio è sull’isola a destra: premi V, poi clicca proprio lì.|Tocca il pulsante «Nave» (in basso a sinistra), poi il cerchio sull’isola.|Tocca la barca nella colonna a sinistra, poi il cerchio sull’isola.}',
    doIt: c => c.app.act.boat(c.g.owner[T(c, SPOT.islandFree.x, SPOT.islandFree.y)] === 0 ? T(c, SPOT.islandFree.x, SPOT.islandFree.y) : T(c, SPOT.islandFree.x + 4, SPOT.islandFree.y + 4)), doItWait: 2,
    ok: 'La nave è salpata.',
  },
  {
    id: 'c1-boat-watch', chapter: 1, kind: 'watch', title: 'Guarda la traversata.',
    text: 'La nave segue la rotta più breve. {Premi 4|Tocca 4×} per accelerare.',
    mark: c => { const u = c.g.units.find(v => v.alive && v.type === 'transport' && v.owner === me(c)); return u ? { x: u.x, y: u.y } : spot(SPOT.islandFree); },
    markLive: true,
    done: c => c.saw(e => e.type === 'boatLanded' && e.owner === me(c)) || (c.secs > 3 && !c.g.units.some(v => v.alive && v.type === 'transport' && v.owner === me(c))),
    leave: c => { if (c.app.speed > 1) c.app.setSpeed(1); },
    ok: 'Sbarco riuscito: ecco la tua testa di ponte sull’isola.',
  },
  {
    id: 'c1-trade', chapter: 1, kind: 'info', title: 'Navi mercantili',
    text: 'Ogni porto manda da solo navi mercantili verso i porti degli altri: all’arrivo pagano oro a entrambi, di più se il viaggio è lungo. Marea ha un porto sulla sua isola, quindi i vostri porti commerciano.\nUn embargo blocca questi scambi.',
    prep: c => { mareaPort(c); },
    focus: c => { const t = mareaPort(c); return t >= 0 ? { ...c.xy(t), span: 90 } : null; },
    mark: c => tileXY(c, mareaPort(c)),
  },
  // ── diplomacy ──
  {
    id: 'c1-dip-info', chapter: 1, kind: 'info', title: 'Alleanze',
    text: 'Due alleati non possono attaccarsi. Un’alleanza dura 4 minuti: nell’ultimo minuto puoi rinnovarla con una nuova proposta. Al massimo 4 alleati a testa.',
    focus: c => ({ ...c.centroid(c.id('corvia')), span: 110 }), mark: c => c.centroid(c.id('corvia')),
  },
  {
    id: 'c1-ally', chapter: 1, kind: 'do', title: 'Proponi un’alleanza a Corvia.',
    text: '{Clic destro sul territorio di Corvia › Proponi alleanza.|Tieni premuto il dito sul territorio di Corvia › Proponi alleanza.}',
    mark: c => c.centroid(c.id('corvia')),
    done: c => c.g.areAllied(me(c), c.id('corvia')),
    hint: '{Clic con il tasto destro dentro il cerchio, poi la voce «Proponi alleanza».|Tieni il dito fermo dentro il cerchio finché si apre il menu, poi «Proponi alleanza».}',
    doIt: c => c.app.act.propose(c.id('corvia')), doItWait: 4,
    ok: 'Corvia ha accettato: siete alleati.',
  },
  {
    id: 'c1-request', chapter: 1, kind: 'info', title: 'Una richiesta per te',
    text: 'Marea ti propone un’alleanza: la richiesta compare in alto con «Accetta» e «Rifiuta». Se non rispondi, dopo 30 secondi decade.',
    prep: c => {
      const m = c.id('marea');
      if (!c.g.areAllied(me(c), m) && !c.g.allianceRequests.some(r => r.from === m && r.to === me(c))) c.raw.proposeAlliance(m, me(c));
    },
    target: '.requests .req',
  },
  {
    id: 'c1-request-do', chapter: 1, kind: 'do', title: 'Rispondi a Marea.',
    text: 'Premi «Accetta» o «Rifiuta» sulla richiesta in alto.',
    target: '.requests .req',
    tick: c => {
      const m = c.id('marea');
      if (c.did('respondAlliance') || c.g.areAllied(me(c), m)) return;
      if (!c.g.allianceRequests.some(r => r.from === m && r.to === me(c))) c.raw.proposeAlliance(m, me(c));
    },
    done: c => c.did('respondAlliance', a => a[2] === c.id('marea')) || c.g.areAllied(me(c), c.id('marea')),
    hint: '{La richiesta di Marea è in alto al centro, con il pulsante verde «Accetta».|La richiesta di Marea è in alto al centro, con il pulsante verde «Accetta».|La richiesta di Marea è in alto a sinistra, con il pulsante verde «Accetta».}',
    doIt: c => { const r = c.g.allianceRequests.find(x => x.from === c.id('marea') && x.to === me(c)); if (r) c.app.act.respond(r.id, true); }, doItWait: 2,
    ok: c => (c.g.areAllied(me(c), c.id('marea')) ? 'Ora sei alleato anche di Marea.' : 'Hai rifiutato: Marea resta neutrale.'),
  },
  {
    id: 'c1-betray', chapter: 1, kind: 'info', title: 'Rompere un’alleanza',
    text: 'Dal menu di un alleato puoi rompere l’alleanza quando vuoi, ma per un minuto sarai marchiato TRADITORE.\nLo vedono tutti in classifica: le altre nazioni si fidano meno di te e ti prendono di mira più volentieri.',
  },
  {
    id: 'c1-embargo-info', chapter: 1, kind: 'info', title: 'Embargo',
    text: 'Un embargo blocca il commercio con un giocatore: niente navi mercantili tra voi. Lo irrita, quindi usalo con chi è già tuo nemico.',
    focus: c => ({ ...c.centroid(c.id('borea')), span: 110 }),
  },
  {
    id: 'c1-embargo', chapter: 1, kind: 'do', title: 'Metti l’embargo a Borea.',
    text: '{Clic destro sul territorio di Borea › Embargo.|Tieni premuto sul territorio di Borea › Embargo.}',
    mark: c => c.centroid(c.id('borea')),
    done: c => c.me.embargoes.has(c.id('borea')),
    hint: '{Clic destro nel cerchio, poi la voce «Embargo».|Tieni premuto nel cerchio, poi «Embargo».}',
    doIt: c => c.app.act.embargo(c.id('borea'), true), doItWait: 1,
    ok: 'Embargo attivo: niente commercio con Borea.',
  },
  {
    id: 'c1-donate', chapter: 1, kind: 'do', title: 'Fai un dono a Corvia.',
    text: 'Puoi donare truppe od oro a chiunque: la quantità è la percentuale della forza d’attacco. {Clic destro su Corvia › Dona oro (o Dona truppe).|Tieni premuto su Corvia › Dona oro (o Dona truppe).}',
    prep: c => c.gold(800, 'da regalare'),
    mark: c => c.centroid(c.id('corvia')),
    done: c => c.did('donate'),
    hint: '{Clic destro nel cerchio, poi «Dona oro».|Tieni premuto nel cerchio, poi «Dona oro».}',
    doIt: c => c.app.act.donate(c.id('corvia'), 'gold'), doItWait: 1,
    ok: 'Dono consegnato: Corvia ti apprezza di più.',
  },
  {
    id: 'c1-card', chapter: 1, kind: 'info', title: 'La scheda del giocatore',
    text: '{Passando il mouse su un territorio|Toccando un nome in classifica, o «Info» nel menu,} vedi la scheda del giocatore: terre, truppe, oro, alleati e cosa pensa di te («Verso di te»).\nChi ti apprezza accetta più volentieri le tue proposte.',
    enter: c => { c.app.hud.hoverPlayer = 0; c.app.hud.mapHover = 0; c.app.selectPlayer(c.id('corvia')); },
    leave: c => c.app.selectPlayer(0),
    target: '.side .pcard',
  },
  // ── nukes ──
  {
    id: 'c1-nukes-info', chapter: 1, kind: 'info', title: 'Armi nucleari',
    text: 'La bomba atomica (1.500 oro) cancella tutto in un raggio di 12 caselle, la bomba H (7.000 oro) in un raggio di 30. Terre, edifici e navi nell’esplosione spariscono e chi le possedeva perde truppe.\nRestano radiazioni: lì conquistare costa molto di più finché non svaniscono.',
  },
  buildStep('silo', 'c1-silo', 'Costruisci un silo.', { extraGold: 1500, ok: 'Silo in costruzione: si ricarica 15 secondi dopo ogni lancio.' }),
  {
    id: 'c1-silo-watch', chapter: 1, kind: 'watch', title: 'Il silo è in costruzione.',
    text: 'Ci vogliono 10 secondi. Intanto guarda il bersaglio: il cerchio sul territorio di Borea.',
    prep: c => { if (!c.structure('silo', false)) ensureSiloReady(c); },
    focus: c => { const t = nukeTarget(c); return t >= 0 ? { ...c.xy(t), span: 120 } : null; },
    mark: c => tileXY(c, nukeTarget(c)),
    done: c => !!c.structure('silo', true),
    doIt: c => ensureSiloReady(c), doItWait: 1,
    ok: 'Il silo è pronto.',
  },
  {
    id: 'c1-nuke', chapter: 1, kind: 'do', title: 'Lancia un’atomica su Borea.',
    text: '{Premi N e clicca il bersaglio nel cerchio, oppure clic destro sul bersaglio › Lancia atomica.|Tocca «Armi» › Atomica, tocca il bersaglio nel cerchio e poi «Lancia».|Tocca il mirino a sinistra (Armi) › Atomica, tocca il bersaglio nel cerchio e poi «Lancia».}',
    target: '{|.m-dock .m-db.arm}',
    prep: c => {
      ensureSiloReady(c);
      c.gold(c.g.q.nukeCost(me(c), 'atom'), 'per la bomba');
      // Borea must survive the blast (the tutorial still needs it)
      const B = c.P('borea');
      if (B?.alive && B.tiles < 900) c.g.claimDisc(B.id, B.spawnX, B.spawnY, 17);
    },
    focus: c => { const t = nukeTarget(c); return t >= 0 ? { ...c.xy(t), span: 110 } : null; },
    mark: c => tileXY(c, nukeTarget(c)),
    done: c => c.did('launchNuke'),
    hint: '{Premi N: compare un cerchio rosso che segue il mouse. Clicca dentro il cerchio del tutorial.|Tocca «Armi», poi «Atomica», poi il bersaglio e infine il pulsante rosso «Lancia».|Tocca il mirino nella colonna a sinistra, poi «Atomica», poi il bersaglio e infine il pulsante rosso «Lancia».}',
    doIt: c => { const t = nukeTarget(c); if (t >= 0) c.app.act.nuke('atom', t); }, doItWait: 2,
    ok: 'Missile lanciato!',
  },
  {
    id: 'c1-nuke-watch', chapter: 1, kind: 'watch', title: 'Il missile è in volo…',
    text: 'Vola a 30 caselle al secondo: più il bersaglio è lontano, più tempo hanno le SAM nemiche per abbatterlo.',
    mark: c => { const u = c.g.units.find(v => v.alive && (v.type === 'atom' || v.type === 'hydrogen') && v.owner === me(c)); return u ? { x: u.x, y: u.y } : null; },
    markLive: true,
    done: c => c.saw(e => (e.type === 'explosion' || e.type === 'nukeIntercepted') && e.owner === me(c)) || (c.secs > 2 && !c.g.units.some(v => v.alive && v.type === 'atom' && v.owner === me(c))),
    ok: 'Boom. Il cerchio scuro è la zona radioattiva: le radiazioni svaniscono piano piano.',
  },
  {
    id: 'c1-sam-info', chapter: 1, kind: 'info', title: 'Difesa: la SAM',
    text: 'Una SAM abbatte le bombe che le passano entro 45 caselle: il 70% delle atomiche, il 35% delle bombe H. Dopo ogni colpo si ricarica per 12 secondi. Costa 1.800 oro.',
  },
  buildStep('sam', 'c1-sam', 'Costruisci una SAM vicino alla costa.', {
    near: c => { const t = [...c.me.border].find(x => c.g.isCoast(x)); return t !== undefined ? c.xy(t) : null; },
    ok: 'SAM in costruzione.',
  }),
  {
    id: 'c1-sam-watch', chapter: 1, kind: 'watch', title: 'Borea risponde.',
    text: 'Appena la tua SAM è pronta, Borea lancia un’atomica verso il mare davanti alla tua costa (non colpirà le tue terre): guarda la SAM in azione.',
    prep: c => {
      let s = c.structure('sam', false);
      if (!s) { c.gold(c.g.q.buildCost(me(c), 'sam')); const t = c.buildSpot('sam'); if (t >= 0) c.raw.build(me(c), 'sam', t); s = c.structure('sam', false); }
    },
    focus: c => { const s = c.structure('sam', false); return s ? { x: s.x, y: s.y, span: 120 } : null; },
    tick: c => {
      if (c.data.launched || c.data.none) return;
      const s = c.structure('sam', true);
      if (!s) return;
      const g = c.g, b = c.id('borea'), B = c.P('borea');
      if (!B?.alive) { c.data.none = true; return; }
      const target = c.safeWater(s.x, s.y, 15, 36);
      if (target < 0) { c.data.none = true; return; }
      let silo = g.structures.find(x => x.owner === b && x.type === 'silo');
      if (!silo) {
        const k = c.centroid(b);
        let best = -1, bd = Infinity;
        for (const t of c.tilesOf(b)) { if (g.structureAt.has(t)) continue; const d = (g.xOf(t) - k.x) ** 2 + (g.yOf(t) - k.y) ** 2; if (d < bd) { bd = d; best = t; } }
        if (best >= 0) silo = g.addStructure('silo', b, best, 0);
      }
      if (!silo) { c.data.none = true; return; }
      silo.readyTick = Math.min(silo.readyTick, g.tick); silo.cooldownUntil = 0;
      B.gold = Math.max(B.gold, g.q.nukeCost(b, 'atom') + 10);
      c.data.launched = c.raw.launchNuke(b, 'atom', target);
      c.data.target = target;
      if (!c.data.launched) c.data.none = true;
    },
    mark: c => { const u = c.g.units.find(v => v.alive && v.type === 'atom' && v.owner === c.id('borea')); return u ? { x: u.x, y: u.y } : c.data.target !== undefined ? c.xy(c.data.target) : null; },
    markLive: true,
    done: c => !!c.data.none || c.saw(e => (e.type === 'nukeIntercepted' || e.type === 'explosion') && e.owner === c.id('borea')),
    ok: c => c.saw(e => e.type === 'nukeIntercepted' && e.owner === c.id('borea')) ? 'La tua SAM ha abbattuto la bomba!'
      : c.data.none ? 'Borea non ha potuto lanciare: la tua SAM resta di guardia.' : 'Questa volta la SAM ha mancato (succede 3 volte su 10): la bomba è caduta in mare.',
  },
  // ── the rest of the screen ──
  {
    id: 'c1-leaderboard', chapter: 1, kind: 'info', title: 'Classifica',
    text: 'I giocatori in vita, ordinati per terre, con le loro truppe. Le etichette ALLEATO e TRADITORE ti dicono di chi fidarti.\n{Clicca|Tocca} un nome per andare a vederlo sulla mappa.{|Tocca il titolo «Classifica» per aprirla o chiuderla.|Si apre con il pulsante «#» in alto: il numero è la tua posizione.}',
    enter: c => { if (c.phone) return; const el = document.querySelector('.side .leaderboard'); if (el?.classList.contains('collapsed')) { el.classList.remove('collapsed'); c.data.col = true; } },
    leave: c => { if (c.data.col) document.querySelector('.side .leaderboard')?.classList.add('collapsed'); },
    target: '.side .leaderboard{||;.m-lbb}', panel: 'lb',
  },
  {
    id: 'c1-log', chapter: 1, kind: 'info', title: 'Registro degli eventi',
    text: 'Qui compaiono gli avvenimenti: attacchi, alleanze, sbarchi, bombe. {Clicca|Tocca} una riga che indica un luogo per vederlo sulla mappa.{|Il pulsante «Eventi» in basso apre tutto lo storico.|L’ultima notizia compare per pochi secondi sopra la forza d’attacco; il pulsante con le righe, in fondo alla colonna a sinistra (Eventi), apre tutto lo storico.}',
    enter: c => { if (c.touch && !c.phone && !c.app.hud.logExpanded) { c.app.hud.setLogExpanded(true); c.data.exp = true; } },
    leave: c => { if (c.data.exp) c.app.hud.setLogExpanded(false); },
    panel: 'log',
    target: '{.log|.log;.m-dock .m-db.evt}',
  },
  {
    id: 'c1-coalition', chapter: 1, kind: 'info', title: 'Coalizione contro il primo',
    text: 'Quando qualcuno supera il 35% delle terre, gli altri smettono di farsi la guerra e si alleano contro di lui. Se sei tu il primo, preparati: arriveranno da tutte le parti.',
  },
  {
    id: 'c1-end', chapter: 1, kind: 'info', title: 'Come finisce la partita',
    text: 'Vince chi possiede l’80% delle terre. Se perdi tutte le tue terre la partita finisce per te, ma puoi restare a guardare.\nDal menu ☰{ (o con Esc)|} puoi mettere in pausa, rileggere la guida «Come si gioca» o iniziare un’altra partita.{ Il pulsante ? (o il tasto ?) apre subito la guida.|}',
    target: '.topbar .menu-btns',
  },
  {
    id: 'c1-recap', chapter: 1, kind: 'info', title: 'Capitolo 1 completato',
    text: 'Ora sai muovere la visuale, espanderti, attaccare e difenderti, eliminare un nemico, costruire, andare per mare, fare diplomazia e usare le atomiche: è tutto il gioco base.\nLa modalità avanzata aggiunge fronti, capitale, rifornimenti, risorse, flotte, dottrine, patti e nebbia di guerra. Si gioca in una nuova partita.',
    final: () => [
      { label: 'Esci dal tutorial', run: t => t.exit() },
      { label: 'Continua con la modalità avanzata', primary: true, run: t => t.app.startTutorial(2) },
    ],
  },
];

// ═════════════════════════════════════════════════════════════════════════════
// CHAPTER 2 — the advanced game
// ═════════════════════════════════════════════════════════════════════════════
const C2: Step[] = [
  {
    id: 'c2-intro', chapter: 2, kind: 'info', title: 'La modalità avanzata',
    text: 'Questa è una nuova partita: le regole di prima più nove sistemi. Fronti, capitale e rifornimenti, economia, risorse, flotta, dottrine, patti, scenari e nebbia di guerra.\nPer cominciare ti ho dato un territorio più grande, 6.000 truppe e 1.000 oro.',
    focus: () => ({ ...spot(SPOT.human), span: 110 }), mark: () => spot(SPOT.human),
  },
  {
    id: 'c2-panel', chapter: 2, kind: 'info', title: 'Il pannello Comando',
    text: '{A sinistra c’è il pannello Comando: risorse, postura, lavoratori, capitale, dottrine e flotta. Lo vedremo pezzo per pezzo.|Il pulsante «Comando» in basso apre il pannello con risorse, postura, lavoratori, capitale, dottrine e flotta. Lo vedremo pezzo per pezzo.|Il pulsante «Comando» (la stella, a sinistra) apre il pannello con risorse, postura, lavoratori, capitale, dottrine, flotta e obiettivi. Lo vedremo pezzo per pezzo.}',
    target: '{.adv-panel|.m-dock .m-db.cmd}',
  },
  {
    id: 'c2-panel-open', chapter: 2, kind: 'do', only: 'touch', title: 'Apri il pannello Comando.',
    text: '{|Tocca «Comando» in basso. Toccalo di nuovo per richiuderlo.|Tocca «Comando» (la stella) a sinistra. Toccalo di nuovo, o tocca la mappa, per richiuderlo.}',
    target: '.m-dock .m-db.cmd',
    done: c => c.app.advHud.sheetOpen,
    hint: '{|È il pulsante con la stella, nella fila in basso a sinistra.|È il pulsante con la stella, nella colonna di pulsanti a sinistra.}',
    doIt: c => c.app.mobile.setOpen('cmd', true), doItWait: 1,
    leave: c => c.app.mobile.setOpen('cmd', false),
    ok: 'Pannello aperto: lo riapriremo quando serve.',
  },
  {
    id: 'c2-focus-info', chapter: 2, kind: 'info', title: 'Attacco mirato',
    text: 'Qui {un clic|un tocco} attacca un punto preciso: le truppe prendono solo le caselle entro 28 dal punto, ma con il 25% di forza in più. Un cerchio mostra la zona del fronte.\nServe un tuo confine vicino al punto.',
    focus: () => ({ ...spot(SPOT.human), span: 100 }),
    mark: c => tileXY(c, c.freeNear(SPOT.corvia.x, SPOT.corvia.y - 20, 6)),
  },
  {
    id: 'c2-focus', chapter: 2, kind: 'do', title: 'Fai un attacco mirato.',
    text: '{Clicca|Tocca} la terra libera nel cerchio.',
    prep: c => { c.troops(3000); if (c.app.wholeFront) c.app.setWholeFront(false); },
    mark: c => tileXY(c, c.data.t ??= c.freeNear(SPOT.corvia.x, SPOT.corvia.y - 20, 6)),
    done: c => c.did('attackAt'),
    hint: '{Un clic semplice nel cerchio, senza trascinare.|Un tocco breve nel cerchio.}',
    doIt: c => c.app.aa.focus(c.data.t ?? c.freeNear(SPOT.corvia.x, SPOT.corvia.y - 20, 6)), doItWait: 2,
    ok: 'Attacco mirato partito: guarda il cerchio del fronte.',
  },
  {
    id: 'c2-front-info', chapter: 2, kind: 'info', title: 'Fronte intero',
    text: 'Il pulsante «Mirato» {sopra la|sopra la|all’inizio della barra della} forza d’attacco cambia modalità: con «Fronte intero» {il clic|il tocco} attacca lungo tutto il confine, come nel gioco base.{ Fa lo stesso il pulsante «Fronte intero» nel pannello, o il tasto G.|}',
    target: '.rt-front{;.adv-front|}',
  },
  {
    id: 'c2-front', chapter: 2, kind: 'do', title: 'Passa al fronte intero e torna al mirato.',
    text: '{Premi G (o il pulsante «Mirato») due volte.|Tocca «Mirato» per passare al fronte intero, poi toccalo di nuovo.}',
    target: '.rt-front',
    tick: c => { if (c.app.wholeFront) c.data.on = true; },
    done: c => !!c.data.on && !c.app.wholeFront,
    hint: '{Il pulsante è sopra la barra della forza, a destra; oppure premi G.|Il pulsante è sopra la barra della forza.|Il pulsante è in basso, a sinistra del − nella barra della forza.}',
    doIt: c => { c.app.setWholeFront(true); c.app.setWholeFront(false); c.data.on = true; }, doItWait: 1,
    ok: 'Di nuovo in modalità mirata.',
  },
  {
    id: 'c2-stance-info', chapter: 2, kind: 'info', title: 'Postura',
    text: 'Offensiva: attacco ×1,2 ma difesa ×0,8. Difensiva: attacco ×0,75 e difesa ×1,35. Bilanciata: tutto normale.\nDopo ogni cambio devi aspettare 20 secondi.{ Tasto Z.|}',
    target: '.adv-stance', sheet: true,
  },
  {
    id: 'c2-stance', chapter: 2, kind: 'do', title: 'Scegli una postura offensiva o difensiva.',
    text: '{Clicca «Offensiva» o «Difensiva» nel pannello, oppure premi Z.|Tocca «Offensiva» o «Difensiva» nel pannello.}',
    target: '.adv-stance', sheet: true,
    done: c => c.adv!.players[me(c)].stance !== 'balanced',
    hint: 'I tre pulsanti sono sotto la scritta «Postura».',
    doIt: c => c.app.aa.stance('offense'), doItWait: 1,
    ok: 'Postura cambiata: ora per 20 secondi resta così.',
  },
  {
    id: 'c2-capital-info', chapter: 2, kind: 'info', title: 'La capitale',
    text: 'La stella è la tua capitale: le caselle entro 10 difendono una volta e mezza. Se cade perdi metà delle truppe e chi la prende ti porta via il 30% dell’oro; poi rinasce nella tua città più grande.\n{Tasto K o pulsante «Capitale» per tornarci.|Il pulsante «Capitale» nel pannello ti ci riporta.}',
    focus: c => { const t = capitalOf(c); return t >= 0 ? { ...c.xy(t), span: 70 } : null; },
    mark: c => tileXY(c, capitalOf(c)),
  },
  {
    id: 'c2-capital', chapter: 2, kind: 'do', title: 'Sposta la capitale nella nuova città.',
    text: '{Clic destro sulla città nel cerchio › Sposta qui la capitale, oppure «Sposta…» nel pannello e poi clic sulla città.|Tieni premuto sulla città nel cerchio › Sposta qui la capitale, oppure «Sposta…» nel pannello e poi tocca la città.} Costa 1.500 oro.',
    target: '.adv-caprow', sheet: true,
    prep: c => {
      const cap = capitalOf(c);
      let city = c.g.structuresOf(me(c), 'city', true).find(s => s.tile !== cap) ?? null;
      if (!city) {
        c.gold(c.g.q.buildCost(me(c), 'city'), '');
        const k = c.centroid(me(c));
        const t = c.buildSpot('city', { x: k.x + 12, y: k.y - 4 });
        if (t >= 0) { city = c.g.addStructure('city', me(c), t, 0); c.give('Ti ho costruito una città.'); }
      }
      if (city && city.readyTick > c.g.tick) city.readyTick = c.g.tick;
      c.data.city = city?.tile ?? -1;
      c.gold(ADV.capitalMoveCost, 'per il trasloco');
    },
    mark: c => tileXY(c, c.data.city),
    done: c => c.saw(e => e.type === 'capitalMoved' && e.owner === me(c)),
    hint: '{Clic destro proprio sull’icona della città, poi «Sposta qui la capitale».|Tieni premuto sull’icona della città, poi «Sposta qui la capitale».}',
    doIt: c => c.app.aa.moveCapital(c.data.city), doItWait: 1,
    ok: 'La capitale ora è nella nuova città.',
  },
  {
    id: 'c2-supply-info', chapter: 2, kind: 'info', title: 'Rifornimenti',
    text: 'Capitale, città e porti sono i tuoi centri di rifornimento. Entro 70 caselle da un centro attacchi a piena forza; più lontano la forza cala, fino a meno della metà a 240 caselle.\nPer combattere lontano, costruisci città vicino al fronte.',
    focus: () => ({ ...spot(SPOT.human), span: 130 }),
  },
  {
    id: 'c2-cut', chapter: 2, kind: 'watch', title: 'Un avamposto isolato.',
    text: 'Ti ho dato delle terre staccate dalle tue: non hanno rifornimenti. Tra poco compaiono tratteggiate e il pannello Comando mostra un avviso.',
    prep: c => {
      if (c.adv!.players[me(c)].cutTiles > 0) return;
      const g = c.g, k = c.centroid(me(c));
      // a free spot 10+ tiles beyond the border, toward the north-west
      let best = -1, bd = Infinity;
      for (let y = 8; y < g.H - 8; y += 2) for (let x = 8; x < g.W - 8; x += 2) {
        const t = g.idx(x, y);
        if (!g.isLand(t) || g.owner[t] !== 0) continue;
        let clear = true;
        for (let dy = -8; dy <= 8 && clear; dy += 2) for (let dx = -8; dx <= 8; dx += 2) {
          if (!g.inBounds(x + dx, y + dy)) continue;
          const i = g.idx(x + dx, y + dy);
          if (g.owner[i] !== 0 || g.isWater(i)) { clear = false; break; }
        }
        if (!clear) continue;
        if (c.adv!.deposits.some(dp => (dp.x - x) ** 2 + (dp.y - y) ** 2 < 14 * 14)) continue;
        const d = Math.abs(Math.hypot(x - k.x, y - k.y) - 34) + (x > k.x ? 30 : 0);
        if (d < bd) { bd = d; best = t; }
      }
      if (best >= 0) { g.claimDisc(me(c), g.xOf(best), g.yOf(best), 4); c.data.ex = best; }
    },
    focus: c => (c.data.ex !== undefined ? { ...c.xy(c.data.ex), span: 90 } : null),
    mark: c => (c.data.ex !== undefined ? c.xy(c.data.ex) : null),
    done: c => c.adv!.players[me(c)].cutTiles > 0,
    ok: 'Eccole: tratteggiate, senza rifornimenti.',
  },
  {
    id: 'c2-cut-info', chapter: 2, kind: 'info', title: 'Terre isolate e rivolte',
    text: 'Le terre tagliate fuori difendono poco e, se restano isolate per 30 secondi, si arrendono al vicino. Ricollegale conquistando le caselle in mezzo.\nGli imperi molto grandi (oltre il 10% delle terre) subiscono anche rivolte nelle zone lontane da ogni centro.',
    target: '.adv-cut', sheet: true,
  },
  {
    id: 'c2-econ-info', chapter: 2, kind: 'info', title: 'Lavoratori e soldati',
    text: 'Il cursore divide la popolazione: verso «Lavoratori» guadagni più oro e meno truppe, verso «Soldati» il contrario. A metà è come nel gioco base.',
    target: '.adv-panel .adv-sec:has(input[type=range])', sheet: true,
  },
  {
    id: 'c2-econ', chapter: 2, kind: 'do', title: 'Sposta il cursore lavoratori / soldati.',
    text: 'Trascinalo verso i lavoratori o verso i soldati e lascialo.',
    target: '.adv-panel .adv-sec:has(input[type=range])', sheet: true,
    done: c => Math.abs(c.adv!.players[me(c)].workers - 0.5) >= 0.05,
    hint: 'Trascina il pallino della barra sotto «Lavoratori … Soldati» e poi rilascialo.',
    doIt: c => c.app.aa.workers(0.7), doItWait: 1,
    ok: c => `Lavoratori al ${Math.round(c.adv!.players[me(c)].workers * 100)}%: guarda come cambiano oro e truppe al secondo.`,
  },
  {
    id: 'c2-upkeep', chapter: 2, kind: 'info', title: 'Manutenzione',
    text: 'Oltre i primi 4 edifici, ognuno costa un po’ d’oro al secondo: la cifra compare qui, sotto il cursore. Se l’oro finisce, le truppe crescono la metà.',
    target: '.adv-panel .adv-sec:has(input[type=range]) .adv-note', sheet: true,
  },
  {
    id: 'c2-res-info', chapter: 2, kind: 'info', title: 'Risorse strategiche',
    text: 'Sulla mappa ci sono giacimenti di petrolio, ferro e uranio; i numeri nel pannello dicono quanti ne possiedi, e ognuno rende anche oro.\nFerro: +8% di attacco ciascuno (fino a 3). Petrolio: navi più veloci, una nave in più e le navi da guerra. Uranio: serve per le atomiche (2 per la bomba H).',
    target: '.adv-res', sheet: true,
    focus: c => { const d = oilDeposit(c); return d ? { x: d.x, y: d.y, span: 110 } : null; },
    mark: c => { const d = oilDeposit(c); return d ? { x: d.x, y: d.y } : null; },
  },
  {
    id: 'c2-oil', chapter: 2, kind: 'do', title: 'Conquista il giacimento di petrolio.',
    text: c => (c.adv!.players[me(c)].res.oil >= 1 ? 'Possiedi già un giacimento di petrolio: ottimo.' : '{Clicca|Tocca} il giacimento nel cerchio: un attacco mirato lo prende in fretta.'),
    prep: c => {
      const d = oilDeposit(c);
      c.data.dep = d ? d.tile : -1;
      if (d && approach(c, d.tile, 12)) c.give('Ho avvicinato il tuo confine al giacimento.');
      c.troops(2500);
    },
    mark: c => tileXY(c, c.data.dep),
    done: c => c.adv!.players[me(c)].res.oil >= 1,
    hint: '{Clicca proprio sull’icona del giacimento: l’attacco mirato si concentra lì.|Tocca proprio l’icona del giacimento.}',
    doIt: c => { const t = c.data.dep as Tile; if (t >= 0 && c.adv!.q.canAttackAt(me(c), t) === null) c.app.aa.focus(t); else ensureOil(c); },
    doItWait: 12,
    ok: 'Petrolio conquistato: ora puoi varare navi da guerra.',
  },
  {
    id: 'c2-fleet-info', chapter: 2, kind: 'info', title: 'La flotta',
    text: `Dai tuoi porti costruisci navi da guerra: servono almeno un giacimento di petrolio e ${fmt(ADV.warshipCost)} oro (ogni nave costa il 35% in più). Ne puoi avere una, più una per porto e per petrolio.\nAffondano le navi nemiche, colpiscono i trasporti e bloccano i porti.`,
    target: '.adv-res .fleet', sheet: true,
  },
  {
    id: 'c2-warship', chapter: 2, kind: 'do', title: 'Costruisci una nave da guerra.',
    text: '{Clic destro sul tuo porto nel cerchio › Costruisci nave da guerra.|Tieni premuto sul tuo porto nel cerchio › Costruisci nave da guerra.}',
    prep: c => { c.data.port = ensurePort(c); ensureOil(c); c.gold(c.adv!.q.warshipCost(me(c)), 'per la nave'); },
    focus: c => (c.data.port >= 0 ? { ...c.xy(c.data.port), span: 70 } : null),
    mark: c => tileXY(c, c.data.port),
    done: c => warshipsOf(c.g, me(c)) > 0,
    hint: '{Clic destro proprio sull’icona del porto: compare la voce «Costruisci nave da guerra».|Tieni premuto sull’icona del porto: compare la voce «Costruisci nave da guerra».}',
    doIt: c => { c.gold(c.adv!.q.warshipCost(me(c))); c.app.aa.buildWarship(c.data.port); }, doItWait: 1,
    ok: 'Nave da guerra varata.',
  },
  {
    id: 'c2-fleet-send', chapter: 2, kind: 'do', title: 'Manda la nave davanti al porto di Marea.',
    text: '{Premi X (o «Invia flotta» nel pannello), poi clicca il mare nel cerchio.|Nel pannello Comando tocca «Invia flotta», poi tocca il mare nel cerchio.}',
    target: '.adv-fleet', sheet: true,
    prep: c => { ensureWarship(c); const p = mareaPort(c); c.data.sea = p >= 0 ? c.waterNear(p, 7) : -1; },
    focus: c => (c.data.sea >= 0 ? { ...c.xy(c.data.sea), span: 150 } : null),
    tick: c => { if (!humanShips(c).length) ensureWarship(c); },
    mark: c => tileXY(c, c.data.sea),
    done: c => c.did('sendFleet', a => c.data.sea < 0 || Math.hypot(c.g.xOf(a[1]) - c.g.xOf(c.data.sea), c.g.yOf(a[1]) - c.g.yOf(c.data.sea)) <= 22),
    hint: 'Il cerchio è nel mare accanto all’isola di Marea, a est. {Premi X e clicca lì.|Tocca «Invia flotta» e poi il cerchio.}',
    doIt: c => { if (c.data.sea >= 0) c.app.aa.sendFleet(c.data.sea); }, doItWait: 2,
    leave: c => { if (c.app.renderer.aim) c.app.setAim(null); },
    ok: 'La nave da guerra fa rotta verso Marea.',
  },
  {
    id: 'c2-embargo', chapter: 2, kind: 'do', title: 'Rendi Marea un nemico: embargo.',
    text: 'Le navi da guerra sparano solo a chi è in guerra con te o sotto embargo. {Clic destro su Marea › Embargo.|Tieni premuto su Marea › Embargo.}',
    focus: () => ({ ...spot(SPOT.marea), span: 110 }),
    mark: () => spot(SPOT.marea),
    done: c => c.me.embargoes.has(c.id('marea')),
    hint: '{Clic destro nel cerchio sull’isola, poi «Embargo».|Tieni premuto nel cerchio sull’isola, poi «Embargo».}',
    doIt: c => c.app.act.embargo(c.id('marea'), true), doItWait: 1,
    ok: 'Embargo contro Marea: ora la tua flotta la tratta da nemica.',
  },
  {
    id: 'c2-blockade', chapter: 2, kind: 'watch', title: 'Blocco navale.',
    text: 'Quando la tua nave arriva entro 16 caselle dal porto di Marea, il porto è bloccato: niente commercio e non rifornisce più le sue terre. {Premi 4|Tocca 4×} per accelerare.',
    prep: c => {
      ensureWarship(c);
      if (!c.me.embargoes.has(c.id('marea'))) c.raw.setEmbargo(me(c), c.id('marea'), true);
    },
    focus: c => { const p = mareaPort(c); return p >= 0 ? { ...c.xy(p), span: 90 } : null; },
    tick: c => {
      if (!humanShips(c).length) { ensureWarship(c); return; }
      if (c.data.sent) return;
      c.data.sent = true;
      // a ship that is not heading for Marea's port yet gets the order now
      const p = mareaPort(c), sea = p >= 0 ? c.waterNear(p, 7) : -1;
      const u = humanShips(c)[0];
      if (sea >= 0 && Math.hypot(u.ext.patrol.x - c.g.xOf(sea), u.ext.patrol.y - c.g.yOf(sea)) > 22) c.raw.adv?.sendFleet(me(c), sea);
    },
    mark: c => { const u = humanShips(c)[0]; return u ? { x: u.x, y: u.y } : null; },
    markLive: true,
    done: c => { const p = mareaPort(c); const s = p >= 0 ? c.g.structureAt.get(p) : undefined; return !s || c.adv!.q.isBlockaded(s); },
    doIt: c => {
      // "Salta l'attesa": the ship arrives at once
      const u = humanShips(c)[0], p = mareaPort(c), sea = p >= 0 ? c.waterNear(p, 7) : -1;
      if (!u || sea < 0) return;
      u.x = c.g.xOf(sea); u.y = c.g.yOf(sea); u.ext.at = sea; u.ext.path = null; u.ext.goto = -1; u.ext.patrol = { x: u.x, y: u.y };
      u.ext.wait = c.g.tick + 150; // hold position in front of the port for a while
    },
    doItWait: 4,
    leave: c => { if (c.app.speed > 1) c.app.setSpeed(1); },
    ok: 'Porto di Marea bloccato.',
  },
  {
    id: 'c2-sink', chapter: 2, kind: 'watch', title: 'Un trasporto nemico.',
    text: 'Un trasporto di Marea è uscito dal porto: la tua nave da guerra lo colpisce da sola, finché affonda.',
    prep: c => {
      if (c.data.u) return;
      const ship = humanShips(c)[0];
      if (!ship) return;
      const g = c.g;
      const comp = g.ext.naval?.nav?.comp as Int32Array | undefined;
      const at = ship.ext.at as Tile;
      let best = -1, bd = Infinity;
      for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) {
        const x = Math.round(ship.x) + dx, y = Math.round(ship.y) + dy;
        if (!g.inBounds(x, y)) continue;
        const t = g.idx(x, y);
        if (!g.isWater(t) || (comp && comp[t] !== comp[at])) continue;
        const d = Math.abs(Math.hypot(dx, dy) - 7);
        if (d < bd) { bd = d; best = t; }
      }
      if (best < 0) return;
      const m = c.id('marea');
      const u = g.addUnit('transport', m, best, best, 300);
      u.x = g.xOf(best); u.y = g.yOf(best);
      u.ext.path = [best]; u.ext.pathIndex = 1;
      c.data.u = u;
    },
    focus: c => { const u = humanShips(c)[0]; return u ? { x: u.x, y: u.y, span: 60 } : null; },
    mark: c => { const u = c.data.u as Unit | undefined; return u && u.alive ? { x: u.x, y: u.y } : null; },
    markLive: true,
    done: c => !c.data.u || !(c.data.u as Unit).alive,
    doIt: c => { const u = c.data.u as Unit | undefined; if (u?.alive) { c.g.removeUnit(u); c.g.msg('⚓ Affondato un trasporto di Marea', 'good', me(c), Math.round(u.x), Math.round(u.y)); } }, doItWait: 1,
    leave: c => { const u = c.data.u as Unit | undefined; if (u?.alive) c.g.removeUnit(u); },
    ok: 'Trasporto affondato!',
  },
  {
    id: 'c2-doct-info', chapter: 2, kind: 'info', title: 'Dottrine',
    text: 'Tre rami di ricerca da tre livelli: Guerra lampo (attacco), Fortezza (difesa), Proiezione (mare e atomiche). Una ricerca alla volta: il livello I costa 1.500 oro e 30 secondi, poi 4.000 e 9.000.\nOgni livello già preso in un altro ramo rende la ricerca più cara del 50%.',
    target: '.adv-doc', sheet: true,
  },
  {
    id: 'c2-doct', chapter: 2, kind: 'do', title: 'Avvia una ricerca.',
    text: '{Premi R (o «Dottrine» nel pannello) e scegli un ramo.|Tocca «Dottrine» nel pannello Comando e scegli un ramo.}',
    target: '.adv-docs .adv-br .btn.primary;.adv-doc', sheet: true, modalOk: true,
    prep: c => c.gold(c.adv!.q.doctrineCost(me(c), 'blitz'), 'per la ricerca'),
    done: c => { const d = c.adv!.players[me(c)].doctrine; return !!d.researching || d.level.blitz + d.level.fortress + d.level.projection > 0; },
    hint: '{Apri le dottrine con R e premi uno dei pulsanti arancioni «Ricerca I».|Tocca «Dottrine» e poi uno dei pulsanti «Ricerca I».}',
    doIt: c => c.app.aa.research('blitz'), doItWait: 1,
    leave: c => c.app.advHud.closeDoctrinePanel(),
    ok: 'Ricerca avviata: la barra nel pannello mostra a che punto è.',
  },
  {
    id: 'c2-pacts-info', chapter: 2, kind: 'info', title: 'Patti',
    text: 'Oltre alle alleanze ci sono i patti: non aggressione (3 minuti senza attacchi), tregua (ferma le guerre in corso), tributo (il vassallo ti versa il 20% del suo oro e tu non lo attacchi) e guerra congiunta.\nSi propongono dal menu di un altro paese, alla voce «Diplomazia».',
    focus: c => ({ ...c.centroid(c.id('corvia')), span: 110 }),
  },
  {
    id: 'c2-nap', chapter: 2, kind: 'do', title: 'Proponi un patto di non aggressione a Corvia.',
    text: '{Clic destro su Corvia › Diplomazia › Patto di non aggressione.|Tieni premuto su Corvia › Diplomazia › Patto di non aggressione.}',
    mark: c => c.centroid(c.id('corvia')),
    done: c => !!c.adv!.q.pact(me(c), c.id('corvia'), 'nap'),
    hint: '{Nel menu di Corvia passa su «Diplomazia» per vedere i patti.|Nel menu di Corvia tocca «Diplomazia» per aprire i patti.}',
    doIt: c => c.app.aa.offer(c.id('corvia'), 'nap'), doItWait: 4,
    ok: 'Corvia accetta: per 3 minuti nessuno dei due può attaccare l’altro.',
  },
  {
    id: 'c2-offer-info', chapter: 2, kind: 'info', title: 'Offerte in arrivo',
    text: 'Borea ti propone un patto di non aggressione. Le offerte compaiono in alto, come le richieste di alleanza; se non rispondi decadono dopo 30 secondi.',
    prep: c => {
      const b = c.id('borea');
      if (!c.adv!.q.pact(me(c), b, 'nap') && !c.adv!.offers.some(o => o.from === b && o.to === me(c))) c.t.botOffer(b, 'nap');
    },
    target: '.requests .adv-offer',
  },
  {
    id: 'c2-offer', chapter: 2, kind: 'do', title: 'Rispondi a Borea.',
    text: 'Premi «Accetta» o «Rifiuta» sull’offerta in alto.',
    target: '.requests .adv-offer',
    tick: c => {
      const b = c.id('borea');
      if (c.did('respondOffer') || c.adv!.q.pact(me(c), b, 'nap')) return;
      if (!c.adv!.offers.some(o => o.from === b && o.to === me(c))) c.t.botOffer(b, 'nap');
    },
    done: c => c.did('respondOffer', a => a[2] === c.id('borea')) || !!c.adv!.q.pact(me(c), c.id('borea'), 'nap'),
    hint: '{L’offerta di Borea è in alto al centro.|L’offerta di Borea è in alto al centro.|L’offerta di Borea è in alto a sinistra.}',
    doIt: c => { const o = c.adv!.offers.find(x => x.from === c.id('borea') && x.to === me(c)); if (o) c.app.aa.respond(o.id, true); }, doItWait: 2,
    ok: c => (c.adv!.q.pact(me(c), c.id('borea'), 'nap') ? 'Patto con Borea firmato.' : 'Hai rifiutato l’offerta di Borea.'),
  },
  {
    id: 'c2-tribute', chapter: 2, kind: 'do', title: 'Chiedi un tributo a una tribù.',
    text: c => { const t = tribe2(c); return t ? `{Clic destro su ${c.P(t).name} › Diplomazia › Richiesta di tributo.|Tieni premuto su ${c.P(t).name} › Diplomazia › Richiesta di tributo.} Se accetta diventa tuo vassallo.` : 'Non ci sono tribù: passa oltre.'; },
    prep: c => { c.data.role = tribe2(c); },
    focus: c => (c.data.role ? { ...c.centroid(c.id(c.data.role)), span: 90 } : null),
    mark: c => (c.data.role ? c.centroid(c.id(c.data.role)) : null),
    done: c => !c.data.role || !!c.adv!.q.pact(me(c), c.id(c.data.role), 'tribute'),
    hint: '{Nel menu della tribù passa su «Diplomazia», poi «Richiesta di tributo».|Nel menu della tribù tocca «Diplomazia», poi «Richiesta di tributo».}',
    doIt: c => { if (c.data.role) c.app.aa.offer(c.id(c.data.role), 'tribute'); }, doItWait: 4,
    ok: 'La tribù è tua vassalla: ti versa una parte del suo oro.',
  },
  {
    id: 'c2-pactlist', chapter: 2, kind: 'info', title: 'I tuoi patti',
    prep: c => {
      // straight jump here: show at least one pact in the list
      if (!c.adv!.pacts.some(p => p.a === me(c) || p.b === me(c)) && c.alive('corvia')) c.g.ext.advDiplo?.formPact?.('nap', me(c), c.id('corvia'), true);
    },
    text: 'Qui trovi i patti in corso, con il tempo che resta. «Rompi» li annulla, ma costa reputazione.\nCon un alleato o un partner di patto puoi anche chiedere una guerra congiunta: dal menu del bersaglio, «Diplomazia › Chiedi a … di attaccare».',
    target: '.adv-pacts', sheet: true,
  },
  {
    id: 'c2-rep', chapter: 2, kind: 'info', title: 'Reputazione',
    text: 'Ogni paese ha una reputazione da −100 a +100, scritta nella sua scheda. Scende se tradisci un’alleanza, rompi un patto o bombardi chi non era in guerra con te; sale se rispetti i patti fino in fondo.\nI paesi del computer ne tengono conto quando rispondono alle tue proposte.',
    enter: c => { c.app.hud.hoverPlayer = 0; c.app.hud.mapHover = 0; c.app.selectPlayer(me(c)); },
    leave: c => c.app.selectPlayer(0),
    target: '.side .pcard',
  },
  {
    id: 'c2-fog', chapter: 2, kind: 'info', title: 'Nebbia di guerra',
    text: 'Vedi solo entro 22 caselle dalle tue terre e da quelle degli alleati, più un raggio intorno a capitale, città, porti e navi da guerra; la SAM fa da radar fino a 70 caselle.\nFuori dalla vista la mappa mostra l’ultima situazione nota, più scura: edifici, navi e attacchi sono nascosti e le truppe nemiche diventano «?».',
    focus: () => ({ x: 222, y: 92, span: 120 }), mark: () => ({ x: 226, y: 96 }),
  },
  {
    id: 'c2-obj-watch', chapter: 2, kind: 'watch', title: 'Arriva un obiettivo.',
    text: 'Ogni tanto ricevi una missione a tempo: eccone una.',
    prep: c => { if (!c.adv!.objectives.some(o => o.state === 'active')) c.g.ext.advScenario?.nextObjectiveAt?.(c.g.tick + 1); },
    done: c => c.adv!.objectives.some(o => o.state === 'active') || c.secs > 6,
    ok: 'Nuovo obiettivo ricevuto.',
  },
  {
    id: 'c2-obj', chapter: 2, kind: 'info', title: 'Obiettivi',
    text: 'Le missioni (conquistare un giacimento, prendere una capitale, crescere, avere più città o navi) hanno un tempo limite: completale per un premio in oro. {Clicca|Tocca} l’obiettivo per vedere dove andare.',
    target: '.adv-obj', sheet: true,
  },
  {
    id: 'c2-scen', chapter: 2, kind: 'info', title: 'Scenari',
    text: 'Con la mappa del mondo reale puoi scegliere uno scenario: «1939» parte con i blocchi, le alleanze e le guerre di quell’epoca, «Guerra fredda» con due blocchi armati di atomiche. Si sceglie nella schermata della partita avanzata.',
  },
  {
    id: 'c2-final', chapter: 2, kind: 'info', title: 'Tutorial completato!',
    text: 'Ora conosci ogni funzione di CAPTURE, dal gioco base alla modalità avanzata.\nScegli come continuare: una partita normale, una avanzata, oppure torna al menu.',
    final: () => [
      { label: 'Menu', run: t => t.exit() },
      { label: 'Partita normale', run: t => t.app.playFromTutorial(false) },
      { label: 'Partita avanzata', primary: true, run: t => t.app.playFromTutorial(true) },
    ],
  },
];

export const STEPS: Step[] = [...C1, ...C2];
