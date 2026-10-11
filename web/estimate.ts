// How long a clean will take, from how long cleaning has taken in this home before.
// The server fits seconds = overhead + rate x m² from past runs, per cleaning mode.

import { api, devicePath } from "./api";
import { S } from "./state";
import type { Status } from "./types";

interface Fit {
  rate: number; // seconds per m²
  overhead: number; // seconds: leaving, coming back, washing the mop
  runs: number;
}

let model: { overall: Fit | null; modes: Record<string, Fit> } | null = null;

export async function loadEstimates(): Promise<void> {
  try {
    model = await api<typeof model>(devicePath("estimates"));
  } catch {
    // keep what we had; estimates are a nice-to-have
  }
}

// The current mode's fit if there's history for it, else all runs together. None until there's history.
const fitFor = (mode: string | null | undefined): Fit | null => (model && ((mode && model.modes[mode]) || model.overall)) || null;

const roomArea = (ids: number[]) => (S.map?.rooms ?? []).filter((r) => ids.includes(r.id)).reduce((sum, r) => sum + (r.area || 0), 0);
export const homeArea = () => roomArea((S.map?.rooms ?? []).map((r) => r.id));
export const roomsArea = (ids: number[]) => roomArea(ids);

export function zoneArea(rect: [number, number, number, number] | null): number {
  const m = S.map;
  if (!rect || !m) return 0;
  const metres = (px: number) => (Math.abs(px) / m.scale) * 0.05;
  return metres(rect[2] - rect[0]) * metres(rect[3] - rect[1]);
}

function fmtTime(s: number): string {
  const min = Math.max(1, Math.round(s / 60));
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}

const doneBy = (s: number) => new Date(Date.now() + s * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "About 18 min · done by 14:35" for cleaning this many m², or null without history. */
export function estimateText(area: number, passes = 1): string | null {
  const f = fitFor(S.status?.mode?.cleaning);
  if (!f || area <= 0) return null;
  const s = f.overhead + f.rate * area * passes;
  return `About ${fmtTime(s)} · done by ${doneBy(s)}`;
}

/** Seconds left in the run going on now, or null when there's no good guess. */
export function remainingSeconds(st: Status): number | null {
  if (st.phase !== "cleaning") return null;
  const t = st.clean_time ?? 0;
  // The robot's own progress, where it reports one, beats any guess.
  if (st.clean_percent != null && st.clean_percent >= 5 && st.clean_percent < 100) return (t * (100 - st.clean_percent)) / st.clean_percent;
  const total = S.jobArea ?? (st.job_type === "global_clean_not_complete" ? homeArea() : null);
  if (!total) return null;
  const done = st.clean_area ?? 0;
  // Its pace on this run once it's had a few minutes, else the usual pace.
  const rate = done >= 3 && t >= 180 ? t / done : fitFor(st.mode?.cleaning)?.rate;
  if (!rate) return null;
  return Math.max(0, total - done) * rate + 60; // and the drive back
}

/** The parts for the status card: "6 min" and "done by 14:35". */
export function remainingParts(st: Status): { left: string; by: string } | null {
  const s = remainingSeconds(st);
  return s == null ? null : { left: fmtTime(s), by: `done by ${doneBy(s)}` };
}
