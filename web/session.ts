// Signing in, finding the robots, and polling status and map.

import { api, devicePath } from "./api";
import { $, busyBtn, errorMessage, esc, icon, toast } from "./dom";
import { mapEmpty, setMap } from "./map/core";
import { preload3D } from "./map/views";
import { renderSkeletons, setConn, setStatus } from "./panels";
import { loadSettings } from "./settings";
import { S } from "./state";
import type { Auth, Device, MapResponse, Status } from "./types";

export async function refreshAuth(): Promise<void> {
  let auth: Auth;
  try {
    auth = await api<Auth>("/api/auth");
  } catch (e) {
    document.body.innerHTML = `<div class="center-msg">Can't reach the local server.<br>${esc(errorMessage(e))}</div>`;
    return;
  }
  S.auth = auth;
  checkForUpdate(auth);
  if (!auth.logged_in) {
    showLogin();
    return;
  }
  $("#login-view").hidden = true;
  $("#app-view").hidden = false;
  await loadDevices();
}

// Python changes only take effect after a restart; say so instead of failing quietly.
export function checkForUpdate(auth: Auth | null): void {
  if (auth?.restart_needed && !S.updateDismissed) $("#update-banner").hidden = false;
}

function showLogin(): void {
  const auth = S.auth;
  if (!auth) return;
  $("#app-view").hidden = true;
  $("#login-view").hidden = false;
  const codeStep = auth.code_sent;
  $("#login-step-email").hidden = codeStep;
  $("#login-step-code").hidden = !codeStep;
  if (codeStep) {
    $("#code-email").textContent = auth.email || "";
    $("#code-note").textContent = auth.code_note || "";
    $("#code-note").hidden = !auth.code_note;
    $("#code-sent-to").hidden = !!auth.code_note;
    $("#code-title").textContent = auth.code_note ? "Enter your code" : "Check your inbox";
    $<HTMLInputElement>("#code").focus();
  } else {
    const email = $<HTMLInputElement>("#email");
    if (auth.email) email.value = auth.email;
    email.focus();
  }
}

async function toCodeStep(btn: HTMLButtonElement, send: boolean): Promise<void> {
  $("#email-err").textContent = "";
  busyBtn(btn, true);
  try {
    S.auth = await api<Auth>("/api/auth/code", { method: "POST", body: { email: $<HTMLInputElement>("#email").value, send } });
    showLogin();
  } catch (err) {
    $("#email-err").textContent = errorMessage(err);
  } finally {
    busyBtn(btn, false);
  }
}

$<HTMLFormElement>("#email-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void toCodeStep($<HTMLButtonElement>("#email-form button[type=submit]"), true);
});

// A code from an earlier email still works for a while; no need to ask for another.
$<HTMLButtonElement>("#have-code").addEventListener("click", (e) => {
  const email = $<HTMLInputElement>("#email");
  if (!email.reportValidity()) return;
  void toCodeStep(e.currentTarget as HTMLButtonElement, false);
});

$<HTMLFormElement>("#code-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $<HTMLButtonElement>("#code-form button[type=submit]");
  $("#code-err").textContent = "";
  busyBtn(btn, true);
  try {
    await api<Auth>("/api/auth/login", { method: "POST", body: { code: $<HTMLInputElement>("#code").value } });
    await refreshAuth();
  } catch (err) {
    $("#code-err").textContent = errorMessage(err);
  } finally {
    busyBtn(btn, false);
  }
});

$<HTMLButtonElement>("#resend-code").addEventListener("click", async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  if (!S.auth?.email) return;
  $("#code-err").textContent = "";
  busyBtn(btn, true);
  try {
    S.auth = await api<Auth>("/api/auth/code", { method: "POST", body: { email: S.auth.email, send: true } });
    showLogin();
    if (!S.auth.code_note) toast("New code sent. Check your inbox");
  } catch (err) {
    $("#code-err").textContent = errorMessage(err);
  } finally {
    busyBtn(btn, false);
  }
});

$("#change-email").addEventListener("click", () => {
  if (S.auth) S.auth.code_sent = false;
  showLogin();
});

export async function logout(): Promise<void> {
  const ok = confirm(
    "Sign out of your Roborock account on this computer?\n\n" +
      "Signing back in needs a new code by email, and Roborock only sends a few an hour. " +
      "If the robot isn't responding, try Reconnect instead.",
  );
  if (!ok) return;
  await api("/api/auth/logout", { method: "POST" });
  location.reload();
}

