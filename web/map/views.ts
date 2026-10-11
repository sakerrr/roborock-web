// Map views: the colour map (2D), the floor plan, and the 3D view.

import type { Map3D, Marker3D } from "../map3d";
import { $, $$, cssVar, hexRgb, toast } from "../dom";
import { S, type ViewMode } from "../state";
import { drawSelection, refreshMapOverlays, roomAt, setTool, toggleRoom } from "./core";
import { itemPx } from "./editor";
import { freshImage, loadFreshness, renderFreshPanel } from "../freshness";
import { inner, mapImg, selCanvas, stage } from "./elements";
import { buttonsReach, homeBox, stagePadding } from "./fit";
import { groupObstacles, OBSTACLE_ICON } from "./layers";
import { applyView } from "./panzoom";

export function setViewMode(mode: ViewMode): void {
  if (mode === S.viewMode) return;
  if (mode === "3d" && S.tool !== "rooms") setTool("rooms"); // zones and go-to need the flat map
  S.viewMode = mode;
  try {
    localStorage.setItem("view", mode);
  } catch {
    // storage blocked
  }
  syncViewChrome();
  if (S.map) mapImg.src = viewImage();
  refreshMapOverlays();
  if (mode === "3d") void show3D();
  if (mode === "fresh") void loadFreshness();
}

/** The base image for the current flat view. */
export function viewImage(): string {
  if (!S.map) return "";
  return S.viewMode === "plan" ? planImage() : S.viewMode === "fresh" ? freshImage() : S.map.base;
}

export function syncViewChrome(): void {
  const is3d = S.viewMode === "3d";
  $$("#view-modes button").forEach((b) => b.classList.toggle("active", b.dataset.view === S.viewMode));
  inner.classList.toggle("plan", S.viewMode === "plan");
  inner.classList.toggle("fresh", S.viewMode === "fresh");
  renderFreshPanel();
  stage.classList.toggle("is-3d", is3d);
  $("#map3d").hidden = !is3d;
  map3d?.setActive(is3d);
  if (S.map) applyView();
  for (const b of $$<HTMLButtonElement>('#map-tools [data-tool="zone"], #map-tools [data-tool="goto"]')) {
    b.disabled = is3d;
    b.title = is3d ? "Switch to 2D to use this" : b.dataset.tool === "zone" ? "Draw a zone" : "Send robot to a spot";
  }
}

/* ---- 3D view (three.js, loaded the first time you open it) ---- */

let map3d: Map3D | null = null;
let map3dLoading: Promise<void> | null = null;

export const get3D = (): Map3D | null => map3d;

/** Fetch the 3D code while the browser is idle, so switching to 3D doesn't wait for it. */
export function preload3D(): void {
  const load = () => void import("../map3d").catch(() => {});
  if ("requestIdleCallback" in window) window.requestIdleCallback(load, { timeout: 10_000 });
  else setTimeout(load, 3000);
}

export async function show3D(): Promise<void> {
  try {
    map3dLoading ??= import("../map3d").then(({ createMap3D }) => {
      map3d = createMap3D($("#map3d"), {
        roomAt: (p) => roomAt(p),
        onRoomClick: (id) => toggleRoom(id),
        onHover: (id) => {
          S.hover = id;
          drawSelection();
        },
        insets: () => ({ ...stagePadding(), buttons: buttonsReach() }),
      });
    });
    await map3dLoading;
  } catch {
    map3dLoading = null;
    toast("3D isn't available in this browser", true);
    setViewMode("2d");
    return;
  }
  if (S.viewMode !== "3d" || !map3d) return;
  map3d.setActive(true);
  sync3D(true);
}

// Keep the 3D scene in step with the app: the map itself when it changes,
// and the labels, selection and walls/zones whenever the overlays redraw.
export function sync3D(mapChanged = false): void {
  const m = S.map;
  if (!map3d || S.viewMode !== "3d" || !m || !S.mask) return;
  if (mapChanged) map3d.setMap(m, S.mask, m.mask, homeBox());
  map3d.setLabels(m.rooms.map((r) => ({ id: r.id, name: r.name, x: r.x, y: r.y, sel: S.selected.includes(r.id) })));
  map3d.setRestrictions(m.frame ? m.restrictions.map((r) => ({ type: r.type, pts: itemPx(r) })) : []);
  const markers: Marker3D[] = groupObstacles(m.obstacles ?? [], m.scale).map((g) => ({
    x: g.x, y: g.y, cls: g.kind, title: g.title, icon: OBSTACLE_ICON[g.kind], count: g.count,
  }));
  if (m.goto) markers.push({ x: m.goto[0], y: m.goto[1], cls: "goto", title: "Where the robot is heading", icon: "target" });
  map3d.setThings(m, markers);
  map3d.setLayers(S.layers);
  map3d.setSelectionCanvas(selCanvas);
}

