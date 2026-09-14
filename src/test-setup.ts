import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach } from "vitest";

/**
 * Point every test file at a throwaway Truss home.
 *
 * Without this, anything that routes a run writes to the real `~/.truss` —
 * `recordLimit` and `recordQuota` did exactly that, so `npm test` left a
 * fixture's "usage limit" text sitting in the user's own state file and
 * `truss status` reported a limit that never happened.
 */
const home = mkdtempSync(join(tmpdir(), "truss-test-home-"));

function claim(): void {
  process.env.TRUSS_HOME = home;
}

claim();
// Re-assert it: some suites set their own home and clear it when they finish.
beforeEach(claim);
afterEach(claim);

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});
