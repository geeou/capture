// Pointer + keyboard input on the map canvas: camera control, taps, context requests, hotkeys.
// One Pointer Events path for mouse, pen and touch:
//   mouse  — left click = tap, right click = context, drag = pan, wheel = zoom (unchanged desktop behaviour)
//   touch  — tap (< TAP_MOVE px, < TAP_MS) = tap, long-press (LONG_MS, still) = context, one-finger drag = pan,
//            two-finger pinch = zoom around the midpoint + pan with it. Pinches and pans never end in an action.
import type { Renderer } from '../render/renderer';

export interface InputHandlers {
  tap(tile: number, sx: number, sy: number): void;
  context(tile: number, sx: number, sy: number): void;
  hover(tile: number): void;
  /** Return true when the key was consumed. */
  key(e: KeyboardEvent): boolean;
  /** Whether camera keys / map input are active right now. */
  active(): boolean;
}

const PAN_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1],
  KeyA: [1, 0], ArrowLeft: [1, 0], KeyD: [-1, 0], ArrowRight: [-1, 0],
};

/** Touch tuning. */
const TAP_MOVE = 10;   // px a finger may wander and still be a tap / long-press
const TAP_MS = 350;    // max duration of a tap
const LONG_MS = 450;   // long-press → context menu

export class Input {
  private pointers = new Map<number, { x: number; y: number }>();
  private downAt: { x: number; y: number; button: number; t: number; id: number; type: string } | null = null;
  private moved = false;
  private consumed = false;
  private longTimer = 0;
  private pinchIds: [number, number] | null = null;
  private pinchDist = 0;
  private pinchMid: [number, number] = [0, 0];
  private held = new Set<string>();
  lastX = -1;
  lastY = -1;
  /** pointerType of the last pointer that went down on the map ('mouse' | 'touch' | 'pen'). */
  lastPointerType = 'mouse';

