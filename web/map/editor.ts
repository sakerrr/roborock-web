/* Map editing.
   Walls & zones are staged here and saved together, because the robot's
   save_map replaces the whole set. Edits are kept in robot millimetres so they
   stay put even if the map image changes size while you edit. Room merges and
   splits go to the robot one at a time; renames only live in this app. */

import { $, $$, $opt, closest, esc, icon, pct, toast } from "../dom";
import { doAction } from "../panels";
import { pollMap } from "../session";
import { S, type EditItem, type EditTool, type Pt } from "../state";
import type { Point, RestrictionType } from "../types";
import { refreshMapOverlays, renderMapFoot, roomAt, toBase } from "./core";
import { inner, shapesSvg } from "./elements";
import { applyView } from "./panzoom";
import { setViewMode } from "./views";

const EDIT_LIMIT = 68; // corner points the robot can store
const RESTRICTION_LABEL: Record<RestrictionType, string> = { wall: "Invisible wall", no_go: "No-go zone", no_mop: "No-mop zone" };
const EDIT_TOOLS: Record<"walls" | "rooms", [EditTool, string, string][]> = {
  walls: [["select", "pointer", "Select"], ["wall", "wall", "Invisible wall"], ["no_go", "ban", "No-go zone"], ["no_mop", "drop-off", "No-mop zone"]],
  rooms: [["merge", "merge", "Merge rooms"], ["split", "scissors", "Split a room"], ["rename", "type", "Rename"]],
};

export type EditGesture =
  | { type: "edit-draft" }
  | { type: "edit-line"; a: Pt; x0: number; y0: number }
  | { type: "edit-handle"; index: number; before: string; x0: number; y0: number; moved: boolean }
  | { type: "edit-move"; start: Point; orig: Pt[]; before: string; x0: number; y0: number; moved: boolean };

/* ---- coordinates ---- */

function mmToPx(x: number, y: number): Pt {
  const f = S.map?.frame;
  if (!f) return [0, 0];
  return [(x / f.mm - f.left) * f.scale, (f.height - (y / f.mm - f.top) - 1) * f.scale];
}

export function pxToMm(x: number, y: number): Pt {
  const f = S.map?.frame;
  if (!f) return [0, 0];
  return [Math.round((x / f.scale + f.left) * f.mm), Math.round((f.top + f.height - 1 - y / f.scale) * f.mm)];
}

/** A wall or zone's corners in base-image pixels. */
export function itemPx(it: { mm: number[] }): Pt[] {
  const pts: Pt[] = [];
  for (let i = 0; i < it.mm.length; i += 2) pts.push(mmToPx(it.mm[i], it.mm[i + 1]));
  return pts;
}

const setItemPx = (it: EditItem, pts: Pt[]) => {
  it.mm = pts.flatMap(([x, y]) => pxToMm(x, y));
};
const pointsUsed = (items: EditItem[]) => items.reduce((n, it) => n + (it.type === "wall" ? 2 : 4), 0);
const roomName = (id: number) => S.map?.rooms.find((r) => r.id === id)?.name || `Room ${id}`;
const selectedItem = (): EditItem | undefined => (S.edit ? S.edit.items.find((i) => i.id === S.edit?.sel) : undefined);

export const copyRestrictions = (): EditItem[] => (S.map?.restrictions ?? []).map((r) => ({ id: r.id, type: r.type, mm: [...r.mm] }));

function rectPx(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const l = Math.min(x0, x1);
  const r = Math.max(x0, x1);
  const t = Math.min(y0, y1);
  const b = Math.max(y0, y1);
  return [[l, t], [r, t], [r, b], [l, b]];
}

function isAxisRect(pts: Pt[]): boolean {
  if (pts.length !== 4) return false;
  const near = (a: number, b: number) => Math.abs(a - b) < 0.75;
  const [a, b, c, d] = pts;
  return (
    (near(a[1], b[1]) && near(b[0], c[0]) && near(c[1], d[1]) && near(d[0], a[0])) ||
    (near(a[0], b[0]) && near(b[1], c[1]) && near(c[0], d[0]) && near(d[1], a[1]))
  );
}

