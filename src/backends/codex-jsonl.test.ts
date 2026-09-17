import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { classify } from "./detectors.js";
import { ingestLine } from "./parse.js";
import { spawnRun } from "./spawn.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mockBinary(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), "truss-mock-"));
  dirs.push(dir);
  const path = join(dir, "mock-codex");
  writeFileSync(path, `#!/usr/bin/env node\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

function loadJsonl(name: string): string {
  return readFileSync(join(fixtures, name), "utf8");
}

describe("Codex JSONL fixtures", () => {
  it("classifies success after ignoring thread.started", () => {
    const lines = loadJsonl("codex-success.jsonl").trim().split("\n");
    let raw: unknown;
    for (const line of lines) {
      for (const event of ingestLine(line, "codex")) {
        if (event.kind === "result") raw = event.raw;
      }
    }
    expect(raw).toMatchObject({ type: "turn.completed" });
    expect(classify({ exitCode: 0, raw })).toBe("success");
  });

  it("classifies quota after thread.started + turn.failed", () => {
    const lines = loadJsonl("codex-limit.jsonl").trim().split("\n");
    let raw: unknown;
    for (const line of lines) {
      for (const event of ingestLine(line, "codex")) {
        if (event.kind === "result") raw = event.raw;
      }
    }
    expect(raw).toMatchObject({ type: "turn.failed" });
    expect(classify({ exitCode: 1, raw })).toBe("limit_exhausted");
  });

  it("classifies transient and auth failures", () => {
    const transient = JSON.parse(
      loadJsonl("codex-transient.jsonl").trim().split("\n").at(-1)!,
    );
    expect(classify({ exitCode: 1, raw: transient })).toBe("transient");

    const auth = JSON.parse(
      loadJsonl("codex-auth.jsonl").trim().split("\n").at(-1)!,
    );
    expect(classify({ exitCode: 1, raw: auth })).toBe("unusable");
  });

  it("skips malformed lines and still takes turn.completed", () => {
    const lines = loadJsonl("codex-malformed.jsonl").trim().split("\n");
    let raw: unknown;
    for (const line of lines) {
      for (const event of ingestLine(line, "codex")) {
        if (event.kind === "result") raw = event.raw;
      }
    }
    expect(raw).toMatchObject({ type: "turn.completed" });
  });
});

describe("spawnRun with mock Codex JSONL", () => {
  it("does not let thread.started mask a later quota failure", async () => {
    const payload = JSON.stringify(loadJsonl("codex-limit.jsonl"));
    const binary = mockBinary(`
      process.stdout.write(${payload});
      process.exit(1);
    `);
    const run = spawnRun(
      {
        binary,
        args: [],
        dialect: "codex",
        cwd: process.cwd(),
      },
      { autonomy: "low" },
    );
    const result = await run.result;
    expect(result.outcome).toBe("limit_exhausted");
    expect(result.raw).toMatchObject({ type: "turn.failed" });
  });

  it("classifies a successful JSONL stream", async () => {
    const payload = JSON.stringify(loadJsonl("codex-success.jsonl"));
    const binary = mockBinary(`
      process.stdout.write(${payload});
      process.exit(0);
    `);
    const run = spawnRun(
      {
        binary,
        args: [],
        dialect: "codex",
        cwd: process.cwd(),
      },
      { autonomy: "low" },
    );
    const result = await run.result;
    expect(result.outcome).toBe("success");
    expect(result.text).toContain("done");
  });
});
