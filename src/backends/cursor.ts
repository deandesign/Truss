import { runFromArgv } from "./spawn.js";
import type {
  AgentRun,
  Autonomy,
  Availability,
  Backend,
  Capabilities,
  RunOpts,
  Task,
} from "./types.js";
import { which } from "../core/which.js";

const CAPABILITIES: Capabilities = {
  reportsCost: false,
  reportsTokens: false,
  supportsBudgetCap: false,
  supportsResume: true,
  requiresTrust: true,
};

function autonomyFlags(autonomy: Autonomy): string[] {
  if (autonomy === "high") return ["--force"];
  if (autonomy === "medium") return ["--auto-review"];
  return [];
}

export class CursorBackend implements Backend {
  readonly dialect = "cursor" as const;
  readonly capabilities = CAPABILITIES;

  constructor(
    readonly id: string,
    readonly binary: string,
    readonly defaultArgs: string[] = [],
  ) {}

  async available(): Promise<Availability> {
    const binaryPath = await which(this.binary);
    return {
      installed: Boolean(binaryPath),
      authed: "unknown",
      binaryPath,
      detail: binaryPath ? undefined : `${this.binary} not on PATH`,
    };
  }

  argv(task: Task, opts: RunOpts): string[] {
    return [
      "-p",
      "--output-format",
      "stream-json",
      "--trust",
      ...autonomyFlags(opts.autonomy),
      ...this.defaultArgs,
      ...(opts.extraArgs ?? []),
      task.prompt,
    ];
  }

  run(task: Task, opts: RunOpts): AgentRun {
    return runFromArgv(this.binary, this.argv(task, opts), this.dialect, task, opts);
  }
}
