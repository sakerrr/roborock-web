// Small DOM and formatting helpers.

/** The element matching `sel`; throws if the page doesn't have it. */
export function $<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
}

/** The element matching `sel`, or null. */
export function $opt<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T | null {
  return root.querySelector<T>(sel);
}

export function $$<T extends Element = HTMLElement>(sel: string, root: ParentNode = document): T[] {
  return [...root.querySelectorAll<T>(sel)];
}

/** The closest element matching `sel` from an event target, if any. */
export function closest<T extends Element = HTMLElement>(target: EventTarget | null, sel: string): T | null {
  return target instanceof Element ? target.closest<T>(sel) : null;
}

export const icon = (name: string, cls = "i"): string => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: unknown): string => String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

export const human = (s: string | null | undefined): string =>
  s ? String(s).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "";

export const pct = (v: number, total: number): string => `${(v / total) * 100}%`;
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(msg: string, isErr = false): void {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), isErr ? 4200 : 2200);
}

export function busyBtn(btn: HTMLButtonElement, on: boolean): void {
  btn.classList.toggle("busy", on);
  btn.disabled = on;
}

export function fmtDuration(sec: number | null | undefined): string {
  if (sec == null) return "–";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

export const fmtArea = (a: number | null | undefined): string => (a == null ? "–" : `${Number(a).toFixed(a >= 100 ? 0 : 1)} m²`);

export function fmtWhen(ts: number | null | undefined): string {
  if (!ts) return "–";
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

export function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
