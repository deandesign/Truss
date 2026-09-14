import type { Outcome } from "./types.js";

const LIMIT_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /too many requests/i,
  /out of extra usage/i,
  /quota(?:\s+exceeded|\s+exhausted)?/i,
  /\b429\b/,
  /you've hit your limit/i,
  /hit your limit/i,
];

const TRANSIENT_PATTERNS = [
  /overloaded/i,
  /service unavailable/i,
  /timed? out/i,
  /econnreset/i,
  /enotfound/i,
  /network error/i,
  /\b5\d\d\b/,
];

export interface ClassifyInput {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  raw?: unknown;
  aborted?: boolean;
}

function blob(input: ClassifyInput): string {
  const rawText =
    input.raw && typeof input.raw === "object"
      ? JSON.stringify(input.raw)
      : "";
  return [input.stdout, input.stderr, rawText].filter(Boolean).join("\n");
}

function statusOf(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const value = rec.api_error_status ?? rec.status ?? rec.status_code;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function field(raw: unknown, key: string): string {
  if (!raw || typeof raw !== "object") return "";
  const value = (raw as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

export function classify(input: ClassifyInput): Outcome {
  if (input.aborted) return "cancelled";

  const status = statusOf(input.raw);
  if (status === 429 || status === 402) return "limit_exhausted";
  if (status !== undefined && status >= 500) return "transient";

  const subtype = field(input.raw, "subtype");
  const terminal = field(input.raw, "terminal_reason");
  const combined = `${subtype} ${terminal}`;
  if (/rate_limit|usage_limit|quota/i.test(combined)) return "limit_exhausted";
  if (/overloaded|unavailable/i.test(combined)) return "transient";

  const text = blob(input);
  if (LIMIT_PATTERNS.some((p) => p.test(text))) return "limit_exhausted";
  if (TRANSIENT_PATTERNS.some((p) => p.test(text))) return "transient";

  const isError =
    input.raw &&
    typeof input.raw === "object" &&
    (input.raw as { is_error?: unknown }).is_error === true;

  if (input.exitCode === 0 && !isError) return "success";
  return "task_failure";
}
