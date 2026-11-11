// Full-screen flows: title, setup, loading, spawn bar, pause, help, end of match.
import type { Difficulty } from '../sim/types';
import type { ScenarioId } from '../sim/adv/types';
import { h } from './dom';
import { hexColor, parseHex } from './format';
import { STRUCTURE_KEY, STRUCTURE_LABEL, glyphURL } from '../render/icons';
import { SKIN_IDS, SKIN_INFO, isSkinId, setSkin, skinId, type SkinId } from '../render/skins';
import { QUALITY_LABEL, QUALITY_SETTINGS, onQualityChange, qualityLevel, qualitySetting, setQuality } from '../render/quality';

/** "Qualità grafica" selector (Auto / Alta / Media / Bassa), stored in localStorage by setQuality. */
function qualitySeg(): HTMLElement {
  const seg = h('div', { class: 'seg quality' });
  const hint = h('small', { class: 'q-hint dim' });
  const paint = () => {
    const cur = qualitySetting();
    [...seg.children].forEach((b, k) => b.classList.toggle('on', QUALITY_SETTINGS[k] === cur));
    hint.textContent = cur === 'auto' ? `Ora: ${QUALITY_LABEL[qualityLevel()]}. Si adatta da sola se il gioco rallenta.` : '';
  };
  for (const q of QUALITY_SETTINGS) {
    seg.appendChild(h('button', { type: 'button', title: q === 'auto' ? 'Sceglie e adatta la qualità in base al dispositivo' : undefined, onclick: () => { setQuality(q); paint(); } }, QUALITY_LABEL[q]));
  }
  const wrap = h('div', { class: 'q-wrap' }, seg, hint);
  const off = onQualityChange(() => { if (!wrap.isConnected) { off(); return; } paint(); });
  paint();
  return wrap;
}

export interface MatchConfig {
  map: 'world' | 'proc';
  seed: number;
  name: string;
  color: number;
  difficulty: Difficulty;
  nations: number;
  tribes: number;
  spectate: boolean;
  /** Graphic skin. */
  skin?: SkinId;
  /** Advanced mode (docs/ADVANCED.md). Set by the title entry, not persisted. */
  advanced?: boolean;
  /** Advanced only: scenario (1939 / guerrafredda need the world map). */
  scenario?: ScenarioId;
  /** Advanced only: fog of war for the human. */
  fog?: boolean;
}

const SCENARIOS: [ScenarioId, string, string][] = [
  ['libero', 'Libero', 'Partenza classica: tutti alla pari.'],
  ['1939', '1939', 'Blocchi, alleanze e guerre del 1939.'],
  ['guerrafredda', 'Guerra fredda', 'Due blocchi armati di atomiche.'],
];

export const PLAYER_COLORS = [0x2f7bff, 0xff4f5e, 0x22c58b, 0xffb020, 0xa860ff, 0xff7a2f, 0x18c3d6, 0xf2f2f2];

const STORE_KEY = 'capture.setup.v1';

export function loadSetup(): MatchConfig {
  const def: MatchConfig = { map: 'world', seed: 1 + Math.floor(Math.random() * 99999), name: 'Comandante', color: PLAYER_COLORS[0], difficulty: 'normal', nations: 88, tribes: 150, spectate: false, scenario: 'libero', fog: true };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const o = { ...def, ...JSON.parse(raw), spectate: false, advanced: false };
      if (!isSkinId(o.skin)) o.skin = skinId();
      if (!SCENARIOS.some(([id]) => id === o.scenario)) o.scenario = 'libero';
      if (typeof o.fog !== 'boolean') o.fog = true;
      return o;
    }
  } catch { /* storage unavailable */ }
  return def;
}
function saveSetup(c: MatchConfig): void {
  try { const { advanced: _a, ...rest } = c; localStorage.setItem(STORE_KEY, JSON.stringify(rest)); } catch { /* ignore */ }
}

export interface EndInfo {
  win: boolean;
  title: string;
  subtitle: string;
  stats: [string, string][];
  canWatch: boolean;
}

export class Screens {
  readonly root: HTMLElement;
  private layer: HTMLElement | null = null;
  private modal: HTMLElement | null = null;

