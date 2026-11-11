// Full-screen flows: title, setup, loading, spawn bar, pause, help, end of match.
import type { Difficulty } from '../sim/types';
import { h } from './dom';
import { hexColor, parseHex } from './format';
import { STRUCTURE_KEY, STRUCTURE_LABEL, glyphURL } from '../render/icons';
import { SKIN_IDS, SKIN_INFO, isSkinId, setSkin, skinId, type SkinId } from '../render/skins';

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
}

export const PLAYER_COLORS = [0x2f7bff, 0xff4f5e, 0x22c58b, 0xffb020, 0xa860ff, 0xff7a2f, 0x18c3d6, 0xf2f2f2];

const STORE_KEY = 'capture.setup.v1';

export function loadSetup(): MatchConfig {
  const def: MatchConfig = { map: 'world', seed: 1 + Math.floor(Math.random() * 99999), name: 'Comandante', color: PLAYER_COLORS[0], difficulty: 'normal', nations: 88, tribes: 150, spectate: false };
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) { const o = { ...def, ...JSON.parse(raw), spectate: false }; if (!isSkinId(o.skin)) o.skin = skinId(); return o; }
  } catch { /* storage unavailable */ }
  return def;
}
function saveSetup(c: MatchConfig): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(c)); } catch { /* ignore */ }
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
  title(onPlay: () => void, onWatch: () => void, onHelp: () => void): void {
    this.set(h('div', { class: 'scr title' },
      h('div', { class: 'title-box' },
        h('div', { class: 'logo' }, 'CAPTURE'),
        h('p', { class: 'tag' }, 'Conquista il mondo, una casella alla volta.'),
        h('div', { class: 'title-actions' },
          h('button', { class: 'btn primary big', onclick: onPlay }, 'Gioca'),
          h('button', { class: 'btn big ghost', onclick: onWatch }, 'Guarda una partita'),
          h('button', { class: 'btn big ghost', onclick: onHelp }, 'Come si gioca')),
        h('p', { class: 'foot' }, 'Possiedi l’80% delle terre per vincere · ~240 avversari'))));
  }

  // ── setup ──────────────────────────────────────────────────────────────────
  setup(onStart: (c: MatchConfig) => void, onBack: () => void, spectate = false): void {
    const cfg = loadSetup();
    cfg.spectate = spectate;
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
    const refresh = () => {
      seedRow.classList.toggle('hidden', cfg.map !== 'proc');
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
      saveSetup(cfg);
      onStart({ ...cfg });
    } },
      h('div', { class: 'setup-head' }, h('button', { type: 'button', class: 'btn ghost sm', onclick: onBack }, '‹ Indietro'), h('h2', null, 'Nuova partita')),
      humanRows,
      h('div', { class: 'grp' }, h('div', { class: 'row' }, h('label', null, 'Mappa'), mapCards), seedRow),
      h('div', { class: 'grp' }, h('div', { class: 'row' }, h('label', null, 'Stile grafico'), skinCards)),
      h('div', { class: 'grp' },
        h('div', { class: 'row' }, h('label', null, 'Difficoltà'),
          seg<Difficulty>([['easy', 'Facile'], ['normal', 'Normale'], ['hard', 'Difficile']], () => cfg.difficulty, v => { cfg.difficulty = v; })),
        h('div', { class: 'row two' },
          h('div', null, h('label', null, 'Nazioni'), natIn),
          h('div', null, h('label', null, 'Tribù'), triIn)),
        h('label', { class: 'check' }, specIn, h('span', null, 'Solo spettatore (nessun giocatore umano)'))),
      h('div', { class: 'setup-foot' }, startBtn));
    refresh();
    this.set(h('div', { class: 'scr setup' }, form));
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

  // ── modals ─────────────────────────────────────────────────────────────────
  pause(onResume: () => void, onHelp: () => void, onQuit: () => void): void {
    this.openModal(h('div', { class: 'modal-wrap', onclick: (e: Event) => { if (e.target === e.currentTarget) onResume(); } },
      h('div', { class: 'modal panel pause' },
        h('h2', null, 'Pausa'),
        h('button', { class: 'btn primary big', onclick: onResume }, 'Riprendi'),
        h('button', { class: 'btn big', onclick: onHelp }, 'Come si gioca'),
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
