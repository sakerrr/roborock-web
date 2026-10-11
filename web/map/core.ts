// The map card: loading new maps, overlays (labels, selection, markers),
// the footer, room lookup and the Rooms / Zone / Go to tools.

import { $, $$, clamp, closest, cssVar, esc, fmtArea, hexRgb, icon, loadImg, pct, toast } from "../dom";
import { doAction, renderActions, renderStatus } from "../panels";
import { pollMap } from "../session";
import { S, type Tool } from "../state";
import type { MapPayload, Mask, Point } from "../types";
import { copyRestrictions, editRoomClick, endEdit, renderEditFoot, renderShapes, syncInnerClasses } from "./editor";
import { drawSvg, inner, mapImg, selCanvas, shapesSvg, stage } from "./elements";
import { applyView, clampView, isEditGesture, resetView } from "./panzoom";
import { get3D, planImage, sync3D } from "./views";

export function mapEmpty(html: string): void {
  const empty = $("#map-empty");
  empty.innerHTML = html;
  empty.hidden = false;
  inner.hidden = true;
}

async function decodeMask(src: string): Promise<Mask> {
  const img = await loadImg(src);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas isn't available");
  ctx.drawImage(img, 0, 0);
  return { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
}

export async function setMap(m: MapPayload): Promise<void> {
  const [, mask] = await Promise.all([loadImg(m.base), decodeMask(m.mask)]);
  S.map = m;
  S.mask = mask;
  mapImg.src = S.viewMode === "plan" ? planImage() : m.base;
  selCanvas.width = mask.w;
  selCanvas.height = mask.h;
  drawSvg.setAttribute("viewBox", `0 0 ${m.width} ${m.height}`);
  shapesSvg.setAttribute("viewBox", `0 0 ${m.width} ${m.height}`);
  const ids = new Set(m.rooms.map((r) => r.id));
  S.selected = S.selected.filter((id) => ids.has(id));
  const ed = S.edit;
  if (ed) {
    ed.rooms = ed.rooms.filter((id) => ids.has(id));
    // Pick up the robot's walls and zones unless the user has unsaved changes or is mid-drag.
    if (ed.mode === "walls" && !ed.dirty && !isEditGesture()) {
      ed.items = copyRestrictions();
      if (!ed.items.some((i) => i.id === ed.sel)) ed.sel = null;
    }
  }
  $("#map-empty").hidden = true;
  inner.hidden = false;
  fitMap();
  renderMapSelect();
  refreshMapOverlays();
  renderMarkers();
  sync3D(true);
  if (S.status) renderStatus();
}

export function fitMap(): void {
  const m = S.map;
  if (!m || inner.hidden) return;
  const cs = getComputedStyle(stage);
  const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (availW <= 0) return;
  const desktop = window.matchMedia("(min-width: 1024px)").matches;
  // Desktop: fill the map card. Smaller screens: keep room for the controls below.
  const maxH = desktop
    ? stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    : clamp(window.innerHeight * 0.48, 220, 560);
  const k = Math.min(availW / m.width, maxH / m.height, 3);
  inner.style.width = `${Math.round(m.width * k)}px`;
  inner.style.height = `${Math.round(m.height * k)}px`;
  clampView();
  applyView();
}

function renderMapSelect(): void {
  const sel = $<HTMLSelectElement>("#map-select");
  const maps = S.map?.maps ?? [];
  if (maps.length < 2) {
    sel.hidden = true;
    return;
  }
  sel.innerHTML = maps.map((m) => `<option value="${m.flag}">${esc(m.name)}</option>`).join("");
  sel.value = String(S.map?.current_map ?? "");
  sel.hidden = false;
}

export function refreshMapOverlays(): void {
  renderShapes();
  renderLabels();
  drawSelection();
  renderDraw();
  renderMapFoot();
  sync3D();
  if (S.status) renderActions();
}

function renderLabels(): void {
  const m = S.map;
  if (!m) return;
  $("#map-labels").innerHTML = m.rooms
    .map((r) => {
      const sel = S.edit ? S.edit.mode === "rooms" && S.edit.rooms.includes(r.id) : S.tool === "rooms" && S.selected.includes(r.id);
      const area = S.viewMode === "plan" && r.area ? `<span class="area">${fmtArea(r.area)}</span>` : "";
      return `<button class="room-label ${sel ? "sel" : ""}" data-room="${r.id}" style="left:${pct(r.x, m.width)};top:${pct(r.y, m.height)}">${icon("check", "i tick")}<span class="nm">${esc(r.name)}</span>${area}</button>`;
    })
    .join("");
}

function renderMarkers(): void {
  const m = S.map;
  if (!m) return;
  const dock = $("#dock-marker");
  dock.hidden = !m.charger;
  if (m.charger) Object.assign(dock.style, { left: pct(m.charger.x, m.width), top: pct(m.charger.y, m.height) });
  const rm = $("#robot-marker");
  rm.hidden = !m.robot;
  const body = rm.firstElementChild as HTMLElement | null;
  if (m.robot && body) {
    Object.assign(rm.style, { left: pct(m.robot.x, m.width), top: pct(m.robot.y, m.height) });
    body.style.transform = `rotate(${90 - (m.robot.a || 0)}deg)`;
    body.classList.toggle("busy", S.status?.phase === "cleaning");
  }
}

/** Paint room highlights into the overlay canvas (also the 3D floor overlay). */
export function drawSelection(): void {
  const mask = S.mask;
  if (!mask) return;
  const { w, h, data } = mask;
  const ctx = selCanvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(w, h);
  const out = img.data;
  const editRooms = !!S.edit && S.edit.mode === "rooms";
  const rooms = editRooms || (!S.edit && S.tool === "rooms");
  const sel = new Set(editRooms && S.edit ? S.edit.rooms : rooms ? S.selected : []);
  const any = sel.size > 0;
  const hov = rooms ? S.hover : 0;
  // While a room clean runs, keep its rooms softly marked (like the Roborock app).
  const job = !S.edit && !any && S.jobRooms && S.status?.job ? new Set(S.jobRooms) : null;
  const [ar, ag, ab] = hexRgb(cssVar("--accent") || "#4c7df0");
  const dim = (cssVar("--mask-dim") || "255,255,255").split(",").map(Number);
  const dimA = Number(cssVar("--mask-dim-a")) || 135;
  for (let i = 0; i < data.length; i += 4) {
    const id = data[i];
    if (!data[i + 3] || !id) continue;
    if (sel.has(id)) out.set([ar, ag, ab, 92], i);
    else if (id === hov) out.set([ar, ag, ab, 36], i);
    else if (job?.has(id)) out.set([ar, ag, ab, 46], i);
    else if (any) out.set([dim[0], dim[1], dim[2], dimA], i);
  }
  ctx.putImageData(img, 0, 0);
  const m3 = get3D();
  if (m3 && S.viewMode === "3d") m3.setSelectionCanvas(selCanvas);
}

/** The cleaning zone being drawn and the go-to pin. */
export function renderDraw(): void {
  const m = S.map;
  if (!m) return;
  // Screen pixels per map pixel, so the pin and corners keep their size when zoomed.
  const k = (inner.offsetWidth / m.width) * S.view.s || 1;
  let svg = "";
  if (!S.edit && S.tool === "zone" && S.zone) {
    const [x0, y0, x1, y1] = S.zone;
    svg += `<rect class="zone-rect" x="${Math.min(x0, x1)}" y="${Math.min(y0, y1)}" width="${Math.abs(x1 - x0)}" height="${Math.abs(y1 - y0)}" rx="${6 / k}"/>`;
  }
  if (!S.edit && S.tool === "goto" && S.pin) {
    svg += `<circle class="goto-ring" cx="${S.pin.x}" cy="${S.pin.y}" r="${14 / k}"/><circle class="goto-pin" cx="${S.pin.x}" cy="${S.pin.y}" r="${7 / k}"/>`;
  }
  drawSvg.innerHTML = svg;
}

export function renderMapFoot(): void {
  const foot = $("#map-foot");
  const m = S.map;
  if (!m) {
    foot.innerHTML = "";
    return;
  }
  if (S.edit) {
    renderEditFoot();
    return;
  }
  const names = new Map(m.rooms.map((r) => [r.id, r.name]));
  const plan = S.viewMode === "plan";
  const areaOf = (ids: number[]) => fmtArea(m.rooms.filter((r) => ids.includes(r.id)).reduce((sum, r) => sum + (r.area || 0), 0));
  let html: string;
  if (S.tool === "rooms") {
    html = S.selected.length
      ? `<span class="hint"><b style="color:var(--text)">${S.selected.map((id) => esc(names.get(id))).join(", ")}</b>${plan ? ` · ${areaOf(S.selected)}` : ""}</span><button class="link" data-act="clear-sel">Clear</button>`
      : S.viewMode === "3d"
        ? `<span class="hint">Drag to turn, swipe with two fingers to move, pinch to zoom. Click rooms to clean just those.</span>`
        : plan
          ? `<span class="hint">Floor area ${areaOf(m.rooms.map((r) => r.id))} across ${m.rooms.length} rooms. Click rooms to clean just those.</span>`
          : `<span class="hint">Tap rooms to clean just those, or clean everywhere.</span>`;
  } else if (S.tool === "zone") {
    if (S.zone) {
      const size = (v: number) => ((Math.abs(v) / m.scale) * 0.05).toFixed(1);
      html = `<span class="hint">Zone · ${size(S.zone[2] - S.zone[0])} × ${size(S.zone[3] - S.zone[1])} m</span><button class="link" data-act="clear-sel">Clear</button>`;
    } else html = `<span class="hint">Drag on the map to draw a zone.</span>`;
  } else {
    html = S.pin
      ? `<span class="hint">The robot will drive to the pin.</span><button class="link" data-act="clear-sel">Clear</button>`
      : `<span class="hint">Tap a spot to send the robot there.</span>`;
  }
  foot.innerHTML = html;
}

/** Pointer position in base-image pixels, kept inside the map. */
export function toBase(ev: { clientX: number; clientY: number }): Point {
  const m = S.map;
  if (!m) return { x: 0, y: 0 };
  const r = inner.getBoundingClientRect();
  return {
    x: clamp(((ev.clientX - r.left) / r.width) * m.width, 0, m.width),
    y: clamp(((ev.clientY - r.top) / r.height) * m.height, 0, m.height),
  };
}

// Room under a base-image point. Furniture and walls belong to no room, so a
// click on the sofa falls back to the nearest room within about 20 cm.
export function roomAt(p: Point): number {
  const mask = S.mask;
  const m = S.map;
  if (!mask || !m) return 0;
  const { w, h, data } = mask;
  const x = Math.floor(p.x / m.scale);
  const y = Math.floor(p.y / m.scale);
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  const i = (y * w + x) * 4;
  if (!data[i + 3]) return 0;
  if (data[i]) return data[i];
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = (ny * w + nx) * 4;
        if (data[j + 3] && data[j]) return data[j];
      }
    }
  }
  return 0;
}

