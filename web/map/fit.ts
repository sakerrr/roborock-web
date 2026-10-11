// How the flat map sits in its stage. The home is fitted as large as it can be
// without spilling over the edges or hiding under the zoom buttons. The robot's
// image comes with empty margins (and the odd speck of lidar noise outside), so
// the fit goes by where the home actually is. Pan & zoom are a transform on top.

import { $, clamp } from "../dom";
import { S } from "../state";
import type { MapFrame, MapPayload, Mask, Point } from "../types";
import { inner, stage } from "./elements";
import { applyView, clampView } from "./panzoom";

/** A rectangle in base-image px. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Space kept clear along the edges of the stage, in CSS px. */
export interface Insets {
  l: number;
  r: number;
  t: number;
  b: number;
}

interface Layout {
  k: number; // CSS px per image px
  x: number; // where the home's top-left corner lands in the stage
  y: number;
}

const MAX_FIT = 6; // so a brand-new map of one corner isn't blown up absurdly
const SPECK = 40; // islands under 40 blocks (0.1 m²) outside the home are noise
const GAP = 8; // breathing room beside the zoom buttons

let homeCache: { mask: Mask | null; box: Box } = { mask: null, box: { x: 0, y: 0, w: 1, h: 1 } };
let laid: { k: number; left: number; top: number; W: number; H: number; frame?: MapFrame } | null = null;

/** Where the home is on the image (base px): everything mapped, minus stray specks. */
export function homeBox(): Box {
  const m = S.map;
  const mask = S.mask;
  if (!m || !mask) return { x: 0, y: 0, w: 1, h: 1 };
  if (homeCache.mask !== mask) {
    const extra = [m.charger, m.robot].filter((p): p is Point => !!p);
    homeCache = { mask, box: findHome(mask, m.scale, extra) };
  }
  return homeCache.box;
}

