import { describe, expect, it } from "vitest";
import { buildBrief } from "./brief.js";
import { formatCost, formatReport } from "./report.js";
import type { RunManifest } from "./manifest.js";

describe("brief", () => {
  it("includes role, memory, skill, and handoff", () => {
    const brief = buildBrief({
      task: "add tests",
      identity: "builder — Repo builder",
      memory: "lexer is done",
      skill: "Review a pull request",
      transcript: "user: hi",
      handoff: { from: "claude", diffstat: "1 file", partial: "stopped" },
    });
    expect(brief).toContain("add tests");
    expect(brief).toContain("lexer is done");
    expect(brief).toContain("Review a pull request");
    expect(brief).toContain("previous backend (claude)");
    expect(brief).toContain("memory.md");
  });

  it("does not ask for memory.md when no bot is attached", () => {
    // `truss run` passes no identity. Asking a bot-less run to maintain memory
    // leaves a stray memory.md in whatever repo the task happened to run in.
    const brief = buildBrief({ task: "add tests" });
    expect(brief).toContain("add tests");
    expect(brief).not.toContain("memory.md");
  });

  it("still asks for memory.md on a handoff when a bot is attached", () => {
    const brief = buildBrief({
      task: "add tests",
      identity: "builder — Repo builder",
      handoff: { from: "claude", diffstat: "1 file" },
    });
    expect(brief).toContain("memory.md");
  });

  it("does not ask for memory.md on a bot-less handoff", () => {
    const brief = buildBrief({
      task: "add tests",
      handoff: { from: "claude", diffstat: "1 file" },
    });
    expect(brief).toContain("previous backend (claude)");
    expect(brief).not.toContain("memory.md");
  });
});

describe("report", () => {
  it("labels incomplete cost totals", () => {
    expect(formatCost(undefined, { reportsCost: false, reportsTokens: false, supportsBudgetCap: false, supportsResume: false, requiresTrust: true })).toMatch(
      /cost unknown/,
    );
    const manifest: RunManifest = {
      id: "x",
      task: "t",
      cwd: "/tmp",
      startedAt: "",
      endedAt: "",
      finalOutcome: "success",
      steps: [
        {
          backendId: "claude",
          startedAt: "",
          endedAt: "",
          outcome: "success",
          durationMs: 1,
          cost: { usd: 0.1 },
        },
        {
          backendId: "cursor",
          startedAt: "",
          endedAt: "",
          outcome: "success",
          durationMs: 1,
        },
      ],
    };
    expect(formatReport(manifest)).toContain("incomplete");
  });
});