export function toggleRoom(id: number): void {
  const i = S.selected.indexOf(id);
  if (i >= 0) S.selected.splice(i, 1);
  else S.selected.push(id);
  refreshMapOverlays();
}

export function setTool(tool: Tool): void {
  if (S.viewMode === "3d" && tool !== "rooms") {
    toast("Switch to 2D to draw zones or send the robot to a spot");
    return;
  }
  S.tool = tool;
  S.hover = 0;
  $$("#map-tools button").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  syncInnerClasses();
  applyView();
  refreshMapOverlays();
}

inner.addEventListener("click", (e) => {
  if (!S.map) return;
  if (S.suppressClick) {
    S.suppressClick = false;
    return;
  }
  const p = toBase(e);
  if (S.edit) {
    editRoomClick(e, p);
    return;
  }
  if (S.tool === "rooms") {
    const label = closest(e.target, "[data-room]");
    const id = label ? Number(label.dataset.room) : roomAt(p);
    if (id) toggleRoom(id);
  } else if (S.tool === "goto") {
    if (!roomAt(p)) {
      toast("Pick a spot inside your home");
      return;
    }
    S.pin = p;
    refreshMapOverlays();
  }
});

$("#map-tools").addEventListener("click", (e) => {
  const b = closest(e.target, "[data-tool]");
  if (b) setTool(b.dataset.tool as Tool);
});

$<HTMLSelectElement>("#map-select").addEventListener("change", async (e) => {
  try {
    await doAction("select_map", { flag: Number((e.target as HTMLSelectElement).value) }, { okMsg: "Switching map…" });
    endEdit(true);
    S.map = null;
    resetView(false);
    mapEmpty(`<div class="spinner"></div>Loading map…`);
    setTimeout(() => pollMap(true), 1500);
  } catch {
    // toast shown
  }
});
