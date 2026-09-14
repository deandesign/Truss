# Truss — Architecture

> Status: **meta-harness, v1**. Truss connects your coding-agent CLIs. Named
> agents, memory, and skills live in Truss; the vendor CLIs do the coding.
> This document is the contract the code is written against.

## 1. The problem

Coding agents are sold as sessions, but they are consumed as *capacity*. You
already pay for Claude, Cursor, Codex. When one hits a usage limit, the work
stops, even though another account is sitting idle.

Neither CLI knows the others exist. None emit a "I am out of quota, take over"
signal. ChatGPT Plus and Claude.ai chat cannot drive a computer; only coding
CLIs can.

**Truss is a meta-harness: a thin framework above the agent CLIs that owns
identity, routing, isolation, and accounting, while the agents keep owning the
actual coding.**

```
You
  → message
Bot (role, memory, skills, conversation)
  → brief
Router (ordered chain of coding CLIs)
  → spawn
claude | cursor-agent | codex
  → this Mac (files, git, terminal)
```

Vendor sessions never cross. Truss owns the conversation and briefs the next
CLI with checkpoint + scratchpad.

Two capabilities, in dependency order:

1. **Failover** — run a task; if the primary backend is rate-limited, continue on the next one.
2. **Fan-out** — run N agents in parallel, each in an isolated git worktree, then collect diffs.

Fan-out is M6. v1 ships the connecting framework and the inner loop.

