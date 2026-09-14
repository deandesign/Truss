import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Dialect } from "./types.js";

const execFileAsync = promisify(execFile);

export interface Account {
  email?: string;
  plan?: string;
}

export interface AuthStatus {
  /** "unknown" when the backend offers no way to ask without spending money. */
  authed: boolean | "unknown";
  account?: Account;
  detail?: string;
}

/**
 * How each vendor answers "am I signed in?". Truss never handles a credential
 * itself — every CLI owns its own tokens, and these commands only read the
 * state the vendor already keeps.
 */
const STATUS_ARGS: Record<Dialect, string[]> = {
  claude: ["auth", "status", "--json"],
  cursor: ["status", "--format", "json"],
  codex: ["login", "status"],
};

const LOGIN_ARGS: Record<Dialect, string[]> = {
  claude: ["auth", "login"],
  cursor: ["login"],
  codex: ["login"],
};

const LOGOUT_ARGS: Record<Dialect, string[]> = {
  claude: ["auth", "logout"],
  cursor: ["logout"],
  codex: ["logout"],
};

export function loginCommand(
  dialect: Dialect,
  binary: string,
): { binary: string; args: string[] } {
  return { binary, args: LOGIN_ARGS[dialect] };
}

export function logoutCommand(
  dialect: Dialect,
  binary: string,
): { binary: string; args: string[] } {
  return { binary, args: LOGOUT_ARGS[dialect] };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Parse a vendor's auth payload into the one shape Truss reports. */
export function parseAuth(dialect: Dialect, stdout: string): AuthStatus {
  const trimmed = stdout.trim();
  if (dialect === "codex") {
    // Codex prints prose, not JSON.
    if (/not logged in|no credentials|please (?:run )?.*login/i.test(trimmed)) {
      return { authed: false };
    }
    const email = trimmed.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
    if (/logged in|authenticated/i.test(trimmed)) {
      return { authed: true, account: email ? { email } : undefined };
    }
    return { authed: "unknown", detail: trimmed.split("\n")[0] || undefined };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { authed: "unknown", detail: trimmed.split("\n")[0] || undefined };
  }
  const rec = asRecord(parsed);
  if (!rec) return { authed: "unknown" };

  if (dialect === "claude") {
    const authed = rec.loggedIn === true;
    return {
      authed,
      account: authed
        ? {
            email: str(rec.email),
            plan: str(rec.subscriptionType) ?? str(rec.authMethod),
          }
        : undefined,
    };
  }

  // cursor
  const authed =
    rec.isAuthenticated === true || str(rec.status) === "authenticated";
  const user = asRecord(rec.userInfo);
  return {
    authed,
    account: authed ? { email: str(user?.email) } : undefined,
  };
}

/**
 * Ask a backend whether it is signed in.
 *
 * Deliberately not called by the router: these cost 0.4–1.1s each, which would
 * be paid on every routed run to learn something the run's own outcome reveals
 * anyway. This is for the human-facing commands.
 */
export async function probeAuth(
  dialect: Dialect,
  binary: string,
): Promise<AuthStatus> {
  try {
    const { stdout } = await execFileAsync(binary, STATUS_ARGS[dialect], {
      timeout: 15_000,
    });
    return parseAuth(dialect, stdout);
  } catch (err) {
    const rec = asRecord(err);
    const stdout = typeof rec?.stdout === "string" ? rec.stdout : "";
    const stderr = typeof rec?.stderr === "string" ? rec.stderr : "";
    // A non-zero exit is how some CLIs say "not signed in", so read it before
    // giving up.
    const parsed = parseAuth(dialect, stdout || stderr);
    if (parsed.authed !== "unknown") return parsed;
    if (/not logged in|unauthori[sz]ed|no credentials/i.test(stderr)) {
      return { authed: false };
    }
    return {
      authed: "unknown",
      detail: (stderr || (err as Error)?.message || "")
        .trim()
        .split("\n")[0],
    };
  }
}
