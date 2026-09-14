import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_PRESETS } from "../backends/registry.js";
import type { Autonomy, BackendPreset } from "../backends/types.js";
import { configPath } from "./paths.js";

export interface TrussConfig {
  order: string[];
  autonomy: Autonomy;
  backends: BackendPreset[];
  budgets?: {
    wallClockMs?: number;
    maxTurns?: number;
    maxBudgetUsd?: number;
  };
}

export const DEFAULT_CONFIG: TrussConfig = {
  order: ["claude", "cursor", "codex"],
  autonomy: "low",
  backends: DEFAULT_PRESETS,
};

export function loadConfig(): TrussConfig {
  const path = configPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<TrussConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    backends: parsed.backends ?? DEFAULT_CONFIG.backends,
    order: parsed.order ?? DEFAULT_CONFIG.order,
    autonomy: parsed.autonomy ?? DEFAULT_CONFIG.autonomy,
  };
}

export function saveConfig(config: TrussConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}
