// Procedural structure glyphs. Drawn in a unit box centred on (0,0), extent ±1.
import type { StructureType } from '../sim/types';

type G = CanvasRenderingContext2D;

function city(c: G): void {
  c.beginPath();
  c.rect(-0.82, -0.05, 0.42, 0.85);
  c.rect(-0.3, -0.75, 0.52, 1.55);
  c.rect(0.32, -0.38, 0.5, 1.18);
  c.fill();
  // windows cut-out
  c.globalCompositeOperation = 'destination-out';
  c.beginPath();
  for (let y = -0.55; y < 0.6; y += 0.32) c.rect(-0.14, y, 0.2, 0.14);
  for (let y = -0.2; y < 0.6; y += 0.32) c.rect(0.48, y, 0.18, 0.12);
  c.fill();
  c.globalCompositeOperation = 'source-over';
}

function port(c: G): void {
  c.lineWidth = 0.22;
  c.lineCap = 'round';
  c.beginPath();
  c.arc(0, -0.62, 0.2, 0, Math.PI * 2);
  c.moveTo(0, -0.42); c.lineTo(0, 0.82);
  c.moveTo(-0.42, -0.18); c.lineTo(0.42, -0.18);
  c.moveTo(-0.78, 0.18);
  c.quadraticCurveTo(-0.62, 0.82, 0, 0.82);
  c.quadraticCurveTo(0.62, 0.82, 0.78, 0.18);
  c.stroke();
  c.beginPath();
  c.moveTo(-0.92, 0.3); c.lineTo(-0.62, 0.02); c.lineTo(-0.58, 0.4); c.closePath();
  c.moveTo(0.92, 0.3); c.lineTo(0.62, 0.02); c.lineTo(0.58, 0.4); c.closePath();
  c.fill();
}

function fort(c: G): void {
  c.beginPath();
  c.moveTo(-0.85, 0.85);
  c.lineTo(-0.85, -0.75); c.lineTo(-0.5, -0.75); c.lineTo(-0.5, -0.45);
  c.lineTo(-0.17, -0.45); c.lineTo(-0.17, -0.75); c.lineTo(0.17, -0.75); c.lineTo(0.17, -0.45);
  c.lineTo(0.5, -0.45); c.lineTo(0.5, -0.75); c.lineTo(0.85, -0.75);
  c.lineTo(0.85, 0.85);
  c.closePath();
  c.fill();
  c.globalCompositeOperation = 'destination-out';
  c.beginPath();
  c.moveTo(-0.26, 0.86); c.lineTo(-0.26, 0.2); c.arc(0, 0.2, 0.26, Math.PI, 0); c.lineTo(0.26, 0.86);
  c.closePath();
  c.fill();
  c.globalCompositeOperation = 'source-over';
}

function factory(c: G): void {
  c.beginPath();
  c.moveTo(-0.9, 0.85);
  c.lineTo(-0.9, -0.1);
  c.lineTo(-0.45, -0.42); c.lineTo(-0.45, -0.1);
  c.lineTo(0, -0.42); c.lineTo(0, -0.1);
  c.lineTo(0.38, -0.42); c.lineTo(0.38, -0.9); c.lineTo(0.72, -0.9); c.lineTo(0.72, -0.1);
  c.lineTo(0.9, -0.1); c.lineTo(0.9, 0.85);
  c.closePath();
  c.fill();
  c.globalCompositeOperation = 'destination-out';
  c.beginPath();
  c.rect(-0.62, 0.2, 0.3, 0.26); c.rect(-0.12, 0.2, 0.3, 0.26); c.rect(0.4, 0.2, 0.3, 0.26);
  c.fill();
  c.globalCompositeOperation = 'source-over';
}

