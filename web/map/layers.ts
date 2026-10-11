// What's drawn over the floor in the 2D and plan views: the cleaning path (and
// where it mopped), carpets, obstacles the robot spotted, no-carpet zones, the
// zone being cleaned and the go-to target. The Layers menu switches them on and off.

import { $, $$, closest, cssVar, esc, icon, pct } from "../dom";
import { S, type Layers } from "../state";
import type { ObstacleKind, Polyline } from "../types";
import { inner, mapImg } from "./elements";
import { planImage, sync3D } from "./views";

const infoSvg = $<SVGSVGElement>("#map-info");
const thingsEl = $("#map-things");
const carpetsImg = $<HTMLImageElement>("#map-carpets");

export const OBSTACLE_ICON: Record<ObstacleKind, string> = {
  cable: "plug",
  pet_waste: "paw",
  shoes: "shoe",
  clothes: "shirt",
  pet: "paw",
  furniture: "box",
  obstacle: "alert",
};

const MOP_WIDTH_M = 0.15; // drawn narrower than the real mop pads so the map stays readable

const points = (line: Polyline) => line.map(([x, y]) => `${x},${y}`).join(" ");

/** Redraw everything over the floor. Call when the map or the layers change. */
export function renderThings(): void {
  const m = S.map;
  if (!m) return;
  infoSvg.setAttribute("viewBox", `0 0 ${m.width} ${m.height}`);
  const mopWidth = (MOP_WIDTH_M / 0.05) * m.scale;
  let svg = "";
  for (const line of m.mop_path ?? []) svg += `<polyline class="mop-path" stroke-width="${mopWidth}" points="${points(line)}"/>`;
  for (const line of m.path ?? []) svg += `<polyline class="path" points="${points(line)}"/>`;
  for (const area of m.no_carpet ?? []) svg += `<polygon class="no-carpet" points="${points(area)}"/>`;
  for (const [x0, y0, x1, y1] of m.zones ?? []) {
    svg += `<rect class="active-zone" x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}"/>`;
  }
  for (const line of m.goto_path ?? []) svg += `<polyline class="goto-route" points="${points(line)}"/>`;
  infoSvg.innerHTML = svg;

  const marker = (cls: string, x: number, y: number, title: string, ic: string) =>
    `<span class="thing ${cls}" style="left:${pct(x, m.width)};top:${pct(y, m.height)}" title="${esc(title)}">${icon(ic)}</span>`;
  thingsEl.innerHTML =
    (m.obstacles ?? []).map((o) => marker(o.kind, o.x, o.y, o.label + (o.photo ? " (photo in the Roborock app)" : ""), OBSTACLE_ICON[o.kind])).join("") +
    (m.goto ? marker("goto", m.goto[0], m.goto[1], "Where the robot is heading", "target") : "");

  carpetsImg.src = carpetImage() || "data:,";
  applyLayers();
}

/** Show or hide layers without redrawing them. */
export function applyLayers(): void {
  const l = S.layers;
  inner.classList.toggle("hide-path", !l.path);
  inner.classList.toggle("hide-carpets", !l.carpets);
  inner.classList.toggle("hide-obstacles", !l.obstacles);
  inner.classList.toggle("hide-restrictions", !l.restrictions);
  $$<HTMLInputElement>("#layers-pop [data-layer]").forEach((input) => {
    input.checked = l[input.dataset.layer as keyof Layers];
  });
}

function setLayer(key: keyof Layers, on: boolean): void {
  S.layers[key] = on;
  try {
    localStorage.setItem("layers", JSON.stringify(S.layers));
  } catch {
    // storage blocked
  }
  applyLayers();
  // The plan bakes its carpet hatching into the drawing; the 3D view has its own layers.
  if (key === "carpets" && S.map && S.viewMode === "plan") mapImg.src = planImage();
  sync3D(true);
}

// Carpets on the colour map: soft diagonal hatching over every carpet pixel,
// drawn from the room mask and kept until the layout changes.
let carpetCache = { key: "", url: "" };

function carpetImage(): string {
  const m = S.map;
  const mask = S.mask;
  if (!m || !mask) return "";
  const key = `${m.mask.length}:${m.mask.slice(-64)}:${m.width}:${cssVar("--carpet-hatch")}`;
  if (carpetCache.key === key) return carpetCache.url;
  const { w, h, data } = mask;
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const sctx = small.getContext("2d")!;
  const img = sctx.createImageData(w, h);
  let any = false;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] && data[i + 2] && data[i + 1] !== 1) {
      img.data.set([0, 0, 0, 255], i);
      any = true;
    }
  }
  if (!any) {
    carpetCache = { key, url: "" };
    return "";
  }
  sctx.putImageData(img, 0, 0);
  const big = document.createElement("canvas");
  big.width = m.width;
  big.height = m.height;
  const ctx = big.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, big.width, big.height);
  ctx.globalCompositeOperation = "source-in";
  ctx.fillStyle = cssVar("--carpet-tint") || "rgba(255,248,235,.3)";
  ctx.fillRect(0, 0, big.width, big.height);
  ctx.globalCompositeOperation = "source-atop";
  ctx.strokeStyle = cssVar("--carpet-hatch") || "rgba(80,52,24,.45)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let d = -big.height; d < big.width; d += 7) {
    ctx.moveTo(d, big.height);
    ctx.lineTo(d + big.height, 0);
  }
  ctx.stroke();
  carpetCache = { key, url: big.toDataURL("image/png") };
  return carpetCache.url;
}

/* ---- the Layers menu ---- */

const pop = $("#layers-pop");

$("#layers-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  pop.hidden = !pop.hidden;
  applyLayers();
});

pop.addEventListener("change", (e) => {
  const input = closest<HTMLInputElement>(e.target, "[data-layer]");
  if (input) setLayer(input.dataset.layer as keyof Layers, input.checked);
});

document.addEventListener("click", (e) => {
  if (!pop.hidden && !closest(e.target, "#layers-pop, #layers-btn")) pop.hidden = true;
});
