import type { AuthStatus } from "../backends/auth.js";
import type { QuotaSnapshot } from "../backends/types.js";
import { clip, pad, type Palette } from "./ansi.js";
import { quotaLine } from "./live.js";

export type Health = "ready" | "broken" | "missing";

export interface StatusRow {
  id: string;
  health: Health;
  /** Why it is broken or missing. */
  detail?: string;
  auth?: AuthStatus;
  quota?: QuotaSnapshot;
  limitedAt?: string;
}

function healthMark(health: Health, palette: Palette): string {
  if (health === "ready") return palette.green("●");
  if (health === "broken") return palette.red("○");
  return palette.dim("○");
}

/** Vendor spawn errors are enormous; the headline is the useful part. */
function reason(detail: string | undefined, width: number): string {
  if (!detail) return "";
  const oneLine = detail.replace(/\s+/g, " ").trim();
  const short = oneLine.replace(/^.*?will not run: /, "").replace(/^Error: /, "");
  return clip(short, width);
}

function authLine(row: StatusRow, palette: Palette): string {
  if (row.health === "missing") return palette.dim("not installed");
  if (row.health === "broken") return palette.red("will not run");
  const auth = row.auth;
  if (!auth || auth.authed === "unknown") {
    return palette.dim(auth?.detail ?? "sign-in state unknown");
  }
  if (!auth.authed) {
    return palette.yellow("not signed in");
  }
  const email = auth.account?.email;
  const plan = auth.account?.plan;
  const who = email ? `logged in as ${email}` : "logged in";
  return plan ? `${who} ${palette.dim(`(${plan})`)}` : who;
}

export function formatStatus(
  rows: StatusRow[],
  palette: Palette,
  columns = 90,
): string {
  const width = Math.max(6, ...rows.map((r) => r.id.length));
  const lines: string[] = [""];
  const indent = " ".repeat(width + 15);
  const room = Math.max(30, columns - indent.length - 2);

  for (const row of rows) {
    lines.push(
      `  ${healthMark(row.health, palette)} ${pad(row.id, width)}  ${pad(row.health, 7)}  ${authLine(row, palette)}`,
    );
    if (row.quota?.windows.length) {
      lines.push(`${indent}${quotaLine(row.quota, palette)}`);
    }
    if (row.limitedAt) {
      lines.push(`${indent}${palette.yellow(`limit seen ${row.limitedAt}`)}`);
    }
    if (row.health !== "ready" && row.detail) {
      lines.push(`${indent}${palette.dim(reason(row.detail, room))}`);
      if (row.health === "broken") {
        lines.push(`${indent}${palette.dim("skipped by the router")}`);
      }
    }
  }

  const signedOut = rows.filter(
    (r) => r.health === "ready" && r.auth?.authed === false,
  );
  const usable = rows.filter(
    (r) => r.health === "ready" && r.auth?.authed !== false,
  );

  lines.push("");
  if (usable.length === 0) {
    lines.push(
      `  ${palette.red("no backend is ready")} — run ${palette.bold("truss setup")}`,
    );
  } else if (signedOut.length) {
    lines.push(
      `  ${palette.dim(`sign in with`)} ${palette.bold(`truss login ${signedOut[0].id}`)}`,
    );
  }
  lines.push("");
  return lines.join("\n").replace(/[ \t]+$/gm, "");
}
