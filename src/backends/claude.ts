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
import { checkAvailability } from "./available.js";

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
    return checkAvailability(this.binary);
  }

  argv(task: Task, opts: RunOpts): string[] {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      permissionMode(opts.autonomy),
      ...this.defaultArgs,
      ...(opts.extraArgs ?? []),
    ];
    if (
      typeof opts.maxBudgetUsd === "number" &&
      Number.isFinite(opts.maxBudgetUsd) &&
      opts.maxBudgetUsd > 0
    ) {
      args.push("--max-budget-usd", String(opts.maxBudgetUsd));
    }
    args.push(task.prompt);
    return args;
  }

  run(task: Task, opts: RunOpts): AgentRun {
    return runFromArgv(this.binary, this.argv(task, opts), this.dialect, task, opts);
  }
}
