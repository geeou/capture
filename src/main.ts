// CAPTURE — app shell: flow (title → setup → spawn → match → end), fixed-step loop, debug handle.
import './style.css';
import './mobile.css';
import './perf.css';
import { createGame } from './sim/index';
import { Game, mulberry32 } from './sim/game';
import { TICK_MS, type GameEvent, type MapData, type NationSeed, type StructureType } from './sim/types';
import { generateMap, loadWorldMap } from './map/index';
import { Renderer } from './render/renderer';
import { Minimap } from './render/minimap';
import { rgbCss } from './render/colors';
import { Actions, type Ctl } from './ui/actions';
import { ContextMenu } from './ui/context';
import { Hud } from './ui/hud';
import { Input } from './ui/input';
import { MobileUI } from './ui/mobile';
import { Screens, loadSetup, type MatchConfig } from './ui/screens';
import { AdvActions, AdvHud, aimOf, putAim, type AdvCtl, type AnyAim } from './ui/adv';
import type { ScenarioId } from './sim/adv/types';
import { h, toast } from './ui/dom';
import { Tutorial, loadTutorialProgress, type TutorialChapter } from './ui/tutorial';
import { clock, fmt, pct, parseHex } from './ui/format';
import { perf, PerfOverlay, PERF_KEYS } from './render/perf';
import { governor, onQualityChange, qualityLabel, qualityLevel, qualityProfile, qualitySetting, setQuality, type QualitySetting } from './render/quality';

type Phase = 'title' | 'setup' | 'loading' | 'spawn' | 'match';

const BUILD_KEYS: Record<string, StructureType> = { KeyC: 'city', KeyP: 'port', KeyF: 'fort', KeyB: 'factory', KeyL: 'silo', KeyM: 'sam' };

export interface StartOptions {
  map?: 'world' | 'proc';
  seed?: number;
  spectate?: boolean;
  /** Spawn tile for the human; omitted = random land tile (seeded). */
  spawn?: { x: number; y: number } | null;
  name?: string;
  color?: number;
  difficulty?: 'easy' | 'normal' | 'hard';
  nations?: number;
  tribes?: number;
  speed?: number;
  /** Advanced mode (docs/ADVANCED.md). */
  advanced?: boolean;
  scenario?: ScenarioId;
  fog?: boolean;
}

class App implements Ctl, AdvCtl {
  game!: Game;
  readonly renderer: Renderer;
  readonly screens: Screens;
  readonly hud: Hud;
  readonly act: Actions;
  readonly ctxMenu: ContextMenu;
  readonly input: Input;
  readonly minimap: Minimap;
  readonly mobile: MobileUI;
  readonly aa: AdvActions;
  readonly advHud: AdvHud;
  /** Advanced: plain clicks use the classic whole-front attack. */
  wholeFront = false;
  /** Which title entry led to the setup (normal / advanced). */
  private advMode = false;
  ratio = 0.25;
  speed = 1;
  private resumeSpeed = 1;
  phase: Phase = 'title';
  private acc = 0;
  private lastT = 0;
  private lastAimCheck = 0;
  private spawnPick: { x: number; y: number } | null = null;
  private spawnMap: MapData | null = null;
  private spawnCfg: MatchConfig | null = null;
  private spawnBar: { setPicked(v: boolean, label?: string): void } | null = null;
  private worldMap: Promise<MapData> | null = null;
  private stats = { peakShare: 0, peakTroops: 0, kills: 0, built: 0, nukes: 0, boats: 0, startTick: 0 };
  private endShown = false;
  private stepBudgetHit = 0;
  /** Sim speed requested by a modal-open pause, restored on close. */
  private modalPaused = false;
  private titleDrift = 0;
  private hudEl: HTMLElement;
  /** Guided tutorial match (null outside "Partita tutorial"). */
  tut: Tutorial | null = null;