const canResize = (it: EditItem) => it.type === "wall" || isAxisRect(itemPx(it));

/* ---- entering and leaving ---- */

export function syncInnerClasses(): void {
  const e = S.edit;
  inner.classList.toggle("rooms", e ? e.mode === "rooms" && e.tool !== "split" : S.tool === "rooms");
  inner.classList.toggle("draw", !e && S.tool === "zone");
  inner.classList.toggle("goto", !e && S.tool === "goto");
  inner.classList.toggle("editing", !!e && e.mode === "walls");
  inner.classList.toggle("drawing", !!e && (e.mode === "walls" ? e.tool !== "select" : e.tool === "split"));
}

export function startEdit(): void {
  if (!S.map) {
    toast("The map is still loading. Try again in a moment.");
    return;
  }
  if (S.viewMode === "3d") setViewMode("2d");
  if (!S.map.frame) {
    toast("Restart the app to turn on map editing", true);
    return;
  }
  const ph = S.status?.phase;
  if (ph === "cleaning" || ph === "returning") {
    toast("Pause or dock the robot to edit the map");
    return;
  }
  S.edit = { mode: "walls", tool: "select", items: copyRestrictions(), sel: null, dirty: false, history: [], rooms: [], line: null, draft: null, drag: false };
  S.selected = [];
  S.zone = null;
  S.pin = null;
  S.hover = 0;
  renderEditChrome();
  applyView();
  refreshMapOverlays();
}

export function endEdit(force = false): void {
  if (!S.edit) return;
  if (!force && S.edit.dirty && !confirm("Discard your unsaved wall and zone changes?")) return;
  S.edit = null;
  S.hover = 0;
  renderEditChrome();
  applyView();
  refreshMapOverlays();
}

export function setEditMode(mode: "walls" | "rooms"): void {
  const ed = S.edit;
  if (!ed || mode === ed.mode) return;
  if (mode === "rooms" && ed.dirty) {
    toast("Save or discard your wall and zone changes first");
    return;
  }
  if (mode === "walls") ed.items = copyRestrictions();
  Object.assign(ed, { mode, tool: mode === "walls" ? "select" : "merge", sel: null, rooms: [], line: null, draft: null, history: [] });
  renderEditChrome();
  applyView();
  refreshMapOverlays();
}

export function setEditTool(tool: EditTool): void {
  const ed = S.edit;
  if (!ed) return;
  Object.assign(ed, { tool, draft: null, line: null });
  if (ed.mode === "rooms") ed.rooms = [];
  if (tool !== "select") ed.sel = null;
  renderEditChrome();
  applyView();
  refreshMapOverlays();
}

function renderEditChrome(): void {
  const e = S.edit;
  $("#head-normal").hidden = !!e;
  $("#head-edit").hidden = !e;
  $("#view-modes").hidden = !!e;
  $("#map-title").textContent = e ? "Edit map" : "Map";
  $("#map-card").classList.toggle("is-editing", !!e);
  const tools = $("#edit-tools");
  tools.hidden = !e;
  if (e) {
    $$("#edit-modes button").forEach((b) => b.classList.toggle("active", b.dataset.emode === e.mode));
    tools.innerHTML = EDIT_TOOLS[e.mode]
      .map(([t, ic, label]) => `<button data-etool="${t}" class="${e.tool === t ? "active" : ""}" title="${label}">${icon(ic)}<span>${label}</span></button>`)
      .join("");
  }
  syncInnerClasses();
}

/* ---- drawing walls and zones ---- */

