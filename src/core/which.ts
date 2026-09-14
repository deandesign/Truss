import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function which(binary: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("which", [binary]);
    const path = stdout.trim();
    return path || undefined;
  } catch {
    return undefined;
  }
}

export interface ProbeResult {
  ok: boolean;
  detail?: string;
}

/**
 * Ask a backend binary for its version. Being on PATH is not the same as being
 * runnable: an npm-installed CLI whose vendored native binary is missing
 * resolves via `which` and then fails to spawn. Catching that here means the
 * router skips the backend instead of spending a run discovering it.
 */
export async function probeVersion(binary: string): Promise<ProbeResult> {
  try {
    const { stdout } = await execFileAsync(binary, ["--version"], {
      timeout: 10_000,
    });
    return { ok: true, detail: stdout.trim().split("\n")[0] || undefined };
  } catch (err) {
    const message =
      err && typeof err === "object" && "stderr" in err
        ? String((err as { stderr?: unknown }).stderr ?? "")
        : "";
    const fallback = err instanceof Error ? err.message : String(err);
    const detail = (message || fallback).trim().split("\n")[0];
    return { ok: false, detail: detail || "version probe failed" };
  }
}
