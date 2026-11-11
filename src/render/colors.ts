// Colour helpers and the map palette.

export const PALETTE = {
  deep: [7, 22, 41],
  mid: [14, 44, 74],
  shallow: [27, 74, 106],
  coastFoam: [44, 98, 128],
  plains: [118, 134, 96],
  hills: [132, 124, 94],
  mountain: [146, 138, 124],
  fallout: [112, 150, 38],
  void: '#050d18',
};

export function r8(c: number): number { return (c >> 16) & 255; }
export function g8(c: number): number { return (c >> 8) & 255; }
export function b8(c: number): number { return c & 255; }

export function rgbCss(c: number, a = 1): string {
  return a >= 1 ? `rgb(${r8(c)},${g8(c)},${b8(c)})` : `rgba(${r8(c)},${g8(c)},${b8(c)},${a})`;
}

export function mixColor(a: number, b: number, t: number): number {
  const r = r8(a) + (r8(b) - r8(a)) * t;
  const g = g8(a) + (g8(b) - g8(a)) * t;
  const bb = b8(a) + (b8(b) - b8(a)) * t;
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(bb);
}

export function shade(c: number, f: number): number {
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (cl(r8(c) * f) << 16) | (cl(g8(c) * f) << 8) | cl(b8(c) * f);
}

export function luma(c: number): number {
  return (0.299 * r8(c) + 0.587 * g8(c) + 0.114 * b8(c)) / 255;
}

/** Name colour for labels: a lifted version of the territory colour that stays readable on dark outlines. */
export function labelColor(c: number): string {
  const l = luma(c);
  return rgbCss(l < 0.55 ? mixColor(c, 0xffffff, 0.72) : mixColor(c, 0xffffff, 0.55));
}