export function renderShapes(): void {
  const m = S.map;
  if (!m?.frame) {
    shapesSvg.innerHTML = "";
    return;
  }
  const k = (inner.offsetWidth / m.width) * S.view.s || 1;
  const e = S.edit;
  const editing = !!e && e.mode === "walls";
  let svg = "";
  for (const it of e ? e.items : m.restrictions) {
    const pts = itemPx(it);
    const cls = `shape ${it.type}${editing && e?.sel === it.id ? " sel" : ""}`;
    if (it.type === "wall") {
      const [[x0, y0], [x1, y1]] = pts;
      const xy = `x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"`;
      svg += `<g class="${cls}" data-rid="${esc(it.id)}"><line class="hit" ${xy}/><line class="stroke" ${xy}/></g>`;
    } else {
      svg += `<g class="${cls}" data-rid="${esc(it.id)}"><polygon points="${pts.map((p) => p.join(",")).join(" ")}"/></g>`;
    }
  }
  const sel = editing ? selectedItem() : undefined;
  if (sel && canResize(sel)) {
    itemPx(sel).forEach(([x, y], i) => {
      svg += `<circle class="handle" data-handle="${i}" cx="${x}" cy="${y}" r="${7 / k}"/>`;
    });
  }
  if (e?.draft) {
    const { type, a, b } = e.draft;
    svg +=
      type === "wall"
        ? `<g class="shape wall draft"><line class="stroke" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/></g>`
        : `<g class="shape ${type} draft"><polygon points="${rectPx(a[0], a[1], b[0], b[1]).map((p) => p.join(",")).join(" ")}"/></g>`;
  }
  if (e?.line) {
    const [[x0, y0], [x1, y1]] = e.line;
    svg += `<line class="split-line" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`;
  }
  shapesSvg.innerHTML = svg;

  const del = $("#shape-delete");
  del.hidden = !sel || !!e?.drag;
  if (sel) {
    const pts = itemPx(sel);
    Object.assign(del.style, {
      left: pct(Math.max(...pts.map((p) => p[0])), m.width),
      top: pct(Math.min(...pts.map((p) => p[1])), m.height),
    });
  }
}

export function refreshEdit(): void {
  renderShapes();
  renderMapFoot();
}

const snapshot = () => JSON.stringify(S.edit?.items ?? []);

function pushHistory(snap: string): void {
  if (!S.edit) return;
  S.edit.history.push(snap);
  if (S.edit.history.length > 50) S.edit.history.shift();
}

export function undoEdit(): void {
  const ed = S.edit;
  const prev = ed?.history.pop();
  if (!ed || prev === undefined) return;
  ed.items = JSON.parse(prev) as EditItem[];
  ed.sel = null;
  ed.dirty = ed.history.length > 0;
  refreshEdit();
}

export function deleteSelected(): void {
  const ed = S.edit;
  if (!ed?.sel) return;
  pushHistory(snapshot());
  ed.items = ed.items.filter((i) => i.id !== ed.sel);
  ed.sel = null;
  ed.dirty = true;
  refreshEdit();
}

export function discardEdits(): void {
  if (!S.edit || !confirm("Discard your unsaved wall and zone changes?")) return;
  Object.assign(S.edit, { items: copyRestrictions(), sel: null, dirty: false, history: [] });
  refreshEdit();
}

export function clearEditPicks(): void {
  if (!S.edit) return;
  Object.assign(S.edit, { rooms: [], line: null });
  refreshMapOverlays();
}

/* ---- gestures (called from the map's pointer handling) ---- */

/** Start an edit gesture, or return null to let the map pan. */
export function editPointerDown(e: PointerEvent): EditGesture | null {
  const ed = S.edit;
  if (!ed) return null;
  const p = toBase(e);
  if (ed.mode === "rooms") {
    return ed.tool === "split" ? { type: "edit-line", a: [p.x, p.y], x0: e.clientX, y0: e.clientY } : null;
  }
  if (ed.tool !== "select") {
    const type = ed.tool as RestrictionType;
    if (pointsUsed(ed.items) + (type === "wall" ? 2 : 4) > EDIT_LIMIT) {
      toast("The robot can't store more walls or zones. Delete one first.");
      return null;
    }
    ed.draft = { type, a: [p.x, p.y], b: [p.x, p.y] };
    return { type: "edit-draft" };
  }
  const handle = closest(e.target, "[data-handle]");
  if (handle && ed.sel) {
    return { type: "edit-handle", index: Number(handle.dataset.handle), before: snapshot(), x0: e.clientX, y0: e.clientY, moved: false };
  }
  const shape = closest<SVGElement>(e.target, "[data-rid]");
  if (shape) {
    ed.sel = shape.dataset.rid ?? null;
    refreshEdit();
    const it = selectedItem();
    if (!it) return null;
    return { type: "edit-move", start: p, orig: itemPx(it), before: snapshot(), x0: e.clientX, y0: e.clientY, moved: false };
  }
  if (ed.sel) {
    ed.sel = null;
    refreshEdit();
  }
  return null;
}