  constructor(host: HTMLElement) {
    this.root = h('div', { class: 'screens' });
    host.appendChild(this.root);
  }

  private set(el: HTMLElement | null): void {
    const old = this.layer;
    if (old) { old.classList.add('out'); setTimeout(() => old.remove(), 220); }
    this.layer = el;
    if (el) { this.root.appendChild(el); requestAnimationFrame(() => el.classList.add('in')); }
  }

  clear(): void { this.set(null); this.closeModal(); }

  get modalOpen(): boolean { return this.modal !== null; }

  closeModal(): void {
    const m = this.modal;
    if (!m) return;
    this.modal = null;
    m.classList.remove('in');
    m.classList.add('out');
    setTimeout(() => m.remove(), 200);
  }

  private openModal(el: HTMLElement): void {
    this.closeModal();
    this.modal = el;
    this.root.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
  }

  // ── title ──────────────────────────────────────────────────────────────────
  title(onPlay: () => void, onPlayAdv: () => void, onWatch: () => void, onHelp: () => void, onTutorial?: () => void): void {
    this.set(h('div', { class: 'scr title' },
      h('div', { class: 'title-box' },
        h('div', { class: 'logo' }, 'CAPTURE'),
        h('p', { class: 'tag' }, 'Conquista il mondo, una casella alla volta.'),
        h('div', { class: 'title-actions' },
          h('button', { class: 'btn primary big', onclick: onPlay }, 'Partita normale'),
          h('button', { class: 'btn big adv-play', onclick: onPlayAdv, title: 'Fronti, capitali, rifornimenti, risorse, flotte, dottrine, patti, scenari e nebbia di guerra' },
            'Partita avanzata', h('small', null, 'Fronti · rifornimenti · dottrine · nebbia')),
          onTutorial ? h('button', { class: 'btn big tut-play', onclick: onTutorial, title: 'Una partita guidata che si ferma e ti spiega ogni cosa' },
            'Partita tutorial', h('small', null, 'Impara giocando, passo dopo passo')) : null,
          h('button', { class: 'btn big ghost', onclick: onWatch }, 'Guarda una partita'),
          h('button', { class: 'btn big ghost', onclick: onHelp }, 'Come si gioca')),
        h('p', { class: 'foot' }, 'Possiedi l’80% delle terre per vincere · ~240 avversari'))));
  }

  /** "Partita tutorial": choose where to start (and resume saved progress). */
  tutorialStart(onFull: () => void, onAdvOnly: () => void, onResume: (() => void) | null, onBack: () => void, resumeLabel: string | null): void {
    this.set(h('div', { class: 'scr title tut-start' },
      h('div', { class: 'title-box' },
        h('div', { class: 'logo sm' }, 'Tutorial'),
        h('p', { class: 'tag' }, 'Una partita vera e guidata: il gioco si ferma e ti spiega ogni cosa, poi tocca a te.'),
        h('div', { class: 'title-actions' },
          onResume ? h('button', { class: 'btn primary big tut-resume', onclick: onResume },
            'Riprendi', resumeLabel ? h('small', null, resumeLabel) : null) : null,
          h('button', { class: `btn big${onResume ? ' adv-play' : ' primary'}`, onclick: onFull },
            'Dall’inizio', h('small', null, 'Prima il gioco base, poi la modalità avanzata')),
          h('button', { class: 'btn big adv-play', onclick: onAdvOnly },
            'Solo modalità avanzata', h('small', null, 'Se conosci già il gioco base')),
          h('button', { class: 'btn big ghost', onclick: onBack }, '‹ Indietro')))));
  }

