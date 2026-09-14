import type {
  AgentEvent,
  Cost,
  Dialect,
  QuotaSnapshot,
  QuotaWindow,
} from "./types.js";

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const rec = block as Record<string, unknown>;
      if (typeof rec.text === "string") return rec.text;
      return "";
    })
    .filter(Boolean)
    .join("");
}

/** A short, human-readable hint about what a tool call is acting on. */
function toolDetail(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  for (const key of [
    "file_path",
    "path",
    "pattern",
    "command",
    "url",
    "query",
  ]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().split("\n")[0];
    }
  }
  return undefined;
}

function toolUses(content: unknown): AgentEvent[] {
  if (!Array.isArray(content)) return [];
  const events: AgentEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as Record<string, unknown>;
    if (rec.type !== "tool_use") continue;
    events.push({
      kind: "tool",
      name: String(rec.name ?? "tool"),
      status: "started",
      id: typeof rec.id === "string" ? rec.id : undefined,
      detail: toolDetail(rec.input),
    });
  }
  return events;
}

/**
 * Claude Code emits a `rate_limit_event` on every run carrying current
 * utilization per rolling window, so headroom is observable without waiting for
 * a 429 — see ARCHITECTURE.md §4.
 */
export function quotaFromEvent(
  obj: Record<string, unknown>,
): QuotaSnapshot | null {
  const info = obj.rate_limit_info as Record<string, unknown> | undefined;
  if (!info) return null;
  const windows: QuotaWindow[] = [];
  const unified = info.unifiedWindows as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(unified ?? {})) {
    if (!value || typeof value !== "object") continue;
    const w = value as Record<string, unknown>;
    if (typeof w.utilization !== "number") continue;
    windows.push({
      key,
      utilization: w.utilization,
      resetsAt: typeof w.resetsAt === "number" ? w.resetsAt : undefined,
    });
  }
  return {
    status: typeof info.status === "string" ? info.status : undefined,
    limitType:
      typeof info.rateLimitType === "string" ? info.rateLimitType : undefined,
    usingOverage:
      typeof info.isUsingOverage === "boolean"
        ? info.isUsingOverage
        : undefined,
    windows,
    at: new Date().toISOString(),
  };
}

function ingestClaudeCursor(obj: Record<string, unknown>): AgentEvent[] {
  const type = String(obj.type ?? "");

  if (type === "result") return [{ kind: "result", raw: obj }];

  if (type === "rate_limit_event") {
    const snapshot = quotaFromEvent(obj);
    return snapshot ? [{ kind: "quota", snapshot }] : [];
  }

  if (type === "error") {
    return [
      {
        kind: "error",
        text: String(obj.error ?? obj.result ?? obj.message ?? "error"),
      },
    ];
  }

  if (type === "assistant") {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content ?? obj.content;
    const events: AgentEvent[] = [];
    const text =
      textFromContent(content) ||
      (typeof obj.result === "string" ? obj.result : "");
    if (text) events.push({ kind: "assistant", text });
    // A tool call shares its assistant message with any prose, so both have to
    // come out. Returning only the text hid every tool name from callers.
    events.push(...toolUses(content));
    return events;
  }

  if (type === "user") {
    const message = obj.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) return [];
    const events: AgentEvent[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const rec = block as Record<string, unknown>;
      if (rec.type !== "tool_result") continue;
      events.push({
        kind: "tool",
        name: String(rec.name ?? "tool"),
        status: "completed",
        id: typeof rec.tool_use_id === "string" ? rec.tool_use_id : undefined,
      });
    }
    return events;
  }

  if (type === "tool_use" || (!type && obj.name)) {
    return [
      {
        kind: "tool",
        name: String(obj.name ?? obj.tool ?? "tool"),
        status: "started",
        id: typeof obj.id === "string" ? obj.id : undefined,
        detail: toolDetail(obj.input),
      },
    ];
  }

  return [];
}

function ingestCodex(obj: Record<string, unknown>): AgentEvent[] {
  const type = String(obj.type ?? "");

  if (type === "error" || type === "turn.failed") {
    const error = obj.error as Record<string, unknown> | undefined;
    return [
      {
        kind: "error",
        text: String(error?.message ?? obj.message ?? JSON.stringify(obj)),
      },
    ];
  }

  const item = obj.item as Record<string, unknown> | undefined;
  const isToolItem =
    item?.type === "command_execution" || item?.type === "file_change";

  if (type === "item.started" && isToolItem) {
    return [
      {
        kind: "tool",
        name: String(item?.type === "file_change" ? "file_change" : "Bash"),
        status: "started",
        id: typeof item?.id === "string" ? item.id : undefined,
        detail:
          typeof item?.command === "string" ? item.command.split("\n")[0] : undefined,
      },
    ];
  }

  if (type === "item.completed") {
    if (item?.type === "agent_message" && typeof item.text === "string") {
      return [{ kind: "assistant", text: item.text }];
    }
    if (isToolItem) {
      return [
        {
          kind: "tool",
          name: String(item?.type === "file_change" ? "file_change" : "Bash"),
          status: "completed",
          id: typeof item?.id === "string" ? item.id : undefined,
          detail:
            typeof item?.command === "string"
              ? item.command.split("\n")[0]
              : undefined,
        },
      ];
    }
  }

  if (type === "turn.completed" || type === "thread.started") {
    return [{ kind: "result", raw: obj }];
  }

  return [];
}

export function ingestLine(line: string, dialect: Dialect): AgentEvent[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return [];
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (dialect === "codex") return ingestCodex(obj);
    return ingestClaudeCursor(obj);
  } catch {
    return [];
  }
}

export function ingestBuffer(buffer: string, dialect: Dialect): AgentEvent[] {
  const events: AgentEvent[] = [];
  const lines = buffer.split(/\r?\n/);
  const leftover: string[] = [];
  for (const line of lines) {
    const parsed = ingestLine(line, dialect);
    if (parsed.length) events.push(...parsed);
    else leftover.push(line);
  }
  if (events.length === 0) {
    const joined = leftover.join("\n").trim();
    if (joined.startsWith("{")) events.push(...ingestLine(joined, dialect));
  }
  return events;
}

export function costFromRaw(raw: unknown): Cost | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  const usd =
    typeof rec.total_cost_usd === "number" ? rec.total_cost_usd : undefined;
  const usage = rec.usage as Record<string, unknown> | undefined;
  const tokens = usage
    ? {
        input:
          num(usage.input_tokens) ??
          num(usage.inputTokens) ??
          num(usage.input),
        output:
          num(usage.output_tokens) ??
          num(usage.outputTokens) ??
          num(usage.output),
        cacheRead:
          num(usage.cache_read_input_tokens) ?? num(usage.cached_input_tokens),
        cacheCreation: num(usage.cache_creation_input_tokens),
      }
    : undefined;
  if (usd === undefined && !tokens) return undefined;
  return { usd, tokens };
}

function num(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

export function textFromRaw(raw: unknown, fallback = ""): string {
  if (!raw || typeof raw !== "object") return fallback;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.result === "string") return rec.result;
  if (typeof rec.text === "string") return rec.text;
  return fallback;
}

export function sessionFromRaw(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.session_id === "string") return rec.session_id;
  if (typeof rec.thread_id === "string") return rec.thread_id;
  return undefined;
}
