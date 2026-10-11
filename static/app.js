"use strict";

/* ---------------- helpers ---------------- */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const icon = (name, cls = "i") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const human = (s) => (s ? String(s).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "");
const pct = (v, total) => `${(v / total) * 100}%`;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const STATE_LABEL = {
  starting: "Starting", charger_disconnected: "Off the dock", idle: "Ready", remote_control_active: "Remote control",
  cleaning: "Cleaning", returning_home: "Returning to dock", manual_mode: "Manual mode", charging: "Charging",
  charging_problem: "Charging problem", paused: "Paused", spot_cleaning: "Spot cleaning", error: "Needs attention",
  shutting_down: "Shutting down", updating: "Updating firmware", docking: "Docking", going_to_target: "Heading to spot",
  zoned_cleaning: "Cleaning a zone", segment_cleaning: "Cleaning rooms", emptying_the_bin: "Emptying dust bin",
  washing_the_mop: "Washing mop", going_to_wash_the_mop: "Going to wash mop", mapping: "Mapping your home",
  charging_complete: "Fully charged", device_offline: "Offline", locked: "Locked", air_drying_stopping: "Drying mop",
  robot_status_mopping: "Mopping", clean_mop_cleaning: "Cleaning", clean_mop_mopping: "Mopping",
  segment_mopping: "Mopping rooms", segment_clean_mop_cleaning: "Cleaning rooms", segment_clean_mop_mopping: "Mopping rooms",
  zoned_mopping: "Mopping a zone", zoned_clean_mop_cleaning: "Cleaning a zone", zoned_clean_mop_mopping: "Mopping a zone",
  back_to_dock_washing_duster: "Returning to wash mop", patrol: "Patrolling", in_call: "In a call",
  attaching_the_mop: "Attaching mop", detaching_the_mop: "Detaching mop", unknown: "Unknown",
};
const MODE_LABEL = { vacuum: "Vacuum", vac_and_mop: "Vac & Mop", mop: "Mop", custom: "Custom", smart_mode: "SmartPlan" };
const OPT_LABEL = {
  quiet: "Quiet", balanced: "Balanced", turbo: "Turbo", max: "Max", max_plus: "Max+", off: "Off", gentle: "Gentle",
  smart_mode: "Smart", custom: "Custom", custom_water_flow: "Custom", low: "Low", mild: "Mild", medium: "Medium",
  standard: "Standard", high: "High", intense: "Intense", extreme: "Extreme", min: "Min", slight: "Slight",
  moderate: "Moderate", deep: "Deep", deep_plus: "Deep+", fast: "Fast", light: "Light", smart: "Smart",
  super_deep: "Extra deep",
};
const HIDDEN_OPTS = new Set(["smart_mode", "custom", "custom_water_flow"]);
const TANK_WARN = {
  out_of_water: "Refill the clean water tank", refill_error: "Clean water refill problem",
  full_not_installed: "Empty the dirty water tank", drain_error: "Dirty water drain problem",
  full: "Dust bag is full", not_installed: "Dust bag missing", empty_not_installed: "Refill cleaning solution",
};
const DONE = {
  start: "Starting a full clean", clean_rooms: "Cleaning the selected rooms", clean_zone: "Zone cleaning started",
  goto: "On its way", pause: "Paused", resume: "Resuming", stop: "Stopped", dock: "Heading back to the dock",
  locate: "Playing the locator sound", empty_bin: "Emptying the dust bin", wash_mop: "Washing the mop",
  dry_start: "Drying the mop", dry_stop: "Stopped drying", resolve_error: "Marked as resolved",
  reset_consumable: "Reset", run_routine: "Routine started", test_volume: "Playing a test sound",
};

const S = {
  auth: null, devices: [], duid: null, status: null, map: null, mask: null,
  selected: [], jobRooms: null, edit: null, viewMode: savedViewMode(), view: { s: 1, tx: 0, ty: 0 }, tool: "rooms", zone: null, pin: null, drag: null, repeat: 1, hover: 0,
  settings: null, tab: "home", pending: {}, lastMapAt: 0, mapLoading: false, statusLoading: false,
};

function savedViewMode() {
  try { return localStorage.getItem("view") || "2d"; } catch { return "2d"; }
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const d = data && data.detail;
    throw new Error(typeof d === "string" ? d : d ? JSON.stringify(d) : `${res.status} ${res.statusText}`);
  }
  return data;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), isErr ? 4200 : 2200);
}

function fmtDuration(sec) {
  if (sec == null) return "–";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}
const fmtArea = (a) => (a == null ? "–" : `${Number(a).toFixed(a >= 100 ? 0 : 1)} m²`);
function fmtWhen(ts) {
  if (!ts) return "–";
  const d = new Date(ts * 1000);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === today.toDateString()) return `Today, ${time}`;
  if (d.toDateString() === y.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function hexRgb(hex) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/* ---------------- auth ---------------- */
async function refreshAuth() {
  try {
    S.auth = await api("/api/auth");
  } catch (e) {
    document.body.innerHTML = `<div class="center-msg">Can't reach the local server.<br>${esc(e.message)}</div>`;
    return;
  }
  checkForUpdate(S.auth);
  if (!S.auth.logged_in) return showLogin();
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  await loadDevices();
}

// Python changes only take effect after a restart; say so instead of failing quietly.
function checkForUpdate(auth) {
  if (auth && auth.restart_needed && !S.updateDismissed) $("#update-banner").hidden = false;
}

function showLogin() {
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
  const codeStep = S.auth.code_sent;
  $("#login-step-email").hidden = codeStep;
  $("#login-step-code").hidden = !codeStep;
  if (codeStep) {
    $("#code-email").textContent = S.auth.email || "";
    $("#code").focus();
  } else {
    if (S.auth.email) $("#email").value = S.auth.email;
    $("#email").focus();
  }
}

function busyBtn(btn, on) {
  btn.classList.toggle("busy", on);
  btn.disabled = on;
}

$("#email-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter || $("#email-form button");
  $("#email-err").textContent = "";
  busyBtn(btn, true);
  try {
    S.auth = await api("/api/auth/code", { method: "POST", body: { email: $("#email").value } });
    showLogin();
  } catch (err) {
    $("#email-err").textContent = err.message;
  } finally {
    busyBtn(btn, false);
  }
});

$("#code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#code-form button[type=submit]");
  $("#code-err").textContent = "";
  busyBtn(btn, true);
  try {
    await api("/api/auth/login", { method: "POST", body: { code: $("#code").value } });
    await refreshAuth();
  } catch (err) {
    $("#code-err").textContent = err.message;
  } finally {
    busyBtn(btn, false);
  }
});

$("#change-email").addEventListener("click", () => {
  S.auth.code_sent = false;
  showLogin();
});

async function logout() {
  if (!confirm("Sign out of your Roborock account on this computer?")) return;
  await api("/api/auth/logout", { method: "POST" });
  location.reload();
}

/* ---------------- devices & polling ---------------- */
function centerMsg(html) {
  const el = $("#center-msg");
  el.hidden = !html;
  el.innerHTML = html || "";
  $("#tab-home").hidden = !!html || S.tab !== "home";
  $("#tab-settings").hidden = !!html || S.tab !== "settings";
}

async function loadDevices() {
  centerMsg(`<div><div class="spinner"></div>Connecting to your robot…</div>`);
  try {
    S.devices = await api("/api/devices");
  } catch (e) {
    centerMsg(`<div>Couldn't load your robots.<br><span class="muted">${esc(e.message)}</span><br><br><button class="btn-soft" data-act="reload">Try again</button></div>`);
    return;
  }
  const supported = S.devices.filter((d) => d.supported);
  if (!supported.length) {
    const auth = await api("/api/auth").catch(() => ({}));
    const why = auth.error
      ? `Couldn't connect to Roborock: <span class="muted">${esc(auth.error)}</span>`
      : S.devices.length ? "Your robots use a protocol this app doesn't support yet." : "No robots found on this account.";
    centerMsg(`<div>${why}<br><br><button class="btn-soft" data-act="reload">Try again</button> <button class="btn-soft danger" data-act="logout">${icon("logout")}Sign out</button></div>`);
    return;
  }
  let saved = null;
  try { saved = localStorage.getItem("duid"); } catch { /* storage blocked */ }
  S.duid = supported.some((d) => d.duid === saved) ? saved : supported[0].duid;
  const sel = $("#device-select");
  if (supported.length > 1) {
    sel.innerHTML = supported.map((d) => `<option value="${esc(d.duid)}">${esc(d.name)}</option>`).join("");
    sel.value = S.duid;
    sel.hidden = false;
    $("#robot-name").hidden = true;
  }
  centerMsg(null);
  renderSkeletons();
  startLoops();
}

let loopsStarted = false;
function startLoops() {
  pollStatus();
  pollMap(true);
  if (loopsStarted) return;
  loopsStarted = true;
  setInterval(() => !document.hidden && pollStatus(), 2500);
  setInterval(() => !document.hidden && pollMap(), 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    pollStatus();
    pollMap();
    api("/api/auth").then(checkForUpdate).catch(() => {});
  });
}

