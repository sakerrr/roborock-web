// The app's one shared state object. Modules read and update it directly.

import type { Auth, Device, Freshness, MapPayload, Mask, Point, RestrictionType, Settings, Status } from "./types";

export type Tool = "rooms" | "zone" | "goto";
export type ViewMode = "2d" | "3d" | "plan" | "fresh";
export type Pt = [number, number];
export type EditTool = "select" | RestrictionType | "merge" | "split" | "rename";

export interface EditItem {
  id: string;
  type: RestrictionType;
  mm: number[];
}

export interface EditState {
  mode: "walls" | "rooms";
  tool: EditTool;
  items: EditItem[]; // walls & zones being edited, in device mm
  sel: string | null;
  dirty: boolean;
  history: string[]; // JSON snapshots of items, for undo
  rooms: number[]; // rooms picked for merge / split / rename
  line: [Pt, Pt] | null; // split line, base px
  draft: { type: RestrictionType; a: Pt; b: Pt } | null;
  drag: boolean;
}

/** Things you can show or hide on every map view. */
export interface Layers {
  path: boolean;
  carpets: boolean;
  obstacles: boolean;
  restrictions: boolean;
}

export interface Pending {
  cleaning?: string;
  fan?: number;
  water?: number;
  mop?: number;
}

export interface AppState {
  auth: Auth | null;
  devices: Device[];
  duid: string | null;
  status: Status | null;
  map: MapPayload | null;
  mask: Mask | null;
  selected: number[];
  jobRooms: number[] | null; // rooms of the room clean in progress
  jobArea: number | null; // m² (times passes) of the clean started here, for "time left"
  edit: EditState | null;
  viewMode: ViewMode;
  layers: Layers;
  view: { s: number; tx: number; ty: number }; // 2D pan & zoom
  tool: Tool;
  zone: [number, number, number, number] | null; // base px
  pin: Point | null;
  drag: Point | null;
  repeat: number | null; // passes picked for the next clean; null follows the robot's own setting
  hover: number;
  settings: Settings | null;
  fresh: Freshness | null; // room freshness, loaded for the Freshness view
  freshAge: Mask | null; // its per-block ages, decoded
  tab: "home" | "settings";
  pending: Pending; // mode changes waiting for the robot's answer
  lastMapAt: number;
  mapLoading: boolean;
  statusLoading: boolean;
  suppressClick: boolean;
  updateDismissed: boolean;
}

function savedViewMode(): ViewMode {
  try {
    const v = localStorage.getItem("view");
    return v === "3d" || v === "plan" || v === "fresh" ? v : "2d";
  } catch {
    return "2d";
  }
}

function savedLayers(): Layers {
  const all: Layers = { path: true, carpets: true, obstacles: true, restrictions: true };
  try {
    return { ...all, ...(JSON.parse(localStorage.getItem("layers") || "{}") as Partial<Layers>) };
  } catch {
    return all;
  }
}

export const S: AppState = {
  auth: null,
  devices: [],
  duid: null,
  status: null,
  map: null,
  mask: null,
  selected: [],
  jobRooms: null,
  jobArea: null,
  edit: null,
  viewMode: savedViewMode(),
  layers: savedLayers(),
  view: { s: 1, tx: 0, ty: 0 },
  tool: "rooms",
  zone: null,
  pin: null,
  drag: null,
  repeat: null,
  hover: 0,
  settings: null,
  fresh: null,
  freshAge: null,
  tab: "home",
  pending: {},
  lastMapAt: 0,
  mapLoading: false,
  statusLoading: false,
  suppressClick: false,
  updateDismissed: false,
};