  constructor(root: HTMLElement) {
    const canvas = h('canvas', { class: 'view' });
    root.appendChild(canvas);
    this.renderer = new Renderer(canvas);
    this.act = new Actions(this);
    const hudHost = h('div', { class: 'hud-host' });
    root.appendChild(hudHost);
    this.hudEl = hudHost;
    this.hud = new Hud(this, this.act, hudHost);
    this.minimap = new Minimap(this.renderer, this.hud.root);
    this.ctxMenu = new ContextMenu(this, this.act, root);
    this.aa = new AdvActions(this, this.act);
    this.ctxMenu.adv = this.aa;
    this.advHud = new AdvHud(this, this.aa, this.hud);
    this.screens = new Screens(root);
    this.input = new Input(this.renderer, {
      tap: (t, x, y) => this.onTap(t, x, y),
      context: (t, x, y) => this.onContext(t, x, y),
      hover: t => this.onHover(t),
      key: e => this.onKey(e),
      active: () => (this.phase === 'match' || this.phase === 'spawn') && !this.screens.modalOpen,
    });
    this.mobile = new MobileUI(this, { setAim: a => this.setAim(a), phase: () => this.phase });
    const onResize = () => { this.renderer.resize(); this.minimap.layout(); };
    window.addEventListener('resize', onResize, { passive: true });
    new ResizeObserver(onResize).observe(canvas);
    this.minimap.intervalMs = qualityProfile().minimapMs;
    onQualityChange(p => {
      // renderer applies its own part; the minimap follows the new pixel ratio
      this.minimap.intervalMs = p.minimapMs;
      if (this.game) this.minimap.layout();
    });
    // hidden page: rAF stops; forget the gap so the sim does not try to catch up and the governor ignores it
    document.addEventListener('visibilitychange', () => { this.lastT = 0; governor.reset(); this.renderer.invalidate(); });
    if (new URLSearchParams(location.search).get('perf') === '1') this.perfHud = new PerfOverlay(root);
    this.hud.setVisible(false);
    requestAnimationFrame(this.frame);
  }

  // ── Ctl ────────────────────────────────────────────────────────────────────
  me() {
    const g = this.game;
    if (!g || !g.humanId) return null;
    const p = g.players[g.humanId];
    return p.alive ? p : null;
  }

  setSpeed(n: number): void {
    if (this.phase !== 'match') return;
    if (n > 0) this.resumeSpeed = n;
    this.speed = n;
    this.modalPaused = false;
    this.hud.syncSpeed();
    document.body.classList.toggle('paused', n === 0);
  }

  setRatio(r: number): void {
    this.ratio = Math.max(0.01, Math.min(1, Math.round(r * 100) / 100));
    this.hud.syncRatio();
  }

  selectPlayer(id: number): void {
    this.renderer.selected = id;
    this.hud.update(performance.now(), true);
  }

  focusPlayer(id: number): void {
    const p = this.game?.players[id];
    if (!p || !p.alive || p.tiles <= 0) return;
    const cam = this.renderer.cam;
    const span = Math.sqrt(p.tiles) * 3.2 + 30;
    const s = Math.max(cam.fitScale(), Math.min(cam.viewW, cam.viewH) / span);
    cam.centerOn(p.sumX / p.tiles, p.sumY / p.tiles, s);
    this.selectPlayer(id);
  }

  jumpTo(x: number, y: number): void {
    const cam = this.renderer.cam;
    cam.centerOn(x, y, Math.max(cam.scale, 3));
    this.renderer.fx.ping(x, y, performance.now());
  }

  setWholeFront(v: boolean): void {
    if (!this.game?.adv) return;
    this.wholeFront = v;
    this.advHud.syncFront();
    if (aimOf(this.renderer)?.kind === 'focus') this.setAim(null);
    toast(v ? 'Clic: attacco su tutto il fronte' : 'Clic: attacco mirato sul punto', 'info');
  }

  openDoctrines(): void {
    if (this.phase !== 'match' || !this.game?.adv || !this.me()) return;
    this.ctxMenu.close();
    this.advHud.openDoctrines();
  }

  showPanel(el: HTMLElement): () => void {
    const close = () => { if (el.isConnected) { this.screens.closeModal(); this.resumeFromModal(); } };
    this.screens.panel(el, close);
    return close;
  }

  openHelp(): void {
    this.pauseForModal();
    this.screens.help(() => { this.screens.closeModal(); this.resumeFromModal(); });
  }

  openPause(): void {
    if (this.phase !== 'match') return;
    this.pauseForModal();
    this.screens.pause(
      () => { this.screens.closeModal(); this.resumeFromModal(); },
      () => this.openHelp(),
      () => { this.screens.closeModal(); this.newGame(); },
    );
  }

  private pauseForModal(): void {
    if (this.phase === 'match' && this.speed > 0 && !this.modalPaused) {
      this.resumeSpeed = this.speed;
      this.speed = 0;
      this.modalPaused = true;
      this.hud.syncSpeed();
    }
  }
  private resumeFromModal(): void {
    if (this.modalPaused) { this.speed = this.resumeSpeed; this.modalPaused = false; this.hud.syncSpeed(); }
  }

  newGame(): void {
    this.stopTutorial();
    this.ctxMenu.close();
    this.setAim(null);
    this.screens.closeModal();
    this.hud.setVisible(false);
    this.phase = 'setup';
    document.body.classList.remove('paused', 'in-match', 'adv-match');
    this.showSetup(false);
  }

