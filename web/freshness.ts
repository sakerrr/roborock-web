// Room freshness: when each room, and each spot, was last cleaned, from the history the
// server keeps of every run. It's a map view of its own (the floor coloured by how long
// ago it was cleaned) with a panel of rooms, what's due and the recent runs.

import { api, devicePath } from "./api";
import { $, closest, cssVar, esc, fmtArea, fmtDuration, fmtWhen, hexRgb, icon, toast } from "./dom";
import { decodeMask, refreshMapOverlays, toBase, toggleRoom } from "./map/core";
import { mapImg, stage } from "./map/elements";
import { estimateText, roomsArea } from "./estimate";
import { doAction } from "./panels";
import { S } from "./state";
import type { Freshness, RoomFreshness } from "./types";

/** The colour steps, freshest first. A spot's age is in whole days since it was cleaned. */
const STEPS = [
  { upTo: 0, label: "Under a day" },
  { upTo: 2, label: "1–2 days" },
  { upTo: 6, label: "3–6 days" },
  { upTo: 13, label: "1–2 weeks" },
  { upTo: 254, label: "Over 2 weeks" },
];
const MISSED = STEPS.length; // never reached, in a room that does get cleaned
const NEVER = 255;

const EVERY: Record<number, string> = { 1: "Every day", 2: "Every 2 days", 3: "Every 3 days", 7: "Every week", 14: "Every 2 weeks" };
const DAY = 86400;

const panel = $("#fresh-panel");
const tip = $("#fresh-tip");

const stepOf = (days: number) => STEPS.findIndex((s) => days <= s.upTo);
const daysSince = (ts: number) => Math.floor((Date.now() / 1000 - ts) / DAY);
const cleanedRooms = () => new Set((S.fresh?.rooms ?? []).filter((r) => r.last_cleaned != null).map((r) => r.id));

function ago(ts: number): string {
  const s = Date.now() / 1000 - ts;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < DAY) return `${Math.round(s / 3600)} h ago`;
  const d = Math.floor(s / DAY);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

const dayAgo = (d: number) => (d === 0 ? "in the last day" : d === 1 ? "a day ago" : `${d} days ago`);
const since = () => (S.fresh?.since ? new Date(S.fresh.since * 1000).toLocaleDateString([], { month: "short", day: "numeric" }) : "the start");

/* ---- loading ---- */

let loading: Promise<void> | null = null;
let loadedAt = 0;

export function loadFreshness(): Promise<void> {
  if (loading || !S.duid) return loading ?? Promise.resolve();
  loading = (async () => {
    try {
      const f = await api<Freshness>(devicePath("freshness"));
      S.freshAge = f.age ? await decodeMask(f.age) : null;
      S.fresh = f;
    } catch (e) {
      if (!S.fresh) toast(`Couldn't load the cleaning history: ${e instanceof Error ? e.message : e}`, true);
    } finally {
      loadedAt = Date.now();
      loading = null;
    }
    if (S.viewMode === "fresh") {
      if (S.map) mapImg.src = freshImage();
      renderFreshPanel();
      refreshMapOverlays();
    }
  })();
  return loading;
}

/** A new map came in. Ages are per map, so fetch them again now and then while it changes. */
export function freshMapChanged(): void {
  if (S.viewMode !== "fresh" || !S.map) return;
  const stale = !S.fresh?.map || !S.map.version.startsWith(S.fresh.map);
  if (stale && Date.now() - loadedAt > 30_000) void loadFreshness();
}

setInterval(() => {
  if (S.viewMode === "fresh" && !document.hidden && Date.now() - loadedAt > 60_000) void loadFreshness();
}, 15_000);

/** A run started or finished: update the button now, and pick up the new run once it's recorded. */
export function freshJobChanged(running: boolean): void {
  renderFreshPanel();
  if (running || S.viewMode !== "fresh") return;
  setTimeout(() => void loadFreshness(), 3_000);
  setTimeout(() => void loadFreshness(), 45_000); // the robot can take a moment to file the run
}

/* ---- the map image ---- */

type RGBA = [number, number, number, number];
let imgCache = { key: "", url: "" };

