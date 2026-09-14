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