  // ── flow ───────────────────────────────────────────────────────────────────
  async showTitle(): Promise<void> {
    this.stopTutorial();
    this.ctxMenu.close();
    this.setAim(null);
    this.screens.closeModal();
    document.body.classList.remove('paused', 'in-match');
    this.phase = 'title';
    this.hud.setVisible(false);
    document.body.classList.add('at-title');
    try {
      const map = generateMap(1 + Math.floor(Math.random() * 9999));
      const bg = new Game(map, 1);
      this.game = bg;
      this.renderer.setGame(bg);
      this.renderer.spawn = null;
      const cam = this.renderer.cam;
      cam.centerOn(map.width * 0.35, map.height * 0.5, cam.fitScale() * 1.8, false);
    } catch (err) { console.warn('title map failed', err); }
    document.body.classList.remove('adv-match');
    this.screens.title(
      () => { this.advMode = false; this.showSetup(false); },
      () => { this.advMode = true; this.showSetup(false); },
      () => { this.advMode = false; this.showSetup(true); },
      () => this.openHelp(),
      () => this.tutorialMenu());
  }

  // ── guided tutorial ────────────────────────────────────────────────────────
  private tutorialMenu(): void {
    const saved = loadTutorialProgress();
    this.screens.tutorialStart(
      () => this.startTutorial(1),
      () => this.startTutorial(2),
      saved ? () => this.startTutorial(saved.chapter, saved.step) : null,
      () => this.showTitle(),
      saved?.label ?? null);
  }

  /** Start (or restart) the guided tutorial at a chapter; `step` = step id or 1-based index within the chapter. */
  startTutorial(chapter: TutorialChapter, step?: string | number): void {
    this.stopTutorial();
    this.advMode = chapter === 2;
    this.tut = new Tutorial(this);
    this.tut.begin(chapter, step);
  }

  stopTutorial(): void {
    const t = this.tut;
    if (!t) return;
    this.tut = null;
    t.dispose();
  }

  /** Called by the tutorial: open the normal setup for a classic or advanced match. */
  playFromTutorial(advanced: boolean): void {
    this.stopTutorial();
    this.ctxMenu.close();
    this.setAim(null);
    this.screens.closeModal();
    this.hud.setVisible(false);
    document.body.classList.remove('paused', 'in-match', 'adv-match');
    this.advMode = advanced;
    this.showSetup(false);
  }

  private showSetup(spectate: boolean): void {
    this.phase = 'setup';
    document.body.classList.add('at-title');
    this.screens.setup(cfg => this.afterSetup(cfg), () => this.showTitle(), spectate, this.advMode);
  }

  private async loadMap(kind: 'world' | 'proc', seed: number): Promise<MapData> {
    if (kind === 'world') {
      if (!this.worldMap) this.worldMap = loadWorldMap();
      try { return await this.worldMap; } catch (e) { this.worldMap = null; throw e; }
    }
    await new Promise(r => setTimeout(r, 30)); // let the loading screen paint
    return generateMap(seed);
  }

  private async afterSetup(cfg: MatchConfig): Promise<void> {
    this.phase = 'loading';
    this.screens.loading(cfg.map === 'world' ? 'Carico il mondo…' : 'Genero i continenti…');
    let map: MapData;
    try { map = await this.loadMap(cfg.map, cfg.seed); }
    catch (err) {
      console.error(err);
      toast('Impossibile caricare la mappa', 'danger');
      this.showSetup(cfg.spectate);
      return;
    }
    if (cfg.spectate) { this.startMatch(map, cfg, null); return; }
    this.enterSpawn(map, cfg);
  }

  private nationPreview(map: MapData, max: number): NationSeed[] {
    const out: NationSeed[] = [];
    const seeds = [...map.nations].sort((a, b) => b.strength - a.strength);
    for (const s of seeds) {
      if (out.length >= max) break;
      if (out.some(o => (o.x - s.x) ** 2 + (o.y - s.y) ** 2 < 14 * 14)) continue;
      out.push(s);
    }
    return out;
  }

  private enterSpawn(map: MapData, cfg: MatchConfig): void {
    this.phase = 'spawn';
    document.body.classList.remove('at-title');
    this.spawnMap = map;
    this.spawnCfg = cfg;
    this.spawnPick = null;
    const bare = new Game(map, cfg.seed);
    this.game = bare;
    this.renderer.setGame(bare);
    this.renderer.spawn = { seeds: this.nationPreview(map, cfg.nations), pick: null, color: cfg.color, name: cfg.name };
    this.spawnBar = this.screens.spawnBar(
      () => this.confirmSpawn(),
      () => {
        const t = this.randomLand(bare, Math.floor(Math.random() * 1e9));
        if (t >= 0) { this.pickSpawn(t); this.renderer.cam.centerOn(bare.xOf(t), bare.yOf(t), Math.max(this.renderer.cam.scale, this.renderer.cam.fitScale() * 2.5)); }
      },
      () => this.showSetup(false),
    );
  }

