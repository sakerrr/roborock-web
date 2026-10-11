// The Settings tab.

import { api, devicePath } from "./api";
import { $, $opt, errorMessage, esc, fmtArea, fmtDuration, fmtWhen, human, icon } from "./dom";
import { OPT_LABEL } from "./labels";
import { doAction } from "./panels";
import { S } from "./state";
import { notifyEnabled, notifySupported, setNotify } from "./notify";
import { themeChoice } from "./theme";
import type { Choice, Settings } from "./types";

export async function loadSettings(): Promise<void> {
  const el = $("#settings");
  if (!S.settings) {
    el.innerHTML = [1, 2, 3, 4]
      .map(() => `<div class="card"><div class="skel" style="height:18px;width:40%"></div><div class="skel" style="height:40px;margin-top:18px"></div><div class="skel" style="height:40px;margin-top:12px"></div></div>`)
      .join("");
  }
  try {
    S.settings = await api<Settings>(devicePath("settings"));
    renderSettings();
  } catch (e) {
    el.innerHTML = `<div class="card">Couldn't load settings.<br><span class="muted">${esc(errorMessage(e))}</span></div>`;
  }
}

function connectionText(): string {
  const l = S.status?.links;
  if (!l) return S.status?.connected === false ? "Offline" : S.status?.local ? "Local network" : "Roborock cloud";
  const ways = [l.local ? `Home network${l.ip ? ` (${esc(l.ip)})` : ""}` : "", l.cloud ? "Roborock cloud" : ""].filter(Boolean);
  return ways.length ? ways.join(" and ") : "Offline";
}

const sw = (action: string, on: boolean | null | undefined) =>
  `<label class="switch"><input type="checkbox" data-switch="${action}" ${on ? "checked" : ""}><span></span></label>`;

const row = (iconName: string, title: string, sub: string | null, control: string) =>
  `<div class="row"><div class="row-main"><span class="row-icon">${icon(iconName)}</span><div><div class="row-title">${title}</div>${sub ? `<div class="row-sub">${sub}</div>` : ""}</div></div>${control}</div>`;

const choice = (action: string, opt: Choice) =>
  `<div class="seg small" style="margin-top:10px">${opt.options.map((o) => `<button data-choice="${action}" data-value="${esc(o)}" class="${o === opt.value ? "active" : ""}">${esc(OPT_LABEL[o] || human(o))}</button>`).join("")}</div>`;

