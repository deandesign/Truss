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
  reportsCost: true,
  reportsTokens: true,
  supportsBudgetCap: true,
  supportsResume: true,
  requiresTrust: false,
};

function permissionMode(autonomy: Autonomy): string {
  if (autonomy === "high") return "bypassPermissions";
  if (autonomy === "medium") return "acceptEdits";
  return "default";
}

export class ClaudeBackend implements Backend {
  readonly dialect = "claude" as const;
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
      "--verbose",
      "--permission-mode",
      permissionMode(opts.autonomy),
      ...this.defaultArgs,
      ...(opts.extraArgs ?? []),
      task.prompt,
    ];
  }

  run(task: Task, opts: RunOpts): AgentRun {
    return runFromArgv(this.binary, this.argv(task, opts), this.dialect, task, opts);
  }
}