function colours() {
  const rgba = (name: string, fallback: string): RGBA => [...hexRgb(cssVar(name) || fallback), 255];
  const steps = ["#f9e0cc", "#f4c49e", "#eca06f", "#de7642", "#b9531f", "#7a3210"].map((c, i) => rgba(`--fresh-${i}`, c));
  return {
    steps,
    none: rgba("--fresh-none", "#e6e8ec"),
    wall: rgba("--fresh-wall", "#8b9099"),
    furniture: rgba("--fresh-furniture", "#d5d9df"),
    hatch: cssVar("--fresh-none-hatch") || "rgba(120,128,140,.35)",
  };
}

/** The floor coloured by how long ago each spot was cleaned. Redrawn when the ages or the layout change. */
export function freshImage(): string {
  const m = S.map;
  const mask = S.mask;
  if (!m || !mask) return "";
  const age = S.freshAge && S.freshAge.w === mask.w && S.freshAge.h === mask.h ? S.freshAge : null;
  const cleaned = cleanedRooms();
  const c = colours();
  const key = [m.mask.length, m.mask.slice(-48), m.width, S.fresh?.age?.slice(-48) ?? "", [...cleaned].join(","), c.steps.join(), c.wall.join()].join(":");
  if (imgCache.key === key) return imgCache.url;

  // 1. one pixel per 5 cm block, and a separate layer marking spots with no data yet
  const { w, h, data } = mask;
  const small = canvas(w, h);
  const img = small.getContext("2d")!.createImageData(w, h);
  const blank = canvas(w, h);
  const blankImg = blank.getContext("2d")!.createImageData(w, h);
  for (let o = 0; o < data.length; o += 4) {
    if (!data[o + 3]) continue;
    const kind = data[o + 1];
    let px: RGBA;
    if (kind === 1) px = c.wall;
    else if (kind === 2) px = c.furniture;
    else {
      const d = age ? age.data[o] : NEVER;
      if (d < NEVER) px = c.steps[stepOf(d)];
      else if (data[o] && cleaned.has(data[o])) px = c.steps[MISSED];
      else {
        px = c.none;
        blankImg.data.set([0, 0, 0, 255], o);
      }
    }
    img.data.set(px, o);
  }
  small.getContext("2d")!.putImageData(img, 0, 0);
  blank.getContext("2d")!.putImageData(blankImg, 0, 0);

  // 2. scale up with crisp edges, and hatch the spots with no data
  const big = canvas(m.width, m.height);
  const ctx = big.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, big.width, big.height);
  const hatch = canvas(big.width, big.height);
  const hctx = hatch.getContext("2d")!;
  hctx.imageSmoothingEnabled = false;
  hctx.drawImage(blank, 0, 0, big.width, big.height);
  hctx.globalCompositeOperation = "source-in";
  hctx.strokeStyle = c.hatch;
  hctx.lineWidth = 1.5;
  hctx.beginPath();
  for (let d = -big.height; d < big.width; d += 8) {
    hctx.moveTo(d, big.height);
    hctx.lineTo(d + big.height, 0);
  }
  hctx.stroke();
  ctx.drawImage(hatch, 0, 0);

  imgCache = { key, url: big.toDataURL("image/png") };
  return imgCache.url;
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = w;
  el.height = h;
  return el;
}

/* ---- hover ---- */

/** What the Freshness view says about the spot under the pointer (null hides the tip). */
export function freshHover(e: PointerEvent | null): void {
  const text = e && S.viewMode === "fresh" ? describe(e) : null;
  tip.hidden = !text;
  if (!e || !text) return;
  tip.innerHTML = text;
  const r = stage.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  const flip = x + tip.offsetWidth + 24 > r.width;
  tip.style.left = `${flip ? x - tip.offsetWidth - 14 : x + 14}px`;
  tip.style.top = `${Math.max(8, y - tip.offsetHeight - 10)}px`;
}

