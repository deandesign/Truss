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
import type { Budgets } from "./config.js";
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
      reason: "limit_exhausted" | "transient" | "unusable";
    }
  | { kind: "run_end"; manifest: RunManifest };

export interface RouteOpts {
  backends: Backend[];
  task: Task;
  autonomy: RunOpts["autonomy"];
  budgets?: Budgets;
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
  const budgets = opts.budgets ?? {};
  const runStarted = Date.now();
  let toolTurns = 0;

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
    if (
      typeof budgets.wallClockMs === "number" &&
      Date.now() - runStarted >= budgets.wallClockMs
    ) {
      finalOutcome = "budget_exhausted";
      steps.push({
        backendId: "budget",
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        outcome: "budget_exhausted",
        durationMs: Date.now() - runStarted,
        text: `wall-clock budget of ${budgets.wallClockMs}ms exhausted`,
      });
      return finish();
    }

    const backend = opts.backends[i];
    const availability = await backend.available();
    if (!availability.usable) {
      emit({
        kind: "backend_skip",
        backendId: backend.id,
        reason: availability.detail ?? `${backend.binary} is not usable`,
      });
      continue;
    }

    let attempt = 0;
    let advance = false;

    while (!advance) {
      const remainingMs =
        typeof budgets.wallClockMs === "number"
          ? budgets.wallClockMs - (Date.now() - runStarted)
          : undefined;
      if (typeof remainingMs === "number" && remainingMs <= 0) {
        finalOutcome = "budget_exhausted";
        steps.push({
          backendId: backend.id,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          outcome: "budget_exhausted",
          durationMs: Date.now() - runStarted,
          text: `wall-clock budget of ${budgets.wallClockMs}ms exhausted`,
        });
        return finish();
      }

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

      const controller = new AbortController();
      let wallTimer: ReturnType<typeof setTimeout> | undefined;
      if (typeof remainingMs === "number") {
        wallTimer = setTimeout(() => controller.abort(), remainingMs);
      }

      let pending: Promise<void> = Promise.resolve();
      const run = backend.run(
        { prompt, cwd: opts.task.cwd },
        {
          autonomy: opts.autonomy,
          extraArgs: opts.extraArgs,
          abortSignal: controller.signal,
          maxBudgetUsd: budgets.maxBudgetUsd,
          onEvent: (event) => {
            opts.onEvent?.(event);
            emit({ kind: "agent", backendId: backend.id, event });
          },
          onTool: (event): Promise<void> | void => {
            if (event.status !== "completed") return;
            toolTurns += 1;
            if (
              typeof budgets.maxTurns === "number" &&
              toolTurns > budgets.maxTurns
            ) {
              controller.abort();
              return;
            }
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

      let result: NormalizedResult;
      try {
        result = await run.result;
      } finally {
        if (wallTimer) clearTimeout(wallTimer);
      }
      await pending;
      if (result.quota) recordQuota(backend.id, result.quota);

      if (
        typeof budgets.maxTurns === "number" &&
        toolTurns > budgets.maxTurns
      ) {
        result = {
          ...result,
          ok: false,
          outcome: "budget_exhausted",
          text:
            result.text ||
            `turn budget of ${budgets.maxTurns} tool completions exhausted`,
        };
      } else if (
        controller.signal.aborted &&
        typeof budgets.wallClockMs === "number" &&
        Date.now() - runStarted >= budgets.wallClockMs
      ) {
        result = {
          ...result,
          ok: false,
          outcome: "budget_exhausted",
          text:
            result.text ||
            `wall-clock budget of ${budgets.wallClockMs}ms exhausted`,
        };
      } else if (
        typeof budgets.maxBudgetUsd === "number" &&
        typeof result.cost?.usd === "number" &&
        result.cost.usd >= budgets.maxBudgetUsd
      ) {
        result = {
          ...result,
          ok: false,
          outcome: "budget_exhausted",
          text:
            result.text ||
            `dollar budget of $${budgets.maxBudgetUsd} exhausted (known spend $${result.cost.usd})`,
        };
      }

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

      // Budget hits stop the chain — spending another provider would defeat the cap.
      if (result.outcome === "budget_exhausted") {
        return finish();
      }

      if (result.outcome === "transient") {
        if (attempt < TRANSIENT_BACKOFF_MS.length) {
          const afterMs = TRANSIENT_BACKOFF_MS[attempt];
          emit({ kind: "retry", backendId: backend.id, afterMs, attempt });
          await sleep(afterMs);
          attempt += 1;
          continue;
        }
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

      if (result.outcome === "unusable") {
        emit({
          kind: "handoff",
          from: backend.id,
          to: nextBackend,
          reason: "unusable",
        });
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

      return finish();
    }
  }

  if (!ran) finalOutcome = "no_backend";
  return finish();
}