  private randomLand(g: Game, seed: number): number {
    const rng = mulberry32(seed);
    for (let k = 0; k < 20000; k++) {
      const i = Math.floor(rng() * g.N);
      if (g.isLand(i)) {
        // avoid tiny islets: require some land around
        let land = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const x = g.xOf(i) + dx, y = g.yOf(i) + dy;
          if (g.inBounds(x, y) && g.isLand(g.idx(x, y))) land++;
        }
        if (land >= 40) return i;
      }
    }
    return -1;
  }

  private pickSpawn(tile: number): void {
    const g = this.game;
    if (tile < 0 || !g.isLand(tile)) { toast('Scegli un punto sulla terraferma'); return; }
    this.spawnPick = { x: g.xOf(tile), y: g.yOf(tile) };
    if (this.renderer.spawn) this.renderer.spawn.pick = this.spawnPick;
    const near = this.renderer.spawn?.seeds.find(s => (s.x - this.spawnPick!.x) ** 2 + (s.y - this.spawnPick!.y) ** 2 < 14 * 14);
    this.spawnBar?.setPicked(true, near ? `Vicino a ${near.name}: prenderai il suo posto.` : 'Ottima scelta. Conferma per iniziare.');
  }

  private confirmSpawn(): void {
    if (!this.spawnPick || !this.spawnMap || !this.spawnCfg) return;
    this.startMatch(this.spawnMap, this.spawnCfg, this.spawnPick);
  }

  startMatch(map: MapData, cfg: MatchConfig, spawn: { x: number; y: number } | null, speed = 1): Game {
    const game = createGame(map, {
      seed: cfg.seed,
      humanSpawn: spawn,
      humanName: cfg.name,
      humanColor: cfg.color,
      nations: cfg.nations,
      tribes: cfg.tribes,
      difficulty: cfg.difficulty,
      ...(cfg.advanced ? { advanced: true, scenario: cfg.scenario ?? 'libero', fog: cfg.fog !== false } : {}),
    });
    if (spawn && !game.humanId) toast('Punto di partenza non valido: modalità spettatore', 'danger');
    return this.attachMatch(game, speed);
  }

  /** Make `game` the running match (HUD, camera, events). Used by startMatch and by the tutorial. */
  attachMatch(game: Game, speed = 1): Game {
    this.ctxMenu.close();
    this.screens.clear();
    document.body.classList.remove('at-title');
    game.trackChanges = true;
    game.changed.length = 0;
    this.game = game;
    (window as any).game = game;
    this.renderer.setGame(game);
    this.renderer.spawn = null;
    this.minimap.layout();
    this.phase = 'match';
    this.acc = 0;
    this.endShown = false;
    this.stats = { peakShare: 0, peakTroops: 0, kills: 0, built: 0, nukes: 0, boats: 0, startTick: 0 };
    this.wholeFront = false;
    this.setAim(null);
    const me = game.human;
    const cam = this.renderer.cam;
    if (me) cam.centerOn(me.spawnX, me.spawnY, Math.max(cam.fitScale() * 2, Math.min(cam.viewW, cam.viewH) / 150), false);
    else cam.fit();
    this.hud.attach(game);
    this.advHud.attach(game);
    this.hud.setVisible(true);
    game.on(ev => { if (this.game === game) this.onGameEvent(ev); });
    document.body.classList.add('in-match');
    this.speed = 1;
    this.setSpeed(speed);
    this.hud.addLog(me ? `${me.name}, la tua nazione è nata. Espanditi!` : 'Modalità spettatore: clicca un territorio per seguirlo.', 'good', me?.spawnX, me?.spawnY);
    if (game.adv && me) this.hud.addLog('Partita avanzata: il clic attacca un punto preciso, G per tutto il fronte. R: dottrine.', 'info');
    return game;
  }

  /** Scriptable start used by URL params and window.capture.start(). */
  async start(o: StartOptions = {}): Promise<Game> {
    const base = loadSetup();
    const cfg: MatchConfig = {
      map: o.map ?? 'proc',
      seed: o.seed ?? 1,
      name: o.name ?? base.name,
      color: o.color ?? base.color,
      difficulty: o.difficulty ?? 'normal',
      nations: o.nations ?? 88,
      tribes: o.tribes ?? 150,
      spectate: !!o.spectate,
      advanced: !!o.advanced,
      scenario: o.advanced ? (o.map === 'world' ? o.scenario ?? 'libero' : 'libero') : undefined,
      fog: o.advanced ? o.fog !== false : undefined,
    };
    this.advMode = cfg.advanced!;
    this.phase = 'loading';
    this.screens.loading('Preparo la partita…');
    const map = await this.loadMap(cfg.map, cfg.seed);
    let spawn: { x: number; y: number } | null = null;
    if (!cfg.spectate) {
      if (o.spawn) spawn = o.spawn;
      else {
        const tmp = new Game(map, cfg.seed);
        const t = this.randomLand(tmp, cfg.seed * 7919 + 13);
        spawn = t >= 0 ? { x: tmp.xOf(t), y: tmp.yOf(t) } : null;
      }
    }
    return this.startMatch(map, cfg, spawn, o.speed ?? 1);
  }

  // ── events ─────────────────────────────────────────────────────────────────
  private onGameEvent(ev: GameEvent): void {
    const g = this.game, r = this.renderer, now = performance.now();
    const me = g.humanId;
    switch (ev.type) {
      case 'explosion':
        r.fx.blast(ev.x, ev.y, ev.radius, ev.kind === 'hydrogen', now, r.visible(ev.x, ev.y, 200));
        break;
      case 'nukeIntercepted':
        r.fx.puff(ev.x, ev.y, now);
        break;
      case 'boatLanded': {
        const p = g.players[ev.owner];
        if (r.visible(g.xOf(ev.tile), g.yOf(ev.tile), 50)) r.fx.splash(g.xOf(ev.tile), g.yOf(ev.tile), now, p ? rgbCss(p.color) : '#fff');
        break;
      }
      case 'structureDestroyed':
        if (r.cam.scale > 1.5 && r.visible(ev.structure.x, ev.structure.y)) r.fx.puff(ev.structure.x, ev.structure.y, now);
        break;
      case 'nukeLaunched':
        if (ev.unit.owner === me) this.stats.nukes++;
        else if (me && g.owner[ev.unit.toTile] === me) toast('Missile nucleare in arrivo!', 'danger');
        break;
      case 'boatLaunched':
        if (ev.unit.owner === me) this.stats.boats++;
        break;
      case 'structureBuilt':
        if (ev.structure.owner === me) this.stats.built++;
        break;
      case 'playerDied':
        if (me && ev.by === me) this.stats.kills++;
        if (me && ev.id === me) setTimeout(() => this.showEnd(false), 600);
        if (me && ev.id === this.renderer.selected) this.renderer.selected = 0;
        break;
      case 'win':
        setTimeout(() => this.showEnd(true), 900);
        break;
    }
  }

  private showEnd(fromWin: boolean): void {
    const g = this.game;
    if (this.phase !== 'match' || this.tut) return;
    const me = g.humanId ? g.players[g.humanId] : null;
    const winner = g.winner ? g.players[g.winner] : null;
    if (this.endShown && !fromWin) return;
    this.endShown = true;
    if (me) {
      this.stats.peakShare = Math.max(this.stats.peakShare, g.share(me.id));
      this.stats.peakTroops = Math.max(this.stats.peakTroops, me.troops);
    }
    this.ctxMenu.close();
    this.setAim(null);
    const elapsed = clock(g.tick);
    let info;
    if (me && winner && winner.id === me.id) {
      info = { win: true, title: 'Il mondo è tuo', subtitle: `${me.name} controlla ${pct(g.share(me.id))} delle terre.`, canWatch: false };
    } else if (me && !me.alive) {
      info = fromWin && winner
        ? { win: false, title: `${winner.name} ha vinto`, subtitle: 'La partita è finita.', canWatch: false }
        : { win: false, title: 'Sconfitta', subtitle: 'La tua nazione è stata cancellata dalla mappa.', canWatch: !g.over };
    } else if (me && winner) {
      info = { win: false, title: 'Sconfitta', subtitle: `${winner.name} ha raggiunto l’${Math.round(0.8 * 100)}% delle terre.`, canWatch: false };
    } else {
      info = { win: false, title: winner ? `${winner.name} conquista il mondo` : 'Partita finita', subtitle: 'Fine della partita.', canWatch: false };
    }
    const stats: [string, string][] = me
      ? [['Tempo', elapsed], ['Quota massima', pct(this.stats.peakShare)], ['Truppe massime', fmt(this.stats.peakTroops)],
         ['Nazioni eliminate', String(this.stats.kills)], ['Strutture', String(this.stats.built)], ['Navi / atomiche', `${this.stats.boats} / ${this.stats.nukes}`]]
      : [['Tempo', elapsed], ['Sopravvissuti', String(g.alivePlayers().length)]];
    this.pauseForModal();
    this.screens.end({ ...info, stats }, () => this.newGame(), () => {
      this.screens.closeModal();
      this.resumeFromModal();
      this.hud.root.classList.add('spectator');
    });
  }

  // ── input handlers ─────────────────────────────────────────────────────────
  setAim(a: AnyAim | Renderer['aim']): void {
    putAim(this.renderer, a as AnyAim);
    this.renderer.aimReason = null;
    this.lastAimCheck = 0;
    document.body.classList.toggle('aiming', !!a && a.kind !== 'focus');
  }

  /** The armed aim, ignoring the passive focus-attack preview. */
  private armedAim(): AnyAim {
    const a = aimOf(this.renderer);
    return a && a.kind !== 'focus' ? a : null;
  }

  private onTap(tile: number, _x: number, _y: number): void {
    if (this.phase === 'spawn') { this.pickSpawn(tile); return; }
    if (this.phase !== 'match') return;
    if (performance.now() - this.ctxMenu.closedAt < 250) return;
    if (this.mobile.tap(tile)) return;
    const aim = this.armedAim();
    if (aim) {
      if (tile < 0) return;
      let ok: boolean;
      if (aim.kind === 'nuke') ok = this.act.nuke(aim.nuke, tile);
      else if (aim.kind === 'fleet') ok = this.aa.sendFleet(tile);
      else if (aim.kind === 'capital') ok = this.aa.moveCapital(this.aa.cityNear(tile));
      else { this.act.boat(tile); ok = true; }
      if (ok) this.setAim(null);
      return;
    }
    if (this.game.adv) this.aa.primary(tile);
    else this.act.primary(tile);
  }

  private onContext(tile: number, x: number, y: number): void {
    if (this.phase !== 'match') return;
    if (this.armedAim()) { this.setAim(null); return; }
    this.ctxMenu.show(tile, x, y);
  }

  private onHover(tile: number): void {
    this.renderer.hoverTile = tile;
    if (this.phase === 'match') {
      this.hud.mapHover = tile >= 0 ? this.renderer.shownOwner(tile) : 0; // fog: what the map shows
      this.lastAimCheck = 0;
    }
  }

  private onKey(e: KeyboardEvent): boolean {
    if (this.tut && this.phase === 'match' && this.tut.key(e)) return true;
    if (this.screens.modalOpen) {
      if (e.key === 'Escape') {
        this.screens.closeModal();
        this.resumeFromModal();
        return true;
      }
      return false;
    }
    if (this.phase === 'spawn') {
      if (e.key === 'Enter') { this.confirmSpawn(); return true; }
      if (e.key === 'Escape') { this.showSetup(false); return true; }
      return false;
    }
    if (this.phase !== 'match') return false;
    const me = this.me();
    const cursor = this.input.cursorTile();
    if (e.key === '?' || (e.shiftKey && (e.code === 'Slash' || e.key === '/'))) { this.openHelp(); return true; }
    switch (e.code) {
      case 'Escape':
        if (this.ctxMenu.open) this.ctxMenu.close();
        else if (this.armedAim()) this.setAim(null);
        else this.openPause();
        return true;
      case 'Space':
        this.setSpeed(this.speed > 0 ? 0 : this.resumeSpeed || 1);
        return true;
      case 'Digit1': this.setSpeed(1); return true;
      case 'Digit2': this.setSpeed(2); return true;
      case 'Digit4': this.setSpeed(4); return true;
      case 'KeyQ': this.setRatio(this.ratio - (e.shiftKey ? 0.01 : 0.05)); return true;
      case 'KeyE': this.setRatio(this.ratio + (e.shiftKey ? 0.01 : 0.05)); return true;
      case 'KeyT': this.renderer.showLabels = !this.renderer.showLabels; return true;
      case 'KeyN': case 'KeyH':
        if (!me) return true;
        this.setAim({ kind: 'nuke', nuke: e.code === 'KeyN' ? 'atom' : 'hydrogen' });
        toast(e.code === 'KeyN' ? 'Atomica armata: clicca il bersaglio (Esc annulla)' : 'Bomba H armata: clicca il bersaglio (Esc annulla)', 'info');
        return true;
      case 'KeyV':
        if (!me) return true;
        this.setAim({ kind: 'boat' });
        toast('Nave pronta: clicca la costa da invadere (Esc annulla)', 'info');
        return true;
    }
    if (this.game.adv) {
      switch (e.code) {
        case 'KeyZ': if (me) this.aa.cycleStance(); return true;
        case 'KeyR': this.openDoctrines(); return true;
        case 'KeyG': if (me) this.setWholeFront(!this.wholeFront); return true;
        case 'KeyX': if (me) this.aa.armFleet(); return true;
        case 'KeyK': if (me) this.aa.jumpCapital(); return true;
      }
    }
    const bt = BUILD_KEYS[e.code];
    if (bt) {
      if (!me) return true;
      if (cursor < 0) { toast('Punta il cursore sulla mappa'); return true; }
      this.act.build(bt, cursor);
      return true;
    }
    return false;
  }

  // ── loop ───────────────────────────────────────────────────────────────────
  /** Smoothed CPU cost of a frame (sim + render + HUD), ms. */
  cpuMs = 0;
  simMs = 0;
  private lastErr = -1e9;
  private perfHud: PerfOverlay | null = null;
  private frame = (now: number) => {
    requestAnimationFrame(this.frame);
    if (document.hidden) return;
    const interval = this.lastT ? now - this.lastT : 0;
    const c0 = performance.now();
    const drew = this.frameBody(now);
    const cpu = performance.now() - c0;
    perf.add('frame', cpu);
    perf.add('interval', interval);
    perf.commit(drew);
    this.cpuMs += (cpu - this.cpuMs) * 0.05;
    if (this.phase === 'match' && this.speed > 0 && !this.screens.modalOpen && interval > 0) governor.feed(now, interval, cpu, drew);
    if (this.perfHud) this.perfHud.update(now, () => this.perfLines());
  };

  /** One animation frame: input, sim catch-up, map update + draw, minimap, HUD. Returns true if the map redrew. */
  frameBody(now: number): boolean {
    const P = performance;
    const dt = this.lastT ? Math.max(0, Math.min(250, now - this.lastT)) : 16;
    this.lastT = now;
    this.input.update(dt);
    const g = this.game;
    let steps = 0;
    if (this.phase === 'match' && g && !g.over && this.speed > 0 && !this.tut?.hold) {
      this.acc += dt * this.speed;
      const maxSteps = Math.max(2, this.speed * 2);
      const budget = qualityProfile().simBudgetMs;
      const t0 = P.now();
      while (this.acc >= TICK_MS && steps < maxSteps) {
        this.renderer.beforeStep();
        g.step();
        this.acc -= TICK_MS;
        steps++;
        if (P.now() - t0 > budget) break; // never spiral on slow machines
      }
      if (this.acc >= TICK_MS * 2) { this.acc = TICK_MS * 0.5; this.stepBudgetHit++; }
      const simT = P.now() - t0;
      perf.add('sim', simT);
      if (steps) this.simMs += (simT / steps - this.simMs) * 0.1;
      const me = g.human;
      if (me && me.alive) {
        const sh = g.share(me.id);
        if (sh > this.stats.peakShare) this.stats.peakShare = sh;
        if (me.troops > this.stats.peakTroops) this.stats.peakTroops = me.troops;
      }
    } else if (this.phase === 'title' || this.phase === 'setup' || this.phase === 'loading') {
      const cam = this.renderer.cam;
      this.titleDrift += dt;
      if (g) { cam.x += dt * 0.004; if (cam.x > g.W * 0.7) cam.x = g.W * 0.3; cam.clamp(); }
    }
    if (this.phase === 'match' && (this.renderer.aim || this.game?.adv) && now - this.lastAimCheck > 150) {
      this.lastAimCheck = now;
      this.updatePassiveAim();
      this.updateAimReason();
    }
    const alpha = this.phase === 'match' ? Math.min(1, this.acc / TICK_MS) : 1;
    let drew = false;
    try {
      drew = this.renderer.render(alpha, now, steps > 0 && qualityProfile().deferFlush);
      let t = P.now();
      if (this.phase === 'match' || this.phase === 'spawn') { this.minimap.draw(now); const t2 = P.now(); perf.add('minimap', t2 - t); t = t2; }
      if (this.phase === 'match') { this.hud.update(now); this.advHud.update(now); }
      if (this.tut && this.phase === 'match') this.tut.frame(now);
      perf.add('hud', P.now() - t);
    } catch (err) {
      if (now - this.lastErr > 5000) { this.lastErr = now; console.error(err); }
    }
    return drew;
  }

  /** Text of the ?perf=1 overlay. */
  private perfLines(): string[] {
    const r = this.renderer, iv = perf.stat('interval'), fr = perf.stat('frame'), sim = perf.stat('sim'), dr = perf.stat('draw', true);
    const fps = iv.avg > 0 ? Math.round(1000 / iv.avg) : 0;
    return [
      `${fps} fps · frame ${iv.p50.toFixed(1)}/${iv.p95.toFixed(1)} ms (p50/p95)`,
      `cpu ${fr.p50.toFixed(1)}/${fr.p95.toFixed(1)} · sim ${sim.avg.toFixed(1)} · draw ${dr.avg.toFixed(1)} · ${Math.round(perf.drawnRatio() * 100)}% drawn`,
      `Q ${qualityLabel()} · ${r.canvas.width}×${r.canvas.height} @${r.dpr} (dev ${+(window.devicePixelRatio || 1).toFixed(2)})`,
    ];
  }

  perf() {
    const r = this.renderer;
    const all = perf.all();
    const iv = all.interval;
    return {
      fps: iv.avg > 0 ? Math.round(1000 / iv.avg) : Math.round(1000 / r.frameMs),
      frames: perf.frames,
      drawnRatio: +perf.drawnRatio().toFixed(2),
      quality: { setting: qualitySetting(), level: qualityLevel(), governorWindow: { intervalMs: +governor.lastInterval.toFixed(1), cpuMs: +governor.lastCpu.toFixed(2) } },
      canvas: `${r.canvas.width}x${r.canvas.height}`,
      view: `${r.cam.viewW}x${r.cam.viewH}`,
      dpr: r.dpr,
      devicePixelRatio: window.devicePixelRatio || 1,
      ms: all,
      cpuMs: +this.cpuMs.toFixed(2), simMsPerTick: +this.simMs.toFixed(2), droppedCatchUps: this.stepBudgetHit,
    };
  }

  /**
   * CPU benchmark: run `frames` loop bodies back to back with a simulated 60 Hz clock (works with the pane hidden,
   * where rAF is throttled). Returns per-stage avg / p50 / p95 over those frames.
   */
  bench(frames = 200, hz = 60): ReturnType<App['perf']> {
    perf.reset();
    let now = performance.now();
    for (let i = 0; i < frames; i++) {
      now += 1000 / hz;
      const c0 = performance.now();
      const drew = this.frameBody(now);
      perf.add('frame', performance.now() - c0);
      perf.add('interval', 1000 / hz);
      perf.commit(drew);
    }
    this.lastT = 0;
    return this.perf();
  }

  setQuality(q: QualitySetting): void { setQuality(q); }

  /** Advanced, desktop mouse: show the focus-attack preview while hovering land a click would attack by land. */
  private updatePassiveAim(): void {
    const g = this.game, r = this.renderer, cur = aimOf(r);
    if (cur && cur.kind !== 'focus') return;
    const me = this.me(), t = r.hoverTile;
    let want = false;
    if (g.adv && me && !this.wholeFront && t >= 0 && !this.ctxMenu.open && !this.screens.modalOpen && !this.mobile.placing
      && this.input.lastPointerType === 'mouse' && !document.body.classList.contains('touch-ui') && g.isLand(t)) {
      const o = g.owner[t];
      want = o !== me.id && !(o && g.areAllied(me.id, o)) && this.act.landReachable(t);
    }
    if (want && !cur) { putAim(r, { kind: 'focus' }); }
    else if (!want && cur) { putAim(r, null); r.aimReason = null; }
  }

  private updateAimReason(): void {
    const g = this.game, aim = aimOf(this.renderer), me = this.me();
    const t = this.renderer.hoverTile;
    if (!aim || !me || t < 0) { this.renderer.aimReason = null; return; }
    if (aim.kind === 'nuke') {
      const o = g.owner[t];
      this.renderer.aimReason = o && g.areAllied(me.id, o) ? 'Bersaglio alleato' : g.q.canNuke(me.id, aim.nuke, t);
    } else if (aim.kind === 'focus') this.renderer.aimReason = g.adv ? g.adv.q.canAttackAt(me.id, t) : null;
    else if (aim.kind === 'fleet') this.renderer.aimReason = g.adv ? (g.isLand(t) ? 'Scegli un punto di mare' : g.adv.q.canSendFleet(me.id, t)) : null;
    else if (aim.kind === 'capital') this.renderer.aimReason = g.adv ? g.adv.q.canMoveCapital(me.id, this.aa.cityNear(t)) : null;
    else this.renderer.aimReason = g.q.canBoat(me.id, t);
  }
}

