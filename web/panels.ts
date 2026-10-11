// The sidebar: status, the main action buttons, cleaning mode and the dock.

import { api, devicePath } from "./api";
import { $, $opt, busyBtn, esc, fmtArea, fmtDuration, human, icon, toast } from "./dom";
import { DONE, HIDDEN_OPTS, MODE_LABEL, OPT_LABEL, STATE_LABEL, TANK_WARN } from "./labels";
import { drawSelection, refreshMapOverlays } from "./map/core";
import { errorHelp } from "./errors";
import { estimateText, homeArea, loadEstimates, remainingParts, roomsArea, zoneArea } from "./estimate";
import { freshJobChanged } from "./freshness";
import { notifyEnabled, notifyProblem, notifySupported } from "./notify";
import { loadSettings } from "./settings";
import { S, type Pending } from "./state";
import type { ModeOption, Status } from "./types";

export function setConn(ok: boolean, text: string): void {
  $("#conn").className = "conn " + (ok ? "on" : "off");
  $("#conn-text").textContent = text;
}

let lastStatus = "";

export function setStatus(st: Status): void {
  // Polled every few seconds; when nothing changed, leave the sidebar alone.
  const key = JSON.stringify(st);
  if (S.status && key === lastStatus) return;
  lastStatus = key;
  const jobEnded = S.jobRooms && !st.job;
  const backOnline = S.status?.connected === false && st.connected !== false;
  const jobChanged = !!S.status && !!S.status.job !== !!st.job;
  const problem = (s: Status | null) => (s ? `${s.error ?? ""}|${s.dock_error ?? ""}` : "");
  const newProblem = !!S.status && problem(st) !== problem(S.status) && !!(st.error || st.dock_error);
  S.status = st;
  if (jobChanged) freshJobChanged(!!st.job);
  if (jobChanged && !st.job) {
    S.jobArea = null;
    setTimeout(() => void loadEstimates(), 60_000); // once the run is filed
  }
  if (newProblem) {
    const h = errorHelp((st.error ?? st.dock_error)!, !st.error);
    notifyProblem(`${st.name || "Robot"}: ${h.title}`, h.fix[0]);
  }
  if (backOnline && S.tab === "settings") void loadSettings();
  if (jobEnded) {
    S.jobRooms = null;
    drawSelection();
  }
  $("#robot-name").innerHTML = esc(st.name || "Robot") + (S.auth?.demo ? `<span class="demo-badge">Demo</span>` : "");
  document.title = `${st.name || "Robot"} · ${STATE_LABEL[st.state ?? ""] || human(st.state) || "Roborock"}`;
  if (st.connected === false) setConn(false, "Offline");
  else setConn(true, st.local ? "Local network" : "Via Roborock cloud");
  renderStatus();
  renderActions();
  renderMode();
  renderDock();
  $opt("#robot-marker .robot")?.classList.toggle("busy", st.phase === "cleaning");
  $opt("#robot-marker")?.classList.toggle("stuck", !!st.error);
}

export function renderSkeletons(): void {
  $("#status-card").innerHTML = `<div class="skel" style="height:30px;width:55%"></div><div class="skel" style="height:16px;width:35%;margin-top:12px"></div><div class="stats"><div class="skel" style="height:58px"></div><div class="skel" style="height:58px"></div><div class="skel" style="height:58px"></div></div>`;
  $("#action-card").innerHTML = `<div class="skel" style="height:56px;border-radius:999px"></div>`;
  $("#mode-card").innerHTML = `<div class="skel" style="height:18px;width:40%"></div><div class="skel" style="height:44px;margin-top:16px"></div><div class="skel" style="height:36px;margin-top:16px"></div>`;
}

/* ---------------- status card ---------------- */

function statusSub(st: Status): string {
  const mode = MODE_LABEL[st.mode?.cleaning ?? ""];
  switch (st.phase) {
    case "cleaning": {
      const room = S.map?.robot_room ? S.map.rooms.find((r) => r.id === S.map?.robot_room)?.name : undefined;
      return [mode, room && `now in ${room}`, remainingParts(st)?.by].filter(Boolean).join(" · ") || "Working on it";
    }
    case "paused":
      return st.job ? "Tap resume to pick up where it left off" : "Waiting for you";
    case "returning":
      return st.job ? "Will continue after the dock" : "Heading home";
    case "dock":
      return "Busy at the dock";
    case "docked":
      return (st.battery ?? 0) >= 100 ? "On the dock, ready to go" : "On the dock";
    case "error":
      return st.error ? "It stopped and needs a hand" : human(st.state);
    default:
      return "Ready when you are";
  }
}

