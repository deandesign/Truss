import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeBackend, result } from "../backends/fake.js";
import { initHome } from "../core/init.js";
import { harvestMemory, memoryDropPath } from "./harvest.js";
import { loadMemory, saveMemory } from "./store.js";
import { talkOnce } from "./talk.js";

const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  process.env.TRUSS_HOME = tmp("truss-home-");
  initHome();
});

afterEach(() => {
  delete process.env.TRUSS_HOME;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function drop(cwd: string, body: string): void {
  const path = memoryDropPath(cwd);
  mkdirSync(join(cwd, ".truss"), { recursive: true });
  writeFileSync(path, body);
}

describe("memory harvest", () => {
  it("moves the drop into the bot's store and clears it", () => {
    const cwd = tmp("truss-repo-");
    drop(cwd, "lexer done, parser next\n");

    expect(harvestMemory(cwd, "builder")).toBe(true);
    expect(loadMemory("builder")).toContain("lexer done, parser next");
    expect(existsSync(memoryDropPath(cwd))).toBe(false);
  });

  it("is a no-op when the run left nothing", () => {
    const cwd = tmp("truss-repo-");
    saveMemory("builder", "existing notes\n");

    expect(harvestMemory(cwd, "builder")).toBe(false);
    expect(loadMemory("builder")).toContain("existing notes");
  });

  it("treats an empty scratchpad as nothing to say, not as forget everything", () => {
    const cwd = tmp("truss-repo-");
    saveMemory("builder", "existing notes\n");
    drop(cwd, "   \n");

    expect(harvestMemory(cwd, "builder")).toBe(false);
    expect(loadMemory("builder")).toContain("existing notes");
    // Still cleared, so it cannot be read back into a different bot later.
    expect(existsSync(memoryDropPath(cwd))).toBe(false);
  });

  it("never touches a memory.md the repo keeps for itself", () => {
    const cwd = tmp("truss-repo-");
    const repoOwned = join(cwd, "memory.md");
    writeFileSync(repoOwned, "# the project's own notes\n");
    drop(cwd, "bot notes\n");

    harvestMemory(cwd, "builder");

    expect(readFileSync(repoOwned, "utf8")).toBe("# the project's own notes\n");
    expect(loadMemory("builder")).toContain("bot notes");
  });
});

describe("memory round trip", () => {
  it("persists across turns — what one turn writes, the next one reads", async () => {
    const cwd = tmp("truss-repo-");

    // Turn one: the agent leaves a scratchpad the way the brief asks it to.
    const writer = new FakeBackend("claude", "claude", () => {
      drop(cwd, "decided: continue, no validity gate\n");
      return result("success", "noted");
    });
    await talkOnce({ botId: "builder", message: "start", cwd, backends: [writer] });

    expect(loadMemory("builder")).toContain("continue, no validity gate");

    // Turn two: a fresh run must inherit it through the brief.
    let seen = "";
    const reader = new FakeBackend("claude", "claude", (prompt) => {
      seen = prompt;
      return result("success", "ok");
    });
    await talkOnce({ botId: "builder", message: "carry on", cwd, backends: [reader] });

    expect(seen).toContain("continue, no validity gate");
  });
});