function describe(e: PointerEvent): string | null {
  const m = S.map;
  const mask = S.mask;
  if (!m || !mask || !S.fresh?.available) return null;
  const p = toBase(e);
  const x = Math.floor(p.x / m.scale);
  const y = Math.floor(p.y / m.scale);
  if (x < 0 || y < 0 || x >= mask.w || y >= mask.h) return null;
  const o = (y * mask.w + x) * 4;
  if (!mask.data[o + 3] || mask.data[o + 1] === 1 || mask.data[o + 1] === 2) return null;
  const age = S.freshAge && S.freshAge.w === mask.w ? S.freshAge : null;
  const d = age ? age.data[o] : NEVER;
  const mopped = age ? age.data[o + 1] : NEVER;
  const room = m.rooms.find((r) => r.id === mask.data[o]);
  const where = room ? `<b>${esc(room.name)}</b>` : "<b>Here</b>";
  if (d === NEVER) {
    return cleanedRooms().has(mask.data[o])
      ? `${where}<br>Never reached since ${since()}<br><span class="muted">Something may be in the way</span>`
      : `${where}<br>No clean recorded here since ${since()}`;
  }
  return `${where}<br>Cleaned ${dayAgo(d)}${mopped < NEVER ? ` · mopped ${dayAgo(mopped)}` : ""}`;
}

/* ---- room labels ---- */

/** The line under a room's name in the Freshness view, and whether it's due. */
export function freshLabel(id: number): { text: string; due: boolean } | null {
  const r = S.fresh?.rooms?.find((x) => x.id === id);
  if (!r) return null;
  const text = r.last_cleaned != null ? ago(r.last_cleaned) : "not yet";
  return { text: r.overdue ? `Due · ${text}` : text, due: r.overdue };
}

/* ---- the panel ---- */

// Most overdue first: how far past its interval each room is.
const urgency = (r: RoomFreshness) => (Date.now() / 1000 - (r.last_cleaned ?? S.fresh?.since ?? 0)) / (r.interval * DAY);

function swatch(r: RoomFreshness): string {
  if (r.last_cleaned == null) return `<span class="fresh-sw none"></span>`;
  return `<span class="fresh-sw" style="background:var(--fresh-${stepOf(daysSince(r.last_cleaned))})"></span>`;
}

