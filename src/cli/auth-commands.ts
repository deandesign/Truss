import { spawn } from "node:child_process";
import { backendFromPreset } from "../backends/registry.js";
import { loginCommand, logoutCommand, probeAuth } from "../backends/auth.js";
import type { Backend } from "../backends/types.js";
import { loadConfig } from "../core/config.js";
import { loadLimits } from "../core/limits.js";
import { paletteFor } from "../ui/ansi.js";
import { formatStatus, type Health, type StatusRow } from "../ui/status.js";

export function configuredBackends(): Backend[] {
  const config = loadConfig();
  const byId = new Map(config.backends.map((p) => [p.id, p]));
  return config.order
    .map((id) => byId.get(id))
    .filter((p): p is NonNullable<typeof p> => Boolean(p))
    .map(backendFromPreset);
}

export async function collectStatus(): Promise<StatusRow[]> {
  const limits = loadLimits();
  const backends = configuredBackends();
  return Promise.all(
    backends.map(async (backend): Promise<StatusRow> => {
      const avail = await backend.available();
      const health: Health = !avail.installed
        ? "missing"
        : avail.usable
          ? "ready"
          : "broken";
      return {
        id: backend.id,
        health,
        detail: avail.detail,
        auth:
          health === "ready"
            ? await probeAuth(backend.dialect, backend.binary)
            : undefined,
        quota: limits[backend.id]?.quota,
        limitedAt: limits[backend.id]?.at,
      };
    }),
  );
}

export async function printStatus(): Promise<void> {
  const rows = await collectStatus();
  process.stdout.write(
    formatStatus(rows, paletteFor(process.stdout), process.stdout.columns ?? 90),
  );
}

/**
 * Hand the terminal to the vendor's own login flow.
 *
 * stdio is inherited so the CLI can run its browser handshake and prompts
 * directly — Truss is not in the middle, and never sees a token.
 */
function runInteractive(binary: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(127));
  });
}

async function resolveTargets(id?: string): Promise<Backend[]> {
  const backends = configuredBackends();
  if (!id) return backends;
  const found = backends.find((b) => b.id === id);
  if (!found) {
    throw new Error(
      `no backend "${id}" — configured: ${backends.map((b) => b.id).join(", ")}`,
    );
  }
  return [found];
}

export async function loginCmd(id: string | undefined): Promise<void> {
  const palette = paletteFor(process.stdout);
  const targets = await resolveTargets(id);
  let attempted = 0;

  for (const backend of targets) {
    const avail = await backend.available();
    if (!avail.usable) {
      console.log(
        `${palette.dim("skip")} ${backend.id} — ${avail.detail ?? "not usable"}`,
      );
      continue;
    }
    const auth = await probeAuth(backend.dialect, backend.binary);
    if (auth.authed === true && !id) {
      const who = auth.account?.email ? ` as ${auth.account.email}` : "";
      console.log(`${palette.green("✓")} ${backend.id} already signed in${who}`);
      continue;
    }
    attempted += 1;
    const cmd = loginCommand(backend.dialect, backend.binary);
    console.log(
      `\n${palette.bold(backend.id)} ${palette.dim(`→ ${cmd.binary} ${cmd.args.join(" ")}`)}\n`,
    );
    const code = await runInteractive(cmd.binary, cmd.args);
    if (code !== 0) {
      console.log(palette.yellow(`${backend.id}: login exited ${code}`));
      process.exitCode = 1;
    }
  }

  if (attempted === 0 && !id) {
    console.log(`\n${palette.dim("every usable backend is already signed in")}`);
  }
}

export async function logoutCmd(id: string): Promise<void> {
  const [backend] = await resolveTargets(id);
  const cmd = logoutCommand(backend.dialect, backend.binary);
  const code = await runInteractive(cmd.binary, cmd.args);
  if (code !== 0) process.exitCode = 1;
}
