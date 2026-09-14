import { spawn } from "node:child_process";
import { classify } from "./detectors.js";
import {
  costFromRaw,
  ingestLine,
  sessionFromRaw,
  textFromRaw,
} from "./parse.js";
import type {
  AgentEvent,
  AgentRun,
  Dialect,
  NormalizedResult,
  QuotaSnapshot,
  RunOpts,
  Task,
} from "./types.js";

export interface SpawnSpec {
  binary: string;
  args: string[];
  dialect: Dialect;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export function spawnRun(spec: SpawnSpec, opts: RunOpts): AgentRun {
  const controller = new AbortController();
  const signal = opts.abortSignal ?? controller.signal;
  const started = Date.now();

  const child = spawn(spec.binary, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let raw: unknown;
  let quota: QuotaSnapshot | undefined;
  const collected: AgentEvent[] = [];
  let assistantText = "";

  // Tool results carry only a tool_use_id, so names are remembered from the
  // matching tool_use and filled back in on completion.
  const toolNames = new Map<string, { name: string; detail?: string }>();

  // Handlers are serialised. `onTool` commits a git checkpoint, and two of
  // those running concurrently race on the same ref.
  let queue: Promise<void> = Promise.resolve();

  const enqueue = (event: AgentEvent) => {
    queue = queue.then(() => handle(event));
    return queue;
  };

  const handle = async (event: AgentEvent): Promise<void> => {
    let resolved = event;
    if (event.kind === "tool" && event.id) {
      if (event.status === "started") {
        toolNames.set(event.id, { name: event.name, detail: event.detail });
      } else if (event.name === "tool" || !event.detail) {
        const known = toolNames.get(event.id);
        if (known) {
          resolved = {
            ...event,
            name: event.name === "tool" ? known.name : event.name,
            detail: event.detail ?? known.detail,
          };
        }
      }
    }
    collected.push(resolved);
    if (resolved.kind === "assistant") assistantText += resolved.text;
    if (resolved.kind === "result") raw = resolved.raw;
    if (resolved.kind === "quota") quota = resolved.snapshot;
    opts.onEvent?.(resolved);
    if (resolved.kind === "tool") await opts.onTool?.(resolved);
  };

  let lineBuf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    lineBuf += text;
    const lines = lineBuf.split(/\r?\n/);
    lineBuf = lines.pop() ?? "";
    for (const line of lines) {
      for (const event of ingestLine(line, spec.dialect)) enqueue(event);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const result = new Promise<NormalizedResult>((resolve, reject) => {
    const finish = async (exitCode: number, aborted: boolean) => {
      if (lineBuf.trim()) {
        for (const event of ingestLine(lineBuf, spec.dialect)) enqueue(event);
      }
      // Let every queued handler (and its checkpoint) settle before reporting.
      await queue.catch(() => undefined);

      if (!raw) {
        const trimmed = stdout.trim();
        if (trimmed.startsWith("{")) {
          try {
            raw = JSON.parse(trimmed);
          } catch {
            raw = { stdout: trimmed, stderr };
          }
        } else {
          raw = { stdout: trimmed, stderr };
        }
      }
      const outcome = classify({
        exitCode,
        stdout,
        stderr,
        raw,
        aborted,
        quotaStatus: quota?.status,
      });
      const text =
        textFromRaw(raw, assistantText) || assistantText || stderr.trim();
      resolve({
        ok: outcome === "success",
        outcome,
        text,
        sessionId: sessionFromRaw(raw),
        durationMs: Date.now() - started,
        cost: costFromRaw(raw),
        quota,
        exitCode,
        raw,
      });
    };

    child.on("close", (code) => {
      void finish(code ?? 1, signal.aborted).catch(reject);
    });
    child.on("error", (err) => {
      stderr += err.message;
      void finish(127, signal.aborted).catch(reject);
    });
  });

  signal.addEventListener("abort", () => {
    child.kill("SIGTERM");
  });

  return {
    events: (async function* () {
      await result;
      yield* collected;
    })(),
    result,
    cancel: async () => {
      controller.abort();
      child.kill("SIGTERM");
    },
  };
}

export function runFromArgv(
  binary: string,
  argv: string[],
  dialect: Dialect,
  task: Task,
  opts: RunOpts,
): AgentRun {
  return spawnRun(
    { binary, args: argv, dialect, cwd: task.cwd, env: opts.env },
    opts,
  );
}