// ── boot ─────────────────────────────────────────────────────────────────────
const root = document.getElementById('app')!;
const app = new App(root);

(window as any).capture = {
  start: (o: StartOptions) => app.start(o),
  setSpeed: (n: number) => app.setSpeed(n),
  get camera() { return app.renderer.cam; },
  get renderer() { return app.renderer; },
  perf: () => app.perf(),
  bench: (frames?: number, hz?: number) => app.bench(frames, hz),
  quality: (q?: QualitySetting) => { if (q) app.setQuality(q); return { setting: qualitySetting(), level: qualityLevel() }; },
  perfKeys: PERF_KEYS,
  app,
};
(window as any).tutorial = null;

const params = new URLSearchParams(location.search);
if (params.get('tutorial') === '1') {
  const ch = params.get('chapter') === '2' ? 2 : 1;
  const st = params.get('step');
  app.startTutorial(ch, st ? (/^\d+$/.test(st) ? Number(st) : st) : undefined);
} else if (params.get('auto') === '1') {
  const num = (k: string) => (params.has(k) ? Number(params.get(k)) : undefined);
  const x = num('x'), y = num('y');
  const diff = params.get('difficulty') ?? params.get('diff');
  app.start({
    map: params.get('map') === 'world' ? 'world' : 'proc',
    seed: num('seed') ?? 1,
    spectate: params.get('spectate') === '1',
    spawn: x !== undefined && y !== undefined ? { x, y } : undefined,
    name: params.get('name') ?? undefined,
    color: params.has('color') ? parseHex(params.get('color')!) : undefined,
    difficulty: diff === 'easy' || diff === 'hard' || diff === 'normal' ? diff : undefined,
    nations: num('nations'),
    tribes: num('tribes'),
    speed: num('speed'),
    advanced: params.get('adv') === '1',
    scenario: ((s: string | null) => (s === '1939' || s === 'guerrafredda' || s === 'libero' ? s : undefined))(params.get('scenario')),
    fog: params.get('fog') !== '0',
  }).catch(err => { console.error(err); app.showTitle(); });
} else {
  app.showTitle();
}