export function renderSettings(): void {
  const s = S.settings;
  if (!s) return;
  const cards: string[] = [];
  const offline = s.connected === false || S.status?.connected === false;
  if (offline) {
    cards.push(`<div class="card offline-card"><div class="card-head"><h3 class="card-title">${icon("wifi")}Can't reach your robot</h3></div>
      <p class="muted">Sound, do not disturb, dock and maintenance settings are read from the robot itself, so they'll be back here as soon as it's online again. Check that it's switched on and connected to Wi‑Fi.</p>
      <button class="btn-soft" data-act="reconnect" style="margin-top:14px">Reconnect</button></div>`);
  }

  // Robot
  let robot = "";
  if (s.volume != null) {
    robot += `<div class="row stack"><div class="row-main"><span class="row-icon">${icon("volume")}</span><div class="row-title">Voice volume</div></div>
      <div class="range-row"><input type="range" min="0" max="100" step="5" value="${s.volume}" id="vol"><output id="vol-out">${s.volume}</output>
      <button class="btn-soft" data-act="test_volume">Test</button></div></div>`;
  }
  if (s.child_lock != null) robot += row("lock", "Child lock", "Disables the buttons on the robot", sw("set_child_lock", s.child_lock));
  if (s.led != null) robot += row("light", "Status light", "The light ring on the robot", sw("set_led", s.led));
  if (s.flow_led != null) robot += row("light", "Light strip", null, sw("set_flow_led", s.flow_led));
  if (s.carpet_boost != null) robot += row("layers", "Carpet boost", "More suction when it detects carpet", sw("set_carpet_boost", s.carpet_boost));
  if (robot) cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("robot")}Robot</h3></div>${robot}</div>`);

  // Do not disturb
  if (s.dnd) {
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("moon")}Do not disturb</h3>${sw("dnd", s.dnd.enabled)}</div>
      <div class="note" style="margin:0">No cleaning, voice or auto-empty during these hours.</div>
      <div class="time-row"><label>From<input type="time" id="dnd-start" value="${esc(s.dnd.start)}"></label><label>Until<input type="time" id="dnd-end" value="${esc(s.dnd.end)}"></label></div></div>`);
  }

  // Dock
  let dock = "";
  if (s.dust_mode) dock += `<div class="row stack"><div class="row-main"><span class="row-icon">${icon("trash")}</span><div><div class="row-title">Auto-empty</div><div class="row-sub">How hard the dock empties the dust bin</div></div></div>${choice("set_dust_mode", s.dust_mode)}</div>`;
  if (s.wash_mode) dock += `<div class="row stack"><div class="row-main"><span class="row-icon">${icon("waves")}</span><div><div class="row-title">Mop washing</div><div class="row-sub">How thoroughly the dock washes the mop</div></div></div>${choice("set_wash_mode", s.wash_mode)}</div>`;
  if (s.smart_wash) dock += row("spark", "Smart mop washing", "Let the robot decide when to rewash", sw("set_smart_wash", s.smart_wash.enabled));
  if (s.mop_dryer) {
    const h = s.mop_dryer.dry_time ? ` · ${Math.round(s.mop_dryer.dry_time / 3600)} h` : "";
    dock += row("sun", "Auto mop drying", `Dry the mop with warm air after washing${h}`, sw("set_mop_dryer", s.mop_dryer.enabled));
  }
  if (dock) cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("dock")}Dock</h3></div>${dock}</div>`);

  // Maintenance
  if (s.consumables?.length) {
    const items = s.consumables
      .map((c) => {
        const left = c.unit === "s" ? `${Math.round(c.left / 3600)} h left` : `${c.left} uses left`;
        const cls = c.percent < 10 ? "low" : c.percent < 30 ? "mid" : "";
        return `<div class="cons"><div class="cons-top"><b>${esc(c.name)}</b><span>${left} · ${c.percent}%<button data-reset="${esc(c.key)}" data-name="${esc(c.name)}">Reset</button></span></div><div class="bar ${cls}"><i style="width:${c.percent}%"></i></div></div>`;
      })
      .join("");
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("wrench")}Maintenance</h3></div>${items}<div class="note">Reset after you clean or replace a part.</div></div>`);
  }

  // Routines
  if (s.routines?.length) {
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("play")}Routines</h3></div>
      ${s.routines.map((r) => row("spark", esc(r.name), null, `<button class="btn-soft" data-routine="${r.id}">${icon("play")}Run</button>`)).join("")}</div>`);
  }

  // History
  if (s.summary) {
    const sm = s.summary;
    let hist = `<div class="big-stats">
      <div class="stat"><b>${sm.total_time != null ? Math.round(sm.total_time / 3600) + " h" : "–"}</b><span>Total time</span></div>
      <div class="stat"><b>${fmtArea(sm.total_area)}</b><span>Total area</span></div>
      <div class="stat"><b>${sm.count ?? "–"}</b><span>Cleanings</span></div></div>`;
    if (sm.last) {
      hist += `<dl class="kv"><dt>Last clean</dt><dd>${fmtWhen(sm.last.begin)}</dd><dt>Duration</dt><dd>${fmtDuration(sm.last.duration)}</dd><dt>Area</dt><dd>${fmtArea(sm.last.area)}</dd><dt>Finished</dt><dd>${sm.last.complete ? "Yes" : "No"}</dd></dl>`;
    }
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("history")}History</h3></div>${hist}</div>`);
  }

  if (notifySupported()) {
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("bell")}Notifications</h3></div>
      ${row("alert", "When it needs help", "A desktop notification when it gets stuck or the dock needs attention, while this page is open", sw("notify", notifyEnabled()))}</div>`);
  }
  cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("sun")}Appearance</h3></div>
    <div class="row stack"><div class="row-main"><span class="row-icon">${icon("contrast")}</span><div><div class="row-title">Theme</div><div class="row-sub">Auto follows your Mac's light or dark setting</div></div></div>${themeChoice()}</div></div>`);

  // About
  const d = s.device ?? {};
  const n = s.network ?? {};
  cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("info")}About</h3></div>
    <dl class="kv">
      <dt>Model</dt><dd>${esc(d.product || d.model || "–")}</dd>
      ${d.firmware ? `<dt>Firmware</dt><dd>${esc(d.firmware)}</dd>` : ""}
      ${n.ip ? `<dt>IP address</dt><dd>${esc(n.ip)}</dd>` : ""}
      ${n.ssid ? `<dt>Wi‑Fi</dt><dd>${esc(n.ssid)}${n.rssi ? ` · ${n.rssi} dBm` : ""}</dd>` : ""}
      <dt>Connection</dt><dd>${connectionText()}</dd>
      <dt>Account</dt><dd>${esc(S.auth?.email || "–")}</dd>
    </dl>
    <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn-soft" data-act="refresh-settings">Refresh</button>
      ${S.auth?.demo ? "" : `<button class="btn-soft danger" data-act="logout">${icon("logout")}Sign out</button>`}
    </div></div>`);

  $("#settings").innerHTML = cards.join("");

  const vol = $opt<HTMLInputElement>("#vol");
  if (vol) {
    vol.oninput = () => {
      $("#vol-out").textContent = vol.value;
    };
    vol.onchange = () => {
      doAction("set_volume", { value: Number(vol.value) }, { okMsg: "Volume saved" }).catch(() => {});
    };
  }
  const start = $opt<HTMLInputElement>("#dnd-start");
  const end = $opt<HTMLInputElement>("#dnd-end");
  if (start && end) {
    start.onchange = sendDnd;
    end.onchange = sendDnd;
  }
}

function sendDnd(): void {
  const s = S.settings;
  const toggle = $opt<HTMLInputElement>("[data-switch=dnd]");
  const start = $opt<HTMLInputElement>("#dnd-start");
  const end = $opt<HTMLInputElement>("#dnd-end");
  if (!s || !toggle || !start || !end) return;
  const on = toggle.checked;
  s.dnd = { enabled: on, start: start.value, end: end.value };
  doAction("set_dnd", { ...s.dnd }, { okMsg: on ? "Do not disturb saved" : "Do not disturb off" }).catch(() => {});
}

/** Pick an option like the auto-empty mode, showing it straight away. */
export async function setChoice(action: string, value: string): Promise<void> {
  const s = S.settings;
  const key = action === "set_dust_mode" ? "dust_mode" : "wash_mode";
  const opt = s?.[key];
  if (!opt) return;
  const prev = opt.value;
  opt.value = value;
  renderSettings();
  try {
    await doAction(action, { value }, { okMsg: "Saved" });
  } catch {
    opt.value = prev;
    renderSettings();
  }
}

const SETTING_KEY: Record<string, "child_lock" | "led" | "flow_led" | "carpet_boost"> = {
  set_child_lock: "child_lock",
  set_led: "led",
  set_flow_led: "flow_led",
  set_carpet_boost: "carpet_boost",
};

document.addEventListener("change", async (e) => {
  const t = e.target;
  if (!(t instanceof HTMLInputElement) || !t.matches("[data-switch]")) return;
  const action = t.dataset.switch ?? "";
  if (action === "dnd") {
    sendDnd();
    return;
  }
  if (action === "notify") {
    t.checked = await setNotify(t.checked);
    return;
  }
  const on = t.checked;
  try {
    if (action === "set_smart_wash") await doAction(action, { enabled: on }, { okMsg: "Saved" });
    else await doAction(action, { on }, { okMsg: "Saved" });
    const s = S.settings;
    if (!s) return;
    const key = SETTING_KEY[action];
    if (key) s[key] = on;
    if (action === "set_mop_dryer" && s.mop_dryer) s.mop_dryer.enabled = on;
    if (action === "set_smart_wash" && s.smart_wash) s.smart_wash.enabled = on;
  } catch {
    t.checked = !on;
  }
});