  // ── setup ──────────────────────────────────────────────────────────────────
  setup(onStart: (c: MatchConfig) => void, onBack: () => void, spectate = false, advanced = false): void {
    const cfg = loadSetup();
    cfg.spectate = spectate;
    cfg.advanced = advanced;
    const seg = <T extends string>(opts: [T, string][], get: () => T, setv: (v: T) => void) => {
      const wrap = h('div', { class: 'seg' });
      const paint = () => [...wrap.children].forEach((b, k) => b.classList.toggle('on', opts[k][0] === get()));
      opts.forEach(([v, l]) => wrap.appendChild(h('button', { type: 'button', onclick: () => { setv(v); paint(); refresh(); } }, l)));
      paint();
      return wrap;
    };
    const nameIn = h('input', { type: 'text', maxlength: '18', value: cfg.name, spellcheck: false }) as HTMLInputElement;
    const seedIn = h('input', { type: 'number', min: '1', max: '999999', value: String(cfg.seed) }) as HTMLInputElement;
    const natIn = h('input', { type: 'number', min: '0', max: '200', value: String(cfg.nations) }) as HTMLInputElement;
    const triIn = h('input', { type: 'number', min: '0', max: '400', value: String(cfg.tribes) }) as HTMLInputElement;
    const specIn = h('input', { type: 'checkbox', checked: cfg.spectate }) as HTMLInputElement;
    const custom = h('input', { type: 'color', value: hexColor(cfg.color), title: 'Colore personalizzato' }) as HTMLInputElement;
    const swatches = h('div', { class: 'swatches' });
    const paintSw = () => [...swatches.querySelectorAll('.swc')].forEach((b, k) => b.classList.toggle('on', PLAYER_COLORS[k] === cfg.color));
    PLAYER_COLORS.forEach(c => swatches.appendChild(h('button', { type: 'button', class: 'swc', style: `background:${hexColor(c)}`, onclick: () => { cfg.color = c; custom.value = hexColor(c); paintSw(); } })));
    swatches.appendChild(h('label', { class: 'swc custom', title: 'Colore personalizzato' }, custom));
    custom.addEventListener('input', () => { cfg.color = parseHex(custom.value); paintSw(); });
    paintSw();
    const seedRow = h('div', { class: 'row seedrow' },
      h('label', null, 'Seme'),
      h('div', { class: 'inline' }, seedIn,
        h('button', { type: 'button', class: 'btn icon', title: 'Seme casuale', onclick: () => { seedIn.value = String(1 + Math.floor(Math.random() * 999999)); } }, h('span', { class: 'dice' }))));
    const humanRows = h('div', { class: 'grp' },
      h('div', { class: 'row' }, h('label', null, 'Nome'), nameIn),
      h('div', { class: 'row' }, h('label', null, 'Colore'), swatches));
    const mapCards = h('div', { class: 'mapcards' });
    const paintMap = () => [...mapCards.children].forEach((b, k) => b.classList.toggle('on', (k === 0 ? 'world' : 'proc') === cfg.map));
    mapCards.append(
      h('button', { type: 'button', class: 'mapcard world', onclick: () => { cfg.map = 'world'; paintMap(); refresh(); } },
        h('span', { class: 'mc-art' }), h('b', null, 'Mondo reale'), h('small', null, 'Continenti e nazioni del nostro pianeta')),
      h('button', { type: 'button', class: 'mapcard proc', onclick: () => { cfg.map = 'proc'; paintMap(); refresh(); } },
        h('span', { class: 'mc-art' }), h('b', null, 'Mondo casuale'), h('small', null, 'Continenti generati da un seme')));
    paintMap();
    cfg.skin = skinId();
    const skinCards = h('div', { class: 'skincards' });
    const paintSkin = () => [...skinCards.children].forEach((b, k) => b.classList.toggle('on', SKIN_IDS[k] === cfg.skin));
    for (const id of SKIN_IDS) {
      const sw = SKIN_INFO[id].swatch;
      skinCards.appendChild(h('button', { type: 'button', class: 'skincard', title: SKIN_INFO[id].desc, onclick: () => { cfg.skin = id; setSkin(id, true); paintSkin(); } },
        h('span', { class: 'sk-art', style: `background:linear-gradient(135deg, ${sw[0]} 0 38%, ${sw[1]} 38% 64%, ${sw[2]} 64% 82%, ${sw[3]} 82%)` }),
        h('span', null, SKIN_INFO[id].name)));
    }
    paintSkin();
    // advanced-only options: scenario + fog of war
    const fogIn = h('input', { type: 'checkbox', checked: cfg.fog !== false }) as HTMLInputElement;
    const scenSeg = h('div', { class: 'seg scen' });
    const scenHint = h('small', { class: 'scen-hint' });
    const effScenario = (): ScenarioId => (cfg.map === 'world' ? cfg.scenario ?? 'libero' : 'libero');
    for (const [id, label] of SCENARIOS) {
      scenSeg.appendChild(h('button', { type: 'button', onclick: () => { cfg.scenario = id; refresh(); } }, label));
    }
    const fogRow = h('label', { class: 'check' }, fogIn, h('span', null, 'Nebbia di guerra (vedi solo vicino ai tuoi confini)'));
    const advGrp = advanced ? h('div', { class: 'grp adv-grp' },
      h('div', { class: 'row' }, h('label', null, 'Scenario'), h('div', { class: 'scen-wrap' }, scenSeg, scenHint)),
      fogRow) : null;
    const refresh = () => {
      seedRow.classList.toggle('hidden', cfg.map !== 'proc');
      if (advGrp) {
        const eff = effScenario();
        [...scenSeg.children].forEach((b, k) => {
          const id = SCENARIOS[k][0];
          (b as HTMLButtonElement).disabled = id !== 'libero' && cfg.map !== 'world';
          b.classList.toggle('on', id === eff);
          (b as HTMLButtonElement).title = (b as HTMLButtonElement).disabled ? 'Solo con il mondo reale' : SCENARIOS[k][2];
        });
        const info = SCENARIOS.find(([id]) => id === eff)!;
        scenHint.textContent = cfg.map !== 'world' ? `${info[2]} 1939 e Guerra fredda solo con il mondo reale.` : info[2];
        fogRow.classList.toggle('hidden', specIn.checked);
      }
      humanRows.classList.toggle('hidden', specIn.checked);
      startBtn.textContent = specIn.checked ? 'Avvia (spettatore)' : 'Scegli il punto di partenza';
    };
    specIn.addEventListener('change', refresh);
    const startBtn = h('button', { class: 'btn primary big', type: 'submit' }, '');
    const form = h('form', { class: 'setup-card panel', onsubmit: (e: Event) => {
      e.preventDefault();
      cfg.name = nameIn.value.trim() || 'Comandante';
      cfg.seed = Math.max(1, Math.floor(Number(seedIn.value) || 1));
      cfg.nations = Math.max(0, Math.min(200, Math.floor(Number(natIn.value) || 0)));
      cfg.tribes = Math.max(0, Math.min(400, Math.floor(Number(triIn.value) || 0)));
      cfg.spectate = specIn.checked;
      cfg.fog = fogIn.checked;
      saveSetup(cfg);
      onStart({ ...cfg, scenario: advanced ? effScenario() : undefined, fog: advanced ? fogIn.checked : undefined });
    } },
      h('div', { class: 'setup-head' }, h('button', { type: 'button', class: 'btn ghost sm', onclick: onBack }, '‹ Indietro'), h('h2', null, advanced ? 'Partita avanzata' : 'Nuova partita')),
      humanRows,
      h('div', { class: 'grp' }, h('div', { class: 'row' }, h('label', null, 'Mappa'), mapCards), seedRow),
      h('div', { class: 'grp' }, h('div', { class: 'row' }, h('label', null, 'Stile grafico'), skinCards),
        h('div', { class: 'row' }, h('label', null, 'Qualità grafica'), qualitySeg())),
      h('div', { class: 'grp' },
        h('div', { class: 'row' }, h('label', null, 'Difficoltà'),
          seg<Difficulty>([['easy', 'Facile'], ['normal', 'Normale'], ['hard', 'Difficile']], () => cfg.difficulty, v => { cfg.difficulty = v; })),
        h('div', { class: 'row two' },
          h('div', null, h('label', null, 'Nazioni'), natIn),
          h('div', null, h('label', null, 'Tribù'), triIn)),
        h('label', { class: 'check' }, specIn, h('span', null, 'Solo spettatore (nessun giocatore umano)'))),
      advGrp,
      h('div', { class: 'setup-foot' }, startBtn));
    refresh();
    this.set(h('div', { class: `scr setup${advanced ? ' adv' : ''}` }, form));
    setTimeout(() => { if (!specIn.checked) nameIn.focus(); }, 60);
  }

