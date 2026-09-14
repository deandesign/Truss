import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { limitsPath } from "./paths.js";

export interface LimitState {
  [backendId: string]: {
    at: string;
    detail?: string;
  };
}

export function loadLimits(): LimitState {
  const path = limitsPath();
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as LimitState;
}

export function recordLimit(backendId: string, detail?: string): void {
  const path = limitsPath();
  mkdirSync(dirname(path), { recursive: true });
  const current = loadLimits();
  current[backendId] = { at: new Date().toISOString(), detail };
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
}

export function clearLimit(backendId: string): void {
  const path = limitsPath();
  const current = loadLimits();
  delete current[backendId];
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
}
