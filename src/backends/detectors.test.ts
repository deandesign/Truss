import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { classify } from "./detectors.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

describe("classify", () => {
  it("reads a captured Claude success envelope", () => {
    const raw = load("claude-success.json");
    expect(classify({ exitCode: 0, raw })).toBe("success");
  });

  it("treats api_error_status 429 as limit", () => {
    const raw = load("claude-limit.json");
    expect(classify({ exitCode: 1, raw })).toBe("limit_exhausted");
  });

  it("classifies Cursor success", () => {
    expect(classify({ exitCode: 0, raw: load("cursor-success.json") })).toBe(
      "success",
    );
  });

  it("classifies Cursor limit via text when status is missing", () => {
    expect(classify({ exitCode: 1, raw: load("cursor-limit.json") })).toBe(
      "limit_exhausted",
    );
  });

  it("classifies Codex limit events", () => {
    expect(classify({ exitCode: 1, raw: load("codex-limit.json") })).toBe(
      "limit_exhausted",
    );
  });

  it("does not fail over on ordinary task failure", () => {
    expect(
      classify({
        exitCode: 1,
        raw: { type: "result", is_error: true, result: "tests failed" },
      }),
    ).toBe("task_failure");
  });

  it("retries 5xx as transient", () => {
    expect(
      classify({
        exitCode: 1,
        raw: { api_error_status: 503, result: "overloaded" },
      }),
    ).toBe("transient");
  });

  it("marks abort as cancelled", () => {
    expect(classify({ exitCode: 1, aborted: true })).toBe("cancelled");
  });
});

/**
 * Regression corpus. Each case here was an observed misclassification: the
 * classifier used to pattern-match the whole stdout stream, so a repo path, a
 * prompt, or the agent's own prose could look like a quota error.
 */
describe("classify does not read limits out of ordinary output", () => {
  const stream = readFileSync(
    join(fixtures, "claude-success-stream.jsonl"),
    "utf8",
  );

  it("a real success stream whose cwd contains a 5xx-looking number", () => {
    // Captured under /private/tmp/claude-501/… — 501 is the macOS UID, and the
    // init event echoes cwd. This cost three runs of a one-word task.
    expect(stream).toContain("claude-501");
    expect(
      classify({
        exitCode: 0,
        stdout: stream,
        raw: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "pong",
          api_error_status: null,
        },
      }),
    ).toBe("success");
  });

  it("a success whose result text is about rate limiting", () => {
    expect(
      classify({
        exitCode: 0,
        raw: {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "I added retry handling for rate limit errors.",
          api_error_status: null,
        },
      }),
    ).toBe("success");
  });

  it("a success that mentions HTTP 429 in the agent's prose", () => {
    expect(
      classify({
        exitCode: 0,
        stdout:
          '{"type":"assistant","message":{"content":[{"text":"added a test for HTTP 429 retries"}]}}',
        raw: { type: "result", is_error: false, result: "ok" },
      }),
    ).toBe("success");
  });

  it("a success whose token counts contain a 5xx-looking number", () => {
    expect(
      classify({
        exitCode: 0,
        raw: {
          type: "result",
          is_error: false,
          result: "ok",
          usage: { input_tokens: 512, output_tokens: 40 },
        },
      }),
    ).toBe("success");
  });

  it("a task failure whose test output mentions quota", () => {
    expect(
      classify({
        exitCode: 1,
        stdout: "tests failed: expected quota to be tracked",
        raw: { type: "result", is_error: true, result: "2 tests failed" },
      }),
    ).toBe("task_failure");
  });

  it("a task failure in a repo about rate limiting", () => {
    expect(
      classify({
        exitCode: 1,
        stdout: "FAIL src/ratelimit.test.ts — rate limit handler returned 429",
        raw: { type: "result", is_error: true, result: "1 test failed" },
      }),
    ).toBe("task_failure");
  });

  it("still reads a limit out of stderr when the run really failed", () => {
    expect(
      classify({
        exitCode: 1,
        stderr: "Error: usage limit reached. Resets at 4pm.",
        raw: { type: "result", is_error: true, result: "" },
      }),
    ).toBe("limit_exhausted");
  });

  it("still reads a limit from unstructured stdout when there is no envelope", () => {
    expect(
      classify({
        exitCode: 1,
        stdout: "You've hit your usage limit",
        raw: { stdout: "You've hit your usage limit", stderr: "" },
      }),
    ).toBe("limit_exhausted");
  });

  it("still detects a transient network failure", () => {
    expect(
      classify({
        exitCode: 1,
        stderr: "fetch failed: ECONNRESET",
        raw: { type: "result", is_error: true, result: "" },
      }),
    ).toBe("transient");
  });
});

describe("a backend that cannot run is not a task failure", () => {
  it("reads a missing binary as unusable", () => {
    expect(
      classify({
        exitCode: 1,
        stderr:
          "Error: spawn /usr/local/lib/node_modules/@openai/codex/vendor/codex ENOENT",
        raw: { stdout: "", stderr: "" },
      }),
    ).toBe("unusable");
  });

  it("reads a missing login as unusable, not as a spent account", () => {
    expect(
      classify({
        exitCode: 1,
        stderr: "Not logged in. Run `codex login` to continue.",
        raw: { stdout: "", stderr: "" },
      }),
    ).toBe("unusable");
  });

  it("reads 401 as unusable and 402 as a limit", () => {
    expect(classify({ exitCode: 1, raw: { api_error_status: 401 } })).toBe(
      "unusable",
    );
    expect(classify({ exitCode: 1, raw: { api_error_status: 402 } })).toBe(
      "limit_exhausted",
    );
  });

  it("prefers unusable over limit when the text says unauthorized", () => {
    // "unauthorized" must not spend a failover as though quota ran out.
    expect(
      classify({
        exitCode: 1,
        stderr: "401 Unauthorized: invalid api key",
        raw: { type: "result", is_error: true, result: "" },
      }),
    ).toBe("unusable");
  });

  it("does not call an ordinary failure unusable", () => {
    expect(
      classify({
        exitCode: 1,
        raw: { type: "result", is_error: true, result: "2 tests failed" },
      }),
    ).toBe("task_failure");
  });
});