  loading(text: string): void {
    this.set(h('div', { class: 'scr loading' }, h('div', { class: 'spinner' }), h('p', null, text)));
  }

  // ── spawn ──────────────────────────────────────────────────────────────────
  spawnBar(onConfirm: () => void, onRandom: () => void, onBack: () => void): { setPicked(v: boolean, label?: string): void } {
    const confirm = h('button', { class: 'btn primary', disabled: true, onclick: onConfirm }, 'Inizia qui');
    const info = h('span', { class: 'sb-info' }, 'Clicca un punto di terraferma per scegliere dove nasce la tua nazione.');
    this.set(h('div', { class: 'scr spawn' },
      h('div', { class: 'spawnbar panel' },
        h('button', { class: 'btn ghost sm', onclick: onBack }, '‹ Indietro'),
        h('div', { class: 'sb-text' }, h('b', null, 'Scegli il punto di partenza'), info),
        h('button', { class: 'btn', onclick: onRandom }, 'Casuale'),
        confirm)));
    return {
      setPicked(v: boolean, label?: string) {
        (confirm as HTMLButtonElement).disabled = !v;
        info.textContent = v ? (label ?? 'Pronto. Conferma o scegli un altro punto.') : 'Clicca un punto di terraferma per scegliere dove nasce la tua nazione.';
      },
    };
  }