async function pollStatus() {
  if (S.statusLoading || !S.duid) return;
  S.statusLoading = true;
  try {
    setStatus(await api(`/api/devices/${encodeURIComponent(S.duid)}/status`));
  } catch (e) {
    setConn(false, e.message);
  } finally {
    S.statusLoading = false;
  }
}

function mapInterval() {
  const ph = S.status && S.status.phase;
  return ph === "cleaning" || ph === "returning" ? 3000 : 20000;
}

async function pollMap(force = false) {
  if (S.mapLoading || !S.duid) return;
  if (!force && Date.now() - S.lastMapAt < mapInterval()) return;
  S.mapLoading = true;
  S.lastMapAt = Date.now();
  try {
    const v = S.map && S.map.version;
    const q = v && !force ? `?since=${v}` : "";
    const m = await api(`/api/devices/${encodeURIComponent(S.duid)}/map${q}`);
    if (!m.available) mapEmpty("No map yet. Run a full clean once so the robot can learn your home.");
    else if (!m.unchanged) await setMap(m);
  } catch (e) {
    if (!S.map) mapEmpty(`Couldn't load the map.<br><span class="muted">${esc(e.message)}</span>`);
  } finally {
    S.mapLoading = false;
  }
}

function setConn(ok, text) {
  const c = $("#conn");
  c.className = "conn " + (ok ? "on" : "off");
  $("#conn-text").textContent = text;
}

function setStatus(st) {
  const jobEnded = S.jobRooms && !st.job;
  S.status = st;
  if (jobEnded) { S.jobRooms = null; drawSelection(); }
  $("#robot-name").innerHTML = esc(st.name || "Robot") + (S.auth && S.auth.demo ? `<span class="demo-badge">Demo</span>` : "");
  document.title = `${st.name || "Robot"} · ${STATE_LABEL[st.state] || human(st.state) || "Roborock"}`;
  if (st.connected === false) setConn(false, "Offline");
  else setConn(true, st.local ? "Local network" : "Via Roborock cloud");
  renderStatus();
  renderActions();
  renderMode();
  renderDock();
  const robot = $("#robot-marker .robot");
  if (robot) robot.classList.toggle("busy", st.phase === "cleaning");
}

/* ---------------- status card ---------------- */
function renderSkeletons() {
  $("#status-card").innerHTML = `<div class="skel" style="height:30px;width:55%"></div><div class="skel" style="height:16px;width:35%;margin-top:12px"></div><div class="stats"><div class="skel" style="height:58px"></div><div class="skel" style="height:58px"></div><div class="skel" style="height:58px"></div></div>`;
  $("#action-card").innerHTML = `<div class="skel" style="height:56px;border-radius:999px"></div>`;
  $("#mode-card").innerHTML = `<div class="skel" style="height:18px;width:40%"></div><div class="skel" style="height:44px;margin-top:16px"></div><div class="skel" style="height:36px;margin-top:16px"></div>`;
}

function statusSub(st) {
  const mode = MODE_LABEL[st.mode && st.mode.cleaning];
  switch (st.phase) {
    case "cleaning": {
      const room = S.map && S.map.robot_room && (S.map.rooms.find((r) => r.id === S.map.robot_room) || {}).name;
      return [mode, room && `now in ${room}`].filter(Boolean).join(" · ") || "Working on it";
    }
    case "paused": return st.job ? "Tap resume to pick up where it left off" : "Waiting for you";
    case "returning": return st.job ? "Will continue after the dock" : "Heading home";
    case "dock": return "Busy at the dock";
    case "docked": return st.battery >= 100 ? "On the dock, ready to go" : "On the dock";
    case "error": return human(st.error) || human(st.state);
    default: return "Ready when you are";
  }
}

function fanName(st) {
  const m = st.mode;
  if (!m) return null;
  if (m.cleaning === "mop") return "Off";
  if (m.cleaning === "smart_mode") return "Smart";
  const o = m.fan_options.find((x) => x.code === m.fan);
  return o ? OPT_LABEL[o.name] || human(o.name) : null;
}

function renderStatus() {
  const st = S.status;
  const el = $("#status-card");
  if (st.connected === false && st.state == null) {
    el.innerHTML = `<div class="status-state">Can't reach robot</div><div class="status-sub">${esc(st.message || "It may be offline or out of Wi‑Fi range.")}</div>`;
    return;
  }
  const b = st.battery ?? 0;
  const C = 2 * Math.PI * 27;
  const ringCls = b <= 15 ? "crit" : b <= 30 ? "low" : "";
  const charging = st.state === "charging";
  const active = ["cleaning", "paused", "returning"].includes(st.phase) || st.job;
  let html = `
    <div class="status-top">
      <div style="min-width:0">
        <div class="status-state">${esc(STATE_LABEL[st.state] || human(st.state))}</div>
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
      ${st.clean_percent != null
        ? `<div class="stat"><b>${st.clean_percent}%</b><span>Progress</span></div>`
        : `<div class="stat"><b>${esc(fanName(st) || "–")}</b><span>Suction</span></div>`}
    </div>`;
  }
  if (st.error) {
    html += `<div class="banner">${icon("alert")}<span class="grow">${esc(human(st.error))}</span><button data-act="resolve_error">Resolved</button></div>`;
  }
  if (st.dock_error) {
    html += `<div class="banner warn">${icon("alert")}<span class="grow">Dock: ${esc(human(st.dock_error))}</span><button data-act="resolve_error">Resolved</button></div>`;
  }
  const d = st.dock || {};
  const warns = [d.can_wash && d.clean_water, d.can_wash && d.dirty_water, d.can_empty && d.dust_bag]
    .filter((v) => v && TANK_WARN[v]);
  if (warns.length) {
    html += `<div class="chips-row">${warns.map((w) => `<span class="pill-warn">${icon("alert")}${esc(TANK_WARN[w])}</span>`).join("")}</div>`;
  }
  el.innerHTML = html;
}

/* ---------------- actions ---------------- */
function primaryAction() {
  const st = S.status;
  const ph = st.phase;
  if (ph === "cleaning" || ph === "returning") return { label: "Pause", icon: "pause", act: "pause" };
  if (ph === "paused") return { label: "Resume", icon: "play", act: "resume" };
  if (S.tool === "rooms" && S.selected.length) {
    const n = S.selected.length;
    return { label: `Clean ${n} room${n > 1 ? "s" : ""}`, icon: "play", act: "clean_rooms", params: { rooms: S.selected, repeat: S.repeat } };
  }
  if (S.tool === "zone" && S.zone) return { label: "Clean zone", icon: "play", act: "clean_zone", params: { rect: S.zone, repeat: S.repeat } };
  if (S.tool === "goto" && S.pin) return { label: "Go here", icon: "play", act: "goto", params: { x: S.pin.x, y: S.pin.y } };
  return { label: "Clean everywhere", icon: "play", act: "start" };
}