export function editPointerMove(e: PointerEvent, g: EditGesture): void {
  const ed = S.edit;
  if (!ed) return;
  const p = toBase(e);
  if (g.type === "edit-draft") {
    if (ed.draft) ed.draft.b = [p.x, p.y];
    renderShapes();
    return;
  }
  if (g.type === "edit-line") {
    ed.line = [g.a, [p.x, p.y]];
    renderShapes();
    return;
  }
  if (!g.moved && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 3) return;
  g.moved = true;
  ed.drag = true;
  const it = selectedItem();
  if (!it) return;
  if (g.type === "edit-move") {
    const dx = p.x - g.start.x;
    const dy = p.y - g.start.y;
    setItemPx(it, g.orig.map(([x, y]): Pt => [x + dx, y + dy]));
  } else if (it.type === "wall") {
    const pts = itemPx(it);
    pts[g.index] = [p.x, p.y];
    setItemPx(it, pts);
  } else {
    // Resize the rectangle from the corner opposite the one being dragged.
    const pts = itemPx(it);
    const [ox, oy] = pts[(g.index + 2) % 4];
    const r = rectPx(ox, oy, p.x, p.y);
    setItemPx(it, r);
    g.index = r.reduce((best, q, i) => (Math.hypot(q[0] - p.x, q[1] - p.y) < Math.hypot(r[best][0] - p.x, r[best][1] - p.y) ? i : best), 0);
  }
  renderShapes();
}

export function editPointerUp(e: PointerEvent, g: EditGesture): void {
  const ed = S.edit;
  const m = S.map;
  if (!ed || !m) return;
  ed.drag = false;
  if (g.type === "edit-draft") {
    const draft = ed.draft;
    ed.draft = null;
    if (!draft) return;
    const { type, a, b } = draft;
    const min = (0.3 / 0.05) * m.scale; // 30cm
    const ok = type === "wall" ? Math.hypot(b[0] - a[0], b[1] - a[1]) >= min : Math.abs(b[0] - a[0]) >= min && Math.abs(b[1] - a[1]) >= min;
    if (!ok) {
      toast(type === "wall" ? "Drag a little further to draw a wall" : "Drag a little further to draw a zone");
      refreshEdit();
      return;
    }
    pushHistory(snapshot());
    const it: EditItem = { id: `new-${Date.now()}`, type, mm: [] };
    setItemPx(it, type === "wall" ? [a, b] : rectPx(a[0], a[1], b[0], b[1]));
    ed.items.push(it);
    Object.assign(ed, { sel: it.id, tool: "select", dirty: true });
    renderEditChrome();
    refreshEdit();
    return;
  }
  if (g.type === "edit-line") {
    const p = toBase(e);
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 6) {
      // A tap picks the room to split.
      ed.line = null;
      const id = roomAt(p);
      ed.rooms = id ? [id] : [];
    } else {
      ed.line = [g.a, [p.x, p.y]];
      if (!ed.rooms.length) {
        const id = roomAt({ x: (g.a[0] + p.x) / 2, y: (g.a[1] + p.y) / 2 });
        if (id) ed.rooms = [id];
      }
    }
    refreshMapOverlays();
    return;
  }
  if (g.moved) {
    pushHistory(g.before);
    ed.dirty = true;
  }
  refreshEdit();
}

/* ---- footer ---- */