  constructor(private r: Renderer, private hnd: InputHandlers) {
    const cv = r.canvas;
    cv.addEventListener('pointerdown', this.onDown);
    cv.addEventListener('pointermove', this.onMove);
    cv.addEventListener('pointerup', this.onUp);
    cv.addEventListener('pointercancel', this.onCancel);
    cv.addEventListener('pointerleave', e => {
      // touch pointers "leave" right after lifting: keep the tapped tile as the hover (aim previews rely on it)
      if (e.pointerType === 'mouse' && !this.pointers.size) { this.lastX = -1; this.hnd.hover(-1); }
    });
    cv.addEventListener('wheel', this.onWheel, { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', e => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
  }

  private local(e: { clientX: number; clientY: number }): [number, number] {
    const rect = this.r.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private startPinch(): void {
    const ids = [...this.pointers.keys()];
    this.pinchIds = [ids[0], ids[1]];
    const a = this.pointers.get(ids[0])!, b = this.pointers.get(ids[1])!;
    this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
    this.pinchMid = [(a.x + b.x) / 2, (a.y + b.y) / 2];
  }

  private onDown = (e: PointerEvent) => {
    if (!this.hnd.active()) return;
    const [x, y] = this.local(e);
    try { this.r.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic / already released */ }
    this.pointers.set(e.pointerId, { x, y });
    this.lastPointerType = e.pointerType || 'mouse';
    if (this.pointers.size === 1) {
      this.downAt = { x, y, button: e.button, t: performance.now(), id: e.pointerId, type: e.pointerType || 'mouse' };
      this.moved = false;
      this.consumed = false;
      this.pinchIds = null;
      if (e.pointerType !== 'mouse') {
        clearTimeout(this.longTimer);
        this.longTimer = window.setTimeout(() => {
          if (!this.moved && !this.consumed && this.downAt && this.pointers.size === 1) {
            this.consumed = true;
            const tile = this.r.tileAt(this.downAt.x, this.downAt.y);
            try { navigator.vibrate?.(10); } catch { /* not allowed */ }
            this.hnd.hover(tile);
            this.hnd.context(tile, this.downAt.x, this.downAt.y);
          }
        }, LONG_MS);
      }
    } else {
      // a second finger: whatever the first one was doing is no longer a tap
      clearTimeout(this.longTimer);
      this.consumed = true;
      this.r.canvas.classList.remove('panning');
      if (this.pointers.size === 2) this.startPinch();
    }
  };

  private onMove = (e: PointerEvent) => {
    const [x, y] = this.local(e);
    const p = this.pointers.get(e.pointerId);
    const touch = e.pointerType !== 'mouse';
    if (!touch) { this.lastX = x; this.lastY = y; }
    if (!p) {
      if (!touch && this.hnd.active()) this.hnd.hover(this.r.tileAt(x, y));
      return;
    }
    if (this.pointers.size >= 2) {
      p.x = x; p.y = y;
      const ids = this.pinchIds;
      if (!ids || !this.pointers.has(ids[0]) || !this.pointers.has(ids[1])) { this.startPinch(); return; }
      if (e.pointerId !== ids[0] && e.pointerId !== ids[1]) return; // third finger: ignore
      const a = this.pointers.get(ids[0])!, b = this.pointers.get(ids[1])!;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
      const cam = this.r.cam;
      // pan with the midpoint, then zoom around the new midpoint
      cam.panBy(mid[0] - this.pinchMid[0], mid[1] - this.pinchMid[1]);
      if (this.pinchDist > 4 && d > 4) cam.zoomAt(mid[0], mid[1], d / this.pinchDist);
      this.pinchDist = d; this.pinchMid = mid;
      return;
    }
    const dx = x - p.x, dy = y - p.y;
    p.x = x; p.y = y;
    if (this.downAt && !this.moved) {
      const tol = touch ? TAP_MOVE : 4;
      if (Math.hypot(x - this.downAt.x, y - this.downAt.y) > tol) {
        this.moved = true;
        clearTimeout(this.longTimer);
        // first frame of a touch pan: catch up the slop so the map stays under the finger
        if (touch) { this.r.cam.panBy(x - this.downAt.x - dx, y - this.downAt.y - dy); }
      }
    }
    if (this.moved) {
      this.r.cam.panBy(dx, dy);
      this.r.canvas.classList.add('panning');
    }
    if (!touch) this.hnd.hover(this.r.tileAt(x, y));
  };

  private onUp = (e: PointerEvent) => {
    const had = this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchIds = null;
    if (this.pointers.size === 0) { clearTimeout(this.longTimer); this.r.canvas.classList.remove('panning'); }
    if (!had) return;
    const d = this.downAt;
    if (this.pointers.size === 0) this.downAt = null;
    if (!d || d.id !== e.pointerId || this.moved || this.consumed) return;
    const [x, y] = this.local(e);
    if (d.type !== 'mouse') {
      // touch / pen: short and still = tap; anything else is not an action
      if (performance.now() - d.t > TAP_MS) return;
      const tile = this.r.tileAt(d.x, d.y);
      this.hnd.hover(tile);
      this.hnd.tap(tile, d.x, d.y);
      return;
    }
    const tile = this.r.tileAt(x, y);
    if (d.button === 2) this.hnd.context(tile, x, y);
    else if (d.button === 0) this.hnd.tap(tile, x, y);
  };

  private onCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinchIds = null;
    clearTimeout(this.longTimer);
    this.consumed = true;
    if (!this.pointers.size) { this.downAt = null; this.r.canvas.classList.remove('panning'); }
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!this.hnd.active()) return;
    const [x, y] = this.local(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 32;
    else if (e.deltaMode === 2) dy *= 400;
    const k = e.ctrlKey ? 0.012 : 0.0018;
    this.r.cam.zoomAt(x, y, Math.exp(-Math.max(-300, Math.min(300, dy)) * k));
    this.hnd.hover(this.r.tileAt(x, y));
  };

  private onKeyDown = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (this.hnd.key(e)) { e.preventDefault(); return; }
    if (PAN_KEYS[e.code] && this.hnd.active()) { this.held.add(e.code); e.preventDefault(); }
  };

  /** Continuous keyboard panning; dt in ms. */
  update(dt: number): void {
    if (!this.held.size || !this.hnd.active()) return;
    let dx = 0, dy = 0;
    for (const c of this.held) { const v = PAN_KEYS[c]; if (v) { dx += v[0]; dy += v[1]; } }
    if (!dx && !dy) return;
    const sp = 0.9 * dt; // px per ms
    this.r.cam.panBy(dx * sp, dy * sp);
    if (this.lastX >= 0) this.hnd.hover(this.r.tileAt(this.lastX, this.lastY));
  }

  /** Tile under the mouse cursor (for hotkeys), or -1. */
  cursorTile(): number {
    return this.lastX < 0 ? -1 : this.r.tileAt(this.lastX, this.lastY);
  }
}