function renderActions() {
  const st = S.status;
  if (!st) return;
  const p = primaryAction();
  const ph = st.phase;
  const idle = !["cleaning", "paused", "returning"].includes(ph);
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
    </div>`;
  $("#primary-btn").onclick = async (e) => {
    const btn = e.currentTarget;
    const act = primaryAction();
    try {
      await doAction(act.act, act.params || {}, { button: btn });
      if (["clean_rooms", "clean_zone", "goto"].includes(act.act)) {
        S.jobRooms = act.act === "clean_rooms" ? [...S.selected] : null;
        S.selected = []; S.zone = null; S.pin = null;
        refreshMapOverlays();
      }
    } catch { /* toast shown */ }
  };
}

async function doAction(action, params = {}, { button, quiet = false, okMsg } = {}) {
  if (button) busyBtn(button, true);
  try {
    const st = await api(`/api/devices/${encodeURIComponent(S.duid)}/action`, { method: "POST", body: { action, ...params } });
    if (st && st.phase) setStatus(st);
    if (!quiet) toast(okMsg || DONE[action] || "Saved");
    S.lastMapAt = 0; // refresh the map on the next tick
    return st;
  } catch (e) {
    toast(e.message, true);
    throw e;
  } finally {
    if (button) busyBtn(button, false);
  }
}

/* ---------------- cleaning mode ---------------- */
function renderMode() {
  const st = S.status;
  const m = st.mode;
  if (!m) return;
  const cur = S.pending.cleaning ?? m.cleaning;
  const fan = S.pending.fan ?? m.fan;
  const water = S.pending.water ?? m.water;
  const mop = S.pending.mop ?? m.mop;
  const hasModes = m.cleaning_options.length > 0;
  const simple = !["smart_mode", "custom"].includes(cur);
  const showFan = simple && cur !== "mop";
  const showWater = hasModes && simple && cur !== "vacuum" && m.water_options.length;
  const showMop = hasModes && simple && cur !== "vacuum" && m.mop_options.length;
  const chips = (opts, value, kind, extraHide = []) =>
    opts.filter((o) => (!HIDDEN_OPTS.has(o.name) && !extraHide.includes(o.name)) || o.code === value)
      .map((o) => `<button class="chip ${o.code === value ? "active" : ""}" data-${kind}="${o.code}">${esc(OPT_LABEL[o.name] || human(o.name))}</button>`).join("");

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

async function setModeValue(key, value, action, params) {
  S.pending[key] = value;
  renderMode();
  try {
    await doAction(action, params, { quiet: true });
  } catch { /* toast shown */ }
  delete S.pending[key];
  if (S.status) renderMode();
}

/* ---------------- dock ---------------- */
function renderDock() {
  const d = (S.status && S.status.dock) || {};
  const card = $("#dock-card");
  if (!d.can_empty && !d.can_wash && !d.can_dry) { card.hidden = true; return; }
  card.hidden = false;
  const tank = (label, v) => `<span class="tank ${TANK_WARN[v] ? "bad" : ""}"><i></i>${label}</span>`;
  let tanks = "";
  if (d.can_wash) tanks += tank("Clean water", d.clean_water) + tank("Dirty water", d.dirty_water);
  if (d.can_empty) tanks += tank("Dust bag", d.dust_bag);
  const tiles = [];
  if (d.can_empty) tiles.push(`<button class="tile" data-act="empty_bin"><span class="ti">${icon("trash")}</span>Empty bin</button>`);
  if (d.can_wash) tiles.push(`<button class="tile" data-act="wash_mop"><span class="ti">${icon("waves")}</span>Wash mop</button>`);
  if (d.can_dry) tiles.push(`<button class="tile ${d.drying ? "on" : ""}" data-act="${d.drying ? "dry_stop" : "dry_start"}"><span class="ti">${icon("sun")}</span>${d.drying ? "Stop drying" : "Dry mop"}</button>`);
  card.innerHTML = `<div class="card-head"><h3 class="card-title">${icon("dock")}Dock</h3></div>
    <div class="tank-row">${tanks}</div>
    <div class="dock-grid">${tiles.join("")}</div>`;
}

/* ---------------- map ---------------- */
const inner = $("#map-inner");
const selCanvas = $("#map-sel");
const drawSvg = $("#map-draw");
const shapesSvg = $("#map-shapes");

function mapEmpty(html) {
  $("#map-empty").innerHTML = html;
  $("#map-empty").hidden = false;
  inner.hidden = true;
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function decodeMask(src) {
  const img = await loadImg(src);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return { w: c.width, h: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data };
}

async function setMap(m) {
  const [, mask] = await Promise.all([loadImg(m.base), decodeMask(m.mask)]);
  S.map = m;
  S.mask = mask;
  $("#map-img").src = S.viewMode === "plan" ? planImage() : m.base;
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
    const busy = gesture && gesture.type.startsWith("edit-");
    if (ed.mode === "walls" && !ed.dirty && !busy) {
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
  if (S.status) renderStatus();
}

function fitMap() {
  if (!S.map || inner.hidden) return;
  const cs = getComputedStyle(stage);
  const availW = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  if (availW <= 0) return;
  const desktop = window.matchMedia("(min-width: 1024px)").matches;
  // Desktop: fill the map card. Smaller screens: keep room for the controls below.
  const maxH = desktop
    ? stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)
    : clamp(window.innerHeight * 0.48, 220, 560);
  const k = Math.min(availW / S.map.width, maxH / S.map.height, 3);
  inner.style.width = `${Math.round(S.map.width * k)}px`;
  inner.style.height = `${Math.round(S.map.height * k)}px`;
  clampView();
  applyView();
}

function renderMapSelect() {
  const sel = $("#map-select");
  const maps = (S.map && S.map.maps) || [];
  if (maps.length < 2) { sel.hidden = true; return; }
  sel.innerHTML = maps.map((m) => `<option value="${m.flag}">${esc(m.name)}</option>`).join("");
  sel.value = S.map.current_map;
  sel.hidden = false;
}

function refreshMapOverlays() {
  renderShapes();
  renderLabels();
  drawSelection();
  renderDraw();
  renderMapFoot();
  if (S.status) renderActions();
}

function renderLabels() {
  if (!S.map) return;
  const { width: w, height: h } = S.map;
  $("#map-labels").innerHTML = S.map.rooms.map((r) => {
    const sel = S.edit ? S.edit.mode === "rooms" && S.edit.rooms.includes(r.id) : S.tool === "rooms" && S.selected.includes(r.id);
    const area = S.viewMode === "plan" && r.area ? `<span class="area">${fmtArea(r.area)}</span>` : "";
    return `<button class="room-label ${sel ? "sel" : ""}" data-room="${r.id}" style="left:${pct(r.x, w)};top:${pct(r.y, h)}">${icon("check", "i tick")}<span class="nm">${esc(r.name)}</span>${area}</button>`;
  }).join("");
}

function renderMarkers() {
  if (!S.map) return;
  const { width: w, height: h, robot, charger } = S.map;
  const dock = $("#dock-marker");
  dock.hidden = !charger;
  if (charger) Object.assign(dock.style, { left: pct(charger.x, w), top: pct(charger.y, h) });
  const rm = $("#robot-marker");
  rm.hidden = !robot;
  if (robot) {
    Object.assign(rm.style, { left: pct(robot.x, w), top: pct(robot.y, h) });
    rm.firstElementChild.style.transform = `rotate(${90 - (robot.a || 0)}deg)`;
    rm.firstElementChild.classList.toggle("busy", S.status && S.status.phase === "cleaning");
  }
}

function drawSelection() {
  if (!S.mask) return;
  const { w, h, data } = S.mask;
  const ctx = selCanvas.getContext("2d");
  const img = ctx.createImageData(w, h);
  const out = img.data;
  const editRooms = !!S.edit && S.edit.mode === "rooms";
  const rooms = editRooms || (!S.edit && S.tool === "rooms");
  const sel = new Set(editRooms ? S.edit.rooms : rooms ? S.selected : []);
  const any = sel.size > 0;
  const hov = rooms ? S.hover : 0;
  // While a room clean runs, keep its rooms softly marked (like the Roborock app).
  const job = !S.edit && !any && S.jobRooms && S.status && S.status.job ? new Set(S.jobRooms) : null;
  const [ar, ag, ab] = hexRgb(cssVar("--accent") || "#4c7df0");
  const dim = (cssVar("--mask-dim") || "255,255,255").split(",").map(Number);
  const dimA = Number(cssVar("--mask-dim-a")) || 135;
  for (let i = 0; i < data.length; i += 4) {
    const id = data[i];
    if (!data[i + 3] || !id) continue;
    if (sel.has(id)) { out[i] = ar; out[i + 1] = ag; out[i + 2] = ab; out[i + 3] = 92; }
    else if (id === hov) { out[i] = ar; out[i + 1] = ag; out[i + 2] = ab; out[i + 3] = 36; }
    else if (job && job.has(id)) { out[i] = ar; out[i + 1] = ag; out[i + 2] = ab; out[i + 3] = 46; }
    else if (any) { out[i] = dim[0]; out[i + 1] = dim[1]; out[i + 2] = dim[2]; out[i + 3] = dimA; }
  }
  ctx.putImageData(img, 0, 0);
}

function renderDraw() {
  if (!S.map) return;
  // Screen pixels per map pixel, so the pin and corners keep their size when zoomed.
  const k = (inner.offsetWidth / S.map.width) * S.view.s || 1;
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

function renderMapFoot() {
  const foot = $("#map-foot");
  if (!S.map) { foot.innerHTML = ""; return; }
  if (S.edit) { renderEditFoot(); return; }
  const names = new Map(S.map.rooms.map((r) => [r.id, r.name]));
  let html;
  const plan = S.viewMode === "plan";
  const areaOf = (ids) => fmtArea(S.map.rooms.filter((r) => ids.includes(r.id)).reduce((sum, r) => sum + (r.area || 0), 0));
  if (S.tool === "rooms") {
    html = S.selected.length
      ? `<span class="hint"><b style="color:var(--text)">${S.selected.map((id) => esc(names.get(id))).join(", ")}</b>${plan ? ` · ${areaOf(S.selected)}` : ""}</span><button class="link" data-act="clear-sel">Clear</button>`
      : plan
        ? `<span class="hint">Floor area ${areaOf(S.map.rooms.map((r) => r.id))} across ${S.map.rooms.length} rooms. Click rooms to clean just those.</span>`
        : `<span class="hint">Tap rooms to clean just those, or clean everywhere.</span>`;
  } else if (S.tool === "zone") {
    if (S.zone) {
      const m = (v) => ((Math.abs(v) / S.map.scale) * 0.05).toFixed(1);
      html = `<span class="hint">Zone · ${m(S.zone[2] - S.zone[0])} × ${m(S.zone[3] - S.zone[1])} m</span><button class="link" data-act="clear-sel">Clear</button>`;
    } else html = `<span class="hint">Drag on the map to draw a zone.</span>`;
  } else {
    html = S.pin
      ? `<span class="hint">The robot will drive to the pin.</span><button class="link" data-act="clear-sel">Clear</button>`
      : `<span class="hint">Tap a spot to send the robot there.</span>`;
  }
  foot.innerHTML = html;
}

function toBase(ev) {
  const r = inner.getBoundingClientRect();
  return {
    x: clamp(((ev.clientX - r.left) / r.width) * S.map.width, 0, S.map.width),
    y: clamp(((ev.clientY - r.top) / r.height) * S.map.height, 0, S.map.height),
  };
}

// Room under a base-image point. Furniture and walls belong to no room, so a
// click on the sofa falls back to the nearest room within about 20 cm.
function roomAt(p) {
  if (!S.mask) return 0;
  const { w, h, data } = S.mask;
  const x = Math.floor(p.x / S.map.scale);
  const y = Math.floor(p.y / S.map.scale);
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  const i = (y * w + x) * 4;
  if (!data[i + 3]) return 0;
  if (data[i]) return data[i];
  for (let r = 1; r <= 4; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = (ny * w + nx) * 4;
        if (data[j + 3] && data[j]) return data[j];
      }
    }
  }
  return 0;
}

function toggleRoom(id) {
  const i = S.selected.indexOf(id);
  if (i >= 0) S.selected.splice(i, 1);
  else S.selected.push(id);
  refreshMapOverlays();
}

function setTool(tool) {
  S.tool = tool;
  S.hover = 0;
  $$("#map-tools button").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  syncInnerClasses();
  applyView();
  refreshMapOverlays();
}

/* ---- view modes ---- */
function setViewMode(mode) {
  if (mode === S.viewMode) return;
  S.viewMode = mode;
  try { localStorage.setItem("view", mode); } catch { /* storage blocked */ }
  syncViewChrome();
  if (S.map) $("#map-img").src = mode === "plan" ? planImage() : S.map.base;
  refreshMapOverlays();
}

function syncViewChrome() {
  $$("#view-modes button").forEach((b) => b.classList.toggle("active", b.dataset.view === S.viewMode));
  inner.classList.toggle("plan", S.viewMode === "plan");
}

// The floor plan is drawn here from the room mask: walls, floors, carpet hatching
// and a 1 m grid, in the theme's colours. It only changes when the layout does.
let planCache = { key: "", url: "" };
function planImage() {
  const t = (name) => cssVar(name);
  const key = `${S.map.mask.length}:${S.map.mask.slice(-64)}:${S.map.width}:${t("--plan-paper")}`;
  if (planCache.key === key) return planCache.url;

  const { w, h, data } = S.mask;
  const rgba = (v, fallback) => {
    const m = (v || fallback).match(/\d+(\.\d+)?/g).map(Number);
    return [m[0], m[1], m[2], Math.round((m[3] ?? 1) * 255)];
  };
  const paper = hexRgb(t("--plan-paper") || "#fffefb").concat(255);
  const carpet = hexRgb(t("--plan-carpet") || "#f3efe6").concat(255);
  const wall = hexRgb(t("--plan-wall") || "#2b3340").concat(255);
  const furniture = hexRgb(t("--plan-furniture") || "#dfe3e9").concat(255);
  const edge = rgba(t("--plan-edge"), "rgba(43,51,64,.22)");

  // 1. one pixel per 5 cm block
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const sctx = small.getContext("2d");
  const img = sctx.createImageData(w, h);
  const out = img.data;
  const rugs = document.createElement("canvas");
  rugs.width = w;
  rugs.height = h;
  const rctx = rugs.getContext("2d");
  const rugImg = rctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!data[i + 3]) continue;
      const room = data[i], kind = data[i + 1], isCarpet = data[i + 2];
      let c = kind === 1 ? wall : kind === 2 ? furniture : isCarpet ? carpet : paper;
      // A soft line where two rooms meet without a wall in between.
      if (room) {
        const right = x + 1 < w ? data[i + 4] : room;
        const down = y + 1 < h ? data[i + w * 4] : room;
        if ((right && right !== room) || (down && down !== room)) c = blend(c, edge);
      }
      out.set(c, i);
      if (isCarpet && kind !== 1) rugImg.data.set([0, 0, 0, 255], i);
    }
  }
  sctx.putImageData(img, 0, 0);
  rctx.putImageData(rugImg, 0, 0);

  // 2. scale up with crisp edges
  const big = document.createElement("canvas");
  big.width = S.map.width;
  big.height = S.map.height;
  const ctx = big.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, big.width, big.height);

  // 3. diagonal hatching on carpets
  const hatch = document.createElement("canvas");
  hatch.width = big.width;
  hatch.height = big.height;
  const hctx = hatch.getContext("2d");
  hctx.imageSmoothingEnabled = false;
  hctx.drawImage(rugs, 0, 0, big.width, big.height);
  hctx.globalCompositeOperation = "source-in";
  hctx.strokeStyle = t("--plan-hatch") || "rgba(120,100,70,.2)";
  hctx.lineWidth = 1.5;
  hctx.beginPath();
  for (let d = -big.height; d < big.width; d += 9) {
    hctx.moveTo(d, big.height);
    hctx.lineTo(d + big.height, 0);
  }
  hctx.stroke();
  ctx.drawImage(hatch, 0, 0);

  // 4. a 1 m grid, aligned to the robot's coordinates, only on mapped floor
  const f = S.map.frame;
  if (f) {
    const step = (1000 / f.mm) * f.scale; // px per metre
    const blocksPerM = 1000 / f.mm;
    const x0 = (Math.ceil(f.left / blocksPerM) * blocksPerM - f.left) * f.scale;
    const y0 = ((f.top + f.height) % blocksPerM) * f.scale;
    ctx.save();
    ctx.globalCompositeOperation = "source-atop";
    ctx.strokeStyle = t("--plan-grid") || "rgba(43,51,64,.07)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = x0; x < big.width; x += step) { ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, big.height); }
    for (let y = y0; y < big.height; y += step) { ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(big.width, Math.round(y) + 0.5); }
    ctx.stroke();
    ctx.restore();
  }

  planCache = { key, url: big.toDataURL("image/png") };
  return planCache.url;
}

function blend(base, over) {
  const a = over[3] / 255;
  return [0, 1, 2].map((k) => Math.round(base[k] * (1 - a) + over[k] * a)).concat(255);
}

// Follow the system theme while the plan is showing.
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (S.map && S.viewMode === "plan") $("#map-img").src = planImage();
  if (S.mask) drawSelection();
});

/* ---- pan & zoom, Google Maps style ----
   Drag moves the map at any zoom (with a little glide on release), pinch or a
   mouse wheel zooms toward the pointer, and a two-finger trackpad swipe moves
   the map. The fitted layout never changes; the view is a transform on top. */
const stage = $("#map-stage");
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 10;
const pointers = new Map();
let gesture = null;
let spaceDown = false;
let overStage = false;
let inertia = 0;
let frame = 0;

const isFit = () => S.view.s === 1 && !S.view.tx && !S.view.ty;
const capture = (id) => { try { stage.setPointerCapture(id); } catch { /* pointer already gone */ } };
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function applyView() {
  frame = 0;
  const { s, tx, ty } = S.view;
  inner.style.transform = isFit() ? "" : `translate(${tx}px, ${ty}px) scale(${s})`;
  inner.style.setProperty("--inv", String(1 / s));
  const k = S.map ? inner.offsetWidth / S.map.width : 1;
  $("#map-img").style.imageRendering = k * s >= 2 ? "pixelated" : "";
  // On touch screens one finger scrolls the page until you zoom; pinch always zooms the map.
  stage.style.touchAction = S.tool === "zone" || S.edit || s !== 1 ? "none" : "pan-y";
  $("#zoom-in").disabled = s >= MAX_ZOOM;
  $("#zoom-out").disabled = s <= MIN_ZOOM;
  $("#zoom-fit").disabled = isFit();
  renderDraw();
  renderShapes();
}
const scheduleView = () => { if (!frame) frame = requestAnimationFrame(applyView); };

function clampView() {
  const v = S.view;
  v.s = clamp(v.s, MIN_ZOOM, MAX_ZOOM);
  // Move freely, but always keep a good part of the map on screen.
  const W = inner.offsetWidth * v.s;
  const H = inner.offsetHeight * v.s;
  const mx = Math.min(W, stage.clientWidth) * 0.35;
  const my = Math.min(H, stage.clientHeight) * 0.35;
  const ox = inner.offsetLeft, oy = inner.offsetTop;
  v.tx = clamp(v.tx, mx - ox - W, stage.clientWidth - mx - ox);
  v.ty = clamp(v.ty, my - oy - H, stage.clientHeight - my - oy);
}

function zoomAt(clientX, clientY, scale, now = false) {
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
  now ? applyView() : scheduleView();
}

function animateView(fn) {
  stopInertia();
  inner.classList.add("animate");
  fn();
  applyView();
  clearTimeout(animateView.t);
  animateView.t = setTimeout(() => inner.classList.remove("animate"), 260);
}

function zoomBy(f) {
  const r = stage.getBoundingClientRect();
  animateView(() => zoomAt(r.left + r.width / 2, r.top + r.height / 2, S.view.s * f, true));
}

function resetView(animate = true) {
  const run = () => { S.view = { s: 1, tx: 0, ty: 0 }; };
  if (animate) animateView(run);
  else { stopInertia(); run(); applyView(); }
}

function centerOnRobot() {
  if (!S.map || !S.map.robot) { toast("The robot isn't on the map right now"); return; }
  animateView(() => {
    const v = S.view;
    v.s = Math.max(v.s, 2.5);
    const ux = (S.map.robot.x / S.map.width) * inner.offsetWidth;
    const uy = (S.map.robot.y / S.map.height) * inner.offsetHeight;
    v.tx = stage.clientWidth / 2 - inner.offsetLeft - ux * v.s;
    v.ty = stage.clientHeight / 2 - inner.offsetTop - uy * v.s;
    clampView();
  });
}

function panBy(dx, dy) {
  animateView(() => { S.view.tx += dx; S.view.ty += dy; clampView(); });
}

function startInertia(vx, vy) {
  const speed = Math.hypot(vx, vy); // px per ms
  if (speed < 0.25) return; // a slow release just stops
  // Cap the fling so a quick flick glides a short way instead of throwing the map off.
  const cap = 1.6 / Math.max(speed, 1.6);
  vx *= cap;
  vy *= cap;
  let last = performance.now();
  const step = (now) => {
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
function stopInertia() {
  if (inertia) cancelAnimationFrame(inertia);
  inertia = 0;
}

function finishZone() {
  S.drag = null;
  const [x0, y0, x1, y1] = S.zone;
  const minPx = 0.4 / 0.05 * S.map.scale; // at least 40cm
  if (Math.abs(x1 - x0) < minPx || Math.abs(y1 - y0) < minPx) {
    S.zone = null;
    toast("Draw a slightly bigger zone");
  }
  refreshMapOverlays();
}

function setHover(id) {
  inner.classList.toggle("over-room", !!id);
  if (id !== S.hover) { S.hover = id; drawSelection(); }
}

// A notched mouse wheel zooms (like Google Maps); a trackpad swipe moves the map.
function wheelIsMouse(e) {
  if (e.deltaMode !== 0) return true; // line-based scrolling: classic wheel
  if (e.deltaX !== 0) return false; // any sideways motion: trackpad
  const w = e.wheelDeltaY;
  return !!w && w % 120 === 0 && Math.abs(e.deltaY) >= 50;
}

stage.addEventListener("wheel", (e) => {
  if (!S.map || inner.hidden) return;
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
}, { passive: false });

// Safari reports trackpad pinch as its own gesture events instead of ctrl + wheel.
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
  zoomAt(e.clientX, e.clientY, gestureBase * e.scale);
});
stage.addEventListener("gestureend", (e) => { if (S.map && !pointers.size) e.preventDefault(); });

stage.addEventListener("pointerdown", (e) => {
  if (!S.map || inner.hidden || e.target.closest(".map-zoom, .edit-tools, .shape-delete")) return;
  stopInertia();
  S.suppressClick = false;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    // Second finger: pinch to zoom, dropping any half-drawn zone.
    if (gesture && gesture.type === "zone") { S.drag = null; S.zone = null; renderDraw(); }
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
    type: "maybe", id: e.pointerId, touch: e.pointerType === "touch",
    x0: e.clientX, y0: e.clientY, tx0: S.view.tx, ty0: S.view.ty,
    trail: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }],
  };
  if (panButton) e.preventDefault();
});

stage.addEventListener("pointermove", (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!S.map) return;
  if (!gesture) {
    const pickRooms = S.edit ? S.edit.mode === "rooms" && S.edit.tool !== "split" : S.tool === "rooms";
    if (pickRooms && e.pointerType === "mouse") {
      const r = inner.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      setHover(inside ? roomAt(toBase(e)) : 0);
    }
    return;
  }
  if (gesture.type === "pinch") {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()];
    const m = mid(a, b);
    const d = dist(a, b);
    S.view.tx += m.x - gesture.m.x;
    S.view.ty += m.y - gesture.m.y;
    zoomAt(m.x, m.y, S.view.s * (d / (gesture.d || d)));
    gesture.m = m;
    gesture.d = d;
    return;
  }
  if (gesture.type.startsWith("edit-")) {
    editPointerMove(e, gesture);
    return;
  }
  if (gesture.type === "zone") {
    const p = toBase(e);
    S.zone = [S.drag.x, S.drag.y, p.x, p.y];
    renderDraw();
    return;
  }
  if (gesture.type === "maybe") {
    const moved = Math.hypot(e.clientX - gesture.x0, e.clientY - gesture.y0) > 4;
    // Touch keeps page scrolling at the fitted zoom; mouse and trackpad always drag the map.
    if (moved && (!gesture.touch || S.view.s !== 1)) {
      gesture.type = "pan";
      capture(gesture.id);
      stage.classList.add("panning");
      setHover(0);
    }
  }
  if (gesture.type === "pan") {
    S.view.tx = gesture.tx0 + (e.clientX - gesture.x0);
    S.view.ty = gesture.ty0 + (e.clientY - gesture.y0);
    gesture.trail.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    while (gesture.trail.length > 2 && e.timeStamp - gesture.trail[0].t > 100) gesture.trail.shift();
    clampView();
    scheduleView();
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (!gesture) return;
  if (gesture.type === "pinch") {
    if (pointers.size === 1) {
      // Lift one finger: keep moving with the other.
      const [[id, p]] = [...pointers.entries()];
      gesture = { type: "pan", id, x0: p.x, y0: p.y, tx0: S.view.tx, ty0: S.view.ty, trail: [{ t: e.timeStamp, x: p.x, y: p.y }] };
      return;
    }
  } else if (gesture.type.startsWith("edit-")) {
    editPointerUp(e, gesture);
    S.suppressClick = true;
  } else if (gesture.type === "zone") {
    finishZone();
  } else if (gesture.type === "pan") {
    S.suppressClick = true;
    const tr = gesture.trail;
    const a = tr[0];
    const b = tr[tr.length - 1];
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
stage.addEventListener("contextmenu", (e) => S.map && e.preventDefault());
stage.addEventListener("pointerenter", () => (overStage = true));
stage.addEventListener("pointerleave", () => {
  overStage = false;
  if (!gesture) setHover(0);
});

new ResizeObserver(() => fitMap()).observe(stage);
window.addEventListener("resize", fitMap);

$("#map-zoom").addEventListener("click", (e) => {
  const b = e.target.closest("[data-zoom]");
  if (!b) return;
  ({ in: () => zoomBy(1.6), out: () => zoomBy(1 / 1.6), fit: () => resetView(), robot: centerOnRobot })[b.dataset.zoom]();
});

document.addEventListener("keydown", (e) => {
  if (!S.map || S.tab !== "home" || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target.closest("input, select, textarea")) return;
  const step = 120;
  const keys = {
    "+": () => zoomBy(1.4), "=": () => zoomBy(1.4), "-": () => zoomBy(1 / 1.4), _: () => zoomBy(1 / 1.4),
    0: () => resetView(), r: centerOnRobot, R: centerOnRobot,
    ArrowLeft: () => panBy(step, 0), ArrowRight: () => panBy(-step, 0),
    ArrowUp: () => panBy(0, step), ArrowDown: () => panBy(0, -step),
  };
  if (e.key === " " && overStage) {
    e.preventDefault();
    if (!spaceDown) { spaceDown = true; stage.classList.add("space-pan"); }
    return;
  }
  const fn = keys[e.key];
  if (!fn) return;
  e.preventDefault();
  fn();
});
document.addEventListener("keyup", (e) => {
  if (e.key === " ") { spaceDown = false; stage.classList.remove("space-pan"); }
});

/* ---------------- map editing ----------------
   Walls & zones are staged here and saved together, because the robot's
   save_map replaces the whole set. Edits are kept in robot millimetres so they
   stay put even if the map image changes size while you edit. Room merges and
   splits go to the robot one at a time; renames only live in this app. */
const EDIT_LIMIT = 68; // corner points the robot can store
const RESTRICTION_LABEL = { wall: "Invisible wall", no_go: "No-go zone", no_mop: "No-mop zone" };
const EDIT_TOOLS = {
  walls: [["select", "pointer", "Select"], ["wall", "wall", "Invisible wall"], ["no_go", "ban", "No-go zone"], ["no_mop", "drop-off", "No-mop zone"]],
  rooms: [["merge", "merge", "Merge rooms"], ["split", "scissors", "Split a room"], ["rename", "type", "Rename"]],
};

function mmToPx(x, y) {
  const f = S.map.frame;
  return [(x / f.mm - f.left) * f.scale, (f.height - (y / f.mm - f.top) - 1) * f.scale];
}
function pxToMm(x, y) {
  const f = S.map.frame;
  return [Math.round((x / f.scale + f.left) * f.mm), Math.round((f.top + f.height - 1 - y / f.scale) * f.mm)];
}
function itemPx(it) {
  const pts = [];
  for (let i = 0; i < it.mm.length; i += 2) pts.push(mmToPx(it.mm[i], it.mm[i + 1]));
  return pts;
}
const setItemPx = (it, pts) => { it.mm = pts.flatMap(([x, y]) => pxToMm(x, y)); };
const pointsUsed = (items) => items.reduce((n, it) => n + (it.type === "wall" ? 2 : 4), 0);
const roomName = (id) => ((S.map && S.map.rooms.find((r) => r.id === id)) || {}).name || `Room ${id}`;
const selectedItem = () => S.edit && S.edit.items.find((i) => i.id === S.edit.sel);
const copyRestrictions = () => (S.map.restrictions || []).map((r) => ({ id: r.id, type: r.type, mm: [...r.mm] }));

function rectPx(x0, y0, x1, y1) {
  const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
  return [[l, t], [r, t], [r, b], [l, b]];
}
function isAxisRect(pts) {
  if (pts.length !== 4) return false;
  const near = (a, b) => Math.abs(a - b) < 0.75;
  const [a, b, c, d] = pts;
  return (near(a[1], b[1]) && near(b[0], c[0]) && near(c[1], d[1]) && near(d[0], a[0]))
    || (near(a[0], b[0]) && near(b[1], c[1]) && near(c[0], d[0]) && near(d[1], a[1]));
}
const canResize = (it) => it.type === "wall" || isAxisRect(itemPx(it));

function syncInnerClasses() {
  const e = S.edit;
  inner.classList.toggle("rooms", e ? e.mode === "rooms" && e.tool !== "split" : S.tool === "rooms");
  inner.classList.toggle("draw", !e && S.tool === "zone");
  inner.classList.toggle("goto", !e && S.tool === "goto");
  inner.classList.toggle("editing", !!e && e.mode === "walls");
  inner.classList.toggle("drawing", !!e && (e.mode === "walls" ? e.tool !== "select" : e.tool === "split"));
}

function startEdit() {
  if (!S.map) { toast("The map is still loading. Try again in a moment."); return; }
  if (!S.map.frame) { toast("Restart the app to turn on map editing", true); return; }
  const ph = S.status && S.status.phase;
  if (ph === "cleaning" || ph === "returning") { toast("Pause or dock the robot to edit the map"); return; }
  S.edit = { mode: "walls", tool: "select", items: copyRestrictions(), sel: null, dirty: false, history: [], rooms: [], line: null, draft: null, drag: false };
  S.selected = []; S.zone = null; S.pin = null; S.hover = 0;
  renderEditChrome();
  applyView();
  refreshMapOverlays();
}

function endEdit(force = false) {
  if (!S.edit) return;
  if (!force && S.edit.dirty && !confirm("Discard your unsaved wall and zone changes?")) return;
  S.edit = null;
  S.hover = 0;
  renderEditChrome();
  applyView();
  refreshMapOverlays();
}

function setEditMode(mode) {
  const ed = S.edit;
  if (!ed || mode === ed.mode) return;
  if (mode === "rooms" && ed.dirty) { toast("Save or discard your wall and zone changes first"); return; }
  if (mode === "walls") ed.items = copyRestrictions();
  Object.assign(ed, { mode, tool: mode === "walls" ? "select" : "merge", sel: null, rooms: [], line: null, draft: null, history: [] });
  renderEditChrome();
  applyView();
  refreshMapOverlays();
}

function setEditTool(tool) {
  const ed = S.edit;
  Object.assign(ed, { tool, draft: null, line: null });
  if (ed.mode === "rooms") ed.rooms = [];
  if (tool !== "select") ed.sel = null;
  renderEditChrome();
  applyView();
  refreshMapOverlays();
}

function renderEditChrome() {
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

function renderShapes() {
  if (!S.map || !S.map.frame) { shapesSvg.innerHTML = ""; return; }
  const k = (inner.offsetWidth / S.map.width) * S.view.s || 1;
  const e = S.edit;
  const editing = !!e && e.mode === "walls";
  let svg = "";
  for (const it of e ? e.items : S.map.restrictions || []) {
    const pts = itemPx(it);
    const cls = `shape ${it.type}${editing && e.sel === it.id ? " sel" : ""}`;
    if (it.type === "wall") {
      const [[x0, y0], [x1, y1]] = pts;
      const xy = `x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"`;
      svg += `<g class="${cls}" data-rid="${esc(it.id)}"><line class="hit" ${xy}/><line class="stroke" ${xy}/></g>`;
    } else {
      svg += `<g class="${cls}" data-rid="${esc(it.id)}"><polygon points="${pts.map((p) => p.join(",")).join(" ")}"/></g>`;
    }
  }
  const sel = editing && selectedItem();
  if (sel && canResize(sel)) {
    itemPx(sel).forEach(([x, y], i) => { svg += `<circle class="handle" data-handle="${i}" cx="${x}" cy="${y}" r="${7 / k}"/>`; });
  }
  if (e && e.draft) {
    const { type, a, b } = e.draft;
    svg += type === "wall"
      ? `<g class="shape wall draft"><line class="stroke" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/></g>`
      : `<g class="shape ${type} draft"><polygon points="${rectPx(a[0], a[1], b[0], b[1]).map((p) => p.join(",")).join(" ")}"/></g>`;
  }
  if (e && e.line) {
    const [[x0, y0], [x1, y1]] = e.line;
    svg += `<line class="split-line" x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}"/>`;
  }
  shapesSvg.innerHTML = svg;

  const del = $("#shape-delete");
  del.hidden = !sel || e.drag;
  if (sel) {
    const pts = itemPx(sel);
    Object.assign(del.style, {
      left: pct(Math.max(...pts.map((p) => p[0])), S.map.width),
      top: pct(Math.min(...pts.map((p) => p[1])), S.map.height),
    });
  }
}