function silo(c: G): void {
  c.beginPath();
  c.moveTo(0, -0.95);
  c.quadraticCurveTo(0.34, -0.6, 0.3, -0.1);
  c.lineTo(0.3, 0.5);
  c.lineTo(0.62, 0.86); c.lineTo(0.22, 0.74);
  c.lineTo(0, 0.95); c.lineTo(-0.22, 0.74);
  c.lineTo(-0.62, 0.86); c.lineTo(-0.3, 0.5);
  c.lineTo(-0.3, -0.1);
  c.quadraticCurveTo(-0.34, -0.6, 0, -0.95);
  c.fill();
  c.globalCompositeOperation = 'destination-out';
  c.beginPath(); c.arc(0, -0.3, 0.12, 0, Math.PI * 2); c.fill();
  c.globalCompositeOperation = 'source-over';
}

function sam(c: G): void {
  // radar dish on a tripod + emission arcs
  c.lineCap = 'round';
  c.lineWidth = 0.2;
  c.beginPath();
  c.moveTo(-0.15, 0.1); c.lineTo(-0.55, 0.88);
  c.moveTo(-0.15, 0.1); c.lineTo(0.2, 0.88);
  c.moveTo(-0.7, 0.88); c.lineTo(0.4, 0.88);
  c.stroke();
  c.beginPath();
  c.ellipse(-0.2, -0.1, 0.62, 0.3, -0.75, 0, Math.PI);
  c.closePath();
  c.fill();
  c.lineWidth = 0.16;
  c.beginPath(); c.arc(0.1, -0.4, 0.45, -1.4, -0.15); c.stroke();
  c.beginPath(); c.arc(0.1, -0.4, 0.8, -1.35, -0.2); c.stroke();
}

const DRAW: Record<StructureType, (c: G) => void> = { city, port, fort, factory, silo, sam };

export function drawGlyph(c: G, type: StructureType, cx: number, cy: number, half: number, color: string): void {
  c.save();
  c.translate(cx, cy);
  c.scale(half, half);
  c.fillStyle = color;
  c.strokeStyle = color;
  DRAW[type](c);
  c.restore();
}

const spriteCache = new Map<string, HTMLCanvasElement>();

/** White glyph sprite, `px` device pixels square. */
export function glyphSprite(type: StructureType, px: number, color = '#fff'): HTMLCanvasElement {
  px = Math.max(6, Math.round(px));
  const key = type + px + color;
  let s = spriteCache.get(key);
  if (!s) {
    s = document.createElement('canvas');
    s.width = s.height = px;
    const c = s.getContext('2d')!;
    drawGlyph(c, type, px / 2, px / 2, px * 0.42, color);
    spriteCache.set(key, s);
  }
  return s;
}

const urlCache = new Map<string, string>();
export function glyphURL(type: StructureType, color = '#e8eef7'): string {
  const key = type + color;
  let u = urlCache.get(key);
  if (!u) { u = glyphSprite(type, 48, color).toDataURL(); urlCache.set(key, u); }
  return u;
}

export const STRUCTURE_LABEL: Record<StructureType, string> = {
  city: 'Città', port: 'Porto', fort: 'Forte', factory: 'Fabbrica', silo: 'Silo missilistico', sam: 'Antiaerea (SAM)',
};

export const STRUCTURE_HINT: Record<StructureType, string> = {
  city: '+25% truppe max', port: 'Navi e commercio', fort: 'Difesa ×2,5', factory: '+oro al secondo',
  silo: 'Lancia atomiche', sam: 'Abbatte atomiche',
};

export const STRUCTURE_KEY: Record<StructureType, string> = { city: 'C', port: 'P', fort: 'F', factory: 'B', silo: 'L', sam: 'M' };

// ── advanced mode glyphs (same unit box, same style) ──────────────────────────
export type AdvGlyph = 'oil' | 'iron' | 'uranium' | 'capital' | 'warship';

function oil(c: G): void {
  // drop
  c.beginPath();
  c.moveTo(0, -0.95);
  c.bezierCurveTo(0.22, -0.6, 0.72, -0.1, 0.72, 0.3);
  c.arc(0, 0.3, 0.72, 0, Math.PI);
  c.bezierCurveTo(-0.72, -0.1, -0.22, -0.6, 0, -0.95);
  c.fill();
  c.globalCompositeOperation = 'destination-out';
  c.lineWidth = 0.16; c.lineCap = 'round';
  c.beginPath(); c.arc(0, 0.3, 0.42, Math.PI * 0.55, Math.PI * 0.95); c.stroke();
  c.globalCompositeOperation = 'source-over';
}