/** What went wrong, in plain words, how to fix it, and where it happened. */
function helpCard(code: string, dock: boolean): string {
  const h = errorHelp(code, dock);
  const room = !dock && S.map?.robot_room ? S.map.rooms.find((r) => r.id === S.map?.robot_room)?.name : undefined;
  const offerNotify = notifySupported() && !notifyEnabled();
  return `<div class="help-card${dock ? " dock" : ""}">
    <div class="help-title">${icon("alert")}<span>${esc(h.title)}</span></div>
    <p class="help-why">${esc(h.why)}${room ? `<br><span class="help-where">${icon("target", "i tiny")}Stopped in ${esc(room)}</span>` : ""}</p>
    <ol class="help-steps">${h.fix.map((f) => `<li>${esc(f)}</li>`).join("")}</ol>
    <div class="help-actions">
      <button class="btn-soft" data-act="resolve_error">${icon("check")}I've fixed it</button>
      ${dock ? "" : `<button class="btn-soft" data-act="locate">${icon("bell")}Beep</button><button class="btn-soft" data-act="show-robot">${icon("target")}Show</button>`}
    </div>
    ${offerNotify ? `<button class="link help-notify" data-act="notify-on">Get a desktop notification next time</button>` : ""}
  </div>`;
}

function fanName(st: Status): string | null {
  const m = st.mode;
  if (!m) return null;
  if (m.cleaning === "mop") return "Off";
  if (m.cleaning === "smart_mode") return "Smart";
  const o = m.fan_options.find((x) => x.code === m.fan);
  return o ? OPT_LABEL[o.name] || human(o.name) : null;
}

export function renderStatus(): void {
  const st = S.status;
  if (!st) return;
  const el = $("#status-card");
  if (st.connected === false && st.state == null) {
    el.innerHTML = `<div class="status-state">Can't reach robot</div><div class="status-sub">${esc(st.message || "It may be offline or out of Wi‑Fi range.")}</div>
      <button class="btn-soft" data-act="reconnect" style="margin-top:14px">Reconnect</button>`;
    return;
  }
  const b = st.battery ?? 0;
  const C = 2 * Math.PI * 27;
  const ringCls = b <= 15 ? "crit" : b <= 30 ? "low" : "";
  const charging = st.state === "charging";
  const active = ["cleaning", "paused", "returning"].includes(st.phase ?? "") || st.job;
  let html = `
    <div class="status-top">
      <div style="min-width:0">
        <div class="status-state">${esc(STATE_LABEL[st.state ?? ""] || human(st.state))}</div>
        <div class="status-sub">${esc(statusSub(st))}</div>
      </div>
      <div class="battery" title="Battery">
        <div class="ring ${ringCls}">
          <svg viewBox="0 0 66 66"><circle class="track" cx="33" cy="33" r="27"/><circle class="fill" cx="33" cy="33" r="27" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - b / 100)}"/></svg>
          <div class="ring-text">${b}%</div>
        </div>
        ${charging ? `<span class="bolt">${icon("bolt")}Charging</span>` : ""}
      </div>
    </div>`;
  if (active || st.clean_time) {
    html += `<div class="stats">
      <div class="stat"><b>${fmtArea(st.clean_area)}</b><span>${active ? "Cleaned" : "Last clean"}</span></div>
      <div class="stat"><b>${fmtDuration(st.clean_time)}</b><span>Time</span></div>
      ${(() => {
        const left = remainingParts(st);
        if (left) return `<div class="stat"><b>${left.left}</b><span>Left</span></div>`;
        return st.clean_percent != null
          ? `<div class="stat"><b>${st.clean_percent}%</b><span>Progress</span></div>`
          : `<div class="stat"><b>${esc(fanName(st) || "–")}</b><span>Suction</span></div>`;
      })()}
    </div>`;
  }
  for (const [code, dock] of [[st.error, false], [st.dock_error, true]] as const) {
    if (code) html += helpCard(code, dock);
  }
  const d = st.dock;
  const warns = d
    ? [d.can_wash ? d.clean_water : null, d.can_wash ? d.dirty_water : null, d.can_empty ? d.dust_bag : null].filter(
        (v): v is string => !!v && v in TANK_WARN,
      )
    : [];
  if (warns.length) {
    html += `<div class="chips-row">${warns.map((w) => `<span class="pill-warn">${icon("alert")}${esc(TANK_WARN[w])}</span>`).join("")}</div>`;
  }
  el.innerHTML = html;
}

