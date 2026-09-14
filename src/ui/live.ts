import type { Cost, QuotaSnapshot } from "../backends/types.js";
import type { FinalOutcome, RunManifest } from "../core/manifest.js";
import type { RouterEvent } from "../core/router.js";
import { clip, pad, paletteFor, type Palette } from "./ansi.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_ACTIVITY = 6;
const FRAME_MS = 90;

type BackendState =
  | "pending"
  | "running"
  | "success"
  | "task_failure"
  | "limit_exhausted"
  | "transient"
  | "cancelled"
  | "skipped";

interface Activity {
  id?: string;
  name: string;
  detail?: string;
  done: boolean;
}

export interface Lane {
  id: string;
  state: BackendState;
  attempt: number;
  startedAt?: number;
  durationMs?: number;
  cost?: Cost;
  quota?: QuotaSnapshot;
  skipReason?: string;
}

export interface LiveViewOpts {
  stream?: NodeJS.WriteStream;
  /** Force the append-only renderer (used by tests and non-terminal callers). */
  plain?: boolean;
}

export interface LiveView {
  onProgress(event: RouterEvent): void;
  close(): void;
}

export function createLiveView(opts: LiveViewOpts = {}): LiveView {
  const stream = opts.stream ?? process.stdout;
  const live = !opts.plain && Boolean(stream.isTTY);
  return live ? liveRenderer(stream) : plainRenderer(stream);
}

/* ------------------------------------------------------------------ shared */

class RunState {
  runId = "";
  task = "";
  lanes: Lane[] = [];
  activity: Activity[] = [];
  checkpoints = 0;
  note?: string;
  latest?: string;
  manifest?: RunManifest;

  lane(id: string): Lane {
    let found = this.lanes.find((l) => l.id === id);
    if (!found) {
      found = { id, state: "pending", attempt: 0 };
      this.lanes.push(found);
    }
    return found;
  }

  apply(event: RouterEvent): void {
    switch (event.kind) {
      case "run_start":
        this.runId = event.runId;
        this.task = event.task;
        this.lanes = event.chain.map((id) => ({
          id,
          state: "pending",
          attempt: 0,
        }));
        break;
      case "backend_skip": {
        const lane = this.lane(event.backendId);
        lane.state = "skipped";
        lane.skipReason = event.reason;
        break;
      }
      case "attempt_start": {
        const lane = this.lane(event.backendId);
        lane.state = "running";
        lane.attempt = event.attempt;
        lane.startedAt = Date.now();
        this.activity = [];
        this.latest = undefined;
        break;
      }
      case "agent": {
        const inner = event.event;
        if (inner.kind === "assistant") {
          const line = inner.text.trim().split("\n").filter(Boolean).pop();
          if (line) this.latest = line;
        } else if (inner.kind === "tool") {
          this.track(inner.name, inner.status === "completed", inner.id, inner.detail);
        } else if (inner.kind === "quota") {
          this.lane(event.backendId).quota = inner.snapshot;
        } else if (inner.kind === "error") {
          this.latest = inner.text.trim().split("\n")[0];
        }
        break;
      }
      case "checkpoint":
        this.checkpoints += 1;
        break;
      case "attempt_end": {
        const lane = this.lane(event.backendId);
        lane.state = event.outcome;
        lane.durationMs = event.durationMs;
        lane.cost = mergeCost(lane.cost, event.cost);
        if (event.quota) lane.quota = event.quota;
        lane.startedAt = undefined;
        break;
      }
      case "retry":
        this.note = `${event.backendId} was transient — retrying in ${event.afterMs}ms`;
        break;
      case "handoff":
        this.note = event.to
          ? `${event.from} → ${event.to} (${event.reason.replace("_", " ")})`
          : `${event.from} ${event.reason.replace("_", " ")} — no backend left`;
        break;
      case "run_end":
        this.manifest = event.manifest;
        break;
    }
  }

  private track(name: string, done: boolean, id?: string, detail?: string): void {
    const existing = id
      ? this.activity.find((a) => a.id === id)
      : [...this.activity].reverse().find((a) => a.name === name && !a.done);
    if (existing) {
      existing.done = existing.done || done;
      existing.detail = existing.detail ?? detail;
      return;
    }
    this.activity.push({ id, name, detail, done });
    if (this.activity.length > MAX_ACTIVITY * 2) {
      this.activity.splice(0, this.activity.length - MAX_ACTIVITY * 2);
    }
  }
}

function mergeCost(a: Cost | undefined, b: Cost | undefined): Cost | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    usd: (a.usd ?? 0) + (b.usd ?? 0) || undefined,
    tokens: b.tokens ?? a.tokens,
  };
}

const MARKS: Record<BackendState, string> = {
  pending: "·",
  running: "●",
  success: "✓",
  task_failure: "✗",
  limit_exhausted: "⚡",
  transient: "~",
  cancelled: "⊘",
  skipped: "⊘",
};