function findHome(mask: Mask, scale: number, extra: Point[]): Box {
  const { w, h, data } = mask;
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  const islands: { n: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  // Flood-fill each connected patch of mapped blocks (diagonals count, so slanted walls hold together).
  for (let start = 0; start < w * h; start++) {
    if (seen[start] || !data[start * 4 + 3]) continue;
    const isl = { n: 0, x0: w, y0: h, x1: 0, y1: 0 };
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    while (head < tail) {
      const i = queue[head++];
      const x = i % w;
      const y = (i - x) / w;
      isl.n++;
      isl.x0 = Math.min(isl.x0, x);
      isl.x1 = Math.max(isl.x1, x);
      isl.y0 = Math.min(isl.y0, y);
      isl.y1 = Math.max(isl.y1, y);
      for (let ny = Math.max(0, y - 1); ny <= Math.min(h - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(w - 1, x + 1); nx++) {
          const j = ny * w + nx;
          if (!seen[j] && data[j * 4 + 3]) {
            seen[j] = 1;
            queue[tail++] = j;
          }
        }
      }
    }
    islands.push(isl);
  }
  if (!islands.length) return { x: 0, y: 0, w: w * scale, h: h * scale };
  // Keep everything but specks (and always the biggest piece, for a map that's just begun).
  const keep = Math.min(SPECK, Math.max(...islands.map((i) => i.n)));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const i of islands) {
    if (i.n < keep) continue;
    x0 = Math.min(x0, i.x0 * scale);
    y0 = Math.min(y0, i.y0 * scale);
    x1 = Math.max(x1, (i.x1 + 1) * scale);
    y1 = Math.max(y1, (i.y1 + 1) * scale);
  }
  // The dock and the robot always count, with room for their markers.
  const r = 4 * scale;
  for (const p of extra) {
    x0 = Math.min(x0, p.x - r);
    y0 = Math.min(y0, p.y - r);
    x1 = Math.max(x1, p.x + r);
    y1 = Math.max(y1, p.y + r);
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  return { x: x0, y: y0, w: Math.min(w * scale, x1) - x0, h: Math.min(h * scale, y1) - y0 };
}

/** The home's rectangle inside the map element, in its own (unzoomed) CSS px. */
export function homeRect(): Box {
  const m = S.map;
  if (!m) return { x: 0, y: 0, w: inner.offsetWidth, h: inner.offsetHeight };
  const k = inner.offsetWidth / m.width;
  const b = homeBox();
  return { x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k };
}

/** The stage's padding: the fitted home stays inside it. */
export function stagePadding(): Insets {
  const cs = getComputedStyle(stage);
  return { l: parseFloat(cs.paddingLeft), r: parseFloat(cs.paddingRight), t: parseFloat(cs.paddingTop), b: parseFloat(cs.paddingBottom) };
}

/** How far the zoom buttons reach in from the stage's right and bottom edges, plus a gap. */
export function buttonsReach(): { w: number; h: number } {
  const b = $("#map-zoom");
  if (!b.offsetParent) return { w: 0, h: 0 };
  return { w: stage.clientWidth - b.offsetLeft + GAP, h: stage.clientHeight - b.offsetTop + GAP };
}

/** Lay the map out so the home fills the stage. Call when the map or the stage changes size. */
export function fitMap(): void {
  const m = S.map;
  if (!m || !S.mask || inner.hidden) return;
  const pad = stagePadding();
  const W = stage.clientWidth;
  if (W - pad.l - pad.r <= 0) return;
  const home = homeBox();
  const btn = buttonsReach();
  let lay: Layout;
  let H: number;
  if (window.matchMedia("(min-width: 1024px)").matches) {
    // Desktop: the stage fills the map card.
    stage.style.height = "";
    H = stage.clientHeight;
    lay = fitInside(home, W, H, pad, btn);
  } else {
    // Smaller screens: the stage is as tall as the home needs (up to about half the
    // screen), plus a strip for the zoom buttons when they'd cover part of the home.
    const maxH = clamp(window.innerHeight * 0.48, 220, 560);
    const k = Math.min((W - pad.l - pad.r) / home.w, maxH / home.h, MAX_FIT);
    lay = { k, x: (pad.l + W - pad.r - home.w * k) / 2, y: pad.t };
    const bottom = covers(lay, home, W - btn.w, pad.t + home.h * k + pad.b - btn.h) ? Math.max(pad.b, btn.h) : pad.b;
    H = Math.max(pad.t + home.h * k + bottom, parseFloat(getComputedStyle(stage).minHeight) || 0);
    lay.y = (pad.t + H - bottom - home.h * k) / 2;
    stage.style.height = `${Math.round(H)}px`;
  }
  place(m, home, lay, W, H);
}

/** The biggest layout that keeps the home inside the padding and clear of the zoom buttons. */
function fitInside(home: Box, W: number, H: number, pad: Insets, btn: { w: number; h: number }): Layout {
  const fit = (right: number, bottom: number): Layout => {
    const k = Math.min((W - pad.l - right) / home.w, (H - pad.t - bottom) / home.h, MAX_FIT);
    return { k, x: (pad.l + W - right - home.w * k) / 2, y: (pad.t + H - bottom - home.h * k) / 2 };
  };
  const lay = fit(pad.r, pad.b);
  if (!covers(lay, home, W - btn.w, H - btn.h)) return lay;
  // The buttons would sit on part of the home: slide it over if there's room,
  // otherwise shrink it just enough to clear them, beside or above.
  const flushX = W - btn.w - home.w * lay.k;
  if (flushX >= pad.l) return { ...lay, x: flushX };
  const flushY = H - btn.h - home.h * lay.k;
  if (flushY >= pad.t) return { ...lay, y: flushY };
  const beside = fit(Math.max(pad.r, btn.w), pad.b);
  const above = fit(pad.r, Math.max(pad.b, btn.h));
  return beside.k >= above.k ? beside : above;
}

/** Does any of the home land right of x and below y (stage px) in this layout? */
function covers(lay: Layout, home: Box, x: number, y: number): boolean {
  const { w, h, data } = S.mask!;
  const s = S.map!.scale;
  const c0 = clamp(Math.floor((home.x + (x - lay.x) / lay.k) / s), 0, w);
  const r0 = clamp(Math.floor((home.y + (y - lay.y) / lay.k) / s), 0, h);
  const c1 = clamp(Math.ceil((home.x + home.w) / s), 0, w);
  const r1 = clamp(Math.ceil((home.y + home.h) / s), 0, h);
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) if (data[(r * w + c) * 4 + 3]) return true;
  }
  return false;
}

function place(m: MapPayload, home: Box, lay: Layout, W: number, H: number): void {
  const width = Math.round(m.width * lay.k);
  const k = width / m.width;
  const left = Math.round(lay.x - home.x * k);
  const top = Math.round(lay.y - home.y * k);
  const prev = laid;
  laid = { k, left, top, W, H, frame: m.frame };
  const v = S.view;
  if (prev && (v.s !== 1 || v.tx || v.ty)) {
    // Zoomed in: keep the same spot in the middle of the stage, at the same size,
    // even if the map grew (its pixels then move by the change of origin).
    const f0 = prev.frame;
    const f1 = m.frame;
    const dx = f0 && f1 ? (f0.left - f1.left) * f1.scale : 0;
    const dy = f0 && f1 ? (f1.top + f1.height - f0.top - f0.height) * f1.scale : 0;
    const cx = (prev.W / 2 - prev.left - v.tx) / (prev.k * v.s) + dx;
    const cy = (prev.H / 2 - prev.top - v.ty) / (prev.k * v.s) + dy;
    v.s *= prev.k / k;
    v.tx = W / 2 - left - cx * k * v.s;
    v.ty = H / 2 - top - cy * k * v.s;
  }
  Object.assign(inner.style, { width: `${width}px`, height: `${Math.round(m.height * k)}px`, left: `${left}px`, top: `${top}px` });
  clampView();
  applyView();
}

/** Forget the stage height set for small screens (when there's no map to show). */
export function releaseStage(): void {
  stage.style.height = "";
  laid = null;
}
