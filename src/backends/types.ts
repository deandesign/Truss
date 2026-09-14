export type Outcome =
  | "success"
  | "task_failure"
  | "limit_exhausted"
  | "transient"
  | "cancelled";

export type Autonomy = "low" | "medium" | "high";

export type Dialect = "claude" | "cursor" | "codex";

export interface Capabilities {
  reportsCost: boolean;
  reportsTokens: boolean;
  supportsBudgetCap: boolean;
  supportsResume: boolean;
  requiresTrust: boolean;
}

export interface Availability {
  installed: boolean;
  authed: "unknown" | boolean;
  binaryPath?: string;
  detail?: string;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

export interface Cost {
  usd?: number;
  tokens?: TokenUsage;
}

export interface NormalizedResult {
  ok: boolean;
  outcome: Outcome;
  text: string;
  sessionId?: string;
  durationMs: number;
  cost?: Cost;
  quota?: QuotaSnapshot;
  exitCode: number;
  raw: unknown;
}

/** One rolling usage window as the vendor reports it. */
export interface QuotaWindow {
  key: string;
  utilization: number;
  resetsAt?: number;
}

/**
 * Live quota telemetry. Claude Code emits a `rate_limit_event` on every run
 * carrying current utilization per window, so headroom is observable without
 * waiting for a 429 — see ARCHITECTURE.md §4.
 */
export interface QuotaSnapshot {
  status?: string;
  limitType?: string;
  usingOverage?: boolean;
  windows: QuotaWindow[];
  at: string;
}

export type AgentEvent =
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      name: string;
      status: "started" | "completed";
      id?: string;
      detail?: string;
    }
  | { kind: "quota"; snapshot: QuotaSnapshot }
  | { kind: "result"; raw: unknown }
  | { kind: "error"; text: string };

export interface Task {
  prompt: string;
  cwd: string;
}

export interface RunOpts {
  autonomy: Autonomy;
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  onEvent?: (event: AgentEvent) => void;
  onTool?: (
    event: Extract<AgentEvent, { kind: "tool" }>,
  ) => void | Promise<void>;
}

export interface AgentRun {
  events: AsyncIterable<AgentEvent>;
  result: Promise<NormalizedResult>;
  cancel(): Promise<void>;
}

export interface Backend {
  readonly id: string;
  readonly binary: string;
  readonly defaultArgs: string[];
  readonly capabilities: Capabilities;
  readonly dialect: Dialect;
  available(): Promise<Availability>;
  argv(task: Task, opts: RunOpts): string[];
  run(task: Task, opts: RunOpts): AgentRun;
}

export interface BackendPreset {
  id: string;
  binary: string;
  defaultArgs?: string[];
  model?: string;
}
