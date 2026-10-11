/* Pan & zoom for the flat map, Google Maps style.
   Drag moves the map at any zoom (with a little glide on release), pinch or a
   mouse wheel zooms toward the pointer, and a two-finger trackpad swipe moves
   the map. The fitted layout never changes; the view is a transform on top. */

import { $, clamp, closest, toast } from "../dom";
import { S } from "../state";
import type { Point } from "../types";
import { drawSelection, refreshMapOverlays, renderDraw, roomAt, toBase } from "./core";
import { editPointerDown, editPointerMove, editPointerUp, renderShapes, type EditGesture } from "./editor";
import { inner, mapImg, stage } from "./elements";
import { fitMap, homeRect } from "./fit";
import { freshHover } from "../freshness";
import { get3D } from "./views";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 10;

type Trail = { t: number; x: number; y: number }[];
type PanGesture = { type: "maybe" | "pan"; id: number; touch?: boolean; x0: number; y0: number; tx0: number; ty0: number; trail: Trail };
type Gesture = { type: "pinch"; d: number; m: Point } | { type: "zone" } | PanGesture | EditGesture;

const pointers = new Map<number, Point>();
let gesture: Gesture | null = null;
let spaceDown = false;
let overStage = false;
let inertia = 0;
let frame = 0;
let animateTimer: ReturnType<typeof setTimeout> | undefined;

const isEdit = (g: Gesture): g is EditGesture => g.type.startsWith("edit-");
export const isEditGesture = (): boolean => !!gesture && isEdit(gesture);

const isFit = () => S.view.s === 1 && !S.view.tx && !S.view.ty;
const capture = (id: number) => {
  try {
    stage.setPointerCapture(id);
  } catch {
    // pointer already gone
  }
};
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function applyView(): void {
  frame = 0;
  const { s, tx, ty } = S.view;
  inner.style.transform = isFit() ? "" : `translate(${tx}px, ${ty}px) scale(${s})`;
  inner.style.setProperty("--inv", String(1 / s));
  const k = S.map ? inner.offsetWidth / S.map.width : 1;
  mapImg.style.imageRendering = k * s >= 2 ? "pixelated" : "";
  // On touch screens one finger scrolls the page until you zoom; pinch always zooms the map.
  stage.style.touchAction = S.tool === "zone" || S.edit || s !== 1 ? "none" : "pan-y";
  // In 3D the camera has its own limits, so the buttons stay available.
  const is3d = S.viewMode === "3d";
  $<HTMLButtonElement>("#zoom-in").disabled = !is3d && s >= MAX_ZOOM;
  $<HTMLButtonElement>("#zoom-out").disabled = !is3d && s <= MIN_ZOOM;
  $<HTMLButtonElement>("#zoom-fit").disabled = !is3d && isFit();
  renderDraw();
  renderShapes();
}

const scheduleView = () => {
  if (!frame) frame = requestAnimationFrame(applyView);
};

export function clampView(): void {
  const v = S.view;
  v.s = clamp(v.s, MIN_ZOOM, MAX_ZOOM);
  // Move freely, but always keep a good part of the home on screen.
  const home = homeRect();
  const W = home.w * v.s;
  const H = home.h * v.s;
  const mx = Math.min(W, stage.clientWidth) * 0.35;
  const my = Math.min(H, stage.clientHeight) * 0.35;
  const ox = inner.offsetLeft + home.x * v.s;
  const oy = inner.offsetTop + home.y * v.s;
  v.tx = clamp(v.tx, mx - ox - W, stage.clientWidth - mx - ox);
  v.ty = clamp(v.ty, my - oy - H, stage.clientHeight - my - oy);
}

function zoomAt(clientX: number, clientY: number, scale: number, now = false): void {
  const v = S.view;
  const r = stage.getBoundingClientRect();
  const px = clientX - r.left - inner.offsetLeft;
  const py = clientY - r.top - inner.offsetTop;
  const ux = (px - v.tx) / v.s;
  const uy = (py - v.ty) / v.s;
  v.s = clamp(scale, MIN_ZOOM, MAX_ZOOM);
  v.tx = px - ux * v.s;
  v.ty = py - uy * v.s;
  clampView();
  if (now) applyView();
  else scheduleView();
}

