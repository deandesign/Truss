# Spike 1/2 — Limit envelopes and Cursor headless round-trip

Run 2026-09-14 against `claude` 2.1.270 and `cursor-agent` 2026.09.10-fd3934a.

## Claude success envelope (captured)

`claude -p --output-format json --permission-mode plan "Reply with exactly: pong."` exited 0:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "pong",
  "session_id": "9b79014e-f1d4-469d-ac5c-50b6432c31d7",
  "num_turns": 1,
  "duration_ms": 1512,
  "duration_api_ms": 2513,
  "total_cost_usd": 0.098593,
  "api_error_status": null,
  "terminal_reason": "completed",
  "stop_reason": "end_turn"
}
```

`api_error_status: null` on success is the structured field to key 429 detection off.
`stream-json` additionally requires `--verbose`; without it Claude exits 1 with
`Error: When using --print, --output-format=stream-json requires --verbose`.

## Cursor headless round-trip

`cursor-agent -p --output-format json --mode ask` without `--trust` prints:

```
⚠ Workspace Trust Required
  To proceed, you can either:
    • Run 'agent' interactively to decide
    • Pass --trust, --yolo, or -f if you trust this directory
```

and exits 1. Unattended Truss runs **must** pass `--trust`.

Success envelope (docs; error shape still unpublished):

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "<text>",
  "session_id": "<uuid>",
  "duration_ms": 1234,
  "duration_api_ms": 1234
}
```

## Limit envelopes

A 429 still cannot be manufactured on demand. Detector policy:

1. Structured: `api_error_status` 429/402, `subtype`/`terminal_reason` containing
   `rate_limit` / `usage_limit`, Codex `error` events with those codes.
2. Exit code (non-zero is not enough — classify further).
3. Text matching, quarantined, fixture-tested: `usage limit`, `rate limit`,
   `too many requests`, `out of extra usage`.

Synthetic limit fixtures in `src/backends/fixtures/` are labelled as such.
Replace them with captured payloads when a real limit lands.

## Consequences

- Claude adapter: `-p --output-format stream-json --verbose`.
- Cursor adapter: `-p --output-format stream-json --trust`.
- Detectors prefer `api_error_status` over string matching.