/* ---- floor plan ---- */

type RGBA = [number, number, number, number];

// The floor plan is drawn here from the room mask: walls, floors, carpet hatching
// and a 1 m grid, in the theme's colours. It only changes when the layout does.
let planCache = { key: "", url: "" };

export function planImage(): string {
  const m = S.map;
  const mask = S.mask;
  if (!m || !mask) return "";
  const key = `${m.mask.length}:${m.mask.slice(-64)}:${m.width}:${cssVar("--plan-paper")}:${S.layers.carpets}`;
  if (planCache.key === key) return planCache.url;

  const { w, h, data } = mask;
  const colour = (name: string, fallback: string): RGBA => [...hexRgb(cssVar(name) || fallback), 255];
  const paper = colour("--plan-paper", "#fffefb");
  const carpet = colour("--plan-carpet", "#f3efe6");
  const wall = colour("--plan-wall", "#2b3340");
  const furniture = colour("--plan-furniture", "#dfe3e9");
  const edge = parseRgba(cssVar("--plan-edge") || "rgba(43,51,64,.22)");

  // 1. one pixel per 5 cm block, plus a separate layer marking carpets
  const small = canvas(w, h);
  const sctx = small.getContext("2d")!;
  const img = sctx.createImageData(w, h);
  const out = img.data;
  const rugs = canvas(w, h);
  const rctx = rugs.getContext("2d")!;
  const rugImg = rctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!data[i + 3]) continue;
      const room = data[i];
      const kind = data[i + 1];
      const isCarpet = data[i + 2];
      let c = kind === 1 ? wall : kind === 2 ? furniture : isCarpet && S.layers.carpets ? carpet : paper;
      // A soft line where two rooms meet without a wall in between.
      if (room) {
        const right = x + 1 < w ? data[i + 4] : room;
        const down = y + 1 < h ? data[i + w * 4] : room;
        if ((right && right !== room) || (down && down !== room)) c = blend(c, edge);
      }
      out.set(c, i);
      if (isCarpet && kind !== 1 && S.layers.carpets) rugImg.data.set([0, 0, 0, 255], i);
    }
  }
  sctx.putImageData(img, 0, 0);
  rctx.putImageData(rugImg, 0, 0);

  // 2. scale up with crisp edges
  const big = canvas(m.width, m.height);
  const ctx = big.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, big.width, big.height);

  // 3. diagonal hatching on carpets
  const hatch = canvas(big.width, big.height);
  const hctx = hatch.getContext("2d")!;
  hctx.imageSmoothingEnabled = false;
  hctx.drawImage(rugs, 0, 0, big.width, big.height);
  hctx.globalCompositeOperation = "source-in";
  hctx.strokeStyle = cssVar("--plan-hatch") || "rgba(120,100,70,.2)";
  hctx.lineWidth = 1.5;
  hctx.beginPath();
  for (let d = -big.height; d < big.width; d += 9) {
    hctx.moveTo(d, big.height);
    hctx.lineTo(d + big.height, 0);
  }
  hctx.stroke();
  ctx.drawImage(hatch, 0, 0);

  // 4. a 1 m grid, aligned to the robot's coordinates, only on mapped floor
  const f = m.frame;
  if (f) {
    const step = (1000 / f.mm) * f.scale; // px per metre
    const blocksPerM = 1000 / f.mm;
    const x0 = (Math.ceil(f.left / blocksPerM) * blocksPerM - f.left) * f.scale;
    const y0 = ((f.top + f.height) % blocksPerM) * f.scale;
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.strokeStyle = cssVar("--plan-grid") || "rgba(43,51,64,.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x < big.width; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, big.height);
    }
    for (let y = y0; y < big.height; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(big.width, Math.round(y) + 0.5);
    }
    ctx.stroke();
    ctx.restore();
  }

  planCache = { key, url: big.toDataURL("image/png") };
  return planCache.url;
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function parseRgba(v: string): RGBA {
  const n = (v.match(/\d+(\.\d+)?/g) ?? ["0", "0", "0", "1"]).map(Number);
  return [n[0], n[1], n[2], Math.round((n[3] ?? 1) * 255)];
}

function blend(base: RGBA, over: RGBA): RGBA {
  const a = over[3] / 255;
  const mix = (k: 0 | 1 | 2) => Math.round(base[k] * (1 - a) + over[k] * a);
  return [mix(0), mix(1), mix(2), 255];
}

// Follow the system theme in every view.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (S.map && (S.viewMode === "plan" || S.viewMode === "fresh")) mapImg.src = viewImage();
  if (S.mask) drawSelection();
  map3d?.applyTheme();
});
