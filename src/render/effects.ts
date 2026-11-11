// Transient visual effects in world space: nuke blasts, SAM intercepts, landings, captures.
import type { Camera } from './camera';
import { getSkin, type FxTheme } from './skins';

const rgba = (c: [number, number, number], a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

interface Fx {
  kind: 'blast' | 'puff' | 'splash' | 'ping';
  x: number;
  y: number;
  /** world radius */
  r: number;
  t0: number;
  dur: number;
  color: string;
  big?: boolean;
}

export class Effects {
  private list: Fx[] = [];
  private shakeAmp = 0;
  private shakeT0 = 0;
  /** Colours of the active skin. */
  theme: FxTheme = getSkin().fx;
  /** Advanced mode (fog): returns true for world points the human cannot see; their effects are dropped. */
  hidden: ((x: number, y: number) => boolean) | null = null;

  blast(x: number, y: number, radius: number, hydrogen: boolean, now: number, onScreen: boolean): void {
    if (this.hidden && this.hidden(x, y)) return;
    this.list.push({ kind: 'blast', x, y, r: radius, t0: now, dur: hydrogen ? 2200 : 1600, color: '', big: hydrogen });
    if (onScreen) {
      this.shakeAmp = Math.max(this.shakeAmp * this.shakeDecay(now), hydrogen ? 14 : 8);
      this.shakeT0 = now;
    }
  }
  puff(x: number, y: number, now: number): void {
    if (this.hidden && this.hidden(x, y)) return;
    this.list.push({ kind: 'puff', x, y, r: 5, t0: now, dur: 900, color: this.theme.puff });
  }
  splash(x: number, y: number, now: number, color: string): void {
    if (this.hidden && this.hidden(x, y)) return;
    this.list.push({ kind: 'splash', x, y, r: 4, t0: now, dur: 900, color });
  }
  /** Attention ping (e.g. jump-to from the log). */
  ping(x: number, y: number, now: number, color?: string): void {
    this.list.push({ kind: 'ping', x, y, r: 10, t0: now, dur: 1400, color: color ?? this.theme.ping });
  }

  clear(): void { this.list.length = 0; this.shakeAmp = 0; }

  private shakeDecay(now: number): number {
    const t = Math.max(0, (now - this.shakeT0) / 520);
    return t >= 1 ? 0 : (1 - t) * (1 - t);
  }

  /** Screen shake offset in CSS px. */
  shake(now: number): [number, number] {
    if (this.shakeAmp <= 0) return [0, 0];
    const a = this.shakeAmp * this.shakeDecay(now);
    if (a < 0.2) { this.shakeAmp = 0; return [0, 0]; }
    return [Math.sin(now * 0.091) * a, Math.cos(now * 0.077) * a * 0.8];
  }

  draw(c: CanvasRenderingContext2D, cam: Camera, now: number): void {
    if (!this.list.length) return;
    let w = 0;
    for (let k = 0; k < this.list.length; k++) {
      const f = this.list[k];
      const t = Math.max(0, (now - f.t0) / f.dur);
      if (t >= 1) continue;
      this.list[w++] = f;
      const sx = cam.toScreenX(f.x + 0.5), sy = cam.toScreenY(f.y + 0.5);
      const R = f.r * cam.scale;
      if (sx < -R * 3 - 60 || sy < -R * 3 - 60 || sx > cam.viewW + R * 3 + 60 || sy > cam.viewH + R * 3 + 60) continue;
      c.save();
      if (f.kind === 'blast') this.drawBlast(c, f, sx, sy, R, t);
      else if (f.kind === 'puff') {
        const rr = Math.max(6, R) * (0.6 + t * 1.6);
        c.globalAlpha = (1 - t) * 0.9;
        c.fillStyle = f.color;
        for (let j = 0; j < 7; j++) {
          const a = j * 0.9 + f.t0 * 0.001;
          c.beginPath();
          c.arc(sx + Math.cos(a) * rr * 0.55, sy + Math.sin(a) * rr * 0.55, rr * (0.32 + 0.1 * Math.sin(j * 2.1)), 0, Math.PI * 2);
          c.fill();
        }
        c.globalAlpha = (1 - t);
        c.strokeStyle = this.theme.ring;
        c.lineWidth = 1.5;
        c.beginPath(); c.arc(sx, sy, rr * 1.4, 0, Math.PI * 2); c.stroke();
      } else if (f.kind === 'splash') {
        const rr = Math.max(5, R) * (0.4 + t * 1.6);
        c.globalAlpha = (1 - t) * 0.85;
        c.strokeStyle = f.color;
        c.lineWidth = 2;
        c.beginPath(); c.arc(sx, sy, rr, 0, Math.PI * 2); c.stroke();
        c.beginPath(); c.arc(sx, sy, rr * 0.55, 0, Math.PI * 2); c.stroke();
      } else {
        for (let j = 0; j < 2; j++) {
          const tt = (t * 1.4 - j * 0.35);
          if (tt < 0 || tt > 1) continue;
          c.globalAlpha = 1 - tt;
          c.strokeStyle = f.color;
          c.lineWidth = 2.5;
          c.beginPath(); c.arc(sx, sy, 6 + tt * 38, 0, Math.PI * 2); c.stroke();
        }
      }
      c.restore();
    }
    this.list.length = w;
  }

  private drawBlast(c: CanvasRenderingContext2D, f: Fx, sx: number, sy: number, R: number, t: number): void {
    const th = this.theme;
    const Rm = Math.max(R, 10);
    // fireball / flash
    const ft = Math.min(1, t / 0.35);
    if (ft < 1) {
      const fr = Rm * (0.5 + ft * 0.9);
      const g = c.createRadialGradient(sx, sy, 0, sx, sy, fr);
      g.addColorStop(0, rgba(th.core, 1 - ft));
      g.addColorStop(0.35, rgba(th.mid, (1 - ft) * 0.95));
      g.addColorStop(0.75, rgba(th.outer, (1 - ft) * 0.6));
      g.addColorStop(1, rgba(th.outer, 0));
      c.fillStyle = g;
      c.beginPath(); c.arc(sx, sy, fr, 0, Math.PI * 2); c.fill();
    }
    // whole-screen flash for the first moments
    if (t < 0.12) {
      c.globalAlpha = (1 - t / 0.12) * (f.big ? 0.35 : 0.2);
      c.fillStyle = th.flash;
      c.fillRect(-100, -100, 99999, 99999);
      c.globalAlpha = 1;
    }
    // shockwave rings
    const rt = Math.min(1, t / 0.8);
    const ease = 1 - Math.pow(1 - rt, 3);
    const ringR = Rm * (0.3 + ease * 2.1);
    c.globalAlpha = (1 - rt) * 0.9;
    c.strokeStyle = th.ring;
    c.lineWidth = Math.max(2, Rm * 0.12 * (1 - rt));
    c.beginPath(); c.arc(sx, sy, ringR, 0, Math.PI * 2); c.stroke();
    c.globalAlpha = (1 - rt) * 0.45;
    c.lineWidth = Math.max(1, Rm * 0.05);
    c.beginPath(); c.arc(sx, sy, ringR * 0.72, 0, Math.PI * 2); c.stroke();
    // lingering smoke disc
    const st = t;
    c.globalAlpha = Math.max(0, (1 - st)) * 0.45;
    const sg = c.createRadialGradient(sx, sy, 0, sx, sy, Rm * 1.1);
    sg.addColorStop(0, rgba(th.smoke, 0.9));
    sg.addColorStop(0.6, rgba(th.smoke, 0.5));
    sg.addColorStop(1, rgba(th.smoke, 0));
    c.fillStyle = sg;
    c.beginPath(); c.arc(sx, sy - st * Rm * 0.3, Rm * (0.8 + st * 0.4), 0, Math.PI * 2); c.fill();
    c.globalAlpha = 1;
  }
}
