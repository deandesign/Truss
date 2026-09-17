import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeBackend, result } from "../backends/fake.js";
import { talkOnce } from "../bots/talk.js";
import { initHome } from "../core/init.js";
import { loadBot, loadMemory, saveBot, saveMemory } from "./store.js";
import { listSkills, loadSkill, skillFromMessage } from "../skills/store.js";

const dirs: string[] = [];

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "truss-home-"));
  dirs.push(dir);
  process.env.TRUSS_HOME = dir;
  initHome();
});

afterEach(() => {
  delete process.env.TRUSS_HOME;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bots", () => {
  it("creates a default builder bot", () => {
    const bot = loadBot("builder");
    expect(bot?.title).toBe("Repo builder");
    expect(loadMemory("builder")).toMatch(/Plan/);
  });

  it("talk injects identity and memory into the inner loop", async () => {
    saveMemory("builder", "parser is next");
    const backend = new FakeBackend("claude", "claude", (prompt) => {
      expect(prompt).toContain("Repo builder");
      expect(prompt).toContain("parser is next");
      expect(prompt).toContain("ship it");
      return result("success", "ok");
    });
    const out = await talkOnce({
      botId: "builder",
      message: "ship it",
      cwd: process.env.TRUSS_HOME!,
      backends: [backend],
    });
    expect(out.text).toContain("ok");
    expect(out.manifest.finalOutcome).toBe("success");
    expect(backend.prompts).toHaveLength(1);
  });

  it("rejects path-traversal bot ids", () => {
    expect(() =>
      saveBot({
        id: "../evil",
        name: "evil",
        title: "evil",
        role: "no",
      }),
    ).toThrow(/bot id/);
  });

  it("reuses a conversation across turns", async () => {
    const backend = new FakeBackend("claude", "claude", (prompt) => {
      return result("success", `heard:${prompt.includes("first") ? "1" : "2"}`);
    });
    const first = await talkOnce({
      botId: "builder",
      message: "first",
      cwd: process.env.TRUSS_HOME!,
      backends: [backend],
    });
    const second = await talkOnce({
      botId: "builder",
      message: "second",
      cwd: process.env.TRUSS_HOME!,
      backends: [backend],
      conversation: first.conversation,
    });
    expect(second.conversation.id).toBe(first.conversation.id);
    expect(second.conversation.turns.length).toBe(4);
    expect(backend.prompts[1]).toContain("user: first");
  });
});

describe("skills", () => {
  it("ships example packs and injects /review-pr", () => {
    expect(listSkills().map((s) => s.id).sort()).toEqual([
      "daily-triage",
      "review-pr",
    ]);
    const { skill, rest } = skillFromMessage("/review-pr look at #12");
    expect(skill?.id).toBe("review-pr");
    expect(rest).toBe("look at #12");
    expect(loadSkill("daily-triage")?.body).toMatch(/memory.md/);
  });

  it("talk injects --skill text into the brief", async () => {
    const backend = new FakeBackend("claude", "claude", (prompt) => {
      expect(prompt).toContain("Review a pull request");
      return result("success", "nits");
    });
    await talkOnce({
      botId: "builder",
      message: "look at this",
      skill: "review-pr",
      cwd: process.env.TRUSS_HOME!,
      backends: [backend],
    });
  });
});