export function renderEditFoot(): void {
  const ed = S.edit;
  const m = S.map;
  if (!ed || !m) return;
  const foot = $("#map-foot");
  if (ed.mode === "walls") {
    const it = selectedItem();
    const hint =
      ed.tool === "wall" ? "Drag across the map to draw an invisible wall. The robot won't cross it."
      : ed.tool === "no_go" ? "Drag to draw a no-go zone. The robot stays out of it."
      : ed.tool === "no_mop" ? "Drag to draw a no-mop zone. The robot vacuums there but won't mop."
      : it ? `${RESTRICTION_LABEL[it.type]} selected. Drag to move it${canResize(it) ? ", drag the dots to resize" : ""}, or delete it.`
      : "Click a wall or zone to change it, or pick a tool to add one.";
    const warn = m.no_carpet_zones
      ? `<div class="edit-warn">${icon("alert")}This map also has no-carpet zones from the Roborock app. Saving here may remove them.</div>`
      : "";
    foot.innerHTML = `${warn}<span class="hint">${hint}</span>
      <div class="foot-actions">
        <span class="budget" title="The robot stores at most ${EDIT_LIMIT} corner points: a wall uses 2, a zone uses 4">${pointsUsed(ed.items)}/${EDIT_LIMIT} points</span>
        ${ed.history.length ? `<button class="btn-soft" data-act="edit-undo" title="Undo (⌘Z)">${icon("undo")}Undo</button>` : ""}
        ${ed.dirty ? `<button class="btn-soft" data-act="edit-discard">Discard</button>` : ""}
        <button class="btn-small-primary" data-act="edit-save" ${ed.dirty ? "" : "disabled"}>Save to robot</button>
      </div>`;
    return;
  }
  let html: string;
  if (ed.tool === "merge") {
    html =
      ed.rooms.length === 2
        ? `<span class="hint"><b>${esc(roomName(ed.rooms[0]))}</b> + <b>${esc(roomName(ed.rooms[1]))}</b></span>
         <div class="foot-actions"><button class="btn-soft" data-act="edit-clear">Clear</button><button class="btn-small-primary" data-act="room-merge">Merge rooms</button></div>`
        : `<span class="hint">Click two rooms next to each other to merge them into one.</span>`;
  } else if (ed.tool === "split") {
    html =
      ed.line && ed.rooms.length
        ? `<span class="hint">Split <b>${esc(roomName(ed.rooms[0]))}</b> along the line.</span>
         <div class="foot-actions"><button class="btn-soft" data-act="edit-clear">Redraw</button><button class="btn-small-primary" data-act="room-split">Split room</button></div>`
        : `<span class="hint">Drag a line straight across the room you want to split, from wall to wall.</span>`;
  } else {
    const id = ed.rooms[0];
    if (!id) {
      html = `<span class="hint">Click a room to rename it.</span>`;
    } else {
      if (document.activeElement?.id === "rename-input") return; // don't wipe what's being typed
      const room = m.rooms.find((r) => r.id === id);
      html = `<form class="rename" id="rename-form">
          <input class="field" id="rename-input" maxlength="30" value="${esc(room?.name ?? "")}" placeholder="${esc(room?.original ?? "")}" aria-label="Room name" autocomplete="off">
          <button class="btn-small-primary" type="submit">Save name</button>
          ${room?.nickname ? `<button class="btn-soft" type="button" data-act="room-reset-name">Use “${esc(room.original)}”</button>` : ""}
        </form>
        <span class="hint small">Only changes the name in this app. Rename it in the Roborock app to change it everywhere.</span>`;
    }
  }
  foot.innerHTML = html;
}

/* ---- rooms ---- */

export function editRoomClick(e: MouseEvent, p: Point): void {
  const ed = S.edit;
  if (!ed) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active.id === "rename-input") active.blur();
  if (ed.mode !== "rooms" || ed.tool === "split") return;
  const label = closest(e.target, "[data-room]");
  const id = label ? Number(label.dataset.room) : roomAt(p);
  if (!id) return;
  if (ed.tool === "merge") {
    const i = ed.rooms.indexOf(id);
    if (i >= 0) ed.rooms.splice(i, 1);
    else {
      ed.rooms.push(id);
      if (ed.rooms.length > 2) ed.rooms.shift();
    }
  } else {
    ed.rooms = ed.rooms[0] === id ? [] : [id];
  }
  refreshMapOverlays();
  if (ed.tool === "rename" && ed.rooms.length) {
    setTimeout(() => {
      const input = $opt<HTMLInputElement>("#rename-input");
      input?.focus();
      input?.select();
    }, 0);
  }
}