function refreshEdit() {
  renderShapes();
  renderMapFoot();
}

const snapshot = () => JSON.stringify(S.edit.items);
function pushHistory(snap) {
  S.edit.history.push(snap);
  if (S.edit.history.length > 50) S.edit.history.shift();
}
function undoEdit() {
  const ed = S.edit;
  if (!ed || !ed.history.length) return;
  ed.items = JSON.parse(ed.history.pop());
  ed.sel = null;
  ed.dirty = ed.history.length > 0;
  refreshEdit();
}
function deleteSelected() {
  const ed = S.edit;
  if (!ed || !ed.sel) return;
  pushHistory(snapshot());
  ed.items = ed.items.filter((i) => i.id !== ed.sel);
  ed.sel = null;
  ed.dirty = true;
  refreshEdit();
}

// Called from the map's pointer handling; returns a gesture, or null to let the map pan.
function editPointerDown(e) {
  const ed = S.edit;
  const p = toBase(e);
  if (ed.mode === "rooms") {
    return ed.tool === "split" ? { type: "edit-line", a: [p.x, p.y], x0: e.clientX, y0: e.clientY } : null;
  }
  if (ed.tool !== "select") {
    if (pointsUsed(ed.items) + (ed.tool === "wall" ? 2 : 4) > EDIT_LIMIT) {
      toast("The robot can't store more walls or zones. Delete one first.");
      return null;
    }
    ed.draft = { type: ed.tool, a: [p.x, p.y], b: [p.x, p.y] };
    return { type: "edit-draft" };
  }
  const handle = e.target.closest("[data-handle]");
  if (handle && ed.sel) {
    return { type: "edit-handle", index: Number(handle.dataset.handle), before: snapshot(), x0: e.clientX, y0: e.clientY, moved: false };
  }
  const shape = e.target.closest("[data-rid]");
  if (shape) {
    ed.sel = shape.dataset.rid;
    refreshEdit();
    return { type: "edit-move", start: p, orig: itemPx(selectedItem()), before: snapshot(), x0: e.clientX, y0: e.clientY, moved: false };
  }
  if (ed.sel) { ed.sel = null; refreshEdit(); }
  return null;
}

