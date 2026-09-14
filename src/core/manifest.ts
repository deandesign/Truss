import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Cost, Outcome } from "../backends/types.js";
import { repoTrussDir } from "./paths.js";

export interface ManifestStep {
  backendId: string;
  startedAt: string;
  endedAt: string;
  outcome: Outcome;
  durationMs: number;
  cost?: Cost;
  text?: string;
}

export interface RunManifest {
  id: string;
  task: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  steps: ManifestStep[];
  finalOutcome: Outcome;
}

export function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function saveManifest(manifest: RunManifest, cwd = manifest.cwd): string {
  const dir = join(repoTrussDir(cwd), "runs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${manifest.id}.json`);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}