/* ---------------- actions ---------------- */

interface PrimaryAction {
  label: string;
  icon: string;
  act: string;
  params?: Record<string, unknown>;
}

function primaryAction(st: Status): PrimaryAction {
  const ph = st.phase;
  if (ph === "cleaning" || ph === "returning") return { label: "Pause", icon: "pause", act: "pause" };
  if (ph === "paused" || (ph === "error" && st.job)) return { label: "Resume", icon: "play", act: "resume" };
  if (S.tool === "rooms" && S.selected.length) {
    const n = S.selected.length;
    return { label: `Clean ${n} room${n > 1 ? "s" : ""}`, icon: "play", act: "clean_rooms", params: { rooms: S.selected, repeat: S.repeat } };
  }
  if (S.tool === "zone" && S.zone) return { label: "Clean zone", icon: "play", act: "clean_zone", params: { rect: S.zone, repeat: S.repeat } };
  if (S.tool === "goto" && S.pin) return { label: "Go here", icon: "play", act: "goto", params: { x: S.pin.x, y: S.pin.y } };
  return { label: "Clean everywhere", icon: "play", act: "start" };
}

/** m² the primary action would clean (once over). */
function jobAreaFor(p: PrimaryAction): number {
  if (p.act === "start") return homeArea();
  if (p.act === "clean_rooms") return roomsArea(S.selected);
  if (p.act === "clean_zone") return zoneArea(S.zone);
  return 0;
}

export function renderActions(): void {
  const st = S.status;
  if (!st) return;
  const p = primaryAction(st);
  const ph = st.phase;
  const idle = !["cleaning", "paused", "returning"].includes(ph ?? "");
  const showRepeat = idle && ((S.tool === "rooms" && S.selected.length) || (S.tool === "zone" && S.zone));
  const showStop = !idle || st.job;
  const showDock = ph !== "docked" && ph !== "dock";
  $("#action-card").innerHTML = `
    ${showRepeat ? `<div class="repeat"><span class="label" style="margin:0">Passes</span><div class="seg small">${[1, 2, 3].map((n) => `<button data-repeat="${n}" class="${S.repeat === n ? "active" : ""}">${n}×</button>`).join("")}</div></div>` : ""}
    <div class="actions">
      <button class="btn-primary" id="primary-btn">${icon(p.icon)}<span>${esc(p.label)}</span></button>
      ${showStop ? `<button class="btn-round" data-act="stop" data-tip="Stop" aria-label="Stop">${icon("stop")}</button>` : ""}
      ${showDock ? `<button class="btn-round" data-act="dock" data-tip="Send to dock" aria-label="Send to dock">${icon("home")}</button>` : ""}
      <button class="btn-round" data-act="locate" data-tip="Find my robot" aria-label="Find my robot">${icon("bell")}</button>
    </div>
    ${idle ? (() => {
      const est = estimateText(jobAreaFor(p), p.act === "start" ? 1 : S.repeat);
      return est ? `<div class="estimate">${icon("clock", "i tiny")}${est}</div>` : "";
    })() : ""}`;
  const btn = $<HTMLButtonElement>("#primary-btn");
  btn.onclick = async () => {
    if (!S.status) return;
    const act = primaryAction(S.status);
    try {
      await doAction(act.act, act.params ?? {}, { button: btn });
      if (["start", "clean_rooms", "clean_zone"].includes(act.act)) S.jobArea = jobAreaFor(act) * (act.act === "start" ? 1 : S.repeat);
      if (["clean_rooms", "clean_zone", "goto"].includes(act.act)) {
        S.jobRooms = act.act === "clean_rooms" ? [...S.selected] : null;
        S.selected = [];
        S.zone = null;
        S.pin = null;
        refreshMapOverlays();
      }
    } catch {
      // toast shown
    }
  };
}

export interface ActionOptions {
  button?: HTMLButtonElement | null;
  quiet?: boolean;
  okMsg?: string;
}

/** Send a command to the robot; returns the robot's fresh status. */
export async function doAction(action: string, params: Record<string, unknown> = {}, opts: ActionOptions = {}): Promise<Status> {
  const { button, quiet = false, okMsg } = opts;
  if (button) busyBtn(button, true);
  try {
    const st = await api<Status>(devicePath("action"), { method: "POST", body: { action, ...params } });
    if (st?.phase) setStatus(st);
    if (!quiet) toast(okMsg || DONE[action] || "Saved");
    S.lastMapAt = 0; // refresh the map on the next tick
    return st;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), true);
    throw e;
  } finally {
    if (button) busyBtn(button, false);
  }
}