function animateView(fn: () => void): void {
  stopInertia();
  inner.classList.add("animate");
  fn();
  applyView();
  clearTimeout(animateTimer);
  animateTimer = setTimeout(() => inner.classList.remove("animate"), 260);
}

function zoomBy(f: number): void {
  const r = stage.getBoundingClientRect();
  animateView(() => zoomAt(r.left + r.width / 2, r.top + r.height / 2, S.view.s * f, true));
}

export function resetView(animate = true): void {
  const run = () => {
    S.view = { s: 1, tx: 0, ty: 0 };
  };
  if (animate) animateView(run);
  else {
    stopInertia();
    run();
    applyView();
  }
}

export function centerOnRobot(): void {
  const m = S.map;
  if (!m?.robot) {
    toast("The robot isn't on the map right now");
    return;
  }
  const robot = m.robot;
  animateView(() => {
    const v = S.view;
    v.s = Math.max(v.s, 2.5);
    const ux = (robot.x / m.width) * inner.offsetWidth;
    const uy = (robot.y / m.height) * inner.offsetHeight;
    v.tx = stage.clientWidth / 2 - inner.offsetLeft - ux * v.s;
    v.ty = stage.clientHeight / 2 - inner.offsetTop - uy * v.s;
    clampView();
  });
}

function panBy(dx: number, dy: number): void {
  animateView(() => {
    S.view.tx += dx;
    S.view.ty += dy;
    clampView();
  });
}

function startInertia(vx: number, vy: number): void {
  const speed = Math.hypot(vx, vy); // px per ms
  if (speed < 0.25) return; // a slow release just stops
  // Cap the fling so a quick flick glides a short way instead of throwing the map off.
  const cap = 1.6 / Math.max(speed, 1.6);
  vx *= cap;
  vy *= cap;
  let last = performance.now();
  const step = (now: number) => {
    const dt = Math.min(now - last, 32);
    last = now;
    S.view.tx += vx * dt;
    S.view.ty += vy * dt;
    const f = Math.pow(0.992, dt);
    vx *= f;
    vy *= f;
    clampView();
    applyView();
    inertia = Math.hypot(vx, vy) > 0.02 ? requestAnimationFrame(step) : 0;
  };
  inertia = requestAnimationFrame(step);
}

function stopInertia(): void {
  if (inertia) cancelAnimationFrame(inertia);
  inertia = 0;
}

function finishZone(): void {
  S.drag = null;
  const m = S.map;
  if (!S.zone || !m) return;
  const [x0, y0, x1, y1] = S.zone;
  const minPx = (0.4 / 0.05) * m.scale; // at least 40cm
  if (Math.abs(x1 - x0) < minPx || Math.abs(y1 - y0) < minPx) {
    S.zone = null;
    toast("Draw a slightly bigger zone");
  }
  refreshMapOverlays();
}

function setHover(id: number): void {
  inner.classList.toggle("over-room", !!id);
  if (id !== S.hover) {
    S.hover = id;
    drawSelection();
  }
}

// A notched mouse wheel zooms (like Google Maps); a trackpad swipe moves the map.
export function wheelIsMouse(e: WheelEvent): boolean {
  if (e.deltaMode !== 0) return true; // line-based scrolling: classic wheel
  if (e.deltaX !== 0) return false; // any sideways motion: trackpad
  const w = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
  return !!w && w % 120 === 0 && Math.abs(e.deltaY) >= 50;
}

stage.addEventListener(
  "wheel",
  (e) => {
    if (!S.map || inner.hidden || S.viewMode === "3d") return;
    e.preventDefault();
    stopInertia();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stage.clientHeight : 1;
    const dx = e.deltaX * unit;
    const dy = e.deltaY * unit;
    if (e.ctrlKey) {
      // Trackpad pinch: Chrome, Edge and Firefox report it as ctrl + wheel.
      zoomAt(e.clientX, e.clientY, S.view.s * Math.exp(-dy * 0.01));
    } else if (wheelIsMouse(e)) {
      zoomAt(e.clientX, e.clientY, S.view.s * Math.exp(-dy * 0.0025));
    } else {
      S.view.tx -= dx;
      S.view.ty -= dy;
      clampView();
      scheduleView();
    }
  },
  { passive: false },
);

