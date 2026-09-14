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

export const AUTONOMY_VALUES: Autonomy[] = ["low", "medium", "high"];

/** What each autonomy tier actually permits, for anything that explains it. */
export const AUTONOMY_HELP: Record<Autonomy, string> = {
  low: "read and reason only — edits are declined",
  medium: "edits auto-accepted, shell allowed",
  high: "no remaining guardrails",
};

export const CONFIG_KEYS = ["autonomy", "order"] as const;
export type ConfigKey = (typeof CONFIG_KEYS)[number];

export function isConfigKey(key: string): key is ConfigKey {
  return (CONFIG_KEYS as readonly string[]).includes(key);
}

export function readConfigValue(config: TrussConfig, key: ConfigKey): string {
  return key === "autonomy" ? config.autonomy : config.order.join(",");
}

/**
 * Validate and apply one setting, returning a new config.
 *
 * Kept out of the command layer so the rules are testable without touching
 * disk, and so a bad value is refused before anything is written.
 */
export function setConfigValue(
  config: TrussConfig,
  key: ConfigKey,
  raw: string,
): TrussConfig {
  if (key === "autonomy") {
    const value = raw.trim().toLowerCase();
    if (!AUTONOMY_VALUES.includes(value as Autonomy)) {
      throw new Error(
        `autonomy must be one of: ${AUTONOMY_VALUES.join(", ")} (got "${raw}")`,
      );
    }
    return { ...config, autonomy: value as Autonomy };
  }

  const ids = raw
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0) {
    throw new Error("order needs at least one backend");
  }
  const known = new Set(config.backends.map((b) => b.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) {
    throw new Error(
      `unknown backend${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")} — known: ${[...known].join(", ")}`,
    );
  }
  const duplicated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicated.length) {
    throw new Error(`order repeats: ${[...new Set(duplicated)].join(", ")}`);
  }
  return { ...config, order: ids };
}
