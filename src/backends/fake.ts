import type {
  AgentRun,
  Availability,
  Backend,
  Capabilities,
  Dialect,
  NormalizedResult,
  RunOpts,
  Task,
} from "./types.js";

const CAPABILITIES: Capabilities = {
  reportsCost: true,
  reportsTokens: true,
  supportsBudgetCap: false,
  supportsResume: false,
  requiresTrust: false,
};

export class FakeBackend implements Backend {
  readonly dialect: Dialect = "claude";
  readonly capabilities = CAPABILITIES;
  readonly defaultArgs: string[] = [];
  readonly prompts: string[] = [];

  constructor(
    readonly id: string,
    readonly binary: string,
    private impl: (prompt: string) => NormalizedResult | Promise<NormalizedResult>,
    public installed = true,
  ) {}

  async available(): Promise<Availability> {
    return { installed: this.installed, authed: true };
  }

  argv(task: Task): string[] {
    return [task.prompt];
  }

  run(task: Task, _opts: RunOpts): AgentRun {
    this.prompts.push(task.prompt);
    const result = Promise.resolve(this.impl(task.prompt));
    return {
      events: (async function* () {})(),
      result,
      cancel: async () => undefined,
    };
  }
}

export function result(
  outcome: NormalizedResult["outcome"],
  text = outcome,
  extra: Partial<NormalizedResult> = {},
): NormalizedResult {
  return {
    ok: outcome === "success",
    outcome,
    text,
    durationMs: 10,
    exitCode: outcome === "success" ? 0 : 1,
    raw: { result: text },
    ...extra,
  };
}
