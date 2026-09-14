import type {
  AgentEvent,
  Backend,
  Cost,
  NormalizedResult,
  Outcome,
  QuotaSnapshot,
  RunOpts,
  Task,
} from "../backends/types.js";
import { buildBrief } from "./brief.js";
import { checkpoint, diffstat } from "./git.js";
import { recordLimit, recordQuota } from "./limits.js";
import {
  newRunId,
  saveManifest,
  type FinalOutcome,
  type ManifestStep,
  type RunManifest,
} from "./manifest.js";

const TRANSIENT_BACKOFF_MS = [500, 1500];

/**
 * Lifecycle of a routed run, in the order a caller will see it. The TUI renders
 * these; nothing here is required to consume a run headlessly.
 */
export type RouterEvent =
  | { kind: "run_start"; runId: string; task: string; chain: string[] }
  | { kind: "backend_skip"; backendId: string; reason: string }
  | { kind: "attempt_start"; backendId: string; attempt: number }
  | { kind: "agent"; backendId: string; event: AgentEvent }
  | { kind: "checkpoint"; backendId: string; seq: number; commit?: string }
  | {
      kind: "attempt_end";
      backendId: string;
      attempt: number;
      outcome: Outcome;
      durationMs: number;
      cost?: Cost;
      quota?: QuotaSnapshot;
    }
  | { kind: "retry"; backendId: string; afterMs: number; attempt: number }
  | {
      kind: "handoff";
      from: string;
      to?: string;
      reason: "limit_exhausted" | "transient";
    }
  | { kind: "run_end"; manifest: RunManifest };

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
  onProgress?: (event: RouterEvent) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function route(opts: RouteOpts): Promise<RunManifest> {
  const id = newRunId();
  const startedAt = new Date().toISOString();
  const steps: ManifestStep[] = [];
  const emit = (event: RouterEvent) => opts.onProgress?.(event);

  let seq = 0;
  let handoffFrom: string | undefined;
  let partial = "";
  let ran = false;
  let finalOutcome: FinalOutcome = "no_backend";

  const finish = (): RunManifest => {
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
    emit({ kind: "run_end", manifest });
    return manifest;
  };

  emit({
    kind: "run_start",
    runId: id,
    task: opts.task.prompt,
    chain: opts.backends.map((b) => b.id),
  });

  for (let i = 0; i < opts.backends.length; i++) {
    const backend = opts.backends[i];
    const availability = await backend.available();
    if (!availability.installed) {
      emit({
        kind: "backend_skip",
        backendId: backend.id,
        reason: availability.detail ?? `${backend.binary} not on PATH`,
      });
      continue;
    }

    let attempt = 0;
    let advance = false;

    while (!advance) {
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

      emit({ kind: "attempt_start", backendId: backend.id, attempt });
      const started = new Date();
      ran = true;

      // Checkpoints are serialised: a tool-completed event can arrive while a
      // previous checkpoint is still committing, and two concurrent
      // commit-trees on one repo race on the ref.
      let pending: Promise<void> = Promise.resolve();
      const run = backend.run(
        { prompt, cwd: opts.task.cwd },
        {
          autonomy: opts.autonomy,
          extraArgs: opts.extraArgs,
          onEvent: (event) => {
            opts.onEvent?.(event);
            emit({ kind: "agent", backendId: backend.id, event });
          },
          onTool: (event): Promise<void> | void => {
            if (event.status !== "completed") return;
            pending = pending.then(async () => {
              const next = ++seq;
              const commit = await checkpoint(opts.task.cwd, id, next);
              emit({
                kind: "checkpoint",
                backendId: backend.id,
                seq: next,
                commit,
              });
            });
            return pending;
          },
        },
      );

      const result: NormalizedResult = await run.result;
      await pending;
      if (result.quota) recordQuota(backend.id, result.quota);

      const step: ManifestStep = {
        backendId: backend.id,
        attempt,
        startedAt: started.toISOString(),
        endedAt: new Date().toISOString(),
        outcome: result.outcome,
        durationMs: result.durationMs,
        cost: result.cost,
        text: result.text.slice(0, 2000),
      };
      steps.push(step);
      finalOutcome = result.outcome;
      emit({
        kind: "attempt_end",
        backendId: backend.id,
        attempt,
        outcome: result.outcome,
        durationMs: result.durationMs,
        cost: result.cost,
        quota: result.quota,
      });

      const nextBackend = opts.backends[i + 1]?.id;

      if (result.outcome === "transient") {
        if (attempt < TRANSIENT_BACKOFF_MS.length) {
          const afterMs = TRANSIENT_BACKOFF_MS[attempt];
          emit({ kind: "retry", backendId: backend.id, afterMs, attempt });
          await sleep(afterMs);
          attempt += 1;
          continue;
        }
        // Retries exhausted. ARCHITECTURE.md §4: retry with backoff, *then*
        // fail over — a backend that is still 5xx-ing is as unusable as one out
        // of quota.
        emit({
          kind: "handoff",
          from: backend.id,
          to: nextBackend,
          reason: "transient",
        });
        handoffFrom = backend.id;
        partial = result.text;
        advance = true;
        continue;
      }

      if (result.outcome === "limit_exhausted") {
        recordLimit(backend.id, result.text.slice(0, 240));
        const next = ++seq;
        const commit = await checkpoint(opts.task.cwd, id, next);
        emit({ kind: "checkpoint", backendId: backend.id, seq: next, commit });
        emit({
          kind: "handoff",
          from: backend.id,
          to: nextBackend,
          reason: "limit_exhausted",
        });
        handoffFrom = backend.id;
        partial = result.text;
        advance = true;
        continue;
      }

      // success, task_failure, cancelled — the chain stops here either way.
      return finish();
    }
  }

  if (!ran) finalOutcome = "no_backend";
  return finish();
}