function iron(c: G): void {
  // three stacked ingots
  const ingot = (x: number, y: number) => {
    c.moveTo(x - 0.46, y + 0.26); c.lineTo(x - 0.32, y - 0.2); c.lineTo(x + 0.32, y - 0.2); c.lineTo(x + 0.46, y + 0.26); c.closePath();
  };
  c.beginPath();
  ingot(-0.48, 0.58); ingot(0.48, 0.58); ingot(0, -0.02);
  c.fill();
  c.lineWidth = 0.12; c.lineCap = 'round';
  c.beginPath(); c.moveTo(-0.3, -0.48); c.lineTo(0.3, -0.48); c.moveTo(-0.16, -0.72); c.lineTo(0.16, -0.72); c.stroke();
}

function uranium(c: G): void {
  // radiation trefoil
  c.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = -Math.PI / 2 + k * (Math.PI * 2 / 3);
    c.moveTo(Math.cos(a - 0.52) * 0.3, Math.sin(a - 0.52) * 0.3);
    c.arc(0, 0, 0.92, a - 0.52, a + 0.52);
    c.arc(0, 0, 0.3, a + 0.52, a - 0.52, true);
    c.closePath();
  }
  c.moveTo(0.17, 0); c.arc(0, 0, 0.17, 0, Math.PI * 2);
  c.fill();
}

function capital(c: G): void {
  c.beginPath();
  for (let k = 0; k < 10; k++) {
    const r = k & 1 ? 0.42 : 1, a = -Math.PI / 2 + (k * Math.PI) / 5;
    if (k) c.lineTo(Math.cos(a) * r, Math.sin(a) * r + 0.06); else c.moveTo(Math.cos(a) * r, Math.sin(a) * r + 0.06);
  }
  c.closePath();
  c.fill();
}

function warship(c: G): void {
  // side view: hull, superstructure, mast, gun
  c.beginPath();
  c.moveTo(-0.98, 0.22); c.lineTo(0.98, 0.22); c.lineTo(0.72, 0.62); c.lineTo(-0.78, 0.62); c.closePath();
  c.rect(-0.42, -0.12, 0.62, 0.36);
  c.rect(-0.22, -0.4, 0.3, 0.3);
  c.rect(-0.1, -0.86, 0.08, 0.5);
  c.rect(0.3, 0.02, 0.26, 0.2);
  c.fill();
  c.lineWidth = 0.1; c.lineCap = 'round';
  c.beginPath(); c.moveTo(0.5, 0.08); c.lineTo(0.9, -0.06); c.moveTo(-0.6, 0.14); c.lineTo(-0.86, 0.04); c.stroke();
}

const ADV_DRAW: Record<AdvGlyph, (c: G) => void> = { oil, iron, uranium, capital, warship };

export function drawAdvGlyph(c: G, kind: AdvGlyph, cx: number, cy: number, half: number, color: string): void {
  c.save();
  c.translate(cx, cy);
  c.scale(half, half);
  c.fillStyle = color;
  c.strokeStyle = color;
  ADV_DRAW[kind](c);
  c.restore();
}

/** Data URL of an advanced glyph (48 px, transparent background) for DOM use — same style as glyphURL. */
export function advGlyphURL(kind: AdvGlyph, color = '#e8eef7'): string {
  const key = 'adv:' + kind + color;
  let u = urlCache.get(key);
  if (!u) {
    const s = document.createElement('canvas');
    s.width = s.height = 48;
    drawAdvGlyph(s.getContext('2d')!, kind, 24, 24, 48 * 0.42, color);
    u = s.toDataURL();
    urlCache.set(key, u);
  }
  return u;
}

export const ADV_GLYPH_LABEL: Record<AdvGlyph, string> = {
  oil: 'Petrolio', iron: 'Ferro', uranium: 'Uranio', capital: 'Capitale', warship: 'Nave da guerra',
};
