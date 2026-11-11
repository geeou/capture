// Tiny DOM helpers + toasts.

type Attrs = Record<string, any> & { class?: string; style?: string };
type Child = Node | string | number | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.setAttribute('style', v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string') (el as any)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  const add = (c: Child | Child[]) => {
    if (Array.isArray(c)) { c.forEach(add); return; }
    if (c === null || c === undefined || c === false) return;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

/** Set text only when it changed (avoids layout churn in per-frame HUD updates). */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

let toastHost: HTMLElement | null = null;
let lastToast = '';
let lastToastAt = 0;

export function toast(text: string, level: 'info' | 'good' | 'warn' | 'danger' = 'warn'): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts' });
    document.body.appendChild(toastHost);
  }
  const now = performance.now();
  if (text === lastToast && now - lastToastAt < 700) return;
  lastToast = text; lastToastAt = now;
  const t = h('div', { class: `toast lvl-${level}` }, text);
  toastHost.appendChild(t);
  while (toastHost.children.length > 3) toastHost.firstElementChild!.remove();
  requestAnimationFrame(() => t.classList.add('in'));
  setTimeout(() => { t.classList.remove('in'); t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 2200);
}
