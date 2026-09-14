# Spike 4 — stream-json / JSONL vocabularies

Run 2026-09-14. Goal: the common subset worth normalizing into `AgentEvent`.

## Claude (`--output-format stream-json --verbose`)

Documented event types (SDK / `--print` stream):

| `type` | Notes |
|---|---|
| `system` | init: session_id, tools, model |
| `assistant` | message payload |
| `user` | tool results echoed back |
| `result` | terminal envelope (same shape as `--output-format json`) |
| `stream_event` | optional token deltas |

Tool calls arrive as assistant content blocks with `name` / `input`. Checkpoint
per tool call hooks the tool-result `user` event, not the project test suite.

## Cursor (`--output-format stream-json`)

Same three terminal formats as Claude: `text`, `json`, `stream-json`.
`--stream-partial-output` adds text deltas. Event types overlap on
`assistant` / `result`; tool events are not fully documented. Parser is
tolerant: unknown `type` values are ignored, `result` is required to finish.

## Codex (`codex exec --json`)

JSONL, not a Claude-shaped result object:

| `type` | Notes |
|---|---|
| `thread.started` | `thread_id` |
| `turn.started` | |
| `item.started` / `item.completed` | command_execution, agent_message, file_change, … |
| `turn.completed` | `usage` tokens |
| `turn.failed` / `error` | classify via detectors |

The Codex adapter folds `item.completed` agent_message text into `result.text`
and `turn.completed.usage` into `NormalizedResult.cost.tokens` when present.
No `total_cost_usd`.

## Normalized `AgentEvent`

```ts
type AgentEvent =
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; status: "started" | "completed" }
  | { kind: "result"; raw: unknown }
  | { kind: "error"; text: string };
```

Unknown vendor events are dropped, never fatal.