function tint(palette: Palette, state: BackendState): (s: string) => string {
  switch (state) {
    case "running":
      return palette.cyan;
    case "success":
      return palette.green;
    case "task_failure":
      return palette.red;
    case "limit_exhausted":
      return palette.yellow;
    case "transient":
      return palette.yellow;
    default:
      return palette.dim;
  }
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function bar(fraction: number, cells = 10): string {
  const filled = Math.max(0, Math.min(cells, Math.round(fraction * cells)));
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

function shortWindow(key: string): string {
  if (key === "five_hour") return "5h";
  if (key === "seven_day") return "7d";
  return key.replace(/_/g, " ");
}

export function quotaLine(quota: QuotaSnapshot, palette: Palette): string {
  const parts = quota.windows.map((w) => {
    const pct = Math.round(w.utilization * 100);
    const colour =
      w.utilization >= 0.9
        ? palette.red
        : w.utilization >= 0.7
          ? palette.yellow
          : palette.green;
    return `${palette.dim(shortWindow(w.key))} ${colour(bar(w.utilization))} ${pad(`${pct}%`, 4)}`;
  });
  if (quota.usingOverage) parts.push(palette.yellow("on overage"));
  return parts.join("  ");
}

export function costSummary(
  lanes: Lane[],
  palette: Palette,
): string {
  let known = 0;
  let anyKnown = false;
  const silent: string[] = [];
  for (const lane of lanes) {
    // A backend still working has not reported anything yet; calling that
    // "unreported" would confuse it with Cursor, which never reports at all.
    if (
      lane.state === "pending" ||
      lane.state === "skipped" ||
      lane.state === "running"
    ) {
      continue;
    }
    if (typeof lane.cost?.usd === "number") {
      known += lane.cost.usd;
      anyKnown = true;
    } else {
      silent.push(lane.id);
    }
  }
  if (!anyKnown && silent.length === 0) return "";
  const head = anyKnown
    ? `$${known.toFixed(4)} ${palette.dim("known")}`
    : palette.dim("no spend reported");
  if (silent.length === 0) return head;
  // Never imply the total is complete — ARCHITECTURE.md §8.
  return `${head}  ${palette.dim(`+ ${silent.join(", ")} unreported`)}`;
}

/* -------------------------------------------------------------- live frame */

function liveRenderer(stream: NodeJS.WriteStream): LiveView {
  const palette = paletteFor(stream);
  const state = new RunState();
  let tick = 0;
  let painted = 0;
  let closed = false;

  const width = () => Math.max(40, Math.min(stream.columns ?? 80, 120));

  const frame = (): string[] => {
    const w = width();
    const lines: string[] = [];
    const chain = state.lanes
      .map((lane) => tint(palette, lane.state)(`${MARKS[lane.state]} ${lane.id}`))
      .join(palette.dim("  →  "));

    lines.push("");
    lines.push(`  ${palette.bold("truss")}  ${palette.dim(state.runId)}`);
    lines.push(`  ${palette.dim(clip(state.task.split("\n")[0], w - 4))}`);
    lines.push("");
    if (chain) lines.push(`  ${chain}`);

    const active = state.lanes.find((l) => l.state === "running");
    if (active) {
      const elapsed = active.startedAt ? Date.now() - active.startedAt : 0;
      const spin = palette.cyan(SPINNER[tick % SPINNER.length]);
      const attempt =
        active.attempt > 0 ? palette.dim(` attempt ${active.attempt + 1}`) : "";
      lines.push("");
      lines.push(
        `  ${spin} ${pad(active.id, 12)} ${palette.dim(seconds(elapsed))}${attempt}`,
      );
      for (const item of state.activity.slice(-MAX_ACTIVITY)) {
        const mark = item.done ? palette.green("✓") : palette.cyan("▸");
        const detail = item.detail ? palette.dim(` ${item.detail}`) : "";
        lines.push(clip(`      ${mark} ${pad(item.name, 8)}${detail}`, w));
      }
      if (state.latest) {
        lines.push(clip(`      ${palette.dim(state.latest)}`, w));
      }
    }

    for (const lane of state.lanes) {
      if (lane.state === "skipped" && lane.skipReason) {
        lines.push(
          clip(`  ${palette.dim(`⊘ ${lane.id} — ${lane.skipReason}`)}`, w),
        );
      }
    }

    if (state.note) {
      lines.push("");
      lines.push(clip(`  ${palette.yellow("⚡")} ${state.note}`, w));
    }

    const quotaLanes = state.lanes.filter((l) => l.quota?.windows.length);
    if (quotaLanes.length) {
      lines.push("");
      for (const lane of quotaLanes) {
        lines.push(
          clip(
            `  ${palette.dim(pad(lane.id, 8))} ${quotaLine(lane.quota!, palette)}`,
            w,
          ),
        );
      }
    }

    const cost = costSummary(state.lanes, palette);
    const bits = [cost, state.checkpoints ? palette.dim(`${state.checkpoints} checkpoint${state.checkpoints === 1 ? "" : "s"}`) : ""].filter(Boolean);
    if (bits.length) {
      lines.push("");
      lines.push(`  ${bits.join(palette.dim(" · "))}`);
    }
    lines.push("");
    return lines.map((line) => line.replace(/[ \t]+$/, ""));
  };

  const paint = () => {
    if (closed) return;
    const rows = stream.rows ?? 40;
    let lines = frame();
    if (lines.length > rows - 1) lines = lines.slice(0, rows - 1);
    let out = "";
    if (painted > 0) out += `\x1b[${painted}A`;
    out += "\x1b[0J";
    out += lines.join("\n");
    out += "\n";
    stream.write(out);
    painted = lines.length + 1;
  };

  stream.write("\x1b[?25l");
  const timer = setInterval(() => {
    tick += 1;
    paint();
  }, FRAME_MS);
  timer.unref?.();

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    clearInterval(timer);
    process.off("exit", restore);
    stream.write("\x1b[?25h");
  };
  process.once("exit", restore);

  return {
    onProgress(event) {
      state.apply(event);
      if (event.kind === "run_end") {
        paint();
        closed = true;
        restore();
        stream.write(`${finalSummary(state, palette, width())}\n`);
        return;
      }
      paint();
    },
    close() {
      if (closed) return;
      closed = true;
      restore();
    },
  };
}

const OUTCOME_WORD: Record<FinalOutcome, string> = {
  success: "success",
  task_failure: "task failed",
  limit_exhausted: "out of quota",
  transient: "unavailable",
  cancelled: "cancelled",
  no_backend: "no backend available",
};

function finalSummary(
  state: RunState,
  palette: Palette,
  w: number,
): string {
  const manifest = state.manifest;
  const outcome = manifest?.finalOutcome ?? "task_failure";
  const colour =
    outcome === "success"
      ? palette.green
      : outcome === "limit_exhausted"
        ? palette.yellow
        : palette.red;
  const lines = [
    `  ${colour(OUTCOME_WORD[outcome])}${palette.dim(` · run ${state.runId}`)}`,
  ];
  for (const step of manifest?.steps ?? []) {
    const mark = MARKS[step.outcome as BackendState] ?? "·";
    lines.push(
      clip(
        `    ${tint(palette, step.outcome as BackendState)(mark)} ${pad(step.backendId, 10)} ${palette.dim(pad(step.outcome, 16))} ${palette.dim(seconds(step.durationMs))}`,
        w,
      ),
    );
  }
  if (outcome === "no_backend") {
    lines.push(
      `    ${palette.dim("no configured backend is installed — check `truss status`")}`,
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------ append-only output */

/**
 * Used when stdout is not a terminal — piping, CI, and the launchd routines,
 * where a repainting frame would fill the log with escape sequences.
 */
function plainRenderer(stream: NodeJS.WriteStream): LiveView {
  const palette = paletteFor(stream);
  const state = new RunState();
  const say = (line: string) => stream.write(`${line}\n`);

  return {
    onProgress(event) {
      state.apply(event);
      switch (event.kind) {
        case "run_start":
          say(`run ${event.runId}  chain: ${event.chain.join(" → ")}`);
          say(`task: ${event.task.split("\n")[0]}`);
          break;
        case "backend_skip":
          say(`  ${event.backendId}: skipped — ${event.reason}`);
          break;
        case "attempt_start":
          say(`  ${event.backendId}: start (attempt ${event.attempt + 1})`);
          break;
        case "agent":
          if (event.event.kind === "tool" && event.event.status === "completed") {
            const detail = event.event.detail ? ` ${event.event.detail}` : "";
            say(`    ${event.backendId}: ${event.event.name}${detail}`);
          } else if (event.event.kind === "quota") {
            const windows = event.event.snapshot.windows
              .map((w) => `${shortWindow(w.key)} ${Math.round(w.utilization * 100)}%`)
              .join(" ");
            if (windows) say(`    ${event.backendId}: quota ${windows}`);
          }
          break;
        case "retry":
          say(`  ${event.backendId}: transient, retrying in ${event.afterMs}ms`);
          break;
        case "handoff":
          say(
            event.to
              ? `  handoff ${event.from} → ${event.to} (${event.reason})`
              : `  ${event.from}: ${event.reason}, no backend left`,
          );
          break;
        case "attempt_end":
          say(
            `  ${event.backendId}: ${event.outcome} in ${seconds(event.durationMs)}`,
          );
          break;
        case "run_end":
          say(`${OUTCOME_WORD[event.manifest.finalOutcome]} · run ${event.manifest.id}`);
          break;
      }
    },
    close() {
      void palette;
    },
  };
}
