import type { Backend, NormalizedResult, RunOpts, Task } from "../backends/types.js";
import { buildBrief } from "./brief.js";
import { checkpoint, diffstat } from "./git.js";
import { recordLimit } from "./limits.js";
import { newRunId, saveManifest, type RunManifest, type ManifestStep } from "./manifest.js";

const TRANSIENT_BACKOFF_MS = [500, 1500];

export interface RouteOpts {
  backends: Backend[];
  task: Task;
  autonomy: RunOpts["autonomy"];
  identity?: string;
  memory?: string;
  skill?: string;
  transcript?: string;
  extraArgs?: string[];
  onEvent?: RunOpts["onEvent"];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function route(opts: RouteOpts): Promise<RunManifest> {
  const id = newRunId();
  const startedAt = new Date().toISOString();
  const steps: ManifestStep[] = [];
  let seq = 0;
  let handoffFrom: string | undefined;
  let partial = "";
  let finalOutcome: RunManifest["finalOutcome"] = "task_failure";

  for (let i = 0; i < opts.backends.length; i++) {
    const backend = opts.backends[i];
    const availability = await backend.available();
    if (!availability.installed) continue;

    let attempt = 0;
    while (true) {
      const prompt = buildBrief({
        task: opts.task.prompt,
        identity: opts.identity,
        memory: opts.memory,
        skill: opts.skill,
        transcript: opts.transcript,
        handoff: handoffFrom
          ? {
              from: handoffFrom,
              diffstat: await diffstat(opts.task.cwd),
              partial,
            }
          : undefined,
      });
      const started = new Date();
      let checkpointN = seq;
      const run = backend.run(
        { prompt, cwd: opts.task.cwd },
        {
          autonomy: opts.autonomy,
          extraArgs: opts.extraArgs,
          onEvent: opts.onEvent,
          onTool: async (event) => {
            if (event.status === "completed") {
              checkpointN += 1;
              await checkpoint(opts.task.cwd, id, checkpointN);
            }
          },
        },
      );
      const result: NormalizedResult = await run.result;
      seq = checkpointN;
      const step: ManifestStep = {
        backendId: backend.id,
        startedAt: started.toISOString(),
        endedAt: new Date().toISOString(),
        outcome: result.outcome,
        durationMs: result.durationMs,
        cost: result.cost,
        text: result.text.slice(0, 2000),
      };
      steps.push(step);
      finalOutcome = result.outcome;

      if (result.outcome === "transient" && attempt < TRANSIENT_BACKOFF_MS.length) {
        await sleep(TRANSIENT_BACKOFF_MS[attempt]);
        attempt += 1;
        continue;
      }
      if (result.outcome === "limit_exhausted") {
        recordLimit(backend.id, result.text.slice(0, 240));
        await checkpoint(opts.task.cwd, id, ++seq);
        handoffFrom = backend.id;
        partial = result.text;
        break;
      }
      const manifest: RunManifest = {
        id,
        task: opts.task.prompt,
        cwd: opts.task.cwd,
        startedAt,
        endedAt: new Date().toISOString(),
        steps,
        finalOutcome,
      };
      saveManifest(manifest);
      return manifest;
    }
  }

  const manifest: RunManifest = {
    id,
    task: opts.task.prompt,
    cwd: opts.task.cwd,
    startedAt,
    endedAt: new Date().toISOString(),
    steps,
    finalOutcome,
  };
  saveManifest(manifest);
  return manifest;
}