// Safari reports trackpad pinch as its own gesture events instead of ctrl + wheel.
type SafariGesture = Event & { scale: number; clientX: number; clientY: number };
let gestureBase = 1;
stage.addEventListener("gesturestart", (e) => {
  if (!S.map || pointers.size) return;
  e.preventDefault();
  stopInertia();
  gestureBase = S.view.s;
});
stage.addEventListener("gesturechange", (e) => {
  if (!S.map || pointers.size) return;
  e.preventDefault();
  const g = e as SafariGesture;
  zoomAt(g.clientX, g.clientY, gestureBase * g.scale);
});
stage.addEventListener("gestureend", (e) => {
  if (S.map && !pointers.size) e.preventDefault();
});

stage.addEventListener("pointerdown", (e) => {
  if (!S.map || inner.hidden || S.viewMode === "3d" || closest(e.target, ".map-zoom, .edit-tools, .shape-delete")) return;
  stopInertia();
  S.suppressClick = false;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    // Second finger: pinch to zoom, dropping any half-drawn zone.
    if (gesture?.type === "zone") {
      S.drag = null;
      S.zone = null;
      renderDraw();
    }
    const [a, b] = [...pointers.values()];
    gesture = { type: "pinch", d: dist(a, b), m: mid(a, b) };
    for (const id of pointers.keys()) capture(id);
    S.suppressClick = true;
    return;
  }
  if (pointers.size > 2) return;
  const panButton = e.button === 1 || e.button === 2 || spaceDown;
  if (S.edit && e.button === 0 && !panButton) {
    const g = editPointerDown(e);
    if (g) {
      gesture = g;
      capture(e.pointerId);
      return;
    }
  }
  if (!S.edit && S.tool === "zone" && e.button === 0 && !panButton) {
    const p = toBase(e);
    S.drag = p;
    S.zone = [p.x, p.y, p.x, p.y];
    gesture = { type: "zone" };
    capture(e.pointerId);
    renderDraw();
    return;
  }
  gesture = {
    type: "maybe",
    id: e.pointerId,
    touch: e.pointerType === "touch",
    x0: e.clientX,
    y0: e.clientY,
    tx0: S.view.tx,
    ty0: S.view.ty,
    trail: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }],
  };
  if (panButton) e.preventDefault();
});

stage.addEventListener("pointermove", (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!S.map || S.viewMode === "3d") return;
  const g = gesture;
  if (!g) {
    if (e.pointerType === "mouse") freshHover(e);
    const pickRooms = S.edit ? S.edit.mode === "rooms" && S.edit.tool !== "split" : S.tool === "rooms";
    if (pickRooms && e.pointerType === "mouse") {
      const r = inner.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      setHover(inside ? roomAt(toBase(e)) : 0);
    }
    return;
  }
  if (g.type === "pinch") {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const m = mid(a, b);
    const d = dist(a, b);
    S.view.tx += m.x - g.m.x;
    S.view.ty += m.y - g.m.y;
    zoomAt(m.x, m.y, S.view.s * (d / (g.d || d)));
    g.m = m;
    g.d = d;
    return;
  }
  if (isEdit(g)) {
    editPointerMove(e, g);
    return;
  }
  if (g.type === "zone") {
    const p = toBase(e);
    if (S.drag) S.zone = [S.drag.x, S.drag.y, p.x, p.y];
    renderDraw();
    return;
  }
  if (g.type === "maybe") {
    const moved = Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 4;
    // Touch keeps page scrolling at the fitted zoom; mouse and trackpad always drag the map.
    if (moved && (!g.touch || S.view.s !== 1)) {
      g.type = "pan";
      capture(g.id);
      stage.classList.add("panning");
      setHover(0);
      freshHover(null);
    }
  }
  if (g.type === "pan") {
    S.view.tx = g.tx0 + (e.clientX - g.x0);
    S.view.ty = g.ty0 + (e.clientY - g.y0);
    g.trail.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    while (g.trail.length > 2 && e.timeStamp - g.trail[0].t > 100) g.trail.shift();
    clampView();
    scheduleView();
  }
});

