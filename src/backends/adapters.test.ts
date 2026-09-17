import { describe, expect, it } from "vitest";
import { ClaudeBackend } from "./claude.js";
import { CodexBackend } from "./codex.js";
import { CursorBackend } from "./cursor.js";
import { classify } from "./detectors.js";
import { ingestLine } from "./parse.js";

describe("adapter argv", () => {
  const task = { prompt: "do the thing", cwd: "/tmp" };

  it("Claude uses stream-json, verbose, and mapped permission mode", () => {
    const argv = new ClaudeBackend("claude", "claude").argv(task, {
      autonomy: "low",
    });
    expect(argv).toContain("--output-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--verbose");
    expect(argv).toContain("default");
    expect(argv.at(-1)).toBe("do the thing");
  });

  it("Cursor always passes --trust", () => {
    const argv = new CursorBackend("cursor", "cursor-agent").argv(task, {
      autonomy: "medium",
    });
    expect(argv).toContain("--trust");
    expect(argv).toContain("--auto-review");
    expect(argv).toContain("stream-json");
  });

  it("Codex uses exec --json with distinct autonomy tiers", () => {
    const backend = new CodexBackend("codex", "codex");
    const low = backend.argv(task, { autonomy: "low" });
    expect(low[0]).toBe("exec");
    expect(low).toContain("--json");
    expect(low).toContain("read-only");
    expect(low).toContain("never");
    expect(low).not.toContain("workspace-write");

    const medium = backend.argv(task, { autonomy: "medium" });
    expect(medium).toContain("workspace-write");
    expect(medium).toContain("on-request");

    const high = backend.argv(task, { autonomy: "high" });
    expect(high).toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  it("Claude passes --max-budget-usd when requested", () => {
    const argv = new ClaudeBackend("claude", "claude").argv(task, {
      autonomy: "low",
      maxBudgetUsd: 1.5,
    });
    expect(argv).toContain("--max-budget-usd");
    expect(argv).toContain("1.5");
  });
});

describe("parse", () => {
  it("ingests Claude result lines", () => {
    expect(
      ingestLine(
        JSON.stringify({ type: "result", result: "ok", session_id: "abc" }),
        "claude",
      ),
    ).toEqual([
      {
        kind: "result",
        raw: { type: "result", result: "ok", session_id: "abc" },
      },
    ]);
  });

  it("ingests Codex agent messages", () => {
    expect(
      ingestLine(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "hello" },
        }),
        "codex",
      ),
    ).toEqual([{ kind: "assistant", text: "hello" }]);
  });

  it("surfaces prose and tool calls from one assistant message", () => {
    const events = ingestLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Reading the parser." },
            {
              type: "tool_use",
              id: "tu_1",
              name: "Read",
              input: { file_path: "src/parser.ts" },
            },
          ],
        },
      }),
      "claude",
    );
    expect(events).toEqual([
      { kind: "assistant", text: "Reading the parser." },
      {
        kind: "tool",
        name: "Read",
        status: "started",
        id: "tu_1",
        detail: "src/parser.ts",
      },
    ]);
  });

  it("reads live quota utilization out of a rate_limit_event", () => {
    const events = ingestLine(
      JSON.stringify({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed",
          rateLimitType: "five_hour",
          isUsingOverage: false,
          unifiedWindows: {
            five_hour: { utilization: 0.03, resetsAt: 1789398600 },
            seven_day: { utilization: 0.35, resetsAt: 1789603200 },
          },
        },
      }),
      "claude",
    );
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.kind).toBe("quota");
    if (event.kind !== "quota") throw new Error("expected quota");
    expect(event.snapshot.status).toBe("allowed");
    expect(event.snapshot.limitType).toBe("five_hour");
    expect(event.snapshot.windows).toEqual([
      { key: "five_hour", utilization: 0.03, resetsAt: 1789398600 },
      { key: "seven_day", utilization: 0.35, resetsAt: 1789603200 },
    ]);
  });

  it("does not treat thread.started as a terminal result", () => {
    expect(
      ingestLine(
        JSON.stringify({ type: "thread.started", thread_id: "t1" }),
        "codex",
      ),
    ).toEqual([]);
  });

  it("preserves turn.failed as a structured result envelope", () => {
    const events = ingestLine(
      JSON.stringify({
        type: "turn.failed",
        error: { message: "rate limit exceeded", code: "rate_limit" },
      }),
      "codex",
    );
    expect(events).toEqual([
      { kind: "error", text: "rate limit exceeded" },
      {
        kind: "result",
        raw: {
          type: "turn.failed",
          error: { message: "rate limit exceeded", code: "rate_limit" },
        },
      },
    ]);
  });
});

describe("quota status classification", () => {
  it("a non-allowed quota status is an authoritative limit signal", () => {
    expect(
      classify({ exitCode: 0, quotaStatus: "rejected", raw: { type: "result" } }),
    ).toBe("limit_exhausted");
  });

  it("an allowed quota status does not disturb a success", () => {
    expect(
      classify({
        exitCode: 0,
        quotaStatus: "allowed",
        raw: { type: "result", is_error: false, result: "ok" },
      }),
    ).toBe("success");
  });
});
