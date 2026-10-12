// Shapes of the JSON the Python server sends (see robot.py, demo.py, maprender.py).

export interface Point {
  x: number;
  y: number;
}

export interface Pose extends Point {
  a?: number; // heading in degrees, robot coordinates (y up)
}

export type Phase = "cleaning" | "paused" | "returning" | "dock" | "docked" | "idle" | "error";

export interface ModeOption {
  code: number;
  name: string;
}

export interface CleaningModes {
  cleaning: string | null;
  cleaning_options: string[];
  fan: number | null;
  fan_options: ModeOption[];
  water: number | null;
  water_options: ModeOption[];
  mop: number | null;
  mop_options: ModeOption[];
  repeat?: number | null; // passes when cleaning everywhere (the robot's setting); null if it can't be set
}

export interface DockStatus {
  type: string | null;
  can_empty: boolean;
  can_wash: boolean;
  can_dry: boolean;
  drying: boolean;
  clean_water: string | null;
  dirty_water: string | null;
  dust_bag: string | null;
}

// When the robot can't be reached yet, only the identity fields and a message arrive.
export interface Status {
  links?: Links;
  duid: string;
  name: string;
  model: string;
  product?: string | null;
  connected: boolean;
  local?: boolean;
  message?: string;
  state?: string | null;
  phase?: Phase;
  job?: boolean;
  job_type?: string | null;
  battery?: number | null;
  clean_time?: number | null;
  clean_area?: number | null;
  clean_percent?: number | null;
  error?: string | null;
  dock_error?: string | null;
  map_flag?: number | null;
  mode?: CleaningModes;
  dock?: DockStatus;
}

export interface Room extends Point {
  id: number;
  name: string;
  original: string;
  nickname: boolean;
  area?: number; // m²
  w?: number; // bounding size in m
  h?: number;
}

export type RestrictionType = "wall" | "no_go" | "no_mop";

export interface Restriction {
  id: string;
  type: RestrictionType;
  mm: number[]; // device millimetres: x1, y1, x2, y2, …
}

// base px <-> device mm: x_mm = (px / scale + left) * mm, y_mm = (top + height - 1 - py / scale) * mm
export interface MapFrame {
  top: number;
  left: number;
  height: number;
  scale: number;
  mm: number;
}

/** A polyline in base-image px. */
export type Polyline = [number, number][];

export type ObstacleKind = "cable" | "pet_waste" | "shoes" | "clothes" | "pet" | "furniture" | "obstacle";

export interface Obstacle extends Point {
  kind: ObstacleKind;
  label: string;
  photo: boolean;
}

export interface MapPayload {
  available: true;
  unchanged?: undefined;
  version: string;
  width: number;
  height: number;
  scale: number;
  image: string; // version of base + mask: the server leaves them out when the browser has it
  base: string; // data URL
  mask: string; // data URL; see maprender.py for the channel layout
  stale?: boolean; // the last saved map, shown while a fresh one comes in
  rooms: Room[];
  robot: Pose | null;
  charger: Point | null;
  robot_room: number | null;
  restrictions: Restriction[];
  no_carpet_zones: number;
  frame?: MapFrame; // missing from servers older than the map editor
  // Things drawn over the floor, in base px (missing from older servers).
  path?: Polyline[];
  mop_path?: Polyline[];
  obstacles?: Obstacle[];
  no_carpet?: Polyline[];
  zones?: [number, number, number, number][]; // zones being cleaned right now
  goto?: [number, number] | null;
  goto_path?: Polyline[];
  maps: { flag: number; name: string }[];
  current_map: number | null;
}

export type MapResponse =
  | (Omit<MapPayload, "base" | "mask"> & { base?: string; mask?: string })
  | { available: false }
  | { available: true; version: string; unchanged: true };

export interface Auth {
  demo: boolean;
  logged_in: boolean;
  email: string | null;
  code_sent: boolean;
  code_note?: string | null; // why no new code was sent (Roborock pauses them after a few)
  connecting: boolean;
  error: string | null;
  restart_needed?: boolean;
}

export interface Device {
  duid: string;
  name: string;
  model: string;
  supported: boolean;
  connected: boolean;
}

export interface Choice {
  value: string | null;
  options: string[];
}

export interface Consumable {
  key: string;
  name: string;
  unit: "s" | "uses";
  used: number;
  limit: number;
  left: number;
  percent: number;
}

export interface Dnd {
  enabled: boolean;
  start: string;
  end: string;
}

/** When a room was last cleaned, from the history the app keeps of every run. */
export interface RoomFreshness {
  id: number;
  last_cleaned: number | null; // unix time
  last_mopped: number | null;
  interval: number; // days it may go between cleans
  fresh: number; // share of its floor cleaned within that interval
  overdue: boolean;
}

export interface RunSummary {
  begin: number;
  end: number;
  duration: number | null;
  area: number | null;
  complete: boolean | null;
  source: "live" | "robot" | "demo";
  mapped: boolean; // the path is known, so it counts towards freshness
  mopped: boolean;
  rooms: number[]; // rooms it covered at least half of
}

export interface Freshness {
  available: boolean;
  map?: string; // version of the map it was worked out for
  since?: number; // what the history goes back to
  tracked?: number; // runs with a known path on this map
  age?: string; // PNG on the room mask's grid: red = days since cleaned, green = since mopped, 255 = never
  rooms?: RoomFreshness[];
  runs?: RunSummary[];
  intervals?: number[];
}

/** How the app reaches the robot right now. */
export interface Links {
  local: boolean; // directly, on the home network
  cloud: boolean; // through Roborock's cloud
  ip: string | null; // the robot's address on the home network, when known
  blocked?: string | null; // the app macOS needs Local Network access for, when that blocks the direct link
}

export interface Settings {
  connected?: boolean; // false: the robot couldn't be reached, so its own settings are missing
  volume?: number | null;
  dnd?: Dnd | null;
  child_lock?: boolean | null;
  led?: boolean | null;
  flow_led?: boolean | null;
  carpet_boost?: boolean | null;
  dust_mode?: Choice | null;
  wash_mode?: Choice | null;
  smart_wash?: { enabled: boolean } | null;
  mop_dryer?: { enabled: boolean; dry_time?: number | null } | null;
  consumables?: Consumable[] | null;
  summary?: {
    total_time?: number | null;
    total_area?: number | null;
    count?: number | null;
    dust_collections?: number | null;
    last?: { begin?: number | null; end?: number | null; duration?: number | null; area?: number | null; complete: boolean } | null;
  } | null;
  routines?: { id: number; name: string }[] | null;
  network?: { ip?: string | null; ssid?: string | null; rssi?: number | null } | null;
  device?: {
    duid?: string;
    name?: string;
    model?: string;
    product?: string | null;
    firmware?: string | null;
    serial?: string | null;
    local?: boolean;
  };
}

// The decoded room mask, one pixel per 5 cm block (RGBA bytes).
export interface Mask {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}
