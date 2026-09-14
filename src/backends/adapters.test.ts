import { describe, expect, it } from "vitest";
import { ClaudeBackend } from "./claude.js";
import { CodexBackend } from "./codex.js";
import { CursorBackend } from "./cursor.js";
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

  it("Codex uses exec --json", () => {
    const argv = new CodexBackend("codex", "codex").argv(task, {
      autonomy: "low",
    });
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("--json");
    expect(argv).toContain("--ask-for-approval");
  });
});

describe("parse", () => {
  it("ingests Claude result lines", () => {
    const event = ingestLine(
      JSON.stringify({ type: "result", result: "ok", session_id: "abc" }),
      "claude",
    );
    expect(event).toEqual({
      kind: "result",
      raw: { type: "result", result: "ok", session_id: "abc" },
    });
  });

  it("ingests Codex agent messages", () => {
    const event = ingestLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "hello" },
      }),
      "codex",
    );
    expect(event).toEqual({ kind: "assistant", text: "hello" });
  });
});