export function renderFreshPanel(): void {
  const on = S.viewMode === "fresh";
  panel.hidden = !on;
  $("#map-card").classList.toggle("is-fresh", on);
  if (!on) {
    tip.hidden = true;
    return;
  }
  const f = S.fresh;
  const m = S.map;
  if (!f || !m) {
    panel.innerHTML = `<div class="skel" style="height:18px;width:50%"></div>${'<div class="skel" style="height:44px;margin-top:14px"></div>'.repeat(4)}`;
    return;
  }
  if (!f.available) {
    panel.innerHTML = `<p class="muted">There's no map yet, so there's nothing to show. Run a full clean first.</p>`;
    return;
  }
  const names = new Map(m.rooms.map((r) => [r.id, r.name]));
  const rooms = (f.rooms ?? []).filter((r) => names.has(r.id)).sort((a, b) => urgency(b) - urgency(a));
  const due = rooms.filter((r) => r.overdue);
  const busy = !!S.status?.job || S.status?.phase === "cleaning" || S.status?.phase === "returning";
  const intervals = f.intervals ?? [1, 2, 3, 7, 14];

  const row = (r: RoomFreshness) => {
    const name = names.get(r.id) ?? `Room ${r.id}`;
    const bits = [r.last_cleaned != null ? `Cleaned ${ago(r.last_cleaned)}` : `Not cleaned since ${since()}`];
    if (r.last_mopped != null) bits.push(`mopped ${ago(r.last_mopped)}`);
    if (!r.overdue && r.last_cleaned != null && r.fresh < 0.95) bits.push(`${Math.round((1 - r.fresh) * 100)}% not reached`);
    const sel = S.selected.includes(r.id);
    return `<div class="fresh-room${r.overdue ? " due" : ""}${sel ? " sel" : ""}" data-fresh-room="${r.id}" title="Click to pick this room">
      ${swatch(r)}
      <div class="fresh-main">
        <div class="fresh-name">${esc(name)}${r.overdue ? `<span class="due-badge">${icon("clock")}Due</span>` : ""}</div>
        <div class="fresh-sub">${bits.join(" · ")}</div>
      </div>
      <select class="fresh-every" data-fresh-every="${r.id}" aria-label="How often to clean ${esc(name)}">
        ${intervals.map((d) => `<option value="${d}" ${d === r.interval ? "selected" : ""}>${EVERY[d] ?? `Every ${d} days`}</option>`).join("")}
      </select>
    </div>`;
  };

  const est = due.length ? estimateText(roomsArea(due.map((r) => r.id)), S.repeat) : null;
  const go = due.length
    ? `<button class="btn-primary fresh-go" data-fresh-go ${busy ? "disabled" : ""}>${icon("play")}<span>Clean ${due.length === 1 ? esc(names.get(due[0].id)) : `${due.length} due rooms`}</span></button>
       ${est && !busy ? `<div class="estimate">${icon("clock", "i tiny")}${est}</div>` : ""}`
    : `<div class="fresh-ok">${icon("check")}Every room is within its interval</div>`;

  const runs = (f.runs ?? [])
    .map((run) => {
      const where = run.rooms.length ? run.rooms.map((id) => esc(names.get(id) ?? `Room ${id}`)).join(", ") : run.mapped ? "Part of a room" : "No map for this run";
      return `<li><div class="run-when">${esc(fmtWhen(run.begin))}</div><div class="run-what">${where}</div>
        <div class="run-meta">${fmtDuration(run.duration)} · ${fmtArea(run.area)}${run.mopped ? ` · ${icon("drop", "i tiny")}mopped` : ""}</div></li>`;
    })
    .join("");

  const empty = !f.tracked
    ? `<div class="fresh-empty">${icon("history")}<div>Nothing recorded yet. Every run the robot finishes while this app is running is added here, so this fills in as it cleans.</div></div>`
    : "";

  panel.innerHTML = `
    <div class="fresh-head"><h4>Freshness</h4>${due.length ? `<span class="due-badge">${icon("clock")}${due.length} due</span>` : ""}</div>
    ${empty}
    <div class="fresh-rooms">${rooms.map(row).join("")}</div>
    ${go}
    <div class="fresh-legend" aria-label="Map colours">
      ${STEPS.map((s, i) => `<span><i style="background:var(--fresh-${i})"></i>${s.label}</span>`).join("")}
      <span><i style="background:var(--fresh-${MISSED})"></i>Never reached</span>
      <span><i class="none"></i>No data yet</span>
    </div>
    ${runs ? `<details class="fresh-runs"><summary>Recent runs</summary><ul>${runs}</ul></details>` : ""}
    <p class="fresh-note">${S.auth?.demo ? "Made-up history for the demo." : `History since ${since()} · ${f.tracked ?? 0} runs with a map<br>Runs are recorded while this app is running.`}</p>`;
}

panel.addEventListener("click", async (e) => {
  const go = closest<HTMLButtonElement>(e.target, "[data-fresh-go]");
  if (go) {
    const ids = (S.fresh?.rooms ?? []).filter((r) => r.overdue && S.map?.rooms.some((x) => x.id === r.id)).map((r) => r.id);
    try {
      await doAction("clean_rooms", { rooms: ids, repeat: S.repeat }, { button: go, okMsg: "Cleaning the rooms that are due" });
      S.jobRooms = ids;
      S.jobArea = roomsArea(ids) * S.repeat;
      S.selected = [];
      refreshMapOverlays();
    } catch {
      // toast shown
    }
    return;
  }
  if (closest(e.target, "select, details, summary")) return;
  const row = closest(e.target, "[data-fresh-room]");
  if (row) {
    toggleRoom(Number(row.dataset.freshRoom));
    renderFreshPanel();
  }
});

panel.addEventListener("change", async (e) => {
  const sel = closest<HTMLSelectElement>(e.target, "[data-fresh-every]");
  if (!sel) return;
  try {
    await doAction("set_room_interval", { room: Number(sel.dataset.freshEvery), days: Number(sel.value) }, { quiet: true });
    await loadFreshness();
  } catch {
    // toast shown
  }
});
