import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend, result } from "../backends/fake.js";
import { checkpoint, diffstat, isGitRepo } from "./git.js";
import { route } from "./router.js";

const dirs: string[] = [];

function tmpRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "truss-git-"));
  dirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "truss@test"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "truss"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("git checkpoints", () => {
  it("writes scratch refs without polluting the working branch", async () => {
    const cwd = tmpRepo();
    expect(await isGitRepo(cwd)).toBe(true);
    writeFileSync(join(cwd, "src.ts"), "export const x = 1;\n");
    const commit = await checkpoint(cwd, "run1", 1);
    expect(commit).toMatch(/^[0-9a-f]{40}$/);
    const refs = execFileSync("git", ["show-ref"], { cwd, encoding: "utf8" });
    expect(refs).toContain("refs/truss/run1/1");
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd,
      encoding: "utf8",
    }).trim();
    expect(branch).not.toBe("");
  });

  it("surfaces dirty-tree diffstat for handoffs", async () => {
    const cwd = tmpRepo();
    writeFileSync(join(cwd, "extra.txt"), "dirty\n");
    const stat = await diffstat(cwd);
    expect(stat).toMatch(/extra\.txt|files? changed|insertion/i);
  });

  it("handoff brief includes diffstat from a real dirty tree", async () => {
    const cwd = tmpRepo();
    writeFileSync(join(cwd, "parser.ts"), "export {}\n");
    const first = new FakeBackend("claude", "claude", () =>
      result("limit_exhausted", "usage limit"),
    );
    const second = new FakeBackend("cursor", "cursor-agent", (prompt) => {
      expect(prompt).toContain("parser.ts");
      return result("success", "continued");
    });
    const manifest = await route({
      backends: [first, second],
      task: { prompt: "finish parser", cwd },
      autonomy: "low",
    });
    expect(manifest.finalOutcome).toBe("success");
    expect(manifest.steps.map((s) => s.backendId)).toEqual(["claude", "cursor"]);
  });
});

describe("budgets", () => {
  it("stops the chain on budget_exhausted without failing over", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "truss-budget-"));
    dirs.push(cwd);
    mkdirSync(cwd, { recursive: true });
    const spendy = new FakeBackend("claude", "claude", () =>
      result("success", "spent", { cost: { usd: 2 } }),
    );
    const next = new FakeBackend("cursor", "cursor-agent", () =>
      result("success", "should not run"),
    );
    const manifest = await route({
      backends: [spendy, next],
      task: { prompt: "work", cwd },
      autonomy: "low",
      budgets: { maxBudgetUsd: 1 },
    });
    expect(manifest.finalOutcome).toBe("budget_exhausted");
    expect(next.prompts).toHaveLength(0);
  });
});
