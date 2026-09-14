import { describe, expect, it } from "vitest";
import { clip, PLAIN, visibleLength } from "./ansi.js";
import { costSummary, createLiveView, quotaLine, type Lane } from "./live.js";
import type { RouterEvent } from "../core/router.js";
import type { RunManifest } from "../core/manifest.js";

function capture(isTTY: boolean) {
  const chunks: string[] = [];
  const stream = {
    isTTY,
    columns: 90,
    rows: 40,
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { stream, chunks };
}

/** The visible text of the most recently painted frame. */
function frame(chunks: string[]): string {
  return chunks[chunks.length - 1]
    .replace(/\x1b\[\d*A/g, "")
    .replace(/\x1b\[0J/g, "")
    .replace(/\x1b\[\?25[lh]/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

const manifest = (finalOutcome: RunManifest["finalOutcome"]): RunManifest => ({
  id: "run1",
  task: "t",
  cwd: ".",
  startedAt: "",
  endedAt: "",
  finalOutcome,
  steps: [
    {
      backendId: "claude",
      startedAt: "",
      endedAt: "",
      outcome: "limit_exhausted",
      durationMs: 41200,
    },
    {
      backendId: "cursor",
      startedAt: "",
      endedAt: "",
      outcome: "success",
      durationMs: 58900,
    },
  ],
});

const START: RouterEvent = {
  kind: "run_start",
  runId: "run1",
  task: "add tests for the parser",
  chain: ["claude", "cursor", "codex"],
};

describe("live view", () => {
  it("shows the chain, the active backend, and named tool calls", () => {
    const { stream, chunks } = capture(true);
    const view = createLiveView({ stream });
    view.onProgress(START);
    view.onProgress({ kind: "attempt_start", backendId: "claude", attempt: 0 });
    view.onProgress({
      kind: "agent",
      backendId: "claude",
      event: {
        kind: "tool",
        name: "Read",
        status: "started",
        id: "t1",
        detail: "src/parser.ts",
      },
    });
    const out = frame(chunks);
    view.close();

    expect(out).toContain("claude");
    expect(out).toContain("cursor");
    expect(out).toContain("Read");
    expect(out).toContain("src/parser.ts");
  });

  it("resolves a tool_result back to the name of its tool_use", () => {
    const { stream, chunks } = capture(true);
    const view = createLiveView({ stream });
    view.onProgress(START);
    view.onProgress({ kind: "attempt_start", backendId: "claude", attempt: 0 });
    view.onProgress({
      kind: "agent",
      backendId: "claude",
      event: {
        kind: "tool",
        name: "Edit",
        status: "started",
        id: "t1",
        detail: "src/a.ts",
      },
    });
    // Completions arrive carrying only the id, so the name must be remembered.
    view.onProgress({
      kind: "agent",
      backendId: "claude",
      event: { kind: "tool", name: "tool", status: "completed", id: "t1" },
    });
    const out = frame(chunks);
    view.close();

    expect(out).toContain("✓ Edit");
    expect(out).not.toContain("✓ tool");
  });

  it("calls out a failover and keeps the exhausted backend's quota visible", () => {
    const { stream, chunks } = capture(true);
    const view = createLiveView({ stream });
    view.onProgress(START);
    view.onProgress({ kind: "attempt_start", backendId: "claude", attempt: 0 });
    view.onProgress({
      kind: "agent",
      backendId: "claude",
      event: {
        kind: "quota",
        snapshot: {
          status: "allowed",
          windows: [{ key: "five_hour", utilization: 0.97 }],
          at: "",
        },
      },
    });
    view.onProgress({
      kind: "attempt_end",
      backendId: "claude",
      attempt: 0,
      outcome: "limit_exhausted",
      durationMs: 41200,
      cost: { usd: 0.4182 },
    });
    view.onProgress({
      kind: "handoff",
      from: "claude",
      to: "cursor",
      reason: "limit_exhausted",
    });
    view.onProgress({ kind: "attempt_start", backendId: "cursor", attempt: 0 });
    const out = frame(chunks);
    view.close();

    expect(out).toContain("claude → cursor (limit exhausted)");
    expect(out).toContain("97%");
    expect(out).toContain("$0.4182");
  });

  it("does not call a still-running backend's spend unreported", () => {
    const { stream, chunks } = capture(true);
    const view = createLiveView({ stream });
    view.onProgress(START);
    view.onProgress({ kind: "attempt_start", backendId: "claude", attempt: 0 });
    const out = frame(chunks);
    view.close();
    expect(out).not.toContain("unreported");
    expect(out).not.toContain("no spend reported");
  });

  it("names a no_backend run as configuration, not task failure", () => {
    const { stream, chunks } = capture(true);
    const view = createLiveView({ stream });
    view.onProgress(START);
    view.onProgress({
      kind: "backend_skip",
      backendId: "claude",
      reason: "claude not on PATH",
    });
    view.onProgress({
      kind: "run_end",
      manifest: { ...manifest("no_backend"), steps: [] },
    });
    const out = chunks.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(out).toContain("no backend available");
    expect(out).toContain("not on PATH");
  });

  it("prints a final per-backend summary after the run", () => {
    const { stream, chunks } = capture(true);
    const view = createLiveView({ stream });
    view.onProgress(START);
    view.onProgress({ kind: "run_end", manifest: manifest("success") });
    const out = chunks.join("").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
    expect(out).toContain("success");
    expect(out).toContain("claude");
    expect(out).toContain("41.2s");
    expect(out).toContain("58.9s");
  });
});

describe("append-only renderer", () => {
  it("is used when stdout is not a terminal and emits no escape codes", () => {
    const { stream, chunks } = capture(false);
    const view = createLiveView({ stream });
    view.onProgress(START);
    view.onProgress({ kind: "attempt_start", backendId: "claude", attempt: 0 });
    view.onProgress({
      kind: "agent",
      backendId: "claude",
      event: {
        kind: "tool",
        name: "Read",
        status: "completed",
        id: "t1",
        detail: "src/parser.ts",
      },
    });
    view.onProgress({
      kind: "handoff",
      from: "claude",
      to: "cursor",
      reason: "limit_exhausted",
    });
    view.onProgress({ kind: "run_end", manifest: manifest("success") });
    view.close();

    const out = chunks.join("");
    expect(out).not.toMatch(/\x1b/);
    expect(out).toContain("chain: claude → cursor → codex");
    expect(out).toContain("Read src/parser.ts");
    expect(out).toContain("handoff claude → cursor");
  });
});

describe("cost and quota formatting", () => {
  const lane = (over: Partial<Lane>): Lane => ({
    id: "x",
    state: "success",
    attempt: 0,
    ...over,
  });

  it("labels a total as incomplete when a backend reports no spend", () => {
    const out = costSummary(
      [
        lane({ id: "claude", cost: { usd: 0.5 } }),
        lane({ id: "cursor" }),
      ],
      PLAIN,
    );
    expect(out).toContain("$0.5000");
    expect(out).toContain("cursor unreported");
  });

  it("reports a bare total when every backend reported", () => {
    const out = costSummary([lane({ id: "claude", cost: { usd: 0.25 } })], PLAIN);
    expect(out).toBe("$0.2500 known");
  });

  it("renders a utilization bar per window", () => {
    const out = quotaLine(
      {
        windows: [
          { key: "five_hour", utilization: 0.03 },
          { key: "seven_day", utilization: 0.35 },
        ],
        at: "",
      },
      PLAIN,
    );
    expect(out).toContain("5h");
    expect(out).toContain("3%");
    expect(out).toContain("7d");
    expect(out).toContain("35%");
  });
});

describe("clip", () => {
  it("keeps a clipped line within the given width", () => {
    expect(visibleLength(clip("a".repeat(40), 10))).toBeLessThanOrEqual(10);
  });

  it("does not leave a colour unterminated when it cuts mid-style", () => {
    const clipped = clip(`\x1b[32m${"a".repeat(40)}\x1b[39m`, 10);
    expect(clipped.endsWith("\x1b[0m")).toBe(true);
  });
});