function editPointerMove(e, g) {
  const ed = S.edit;
  const p = toBase(e);
  if (g.type === "edit-draft") { ed.draft.b = [p.x, p.y]; renderShapes(); return; }
  if (g.type === "edit-line") { ed.line = [g.a, [p.x, p.y]]; renderShapes(); return; }
  if (!g.moved && Math.hypot(e.clientX - g.x0, e.clientY - g.y0) < 3) return;
  g.moved = true;
  ed.drag = true;
  const it = selectedItem();
  if (!it) return;
  if (g.type === "edit-move") {
    const dx = p.x - g.start.x, dy = p.y - g.start.y;
    setItemPx(it, g.orig.map(([x, y]) => [x + dx, y + dy]));
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

function editPointerUp(e, g) {
  const ed = S.edit;
  ed.drag = false;
  if (g.type === "edit-draft") {
    const { type, a, b } = ed.draft;
    ed.draft = null;
    const min = (0.3 / 0.05) * S.map.scale; // 30cm
    const ok = type === "wall"
      ? Math.hypot(b[0] - a[0], b[1] - a[1]) >= min
      : Math.abs(b[0] - a[0]) >= min && Math.abs(b[1] - a[1]) >= min;
    if (!ok) {
      toast(type === "wall" ? "Drag a little further to draw a wall" : "Drag a little further to draw a zone");
      refreshEdit();
      return;
    }
    pushHistory(snapshot());
    const it = { id: `new-${Date.now()}`, type, mm: [] };
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

function renderEditFoot() {
  const ed = S.edit;
  const foot = $("#map-foot");
  if (ed.mode === "walls") {
    const it = selectedItem();
    const hint = ed.tool === "wall" ? "Drag across the map to draw an invisible wall. The robot won't cross it."
      : ed.tool === "no_go" ? "Drag to draw a no-go zone. The robot stays out of it."
      : ed.tool === "no_mop" ? "Drag to draw a no-mop zone. The robot vacuums there but won't mop."
      : it ? `${RESTRICTION_LABEL[it.type]} selected. Drag to move it${canResize(it) ? ", drag the dots to resize" : ""}, or delete it.`
      : "Click a wall or zone to change it, or pick a tool to add one.";
    const warn = S.map.no_carpet_zones
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
  let html;
  if (ed.tool === "merge") {
    html = ed.rooms.length === 2
      ? `<span class="hint"><b>${esc(roomName(ed.rooms[0]))}</b> + <b>${esc(roomName(ed.rooms[1]))}</b></span>
         <div class="foot-actions"><button class="btn-soft" data-act="edit-clear">Clear</button><button class="btn-small-primary" data-act="room-merge">Merge rooms</button></div>`
      : `<span class="hint">Click two rooms next to each other to merge them into one.</span>`;
  } else if (ed.tool === "split") {
    html = ed.line && ed.rooms.length
      ? `<span class="hint">Split <b>${esc(roomName(ed.rooms[0]))}</b> along the line.</span>
         <div class="foot-actions"><button class="btn-soft" data-act="edit-clear">Redraw</button><button class="btn-small-primary" data-act="room-split">Split room</button></div>`
      : `<span class="hint">Drag a line straight across the room you want to split, from wall to wall.</span>`;
  } else {
    const id = ed.rooms[0];
    if (!id) {
      html = `<span class="hint">Click a room to rename it.</span>`;
    } else {
      if (document.activeElement && document.activeElement.id === "rename-input") return; // don't wipe what's being typed
      const room = S.map.rooms.find((r) => r.id === id) || {};
      html = `<form class="rename" id="rename-form">
          <input class="field" id="rename-input" maxlength="30" value="${esc(room.name || "")}" placeholder="${esc(room.original || "")}" aria-label="Room name" autocomplete="off">
          <button class="btn-small-primary" type="submit">Save name</button>
          ${room.nickname ? `<button class="btn-soft" type="button" data-act="room-reset-name">Use “${esc(room.original)}”</button>` : ""}
        </form>
        <span class="hint small">Only changes the name in this app. Rename it in the Roborock app to change it everywhere.</span>`;
    }
  }
  foot.innerHTML = html;
}

function editRoomClick(e, p) {
  const ed = S.edit;
  if (document.activeElement && document.activeElement.id === "rename-input") document.activeElement.blur();
  if (ed.mode !== "rooms" || ed.tool === "split") return;
  const label = e.target.closest("[data-room]");
  const id = label ? Number(label.dataset.room) : roomAt(p);
  if (!id) return;
  if (ed.tool === "merge") {
    const i = ed.rooms.indexOf(id);
    if (i >= 0) ed.rooms.splice(i, 1);
    else { ed.rooms.push(id); if (ed.rooms.length > 2) ed.rooms.shift(); }
  } else {
    ed.rooms = ed.rooms[0] === id ? [] : [id];
  }
  refreshMapOverlays();
  if (ed.tool === "rename" && ed.rooms.length) setTimeout(() => { const i = $("#rename-input"); if (i) { i.focus(); i.select(); } }, 0);
}

function refreshMapSoon() {
  // The robot takes a moment to rebuild its map after an edit.
  for (const ms of [800, 2500, 6000]) setTimeout(() => pollMap(true), ms);
}

async function saveRestrictions(btn) {
  const ed = S.edit;
  try {
    await doAction("save_restrictions", { items: ed.items.map(({ type, mm }) => ({ type, mm })) }, { button: btn, okMsg: "Saved to the robot" });
    Object.assign(ed, { dirty: false, history: [], sel: null });
    refreshEdit();
    refreshMapSoon();
  } catch { /* toast shown */ }
}

async function mergeRooms(btn) {
  const [a, b] = S.edit.rooms;
  if (!confirm(`Merge ${roomName(a)} and ${roomName(b)} into one room?\n\nThis changes the map on your robot. You can split it again later.`)) return;
  try {
    await doAction("merge_rooms", { rooms: [a, b] }, { button: btn, okMsg: "Rooms merged" });
    S.edit.rooms = [];
    refreshMapOverlays();
    refreshMapSoon();
  } catch { /* toast shown */ }
}

async function splitRoom(btn) {
  const ed = S.edit;
  const room = ed.rooms[0];
  const [[x0, y0], [x1, y1]] = ed.line;
  if (!confirm(`Split ${roomName(room)} along the line?\n\nThis changes the map on your robot. You can merge the parts again later.`)) return;
  try {
    await doAction("split_room", { room, line: [...pxToMm(x0, y0), ...pxToMm(x1, y1)] }, { button: btn, okMsg: "Room split" });
    Object.assign(ed, { line: null, rooms: [] });
    refreshMapOverlays();
    refreshMapSoon();
  } catch { /* toast shown */ }
}

async function renameRoom(name, btn) {
  const room = S.edit && S.edit.rooms[0];
  if (!room) return;
  try {
    await doAction("rename_room", { room, name }, { button: btn, okMsg: name ? "Name saved" : "Back to the original name" });
    await pollMap(true);
    refreshMapOverlays();
  } catch { /* toast shown */ }
}

document.addEventListener("submit", (e) => {
  if (e.target.id !== "rename-form") return;
  e.preventDefault();
  const input = $("#rename-input");
  const name = input.value.trim();
  input.blur();
  renameRoom(name, e.submitter);
});

document.addEventListener("keydown", (e) => {
  const ed = S.edit;
  if (!ed || S.tab !== "home" || e.target.closest("input, select, textarea")) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undoEdit(); return; }
  if ((e.key === "Delete" || e.key === "Backspace") && ed.sel) { e.preventDefault(); deleteSelected(); return; }
  if (e.key === "Escape") {
    e.preventDefault();
    if (ed.draft || ed.line) { ed.draft = null; ed.line = null; }
    else if (ed.sel) ed.sel = null;
    else if (ed.rooms.length) ed.rooms = [];
    else if (ed.tool !== EDIT_TOOLS[ed.mode][0][0]) { setEditTool(EDIT_TOOLS[ed.mode][0][0]); return; }
    refreshMapOverlays();
  }
});

inner.addEventListener("click", (e) => {
  if (!S.map) return;
  if (S.suppressClick) { S.suppressClick = false; return; }
  const p = toBase(e);
  if (S.edit) { editRoomClick(e, p); return; }
  if (S.tool === "rooms") {
    const label = e.target.closest("[data-room]");
    const id = label ? Number(label.dataset.room) : roomAt(p);
    if (id) toggleRoom(id);
  } else if (S.tool === "goto") {
    if (!roomAt(p)) { toast("Pick a spot inside your home"); return; }
    S.pin = p;
    refreshMapOverlays();
  }
});

$("#map-tools").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tool]");
  if (b) setTool(b.dataset.tool);
});

$("#map-select").addEventListener("change", async (e) => {
  try {
    await doAction("select_map", { flag: Number(e.target.value) }, { okMsg: "Switching map…" });
    endEdit(true);
    S.map = null;
    resetView(false);
    mapEmpty(`<div class="spinner"></div>Loading map…`);
    setTimeout(() => pollMap(true), 1500);
  } catch { /* toast shown */ }
});

/* ---------------- settings ---------------- */
async function loadSettings() {
  const el = $("#settings");
  if (!S.settings) {
    el.innerHTML = [1, 2, 3, 4].map(() => `<div class="card"><div class="skel" style="height:18px;width:40%"></div><div class="skel" style="height:40px;margin-top:18px"></div><div class="skel" style="height:40px;margin-top:12px"></div></div>`).join("");
  }
  try {
    S.settings = await api(`/api/devices/${encodeURIComponent(S.duid)}/settings`);
    renderSettings();
  } catch (e) {
    el.innerHTML = `<div class="card">Couldn't load settings.<br><span class="muted">${esc(e.message)}</span></div>`;
  }
}

function sw(action, on) {
  return `<label class="switch"><input type="checkbox" data-switch="${action}" ${on ? "checked" : ""}><span></span></label>`;
}

function row(iconName, title, sub, control) {
  return `<div class="row"><div class="row-main"><span class="row-icon">${icon(iconName)}</span><div><div class="row-title">${title}</div>${sub ? `<div class="row-sub">${sub}</div>` : ""}</div></div>${control}</div>`;
}

function renderSettings() {
  const s = S.settings;
  const cards = [];

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

  // DND
  if (s.dnd) {
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("moon")}Do not disturb</h3>${sw("dnd", s.dnd.enabled)}</div>
      <div class="note" style="margin:0">No cleaning, voice or auto-empty during these hours.</div>
      <div class="time-row"><label>From<input type="time" id="dnd-start" value="${esc(s.dnd.start)}"></label><label>Until<input type="time" id="dnd-end" value="${esc(s.dnd.end)}"></label></div></div>`);
  }

  // Dock
  let dock = "";
  const choice = (action, opt) => `<div class="seg small" style="margin-top:10px">${opt.options.map((o) => `<button data-choice="${action}" data-value="${esc(o)}" class="${o === opt.value ? "active" : ""}">${esc(OPT_LABEL[o] || human(o))}</button>`).join("")}</div>`;
  if (s.dust_mode) dock += `<div class="row stack"><div class="row-main"><span class="row-icon">${icon("trash")}</span><div><div class="row-title">Auto-empty</div><div class="row-sub">How hard the dock empties the dust bin</div></div></div>${choice("set_dust_mode", s.dust_mode)}</div>`;
  if (s.wash_mode) dock += `<div class="row stack"><div class="row-main"><span class="row-icon">${icon("waves")}</span><div><div class="row-title">Mop washing</div><div class="row-sub">How thoroughly the dock washes the mop</div></div></div>${choice("set_wash_mode", s.wash_mode)}</div>`;
  if (s.smart_wash) dock += row("spark", "Smart mop washing", "Let the robot decide when to rewash", sw("set_smart_wash", s.smart_wash.enabled));
  if (s.mop_dryer) {
    const h = s.mop_dryer.dry_time ? ` · ${Math.round(s.mop_dryer.dry_time / 3600)} h` : "";
    dock += row("sun", "Auto mop drying", `Dry the mop with warm air after washing${h}`, sw("set_mop_dryer", s.mop_dryer.enabled));
  }
  if (dock) cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("dock")}Dock</h3></div>${dock}</div>`);

  // Maintenance
  if (s.consumables && s.consumables.length) {
    const items = s.consumables.map((c) => {
      const left = c.unit === "s" ? `${Math.round(c.left / 3600)} h left` : `${c.left} uses left`;
      const cls = c.percent < 10 ? "low" : c.percent < 30 ? "mid" : "";
      return `<div class="cons"><div class="cons-top"><b>${esc(c.name)}</b><span>${left} · ${c.percent}%<button data-reset="${esc(c.key)}" data-name="${esc(c.name)}">Reset</button></span></div><div class="bar ${cls}"><i style="width:${c.percent}%"></i></div></div>`;
    }).join("");
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("wrench")}Maintenance</h3></div>${items}<div class="note">Reset after you clean or replace a part.</div></div>`);
  }

  // Routines
  if (s.routines && s.routines.length) {
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
    if (sm.last) hist += `<dl class="kv"><dt>Last clean</dt><dd>${fmtWhen(sm.last.begin)}</dd><dt>Duration</dt><dd>${fmtDuration(sm.last.duration)}</dd><dt>Area</dt><dd>${fmtArea(sm.last.area)}</dd><dt>Finished</dt><dd>${sm.last.complete ? "Yes" : "No"}</dd></dl>`;
    cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("history")}History</h3></div>${hist}</div>`);
  }

  // About
  const d = s.device || {};
  const n = s.network || {};
  cards.push(`<div class="card"><div class="card-head"><h3 class="card-title">${icon("info")}About</h3></div>
    <dl class="kv">
      <dt>Model</dt><dd>${esc(d.product || d.model || "–")}</dd>
      ${d.firmware ? `<dt>Firmware</dt><dd>${esc(d.firmware)}</dd>` : ""}
      ${n.ip ? `<dt>IP address</dt><dd>${esc(n.ip)}</dd>` : ""}
      ${n.ssid ? `<dt>Wi‑Fi</dt><dd>${esc(n.ssid)}${n.rssi ? ` · ${n.rssi} dBm` : ""}</dd>` : ""}
      <dt>Connection</dt><dd>${d.local ? "Local network" : "Roborock cloud"}</dd>
      <dt>Account</dt><dd>${esc((S.auth && S.auth.email) || "–")}</dd>
    </dl>
    <div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn-soft" data-act="refresh-settings">Refresh</button>
      ${S.auth && S.auth.demo ? "" : `<button class="btn-soft danger" data-act="logout">${icon("logout")}Sign out</button>`}
    </div></div>`);

  $("#settings").innerHTML = cards.join("");

  const vol = $("#vol");
  if (vol) {
    vol.oninput = () => ($("#vol-out").textContent = vol.value);
    vol.onchange = () => doAction("set_volume", { value: Number(vol.value) }, { okMsg: "Volume saved" }).catch(() => {});
  }
  const sendDnd = () => {
    const on = $("[data-switch=dnd]").checked;
    S.settings.dnd = { enabled: on, start: $("#dnd-start").value, end: $("#dnd-end").value };
    doAction("set_dnd", S.settings.dnd, { okMsg: on ? "Do not disturb saved" : "Do not disturb off" }).catch(() => {});
  };
  if ($("#dnd-start")) {
    $("#dnd-start").onchange = sendDnd;
    $("#dnd-end").onchange = sendDnd;
  }
  S.sendDnd = sendDnd;
}