  /** Open an arbitrary panel as a modal (backdrop click calls onClose). */
  panel(el: HTMLElement, onClose: () => void): void {
    this.openModal(h('div', { class: 'modal-wrap', onclick: (e: Event) => { if (e.target === e.currentTarget) onClose(); } }, el));
  }

  // ── modals ─────────────────────────────────────────────────────────────────
  pause(onResume: () => void, onHelp: () => void, onQuit: () => void): void {
    this.openModal(h('div', { class: 'modal-wrap', onclick: (e: Event) => { if (e.target === e.currentTarget) onResume(); } },
      h('div', { class: 'modal panel pause' },
        h('h2', null, 'Pausa'),
        h('button', { class: 'btn primary big', onclick: onResume }, 'Riprendi'),
        h('button', { class: 'btn big', onclick: onHelp }, 'Come si gioca'),
        h('div', { class: 'pause-q' }, h('label', null, 'Qualità grafica'), qualitySeg()),
        h('button', { class: 'btn big danger', onclick: onQuit }, 'Abbandona e nuova partita'))));
  }

  help(onClose: () => void): void {
    const k = (s: string) => h('kbd', null, s);
    const line = (keys: (HTMLElement | string)[], text: string) => h('div', { class: 'hl' }, h('span', { class: 'hk' }, keys), h('span', null, text));
    this.openModal(h('div', { class: 'modal-wrap', onclick: (e: Event) => { if (e.target === e.currentTarget) onClose(); } },
      h('div', { class: 'modal panel help' },
        h('div', { class: 'help-head' }, h('h2', null, 'Come si gioca'), h('button', { class: 'ib', onclick: onClose, title: 'Chiudi (Esc)' }, '✕')),
        h('p', { class: 'lead' }, 'Parti da un piccolo territorio. Le truppe crescono nel tempo: spendile per allargare i confini. Vince chi possiede l’', h('b', null, '80% delle terre'), '.'),
        h('div', { class: 'help-cols' },
          h('div', null,
            h('h3', null, 'Conquista'),
            line([k('Clic')], 'Attacca o espanditi verso quella casella con la forza scelta. Se non confina via terra, salpa una nave.'),
            line([k('Clic destro')], 'Menu azioni della casella (anche pressione lunga).'),
            line([k('Q'), k('E')], 'Riduci / aumenta la forza d’attacco (Maiusc: ±1%).'),
            line([k('V')], 'Prepara una nave, poi clicca la costa bersaglio.'),
            h('h3', null, 'Costruzioni (sul cursore)'),
            h('div', { class: 'help-builds' },
              (['city', 'port', 'fort', 'factory', 'silo', 'sam'] as const).map(t =>
                h('div', { class: 'hb' }, h('img', { src: glyphURL(t), alt: '' }), k(STRUCTURE_KEY[t]), h('span', null, STRUCTURE_LABEL[t]))))),
          h('div', null,
            h('h3', null, 'Armi'),
            line([k('N')], 'Arma un’atomica, poi clicca il bersaglio.'),
            line([k('H')], 'Arma una bomba H (raggio enorme).'),
            line([k('Esc')], 'Annulla la mira / apre la pausa.'),
            h('h3', null, 'Visuale'),
            line([k('Trascina')], 'Sposta la mappa. Rotella o pizzico: zoom.'),
            line([k('W'), k('A'), k('S'), k('D')], 'Sposta la visuale (anche le frecce).'),
            line([k('Spazio')], 'Pausa. ', ),
            line([k('1'), k('2'), k('4')], 'Velocità 1×, 2×, 4×.'),
            line([k('T')], 'Mostra / nascondi i nomi.'),
            line([k('?')], 'Questa guida.'),
            h('h3', null, 'Diplomazia'),
            h('p', { class: 'small' }, 'Dal menu di un altro territorio: proponi alleanze, embarghi, donazioni. Gli alleati non possono attaccarsi; chi rompe un’alleanza diventa traditore.'))),
        h('div', { class: 'help-adv' },
          h('h3', null, 'Modalità avanzata'),
          h('div', { class: 'help-adv-grid' },
            ([
              ['Fronti', 'Il clic attacca un punto preciso (più forte, solo vicino al punto). «Fronte intero» attacca tutto il confine. La postura (offensiva, bilanciata, difensiva) sposta forza tra attacco e difesa.'],
              ['Capitale e rifornimenti', 'Lontano da capitale, città e porti l’attacco si indebolisce. Le terre tagliate fuori difendono poco e dopo un po’ si arrendono. Se cade la capitale perdi truppe e oro; gli imperi troppo grandi subiscono rivolte lontano dai centri.'],
              ['Economia', 'Il cursore lavoratori/soldati sposta la crescita tra oro e truppe. Ogni struttura oltre le prime costa manutenzione.'],
              ['Risorse', 'Giacimenti sulla mappa: petrolio (navi, flotta), ferro (attacco), uranio (serve per le atomiche). Ognuno rende anche oro.'],
              ['Flotta', 'Dai tuoi porti costruisci navi da guerra: affondano navi nemiche e bloccano i porti. «Invia flotta» le manda a pattugliare un mare.'],
              ['Dottrine', 'Tre rami (Guerra lampo, Fortezza, Proiezione) da tre livelli. Una ricerca alla volta, costa oro e tempo.'],
              ['Diplomazia', 'Dal menu di un altro paese: patto di non aggressione, tregua, tributo, guerra congiunta con un alleato. Rompere un patto costa reputazione.'],
              ['Scenari e obiettivi', '1939 e Guerra fredda (mondo reale) partono con blocchi e guerre. Obiettivi a tempo ti danno oro se li completi.'],
              ['Nebbia di guerra', 'Vedi solo vicino ai tuoi confini, alle tue città e alle tue navi. Il resto mostra l’ultimo stato visto; truppe sconosciute appaiono come «?».'],
            ] as [string, string][]).map(([t, d]) => h('div', { class: 'hadv' }, h('b', null, t), h('span', null, d)))),
          h('div', { class: 'help-adv-keys' },
            line([k('Z')], 'Cambia postura.'),
            line([k('G')], 'Attacco mirato / fronte intero.'),
            line([k('R')], 'Dottrine.'),
            line([k('X')], 'Invia flotta, poi clicca il mare.'),
            line([k('K')], 'Vai alla capitale.'))),
        h('div', { class: 'help-foot' }, h('button', { class: 'btn primary', onclick: onClose }, 'Ho capito')))));
  }

  end(info: EndInfo, onNew: () => void, onWatch: () => void): void {
    this.openModal(h('div', { class: `modal-wrap end ${info.win ? 'win' : 'lose'}` },
      h('div', { class: 'modal panel endcard' },
        h('div', { class: 'end-kicker' }, info.win ? 'Vittoria' : 'Partita conclusa'),
        h('h2', null, info.title),
        h('p', { class: 'lead' }, info.subtitle),
        h('div', { class: 'end-stats' }, info.stats.map(([k, v]) => h('div', null, h('b', null, v), h('span', null, k)))),
        h('div', { class: 'end-actions' },
          h('button', { class: 'btn primary big', onclick: onNew }, 'Nuova partita'),
          info.canWatch ? h('button', { class: 'btn big', onclick: onWatch }, 'Continua a guardare') : null))));
  }
}