See [§10](#10-prior-art) for Solo and where Truss differs.

## 2. Why this is tractable: the envelopes already match

Verified against `claude` 2.1.270 and `cursor-agent` 2026.09.10-fd3934a on
2026-09-14 — not only the published docs:

| | Claude Code | cursor-agent | Codex CLI |
|---|---|---|---|
| Headless | `-p` / `--print` | `-p` / `--print` | `codex exec` |
| Machine output | `json`, `stream-json` (`--verbose` required) | `json`, `stream-json` | `--json` (JSONL) |
| Model select | `--model` | `--model` (`--list-models`) | `-c` / config |
| Resume | `-r, --resume <session-id>` | `--resume [chatId]`, `--continue` | `codex exec resume` |
| Autonomy | `--permission-mode` | `-f/--force`, `--auto-review`, `--trust` | `--sandbox`, `--ask-for-approval` |
| Plan mode | `--permission-mode plan` | `--mode plan` / `--plan` | `/plan` |
| Worktrees | `-w, --worktree [name]` | `-w, --worktree [name]` | (none native) |
| Auth | OAuth / `ANTHROPIC_API_KEY` | `--api-key` / `CURSOR_API_KEY` | ChatGPT / API |

Claude Code, observed 2026-09-14:

```json
{ "type": "result", "subtype": "success", "is_error": false,
  "result": "pong", "session_id": "9b79014e-…", "num_turns": 1,
  "duration_ms": 1512, "duration_api_ms": 2513,
  "total_cost_usd": 0.098593, "usage": { … }, "modelUsage": { … },
  "api_error_status": null, "terminal_reason": "completed", "stop_reason": "end_turn" }
```

cursor-agent, per docs (success shape; error shape still undocumented):

```json
{ "type": "result", "subtype": "success", "is_error": false,
  "result": "<text>", "session_id": "<uuid>",
  "duration_ms": 1234, "duration_api_ms": 1234, "request_id": "<optional>" }
```

Codex `exec --json` is a JSONL stream (`thread.started`, `turn.completed`,
`item.*`, `error`), not a Claude-shaped result object. The adapter normalizes
it. See [Spike 4](spikes/004-stream-json.md).

`type`, `subtype`, `is_error`, `result`, `session_id`, `duration_ms` are the
shared core for Claude and Cursor. Everything else is an optional capability.

### The asymmetries that shape the design

- **Cursor reports no cost or token usage.** Claude gives `total_cost_usd`.
  Codex reports token usage on `turn.completed`, not dollars. Totals are
  *known* vs *unknown*, never a silent sum that omits half the work.
- **Claude has `--max-budget-usd`; Cursor and Codex do not.** Caps that cannot
  be enforced natively fall back to wall-clock and turn count.
- **Vendor worktrees are private.** Truss owns the worktree lifecycle and
  invokes every backend with a plain `cwd`. Vendor `-w` flags go unused.
- **Autonomy is a three-tier map, and the middle tier is lossy.** Claude's
  middle is local rules (`acceptEdits`); Cursor's is a remote classifier
  (`--auto-review`); Codex's is `--ask-for-approval on-request`. Adapters
  translate; docs say the translation is lossy.
- **Headless Cursor requires `--trust`** (or `--yolo` / `-f`). Without it the
  process prints a workspace-trust prompt and exits 1. The Cursor adapter
  always passes `--trust` for unattended runs.
- **Claude `stream-json` requires `--verbose`.** The Claude adapter always
  passes both.
- **Do not use detached runs** (`claude --bg`, `cursor-agent persist`). A run
  Truss cannot see the exit of is a run it cannot fail over.
- **Claude `--fallback-model` is model failover inside one vendor.** It does
  nothing for account quota. Don't confuse the two.

## 3. Outer loop: named agents, memory, skills, routines

Identity lives on disk in Truss, not in a vendor chat.

```
~/.truss/
  config.json              backends, order, autonomy
  bots/<id>/identity.md    name, title, role
  bots/<id>/memory.md      durable scratchpad
  bots/<id>/conversations/ Truss-owned transcripts
  skills/                  shared markdown packs
  routines/                schedule + bot + prompt + skill
  state/limits.json        last-known quota per backend

.truss/                    repo-scoped: run manifests, checkpoints
```

`truss talk [bot]` loads identity + memory + recent transcript + optional
skill, then calls the router. Each turn is a fresh inner-loop invocation.
Vendor `--resume` is never used across backends.

Memory is the Solo scratchpad idea, per-bot and always on disk. A handoff
inherits reasoning the agent chose to externalise. If the agent neglects the
scratchpad, the handoff is no worse than checkpoint-and-brief.

Skills are markdown instruction packs. No screen-recording "teach a task" in
v1. The same skill text is what every backend sees.

Routines are `launchd` LaunchAgents that call `truss talk`. They only fire
while this Mac is awake. Work that should continue with the laptop closed waits
on a later cloud VM.

Autonomy defaults **low**. A framework that can spawn shell on your Mac is more
dangerous than a one-shot `truss run`. Truss never quietly upgrades permissions
to make a failover succeed.

## 4. The hard part: failover is not resumable across vendors

A rate limit rarely lands on turn one. It lands after the agent has read nine
files, written four, and run the tests twice. At that moment:

- The work-in-progress lives in **the filesystem**.
- The reasoning lives in **the backend's session store**, which is vendor-private.

`claude --resume` cannot resume a Cursor chat. **There is no conversation
handoff, and there never will be.**

### Mechanism: checkpoint-and-brief

1. **Checkpoint.** Commit the working tree to `refs/truss/<run-id>/<seq>` after
   each tool call, not only at failover.
2. **Harvest.** Partial `result` text plus `git diff --stat`.
3. **Brief.** Next backend gets the original task, the bot's memory, the
   transcript, any skill, and "continue; do not redo completed work."
4. **Record.** The run manifest shows which backend did which part.

**Resolved — continue, not restart.** [Spike 3](spikes/003-handoff-quality.md)
ran both against a 60-test multi-module task interrupted mid-flight. Both
reached 60/60. Continuing wrote 24–40% less code. No validity gate: a
successor handed a truncated file repaired it unprompted.

## 5. Rate-limit detection

| Outcome | Response |
|---|---|
| Success | done |
| Task failure (bad code, failing tests) | report; do **not** fail over |
| Quota / rate limit exhausted | **fail over** |
| Transient (5xx, network, overload) | retry same backend with backoff, then fail over |

Detection reads the backend's **event stream**, never the project's test suite.
[Spike 3](spikes/003-handoff-quality.md) found a task that sat at 0/60 for 42
seconds and then jumped to 59/60.

Layered, most reliable first:

1. **Structured fields.** Claude's `api_error_status` (`null` on success) is
   the most likely 429 carrier, alongside `is_error`, `subtype`, and
   `terminal_reason`. Codex `error` / `turn.failed` events.
2. **Process exit code.**
3. **Message-text matching** — last resort, quarantined in `detectors.ts` with
   a fixture corpus.

A real 429 still cannot be manufactured on demand. Success envelopes are
captured; limit fixtures are labelled synthetic until a real payload is
logged. See [Spike 1](spikes/001-limit-envelopes.md).

## 6. Component design

```
src/
  cli.ts                 commander entry
  backends/
    types.ts             Backend interface + normalized result
    spawn.ts             subprocess + stream parse
    claude.ts | cursor.ts | codex.ts
    registry.ts
    detectors.ts         limit/error classification + fixtures
  core/
    router.ts            failover chain, retry/backoff, checkpoint-and-brief
    checkpoint.ts        scratch-ref commits
    brief.ts             handoff + bot context assembly
    manifest.ts          who did what, when, at what cost
    report.ts            labelled totals
    config.ts
    paths.ts
  ui/
    live.ts              live run view; append-only fallback off a terminal
    ansi.ts              colour + width helpers
  bots/                  identity, memory, transcript, talk
  skills/                markdown packs
  routines/              launchd install/uninstall
```

### The interface

`route()` emits a `RouterEvent` lifecycle — run start, per-backend attempt
start and end, normalized agent events, checkpoints, retries, handoffs, run end
— and `ui/live.ts` is one consumer of it. Nothing in the router depends on a
view existing.

On a terminal that renders as a repainting frame: the backend chain with
per-backend state, the active backend's tool calls as they land, quota headroom
per window, labelled cost, and the checkpoint count. Off a terminal — piping,
CI, `launchd` routines — the same events print append-only with no escape
sequences, because a repainting frame in a log file is unreadable. `--plain`
forces that path.

This does not contradict §10's "stay a CLI, don't grow a GUI". The live view is
terminal output from a headless run, not a workspace: no window, no daemon, no
state of its own, and every byte of it derives from events the router already
emits for the manifest.

### The Backend interface

A backend is a **launch preset** `(binary, defaultArgs)`, not a vendor. The
same CLI can appear twice (Opus then Sonnet) before crossing vendors.

```ts
interface Backend {
  readonly id: string;
  readonly binary: string;
  readonly defaultArgs: string[];
  available(): Promise<Availability>;
  capabilities: Capabilities;
  run(task: Task, opts: RunOpts): AgentRun;
}
```

Adding a third backend means one file in `backends/` and detector fixtures —
nothing else. Codex is that third backend.

### Command surface

```
truss init                      create ~/.truss, default bot, example skills
truss talk [bot] [message]      outer loop
truss run "<task>"              inner loop
truss status                    backends, auth, last-known limits
truss bots list|create|show
truss skills list|show
truss routines list|install|uninstall|run
```

`run` is the primitive. `talk` and routines call it.

## 7. Concurrency and safety

- **One worktree per lane, always** (M6). Refuse parallel lanes without isolation.
- **Never auto-merge.**
- **Everything is reapable** under `.truss/` and `refs/truss/`.
- **Autonomy is explicit and defaults low.**

## 8. Spikes

1. Limit envelopes — [001](spikes/001-limit-envelopes.md). Success captured;
   429 still opportunistic.
2. Cursor headless round-trip — same report. `--trust` is required.
3. Handoff quality — [003](spikes/003-handoff-quality.md). Continue, no gate.
4. Event vocabularies — [004](spikes/004-stream-json.md).
5. Solo gap check — [005](spikes/005-solo.md). Still no automatic quota failover.

## 9. Known limitations

- **No shared vendor context.** Each backend re-reads the repo.
- **Partial cost visibility.**
- **Handoff is lossy.** Filesystem plus summary, never vendor reasoning.
- **Local-first.** Routines do not run with the laptop closed.
- **Coding CLIs only.** Chat subscriptions cannot drive a computer.
- **Interactive vendor sessions cannot fail over.** Truss operates on headless
  invocations it spawned.

## 10. Prior art

### Hosted agent products

Some hosted coding-agent products give you a named agent, memory, skills, and a
cloud computer — and fail over inside **their** model pool. Truss is the other
shape: a local framework that connects **your** CLIs. The computer is this Mac,
not a vendor VM.

### Solo

[Solo](https://soloterm.com/) is a GUI workspace that launches the real
binaries you already have. Overlap worth keeping: launch the real binaries,
reusable presets, scratchpads. Solo now documents git worktrees as a way to
*share* todos across checkouts, and documents **manual** handoff when quota
ends (write the scratchpad, launch a different tool). It does not
automatically detect a 429 and continue the same task on the next vendor.
That remains Truss's wedge. See [Spike 5](spikes/005-solo.md).

Positioning: Solo is a visible workspace; Truss is a meta-harness that makes
capacity across CLIs fungible. Complementary. Talk stays CLI-first rather than
growing a UI of its own.
