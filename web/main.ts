// Entry point: global button handling and start-up.

import { $, $$, closest, icon } from "./dom";
import { mapEmpty, refreshMapOverlays } from "./map/core";
import { fitMap } from "./map/fit";
import {
  clearEditPicks, deleteSelected, discardEdits, endEdit, mergeRooms, renameRoom, saveRestrictions,
  setEditMode, setEditTool, splitRoom, startEdit, undoEdit,
} from "./map/editor";
import { resetView } from "./map/panzoom";
import { setViewMode, show3D, syncViewChrome } from "./map/views";
import { doAction, renderActions, renderSkeletons, setModeValue } from "./panels";
import { logout, reconnect, refreshAuth, startLoops } from "./session";
import { loadSettings, setChoice } from "./settings";
import { S, type EditTool, type ViewMode } from "./state";
import "./theme";

document.addEventListener("click", async (e) => {
  const t = closest<HTMLButtonElement>(e.target, "button");
  if (!t) return;
  const ds = t.dataset;

  if (ds.tab) {
    S.tab = ds.tab === "settings" ? "settings" : "home";
    $$(".tabs button").forEach((b) => b.classList.toggle("active", b === t));
    $("#tab-home").hidden = S.tab !== "home";
    $("#tab-settings").hidden = S.tab !== "settings";
    if (S.tab === "settings") void loadSettings();
    else fitMap();
    window.scrollTo({ top: 0 });
    return;
  }
  if (ds.view) return setViewMode(ds.view as ViewMode);
  if (ds.etool) return setEditTool(ds.etool as EditTool);
  if (ds.emode) return setEditMode(ds.emode === "rooms" ? "rooms" : "walls");
  if (ds.repeat) {
    S.repeat = Number(ds.repeat);
    renderActions();
    return;
  }
  if (ds.cmode) return setModeValue("cleaning", ds.cmode, "set_cleaning_mode", { mode: ds.cmode });
  if (ds.fan) return setModeValue("fan", Number(ds.fan), "set_fan", { code: Number(ds.fan) });
  if (ds.water) return setModeValue("water", Number(ds.water), "set_water", { code: Number(ds.water) });
  if (ds.mop) return setModeValue("mop", Number(ds.mop), "set_mop", { code: Number(ds.mop) });
  if (ds.choice && ds.value) return setChoice(ds.choice, ds.value);
  if (ds.reset) {
    const name = ds.name ?? "part";
    if (!confirm(`Reset the ${name.toLowerCase()} counter? Do this after cleaning or replacing it.`)) return;
    try {
      await doAction("reset_consumable", { key: ds.reset }, { okMsg: `${name} reset` });
      void loadSettings();
    } catch {
      // toast shown
    }
    return;
  }
  if (ds.routine) {
    doAction("run_routine", { id: Number(ds.routine) }, { button: t }).catch(() => {});
    return;
  }

  const act = ds.act;
  if (!act) return;
  switch (act) {
    case "reload":
      return location.reload();
    case "logout":
      return logout();
    case "reconnect":
      return reconnect(t);
    case "refresh-settings":
      return loadSettings();
    case "dismiss-update":
      S.updateDismissed = true;
      $("#update-banner").hidden = true;
      return;
    case "edit-start":
      return startEdit();
    case "edit-done":
      return endEdit();
    case "edit-save":
      return saveRestrictions(t);
    case "edit-undo":
      return undoEdit();
    case "edit-delete":
      return deleteSelected();
    case "edit-discard":
      return discardEdits();
    case "edit-clear":
      return clearEditPicks();
    case "room-merge":
      return mergeRooms(t);
    case "room-split":
      return splitRoom(t);
    case "room-reset-name":
      return renameRoom("", t);
    case "clear-sel":
      S.selected = [];
      S.zone = null;
      S.pin = null;
      return refreshMapOverlays();
    default:
      if (act === "stop" && S.status?.job && !confirm("Stop the current cleaning job?")) return;
      doAction(act, {}, { button: t }).catch(() => {});
  }
});

$<HTMLSelectElement>("#device-select").addEventListener("change", (e) => {
  S.duid = (e.target as HTMLSelectElement).value;
  try {
    localStorage.setItem("duid", S.duid);
  } catch {
    // storage blocked
  }
  endEdit(true);
  S.status = null;
  S.map = null;
  S.mask = null;
  S.settings = null;
  S.fresh = null;
  S.freshAge = null;
  resetView(false);
  S.selected = [];
  S.zone = null;
  S.pin = null;
  mapEmpty(`<div class="spinner"></div>Loading map…`);
  renderSkeletons();
  startLoops();
  if (S.tab === "settings") void loadSettings();
});

/* ---------------- start-up ---------------- */
syncViewChrome();
if (S.viewMode === "3d") void show3D();
$$("[data-icon]").forEach((el) => {
  el.innerHTML = icon(el.dataset.icon ?? "");
});
void refreshAuth();