const SETTING_KEY = { set_child_lock: "child_lock", set_led: "led", set_flow_led: "flow_led", set_carpet_boost: "carpet_boost" };
document.addEventListener("change", async (e) => {
  const t = e.target;
  if (!t.matches("[data-switch]")) return;
  const action = t.dataset.switch;
  if (action === "dnd") return S.sendDnd && S.sendDnd();
  const on = t.checked;
  try {
    if (action === "set_smart_wash") await doAction(action, { enabled: on }, { okMsg: "Saved" });
    else await doAction(action, { on }, { okMsg: "Saved" });
    const s = S.settings;
    if (SETTING_KEY[action]) s[SETTING_KEY[action]] = on;
    if (action === "set_mop_dryer") s.mop_dryer.enabled = on;
    if (action === "set_smart_wash") s.smart_wash.enabled = on;
  } catch {
    t.checked = !on;
  }
});

/* ---------------- global clicks ---------------- */
document.addEventListener("click", async (e) => {
  const t = e.target.closest("button");
  if (!t) return;

  if (t.dataset.tab) {
    S.tab = t.dataset.tab;
    $$(".tabs button").forEach((b) => b.classList.toggle("active", b === t));
    $("#tab-home").hidden = S.tab !== "home";
    $("#tab-settings").hidden = S.tab !== "settings";
    if (S.tab === "settings") loadSettings();
    else fitMap();
    window.scrollTo({ top: 0 });
    return;
  }
  if (t.dataset.view) return setViewMode(t.dataset.view);
  if (t.dataset.etool) return setEditTool(t.dataset.etool);
  if (t.dataset.emode) return setEditMode(t.dataset.emode);
  if (t.dataset.repeat) {
    S.repeat = Number(t.dataset.repeat);
    renderActions();
    return;
  }
  if (t.dataset.cmode) return setModeValue("cleaning", t.dataset.cmode, "set_cleaning_mode", { mode: t.dataset.cmode });
  if (t.dataset.fan) return setModeValue("fan", Number(t.dataset.fan), "set_fan", { code: Number(t.dataset.fan) });
  if (t.dataset.water) return setModeValue("water", Number(t.dataset.water), "set_water", { code: Number(t.dataset.water) });
  if (t.dataset.mop) return setModeValue("mop", Number(t.dataset.mop), "set_mop", { code: Number(t.dataset.mop) });

  if (t.dataset.choice) {
    const key = t.dataset.choice === "set_dust_mode" ? "dust_mode" : "wash_mode";
    const prev = S.settings[key].value;
    S.settings[key].value = t.dataset.value;
    renderSettings();
    try { await doAction(t.dataset.choice, { value: t.dataset.value }, { okMsg: "Saved" }); }
    catch { S.settings[key].value = prev; renderSettings(); }
    return;
  }
  if (t.dataset.reset) {
    if (!confirm(`Reset the ${t.dataset.name.toLowerCase()} counter? Do this after cleaning or replacing it.`)) return;
    try { await doAction("reset_consumable", { key: t.dataset.reset }, { okMsg: `${t.dataset.name} reset` }); loadSettings(); } catch { /* toast */ }
    return;
  }
  if (t.dataset.routine) {
    doAction("run_routine", { id: Number(t.dataset.routine) }, { button: t }).catch(() => {});
    return;
  }

  const act = t.dataset.act;
  if (!act) return;
  switch (act) {
    case "reload": return location.reload();
    case "logout": return logout();
    case "refresh-settings": return loadSettings();
    case "edit-start": return startEdit();
    case "dismiss-update":
      S.updateDismissed = true;
      $("#update-banner").hidden = true;
      return;
    case "edit-done": return endEdit();
    case "edit-save": return saveRestrictions(t);
    case "edit-undo": return undoEdit();
    case "edit-delete": return deleteSelected();
    case "edit-discard":
      if (!confirm("Discard your unsaved wall and zone changes?")) return;
      Object.assign(S.edit, { items: copyRestrictions(), sel: null, dirty: false, history: [] });
      return refreshEdit();
    case "edit-clear":
      Object.assign(S.edit, { rooms: [], line: null });
      return refreshMapOverlays();
    case "room-merge": return mergeRooms(t);
    case "room-split": return splitRoom(t);
    case "room-reset-name": return renameRoom("", t);
    case "clear-sel":
      S.selected = []; S.zone = null; S.pin = null;
      return refreshMapOverlays();
    default:
      if (act === "stop" && S.status && S.status.job && !confirm("Stop the current cleaning job?")) return;
      doAction(act, {}, { button: t }).catch(() => {});
  }
});

$("#device-select").addEventListener("change", (e) => {
  S.duid = e.target.value;
  try { localStorage.setItem("duid", S.duid); } catch { /* storage blocked */ }
  endEdit(true);
  S.status = null; S.map = null; S.mask = null; S.settings = null;
  resetView(false);
  S.selected = []; S.zone = null; S.pin = null;
  mapEmpty(`<div class="spinner"></div>Loading map…`);
  renderSkeletons();
  startLoops();
  if (S.tab === "settings") loadSettings();
});

/* ---------------- boot ---------------- */
syncViewChrome();
$$("[data-icon]").forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
refreshAuth();