/** Connect to Roborock again with the saved sign-in, without asking for a new code. */
export async function reconnect(btn?: HTMLButtonElement | null): Promise<void> {
  if (btn) busyBtn(btn, true);
  try {
    S.auth = await api<Auth>("/api/reconnect", { method: "POST" });
    toast(S.auth.error ? `Still can't connect: ${S.auth.error}` : "Reconnected", !!S.auth.error);
  } catch (e) {
    toast(errorMessage(e), true);
  } finally {
    if (btn) busyBtn(btn, false);
  }
  S.status = null;
  S.settings = null;
  await refreshAuth();
}

/* ---------------- robots & polling ---------------- */

export function centerMsg(html: string | null): void {
  const el = $("#center-msg");
  el.hidden = !html;
  el.innerHTML = html || "";
  $("#tab-home").hidden = !!html || S.tab !== "home";
  $("#tab-settings").hidden = !!html || S.tab !== "settings";
}

async function loadDevices(): Promise<void> {
  centerMsg(`<div><div class="spinner"></div>Connecting to your robot…</div>`);
  try {
    S.devices = await api<Device[]>("/api/devices");
  } catch (e) {
    centerMsg(`<div>Couldn't load your robots.<br><span class="muted">${esc(errorMessage(e))}</span><br><br><button class="btn-soft" data-act="reload">Try again</button></div>`);
    return;
  }
  const supported = S.devices.filter((d) => d.supported);
  if (!supported.length) {
    const auth = await api<Auth>("/api/auth").catch(() => null);
    const why = auth?.error
      ? `Couldn't connect to Roborock: <span class="muted">${esc(auth.error)}</span>`
      : S.devices.length
        ? "Your robots use a protocol this app doesn't support yet."
        : "No robots found on this account.";
    centerMsg(`<div>${why}<br><br><button class="btn-soft" data-act="reconnect">Reconnect</button> <button class="btn-soft danger" data-act="logout">${icon("logout")}Sign out</button></div>`);
    return;
  }
  let saved: string | null = null;
  try {
    saved = localStorage.getItem("duid");
  } catch {
    // storage blocked
  }
  S.duid = supported.some((d) => d.duid === saved) ? saved : supported[0].duid;
  const sel = $<HTMLSelectElement>("#device-select");
  if (supported.length > 1) {
    sel.innerHTML = supported.map((d) => `<option value="${esc(d.duid)}">${esc(d.name)}</option>`).join("");
    sel.value = S.duid ?? "";
    sel.hidden = false;
    $("#robot-name").hidden = true;
  }
  centerMsg(null);
  renderSkeletons();
  startLoops();
}

let loopsStarted = false;

export function startLoops(): void {
  void pollStatus();
  void pollMap(true);
  if (loopsStarted) return;
  loopsStarted = true;
  setInterval(() => !document.hidden && void pollStatus(), 2500);
  setInterval(() => !document.hidden && void pollMap(), 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    void pollStatus();
    void pollMap();
    api<Auth>("/api/auth").then(checkForUpdate).catch(() => {});
  });
}

async function pollStatus(): Promise<void> {
  if (S.statusLoading || !S.duid) return;
  S.statusLoading = true;
  try {
    setStatus(await api<Status>(devicePath("status")));
  } catch (e) {
    setConn(false, errorMessage(e));
  } finally {
    S.statusLoading = false;
  }
}

let warmed = false;

// Once the map is up, get the rest ready in the background: the 3D code, and the
// settings, so opening either is instant.
function warmUp(): void {
  if (warmed) return;
  warmed = true;
  preload3D();
  setTimeout(() => {
    if (!S.settings && S.tab !== "settings") void loadSettings();
  }, 3000);
}

function mapInterval(): number {
  const ph = S.status?.phase;
  return ph === "cleaning" || ph === "returning" ? 3000 : 20000;
}

export async function pollMap(force = false): Promise<void> {
  if (S.mapLoading || !S.duid) return;
  if (!force && Date.now() - S.lastMapAt < mapInterval()) return;
  S.mapLoading = true;
  S.lastMapAt = Date.now();
  try {
    // `since`: nothing changed, nothing sent. `img`: the images it has, so only what changed is sent.
    const q = new URLSearchParams();
    if (S.map && !force) q.set("since", S.map.version);
    if (S.map && S.mask) q.set("img", S.map.image);
    const qs = q.toString();
    const m = await api<MapResponse>(devicePath(`map${qs ? `?${qs}` : ""}`));
    if (!m.available) mapEmpty("No map yet. Run a full clean once so the robot can learn your home.");
    else if (!m.unchanged) {
      const first = !S.map;
      await setMap(m);
      if (first) warmUp();
      if (m.stale) setTimeout(() => void pollMap(true), 2500); // a saved map: the fresh one is on its way
    }
  } catch (e) {
    if (!S.map) mapEmpty(`Couldn't load the map.<br><span class="muted">${esc(errorMessage(e))}</span>`);
  } finally {
    S.mapLoading = false;
  }
}
