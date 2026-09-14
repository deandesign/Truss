import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend, result } from "../backends/fake.js";
import { route } from "./router.js";

const dirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "truss-route-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("router", () => {
  it("fails over on quota and briefs the next backend", async () => {
    const cwd = tmp();
    const claude = new FakeBackend("claude", "claude", () =>
      result("limit_exhausted", "usage limit hit"),
    );
    const cursor = new FakeBackend("cursor", "cursor-agent", () =>
      result("success", "continued"),
    );
    const manifest = await route({
      backends: [claude, cursor],
      task: { prompt: "add tests", cwd },
      autonomy: "low",
    });
    expect(manifest.finalOutcome).toBe("success");
    expect(manifest.steps.map((s) => s.backendId)).toEqual(["claude", "cursor"]);
    expect(cursor.prompts[0]).toContain("add tests");
    expect(cursor.prompts[0]).toContain("previous backend (claude)");
    expect(cursor.prompts[0]).toContain("Continue");
  });

  it("does not fail over on task failure", async () => {
    const cwd = tmp();
    const claude = new FakeBackend("claude", "claude", () =>
      result("task_failure", "tests failed"),
    );
    const cursor = new FakeBackend("cursor", "cursor-agent", () =>
      result("success", "should not run"),
    );
    const manifest = await route({
      backends: [claude, cursor],
      task: { prompt: "add tests", cwd },
      autonomy: "low",
    });
    expect(manifest.finalOutcome).toBe("task_failure");
    expect(cursor.prompts).toHaveLength(0);
  });

  it("retries transient then continues", async () => {
    const cwd = tmp();
    let n = 0;
    const claude = new FakeBackend("claude", "claude", () => {
      n += 1;
      return n === 1 ? result("transient", "503") : result("success", "ok");
    });
    const manifest = await route({
      backends: [claude],
      task: { prompt: "ping", cwd },
      autonomy: "low",
    });
    expect(manifest.finalOutcome).toBe("success");
    expect(claude.prompts).toHaveLength(2);
  });

  it("skips missing binaries", async () => {
    const cwd = tmp();
    const missing = new FakeBackend(
      "claude",
      "claude",
      () => result("success"),
      false,
    );
    const cursor = new FakeBackend("cursor", "cursor-agent", () =>
      result("success", "ran"),
    );
    const manifest = await route({
      backends: [missing, cursor],
      task: { prompt: "ping", cwd },
      autonomy: "low",
    });
    expect(manifest.steps[0]?.backendId).toBe("cursor");
  });
});
