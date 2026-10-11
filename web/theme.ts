// Light or dark: follow the Mac (Auto), or pick one. The choice is remembered in this
// browser. A small script in index.html applies it before the first paint; this keeps
// it up to date and tells the views that draw with theme colours to redraw.

import { $, $$, icon, toast } from "./dom";

export type ThemePref = "auto" | "light" | "dark";

const media = window.matchMedia("(prefers-color-scheme: dark)");
const LABEL: Record<ThemePref, string> = { auto: "Auto (follows your Mac)", light: "Light", dark: "Dark" };
const ICON: Record<ThemePref, string> = { auto: "contrast", light: "sun", dark: "moon" };
const NEXT: Record<ThemePref, ThemePref> = { auto: "light", light: "dark", dark: "auto" };

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem("theme");
    return v === "light" || v === "dark" ? v : "auto";
  } catch {
    return "auto";
  }
}

function applyTheme(): void {
  const pref = themePref();
  const theme = pref === "dark" || (pref === "auto" && media.matches) ? "dark" : "light";
  const root = document.documentElement;
  if (root.dataset.theme !== theme) {
    root.dataset.theme = theme;
    document.dispatchEvent(new CustomEvent("themechange"));
  }
  renderThemeControls();
}

export function setThemePref(pref: ThemePref): void {
  try {
    localStorage.setItem("theme", pref);
  } catch {
    // storage blocked: still switch for now
  }
  applyTheme();
}

function renderThemeControls(): void {
  const pref = themePref();
  const btn = $("#theme-btn");
  btn.innerHTML = icon(ICON[pref]);
  btn.title = `Theme: ${LABEL[pref]}. Click for ${LABEL[NEXT[pref]].split(" ")[0]}`;
  btn.setAttribute("aria-label", `Theme: ${LABEL[pref]}`);
  $$<HTMLButtonElement>("[data-theme-pref]").forEach((b) => b.classList.toggle("active", b.dataset.themePref === pref));
}

$("#theme-btn").addEventListener("click", () => {
  const next = NEXT[themePref()];
  setThemePref(next);
  toast(`Theme: ${LABEL[next]}`);
});

// The Appearance choice in Settings (it's re-rendered with the settings).
document.addEventListener("click", (e) => {
  const b = e.target instanceof Element ? e.target.closest<HTMLButtonElement>("[data-theme-pref]") : null;
  if (b) setThemePref(b.dataset.themePref as ThemePref);
});

media.addEventListener("change", applyTheme);
applyTheme();

/** The segmented Auto / Light / Dark control, for Settings. */
export function themeChoice(): string {
  const pref = themePref();
  return `<div class="seg small theme-choice">${(Object.keys(LABEL) as ThemePref[])
    .map((p) => `<button data-theme-pref="${p}" class="${p === pref ? "active" : ""}">${icon(ICON[p])}${p === "auto" ? "Auto" : LABEL[p]}</button>`)
    .join("")}</div>`;
}
