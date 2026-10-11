// JSON calls to the local Python server.

import { S } from "./state";

interface ApiOptions {
  method?: "GET" | "POST";
  body?: unknown;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // empty body
  }
  if (!res.ok) {
    const d = data && typeof data === "object" && "detail" in data ? (data as { detail: unknown }).detail : null;
    throw new Error(typeof d === "string" ? d : d ? JSON.stringify(d) : `${res.status} ${res.statusText}`);
  }
  return data as T;
}

/** URL of an endpoint for the selected robot. */
export function devicePath(rest: string): string {
  if (!S.duid) throw new Error("No robot selected");
  return `/api/devices/${encodeURIComponent(S.duid)}/${rest}`;
}
