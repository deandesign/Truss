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
  reportsCost: false,
  reportsTokens: true,
  supportsBudgetCap: false,
  supportsResume: true,
  requiresTrust: false,
};

function autonomyFlags(autonomy: Autonomy): string[] {
  if (autonomy === "high") {
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }
  if (autonomy === "medium") {
    return ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"];
  }
  return ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"];
}

export class CodexBackend implements Backend {
  readonly dialect = "codex" as const;
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
    return [
      "exec",
      "--json",
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
