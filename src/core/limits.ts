import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { QuotaSnapshot } from "../backends/types.js";
import { limitsPath } from "./paths.js";

export interface BackendState {
  /** When this backend was last observed out of quota. */
  at?: string;
  detail?: string;
  /** Last quota telemetry the backend volunteered, if it reports any. */
  quota?: QuotaSnapshot;
}

export interface LimitState {
  [backendId: string]: BackendState;
}

export function loadLimits(): LimitState {
  const path = limitsPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as LimitState;
}

function write(state: LimitState): void {
  const path = limitsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function recordLimit(backendId: string, detail?: string): void {
  const current = loadLimits();
  current[backendId] = {
    ...current[backendId],
    at: new Date().toISOString(),
    detail,
  };
  write(current);
}

/**
 * Store observed quota headroom. Recording this on every run means `truss
 * status` can show how much room is left instead of only whether a limit has
 * already been hit.
 */
export function recordQuota(backendId: string, quota: QuotaSnapshot): void {
  const current = loadLimits();
  const previous = current[backendId] ?? {};
  const allowed = !quota.status || /^allow/i.test(quota.status);
  current[backendId] = {
    ...previous,
    quota,
    // A backend reporting headroom again clears a stale limit mark.
    ...(allowed ? { at: undefined, detail: undefined } : {}),
  };
  write(current);
}

export function clearLimit(backendId: string): void {
  const current = loadLimits();
  delete current[backendId];
  write(current);
}