function refreshMapSoon(): void {
  // The robot takes a moment to rebuild its map after an edit.
  for (const ms of [800, 2500, 6000]) setTimeout(() => void pollMap(true), ms);
}

export async function saveRestrictions(btn: HTMLButtonElement): Promise<void> {
  const ed = S.edit;
  if (!ed) return;
  try {
    await doAction("save_restrictions", { items: ed.items.map(({ type, mm }) => ({ type, mm })) }, { button: btn, okMsg: "Saved to the robot" });
    Object.assign(ed, { dirty: false, history: [], sel: null });
    refreshEdit();
    refreshMapSoon();
  } catch {
    // toast shown
  }
}

export async function mergeRooms(btn: HTMLButtonElement): Promise<void> {
  const ed = S.edit;
  if (!ed || ed.rooms.length !== 2) return;
  const [a, b] = ed.rooms;
  if (!confirm(`Merge ${roomName(a)} and ${roomName(b)} into one room?\n\nThis changes the map on your robot. You can split it again later.`)) return;
  try {
    await doAction("merge_rooms", { rooms: [a, b] }, { button: btn, okMsg: "Rooms merged" });
    ed.rooms = [];
    refreshMapOverlays();
    refreshMapSoon();
  } catch {
    // toast shown
  }
}

export async function splitRoom(btn: HTMLButtonElement): Promise<void> {
  const ed = S.edit;
  if (!ed?.line || !ed.rooms.length) return;
  const room = ed.rooms[0];
  const [[x0, y0], [x1, y1]] = ed.line;
  if (!confirm(`Split ${roomName(room)} along the line?\n\nThis changes the map on your robot. You can merge the parts again later.`)) return;
  try {
    await doAction("split_room", { room, line: [...pxToMm(x0, y0), ...pxToMm(x1, y1)] }, { button: btn, okMsg: "Room split" });
    Object.assign(ed, { line: null, rooms: [] });
    refreshMapOverlays();
    refreshMapSoon();
  } catch {
    // toast shown
  }
}

export async function renameRoom(name: string, btn: HTMLButtonElement | null): Promise<void> {
  const room = S.edit?.rooms[0];
  if (!room) return;
  try {
    await doAction("rename_room", { room, name }, { button: btn, okMsg: name ? "Name saved" : "Back to the original name" });
    await pollMap(true);
    refreshMapOverlays();
  } catch {
    // toast shown
  }
}

document.addEventListener("submit", (e) => {
  if ((e.target as HTMLElement).id !== "rename-form") return;
  e.preventDefault();
  const input = $<HTMLInputElement>("#rename-input");
  const name = input.value.trim();
  input.blur();
  const submitter = (e as SubmitEvent).submitter;
  void renameRoom(name, submitter instanceof HTMLButtonElement ? submitter : null);
});

document.addEventListener("keydown", (e) => {
  const ed = S.edit;
  if (!ed || S.tab !== "home" || closest(e.target, "input, select, textarea")) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
    e.preventDefault();
    undoEdit();
    return;
  }
  if ((e.key === "Delete" || e.key === "Backspace") && ed.sel) {
    e.preventDefault();
    deleteSelected();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    const firstTool = EDIT_TOOLS[ed.mode][0][0];
    if (ed.draft || ed.line) {
      ed.draft = null;
      ed.line = null;
    } else if (ed.sel) ed.sel = null;
    else if (ed.rooms.length) ed.rooms = [];
    else if (ed.tool !== firstTool) {
      setEditTool(firstTool);
      return;
    }
    refreshMapOverlays();
  }
});
