# Spike 6 — Live quota telemetry, and what detection must not read

Run 2026-09-14 against `claude` 2.1.270, `cursor-agent` 2026.09.10-fd3934a, and
`codex`. Unlike Spikes 1–5 this one started as a review of the M1 router and
became two findings, one of which invalidated the shipped detector.

## Finding 1 — Claude reports quota utilization on every run

[Spike 1](001-limit-envelopes.md) closed on "a real 429 still cannot be
manufactured on demand", and treated limit detection as something that can only
be observed at the moment of failure. That premise was wrong.

`claude -p --output-format stream-json --verbose` emits a `rate_limit_event`
mid-stream on every run, captured verbatim:

```json
{
  "type": "rate_limit_event",
  "rate_limit_info": {
    "status": "allowed",
    "resetsAt": 1789398600,
    "rateLimitType": "five_hour",
    "overageStatus": "allowed",
    "overageResetsAt": 1790812800,
    "isUsingOverage": false,
    "unifiedWindows": {
      "five_hour": { "utilization": 0.03, "resetsAt": 1789398600 },
      "seven_day": { "utilization": 0.35, "resetsAt": 1789603200 }
    }
  }
}
```

Consequences:

- **`status` is the authoritative limit signal**, ahead of `api_error_status`.
  Anything other than `allowed` means the account is out of road, and it arrives
  without having to parse error prose.
- **Headroom is observable before exhaustion.** `utilization` per rolling window
  makes "predict exhaustion from observed burn rate and route pre-emptively" —
  filed under M5 as speculative — available now, from data already on the wire.
- Truss records the last snapshot per backend, so `truss status` can report
  remaining headroom rather than only whether a limit has already been hit.
- Emitted more than once per run (observed 4× in a 5-tool run), so the *last*
  snapshot wins.

Cursor and Codex emit no equivalent. Headroom joins cost on the list of things
known for one vendor and not the others, and must be labelled the same way.

## Finding 2 — The detector was reading limits out of ordinary output

The shipped `classify()` pattern-matched its whole stdout/stderr/raw blob for
`/rate limit/i`, `/quota/i`, `/\b429\b/` and `/\b5\d\d\b`. Because `stream-json`
stdout carries the repo path, the prompt, and every word the agent says, this
misfired constantly. Reproduced live, not hypothesised:

| Input | Classified | Actual |
|---|---|---|
| `"Reply with the word pong"`, run under `/private/tmp/claude-501/…` | `transient` ×3 | success |
| `"…I added retry handling for rate limit errors."` | `limit_exhausted` | success |
| Task failure whose test output says `expected quota to be tracked` | `limit_exhausted` | task failure |
| Success with `usage.input_tokens: 512` | `transient` | success |

The first cost three runs of a one-word task — $0.28 instead of $0.10 — because
`501` is the macOS UID and the `system.init` event echoes `cwd`. The second is
worse: a task that *succeeded* on Claude was declared out of quota, handed to
Cursor (21s, 15k tokens) and then Codex, and finally reported `task_failure`. It
also wrote a false limit mark for two healthy accounts into `state/limits.json`,
so `truss status` then under-reported available capacity.

This is exactly the conflation §5 names as the main way a tool like this wastes
a second account's quota, and the repo Truss is built in is full of the words
that trigger it.

**Rule adopted: limit and transient signals are only ever read out of error
context.** Concretely:

- A clean exit with a non-error envelope is a success, whatever the agent wrote.
- Text matching sees stderr and the error-bearing fields of the envelope
  (`subtype`, `terminal_reason`, `error.message`, `code`, and `result` *only*
  when `is_error`), never the full stdout stream.
- Full stdout is read only when the process produced no parseable envelope at
  all, since then there is nothing else to go on.
- `\b5\d\d\b` narrowed to `\b50[0-4]\b`; bare `/quota/i` now requires
  `exceeded|exhausted|reached`.

The four rows above are regression tests, and the captured success stream is
checked in as `fixtures/claude-success-stream.jsonl` with its `claude-501` path
intact — that path *is* the fixture.

## Finding 3 — Tool calls were never surfaced

[Spike 4](004-stream-json.md) recorded that "tool calls arrive as assistant
content blocks with `name` / `input`", but the parser returned one event per
line and handled `type: "assistant"` by returning its text, so every `tool_use`
block was dropped. Tool activity was only visible as the `tool_result` echo in
the following `user` event, which carries a `tool_use_id` and no name — so every
tool showed up as the literal string `tool`.

`ingestLine` now returns `AgentEvent[]`, prose and tool calls both come out of
one assistant message, and names are remembered by id so a completion can be
matched back to its call. This is what makes a live view worth having.

## Consequences for the code

- `classify()` takes `quotaStatus`; a non-`allowed` status short-circuits to
  `limit_exhausted`.
- `AgentEvent` gains `{ kind: "quota"; snapshot: QuotaSnapshot }`.
- `NormalizedResult` gains `quota`; the router records it per backend.
- Transient retries now fail over once exhausted, per §5's table, which the
  router did not previously do.
- An empty or entirely uninstalled chain reports `no_backend`, not
  `task_failure`.
