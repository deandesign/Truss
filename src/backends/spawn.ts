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
  const collected: AgentEvent[] = [];
  let assistantText = "";

  const emit = async (event: AgentEvent) => {
    collected.push(event);
    opts.onEvent?.(event);
    if (event.kind === "assistant") assistantText += event.text;
    if (event.kind === "result") raw = event.raw;
    if (event.kind === "tool") await opts.onTool?.(event);
  };

  let lineBuf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    lineBuf += text;
    const lines = lineBuf.split(/\r?\n/);
    lineBuf = lines.pop() ?? "";
    for (const line of lines) {
      const event = ingestLine(line, spec.dialect);
      if (event) void emit(event);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const result = new Promise<NormalizedResult>((resolve) => {
    const finish = (exitCode: number, aborted: boolean) => {
      if (lineBuf.trim()) {
        const event = ingestLine(lineBuf, spec.dialect);
        if (event) void emit(event);
      }
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
        exitCode,
        raw,
      });
    };

    child.on("close", (code) => finish(code ?? 1, signal.aborted));
    child.on("error", (err) => {
      stderr += err.message;
      finish(127, signal.aborted);
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
