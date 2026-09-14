import type { Outcome } from "./types.js";

/**
 * Limit and transient signals are only ever read out of *error context* —
 * stderr, and the error-bearing fields of the result envelope. Never out of
 * the whole stdout stream.
 *
 * The reason is that stream-json stdout carries the repo path, the prompt, and
 * every word the agent said. A successful run of "add retry handling for rate
 * limit errors" contains the phrase "rate limit"; a repo checked out under a
 * path containing 501 contains a 5xx-looking number. Scanning that text
 * conflates task failure with quota exhaustion, which ARCHITECTURE.md §4 calls
 * the main way a tool like this wastes a second account's quota.
 */
const LIMIT_PATTERNS = [
  /usage limit/i,
  /rate limit/i,
  /rate_limit/i,
  /too many requests/i,
  /out of (?:extra )?(?:usage|quota|credits)/i,
  /quota (?:exceeded|exhausted|reached)/i,
  /(?:exceeded|exhausted|reached) (?:your )?quota/i,
  /insufficient (?:quota|credits)/i,
  /\b429\b/,
  /(?:you've |you have )?hit your limit/i,
  /limit reached/i,
];

const TRANSIENT_PATTERNS = [
  /overloaded/i,
  /service unavailable/i,
  /bad gateway/i,
  /gateway timeout/i,
  /internal server error/i,
  /timed? out/i,
  /econnreset/i,
  /econnrefused/i,
  /enotfound/i,
  /etimedout/i,
  /socket hang up/i,
  /network error/i,
  /\b50[0-4]\b/,
];

export interface ClassifyInput {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  raw?: unknown;
  aborted?: boolean;
  /**
   * `rate_limit_info.status` from a vendor quota event, when one was seen.
   * Anything other than "allowed" is an authoritative limit signal — far more
   * reliable than reading error prose.
   */
  quotaStatus?: string;
}

function rec(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function statusOf(raw: unknown): number | undefined {
  const obj = rec(raw);
  if (!obj) return undefined;
  const nested = rec(obj.error);
  const value =
    obj.api_error_status ??
    obj.status_code ??
    obj.statusCode ??
    obj.status ??
    nested?.status ??
    nested?.status_code;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d{3}$/.test(value)) return Number(value);
  return undefined;
}

/** True when the envelope is a real parsed vendor result, not our stdout fallback. */
function hasStructuredEnvelope(raw: unknown): boolean {
  const obj = rec(raw);
  if (!obj) return false;
  return (
    typeof obj.type === "string" ||
    "is_error" in obj ||
    "subtype" in obj ||
    "error" in obj
  );
}

function isErrorEnvelope(raw: unknown): boolean {
  const obj = rec(raw);
  if (!obj) return false;
  if (obj.is_error === true) return true;
  if (obj.type === "error" || obj.type === "turn.failed") return true;
  if (str(obj.subtype).startsWith("error")) return true;
  return false;
}

/**
 * The only text classify is allowed to pattern-match. Error fields of the
 * envelope plus stderr; stdout only when the process produced no parseable
 * envelope at all, since then there is nothing else to go on.
 */
function errorText(input: ClassifyInput): string {
  const obj = rec(input.raw);
  const nested = rec(obj?.error);
  const bits: string[] = [input.stderr ?? ""];

  if (obj) {
    bits.push(
      str(obj.subtype),
      str(obj.terminal_reason),
      str(obj.stop_reason),
      str(obj.api_error_message),
      str(obj.code),
      typeof obj.error === "string" ? obj.error : "",
      str(nested?.message),
      str(nested?.code),
      str(nested?.type),
    );
    // `result` holds the agent's own prose on success — only an error envelope's
    // result is diagnostic text.
    if (isErrorEnvelope(obj)) bits.push(str(obj.result), str(obj.message));
  }

  if (!hasStructuredEnvelope(input.raw)) {
    bits.push(input.stdout ?? "", str(obj?.stdout));
  }

  return bits.filter(Boolean).join("\n");
}

export function classify(input: ClassifyInput): Outcome {
  if (input.aborted) return "cancelled";

  // 1. Vendor-reported quota state, when the stream carried one.
  if (input.quotaStatus && !/^allow/i.test(input.quotaStatus)) {
    return "limit_exhausted";
  }

  // 2. Structured status codes — the most reliable signal, trusted either way.
  const status = statusOf(input.raw);
  if (status === 429 || status === 402) return "limit_exhausted";
  if (status !== undefined && status >= 500) return "transient";

  const failed = input.exitCode !== 0 || isErrorEnvelope(input.raw);

  // 3. A clean exit with a non-error envelope is a success, whatever the agent
  //    happened to write about rate limits.
  if (!failed) return "success";

  // 4. Only now, with a genuine failure in hand, read the error text.
  const text = errorText(input);
  if (LIMIT_PATTERNS.some((p) => p.test(text))) return "limit_exhausted";
  if (TRANSIENT_PATTERNS.some((p) => p.test(text))) return "transient";

  return "task_failure";
}
