import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../core/config.js";
import {
  chooseSetup,
  readyOf,
  suggestedOrder,
  type Ask,
  type Candidate,
} from "./setup.js";

const claude: Candidate = {
  id: "claude",
  usable: true,
  signedIn: true,
  email: "a@b.c",
  plan: "team",
};
const cursorSignedOut: Candidate = {
  id: "cursor",
  usable: true,
  signedIn: false,
};
const codexBroken: Candidate = {
  id: "codex",
  usable: false,
  signedIn: false,
  detail: "will not run",
};

/** Answers the wizard's prompts in order; "" means accept the default. */
function scripted(...answers: string[]): Ask {
  let i = 0;
  return async (_question, fallback) => answers[i++] || fallback;
}

describe("setup survey logic", () => {
  it("counts only runnable, signed-in backends as ready", () => {
    expect(readyOf([claude, cursorSignedOut, codexBroken]).map((c) => c.id)).toEqual(
      ["claude"],
    );
  });

  it("treats an unknown sign-in state as usable rather than excluding it", () => {
    // Codex reports prose, so "unknown" is common. Excluding it would hide a
    // backend that may well work.
    const unknown: Candidate = { id: "codex", usable: true, signedIn: "unknown" };
    expect(readyOf([unknown]).map((c) => c.id)).toEqual(["codex"]);
  });

  it("suggests ready backends first, but keeps the rest in the chain", () => {
    expect(suggestedOrder([codexBroken, cursorSignedOut, claude])).toEqual([
      "claude",
      "codex",
      "cursor",
    ]);
  });
});

describe("setup choices", () => {
  const found = [claude, cursorSignedOut, codexBroken];

  it("accepting both defaults writes the suggested order", async () => {
    const next = await chooseSetup(found, DEFAULT_CONFIG, scripted("", ""));
    // Ready first, then the rest in the order they were found.
    expect(next.order).toEqual(["claude", "cursor", "codex"]);
    expect(next.autonomy).toBe(DEFAULT_CONFIG.autonomy);
  });

  it("honours a typed order and autonomy", async () => {
    const next = await chooseSetup(
      found,
      DEFAULT_CONFIG,
      scripted("cursor, claude", "medium"),
    );
    expect(next.order).toEqual(["cursor", "claude"]);
    expect(next.autonomy).toBe("medium");
  });

  it("refuses an unknown backend rather than saving it", async () => {
    await expect(
      chooseSetup(found, DEFAULT_CONFIG, scripted("claude,nope", "")),
    ).rejects.toThrow(/unknown backend/);
  });

  it("refuses a bad autonomy rather than saving it", async () => {
    await expect(
      chooseSetup(found, DEFAULT_CONFIG, scripted("", "yolo")),
    ).rejects.toThrow(/autonomy must be one of/);
  });

  it("refuses a repeated backend", async () => {
    await expect(
      chooseSetup(found, DEFAULT_CONFIG, scripted("claude,claude", "")),
    ).rejects.toThrow(/repeats/);
  });
});