/* ---------------- cleaning mode ---------------- */

export function renderMode(): void {
  const m = S.status?.mode;
  if (!m) return;
  const cur = S.pending.cleaning ?? m.cleaning;
  const fan = S.pending.fan ?? m.fan;
  const water = S.pending.water ?? m.water;
  const mop = S.pending.mop ?? m.mop;
  const hasModes = m.cleaning_options.length > 0;
  const simple = !["smart_mode", "custom"].includes(cur ?? "");
  const showFan = simple && cur !== "mop";
  const showWater = hasModes && simple && cur !== "vacuum" && m.water_options.length > 0;
  const showMop = hasModes && simple && cur !== "vacuum" && m.mop_options.length > 0;
  const chips = (opts: ModeOption[], value: number | null, kind: string, extraHide: string[] = []) =>
    opts
      .filter((o) => (!HIDDEN_OPTS.has(o.name) && !extraHide.includes(o.name)) || o.code === value)
      .map((o) => `<button class="chip ${o.code === value ? "active" : ""}" data-${kind}="${o.code}">${esc(OPT_LABEL[o.name] || human(o.name))}</button>`)
      .join("");

  let html = `<div class="card-head"><h3 class="card-title">${icon("spark")}Cleaning mode</h3></div>`;
  if (hasModes) {
    html += `<div class="group"><div class="seg">${m.cleaning_options.map((o) => `<button data-cmode="${o}" class="${o === cur ? "active" : ""}">${esc(MODE_LABEL[o] || human(o))}</button>`).join("")}</div>`;
    if (cur === "smart_mode") html += `<div class="note">SmartPlan picks suction, water and route for each room on its own.</div>`;
    if (cur === "custom") html += `<div class="note">Uses the per-room settings you set up in the Roborock app.</div>`;
    html += `</div>`;
  }
  if (showFan) html += `<div class="group"><div class="label">${icon("fan")}Suction</div><div class="chips">${chips(m.fan_options, fan, "fan", ["off", "gentle"])}</div></div>`;
  if (showWater) html += `<div class="group"><div class="label">${icon("drop")}Water flow</div><div class="chips">${chips(m.water_options, water, "water", ["off"])}</div></div>`;
  if (showMop) html += `<div class="group"><div class="label">${icon("route")}Mop route</div><div class="chips">${chips(m.mop_options, mop, "mop")}</div></div>`;
  $("#mode-card").innerHTML = html;
}

/** Show a mode change straight away, then send it. */
export async function setModeValue<K extends keyof Pending>(key: K, value: Pending[K], action: string, params: Record<string, unknown>): Promise<void> {
  S.pending[key] = value;
  renderMode();
  try {
    await doAction(action, params, { quiet: true });
  } catch {
    // toast shown
  }
  delete S.pending[key];
  if (S.status) renderMode();
}

/* ---------------- dock ---------------- */

export function renderDock(): void {
  const d = S.status?.dock;
  const card = $("#dock-card");
  if (!d || (!d.can_empty && !d.can_wash && !d.can_dry)) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const tank = (label: string, v: string | null) => `<span class="tank ${v && TANK_WARN[v] ? "bad" : ""}"><i></i>${label}</span>`;
  let tanks = "";
  if (d.can_wash) tanks += tank("Clean water", d.clean_water) + tank("Dirty water", d.dirty_water);
  if (d.can_empty) tanks += tank("Dust bag", d.dust_bag);
  const tiles: string[] = [];
  if (d.can_empty) tiles.push(`<button class="tile" data-act="empty_bin"><span class="ti">${icon("trash")}</span>Empty bin</button>`);
  if (d.can_wash) tiles.push(`<button class="tile" data-act="wash_mop"><span class="ti">${icon("waves")}</span>Wash mop</button>`);
  if (d.can_dry) tiles.push(`<button class="tile ${d.drying ? "on" : ""}" data-act="${d.drying ? "dry_stop" : "dry_start"}"><span class="ti">${icon("sun")}</span>${d.drying ? "Stop drying" : "Dry mop"}</button>`);
  card.innerHTML = `<div class="card-head"><h3 class="card-title">${icon("dock")}Dock</h3></div>
    <div class="tank-row">${tanks}</div>
    <div class="dock-grid">${tiles.join("")}</div>`;
}