function endPointer(e: PointerEvent): void {
  pointers.delete(e.pointerId);
  const g = gesture;
  if (!g) return;
  if (g.type === "pinch") {
    if (pointers.size === 1) {
      // Lift one finger: keep moving with the other.
      const [[id, p]] = [...pointers.entries()];
      gesture = { type: "pan", id, x0: p.x, y0: p.y, tx0: S.view.tx, ty0: S.view.ty, trail: [{ t: e.timeStamp, x: p.x, y: p.y }] };
      return;
    }
  } else if (isEdit(g)) {
    editPointerUp(e, g);
    S.suppressClick = true;
  } else if (g.type === "zone") {
    finishZone();
  } else if (g.type === "pan") {
    S.suppressClick = true;
    const a = g.trail[0];
    const b = g.trail[g.trail.length - 1];
    const dt = b.t - a.t;
    if (pointers.size === 0 && dt > 0 && e.timeStamp - b.t < 80) startInertia((b.x - a.x) / dt, (b.y - a.y) / dt);
  }
  if (pointers.size === 0) {
    gesture = null;
    stage.classList.remove("panning");
  }
}

stage.addEventListener("pointerup", endPointer);
stage.addEventListener("pointercancel", endPointer);
stage.addEventListener("contextmenu", (e) => {
  if (S.map) e.preventDefault();
});
stage.addEventListener("pointerenter", () => {
  overStage = true;
});
stage.addEventListener("pointerleave", () => {
  overStage = false;
  freshHover(null);
  if (!gesture) setHover(0);
});

new ResizeObserver(() => fitMap()).observe(stage);
window.addEventListener("resize", fitMap);

$("#map-zoom").addEventListener("click", (e) => {
  const b = closest(e.target, "[data-zoom]");
  if (!b) return;
  const action = b.dataset.zoom;
  const m3 = get3D();
  if (S.viewMode === "3d" && m3) {
    if (action === "in") m3.zoomBy(1.6);
    else if (action === "out") m3.zoomBy(1 / 1.6);
    else if (action === "fit") m3.resetView();
    else if (action === "robot" && !m3.centerOnRobot()) toast("The robot isn't on the map right now");
    return;
  }
  if (action === "in") zoomBy(1.6);
  else if (action === "out") zoomBy(1 / 1.6);
  else if (action === "fit") resetView();
  else if (action === "robot") centerOnRobot();
});

document.addEventListener("keydown", (e) => {
  if (!S.map || S.tab !== "home" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (closest(e.target, "input, select, textarea")) return;
  const step = 120;
  const m3 = get3D();
  const keys: Record<string, () => void> =
    S.viewMode === "3d" && m3
      ? {
          "+": () => m3.zoomBy(1.4), "=": () => m3.zoomBy(1.4), "-": () => m3.zoomBy(1 / 1.4), _: () => m3.zoomBy(1 / 1.4),
          "0": () => m3.resetView(), r: () => m3.centerOnRobot(), R: () => m3.centerOnRobot(),
          ArrowLeft: () => m3.pan(-step, 0), ArrowRight: () => m3.pan(step, 0),
          ArrowUp: () => m3.pan(0, -step), ArrowDown: () => m3.pan(0, step),
        }
      : {
          "+": () => zoomBy(1.4), "=": () => zoomBy(1.4), "-": () => zoomBy(1 / 1.4), _: () => zoomBy(1 / 1.4),
          "0": () => resetView(), r: centerOnRobot, R: centerOnRobot,
          ArrowLeft: () => panBy(step, 0), ArrowRight: () => panBy(-step, 0),
          ArrowUp: () => panBy(0, step), ArrowDown: () => panBy(0, -step),
        };
  if (e.key === " " && overStage) {
    e.preventDefault();
    if (m3 && S.viewMode === "3d") m3.spaceDown = true;
    else if (!spaceDown) {
      spaceDown = true;
      stage.classList.add("space-pan");
    }
    return;
  }
  const fn = keys[e.key];
  if (!fn) return;
  e.preventDefault();
  fn();
});

document.addEventListener("keyup", (e) => {
  if (e.key !== " ") return;
  spaceDown = false;
  stage.classList.remove("space-pan");
  const m3 = get3D();
  if (m3) m3.spaceDown = false;
});
