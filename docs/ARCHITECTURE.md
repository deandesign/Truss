# Truss — Architecture

> Status: **design draft**. Nothing here is implemented yet. This document exists to be
> argued with before any code is written.

## 1. The problem

Coding agents are sold as sessions, but they are consumed as *capacity*. You have a Claude
subscription and a Cursor subscription. When one hits a usage limit, the work stops — even
though the other account is sitting idle with quota to burn. And when a task is obviously
parallel, there is no way to put two vendors' agents on it at once without them overwriting
each other's files.

Neither tool knows the other exists. Neither emits a "I am out of quota, take over" signal.

**Truss is a meta-harness: a thin layer above the agent CLIs that owns routing, isolation,
and accounting, while the agents keep owning the actual coding.**

Two capabilities, in dependency order:

1. **Failover** — run a task; if the primary backend is rate-limited, continue on the next one.
2. **Fan-out** — run N agents in parallel, each in an isolated git worktree, then collect diffs.

Both need the same foundation: a uniform way to invoke a backend, read its result, and know
whether it succeeded, failed, or ran out of road.

## 2. Why this is tractable: the envelopes already match

The core bet of this design is that both backends are already close enough to normalize
cheaply. Verified against the `claude` 2.1.268 and `cursor-agent` 2026.09.10-fd3934a
binaries on 2026-09-11 — not the published docs, which understate Cursor's surface:

| | Claude Code | cursor-agent |
|---|---|---|
| Headless flag | `-p` / `--print` | `-p` / `--print` |
| Output formats | `text`, `json`, `stream-json` | `text`, `json`, `stream-json` |
| Model select | `--model` | `--model` (`--list-models`) |
| Resume | `-r, --resume <session-id>`, `--session-id <uuid>` | `--resume [chatId]`, `--continue` |
| Autonomy | `--permission-mode`, `--allowedTools`, `--disallowed-tools` | `-f/--force`, `--auto-review`, `--sandbox`, `--approve-mcps`, `--trust` |
| Plan mode | `--permission-mode plan` | `--mode plan` / `--plan` |
| Worktrees | `-w, --worktree [name]` | `-w, --worktree [name]`, `--worktree-base <ref>` |
| Detached runs | `--bg`, `agents`, `attach`, `logs`, `stop` | `persist` |
| Extra roots | `--add-dir` | `--add-dir`, `--workspace` |
| Auth | OAuth / `ANTHROPIC_API_KEY` | `--api-key` / `CURSOR_API_KEY` |

And the terminal result object is nearly the same shape. Claude Code, observed:

```json
{ "type": "result", "subtype": "success", "is_error": false,
  "result": "ok", "session_id": "0a064228-…", "num_turns": 1,
  "duration_ms": 1779, "duration_api_ms": 2993,
  "total_cost_usd": 0.0439842, "usage": { … }, "modelUsage": { … },
  "api_error_status": null, "terminal_reason": "completed", "stop_reason": "end_turn" }
```

cursor-agent, per docs:

```json
{ "type": "result", "subtype": "success", "is_error": false,
  "result": "<text>", "session_id": "<uuid>",
  "duration_ms": 1234, "duration_api_ms": 1234, "request_id": "<optional>" }
```

`type`, `subtype`, `is_error`, `result`, `session_id`, `duration_ms`, `duration_api_ms` are
common to both. That shared core *is* the normalized result type. Everything else is an
optional capability.

### The asymmetries that shape the design

These are not incidental — each one forces a decision:

- **Cursor reports no cost or token usage.** Claude gives `total_cost_usd`, `usage`, and
  per-model breakdown. So budget accounting is necessarily partial. Truss must present
  spend as *known* vs *unknown*, never silently report a total that omits half the work.
- **Claude has `--max-budget-usd`; Cursor has no equivalent.** Per-backend budget caps
  can't be enforced uniformly. Truss enforces what it can natively and otherwise caps by
  wall-clock and turn count.
- **Both have worktrees, in vendor-private locations.** Claude and Cursor each take
  `-w/--worktree`, but Cursor materializes lanes under `~/.cursor/worktrees/<repo>/<name>`
  and Claude uses its own convention, each with its own naming and cleanup. Delegating
  isolation would scatter a single run's lanes across two vendor directories under two
  naming schemes — making `truss lanes`, `diff`, `merge` and `reap` unable to present one
  coherent model. So **Truss owns the worktree lifecycle itself** and invokes every backend
  with a plain `cwd` in a lane it created. Both `-w` flags go unused on purpose.
- **Autonomy is a three-tier map, not a binary one.** Claude has graduated permission modes
  plus tool-level allow/deny; Cursor has prompt-by-default, `--auto-review` (a server-side
  classifier that auto-runs safe calls), and `--force`. Those line up well enough for a
  three-level Truss `autonomy` setting, but the middle tier is not equivalent on both sides
  — Claude's is a local rules decision, Cursor's is a remote classifier. The adapters
  translate and the docs say the translation is lossy rather than pretending it isn't.
- **Both can run detached**, via Claude's background sessions and Cursor's `persist`. Truss
  should not use either: a run it cannot see the exit of is a run it cannot fail over.
- **Claude already has `--fallback-model`** for when a model is overloaded. That solves
  *model* failover inside one vendor. It does nothing for *account quota* exhaustion, which
  is the case Truss exists for. Don't confuse the two.

## 3. The hard part: failover is not resumable across vendors

This is the central design problem and everything else is easy by comparison.

A rate limit rarely lands on turn one. It lands after the agent has read nine files, written
four, and run the tests twice. At that moment:

- The work-in-progress lives in **the filesystem**, as uncommitted edits.
- The reasoning lives in **the backend's session store**, which is vendor-private.

`claude --resume <id>` cannot resume a Cursor chat. `cursor-agent --resume` cannot resume a
Claude session. **There is no conversation handoff, and there never will be.** Any design
that assumes one is fiction.

So a handoff has to be reconstructed from the only two things that cross the boundary: the
git working tree, and a text summary.

### Proposed mechanism: checkpoint-and-brief

When the router decides to fail over:

1. **Checkpoint.** Commit the working tree to a scratch ref (`refs/truss/<run-id>/<seq>`).
   Nothing is lost and nothing pollutes the user's branches.
2. **Harvest.** Take the partial `result` text plus a `git diff --stat` of the checkpoint.
3. **Brief.** Invoke the next backend with the original task *plus* a preamble: here is the
   task, here is what a previous agent already changed, here is where it stopped. Continue;
   do not redo completed work.
4. **Record.** Log the handoff in the run manifest so the final report shows which backend
   did which part.

This is imperfect. The second agent loses the first one's reasoning and may re-tread ground.
It is, however, the only honest option, and it degrades gracefully: worst case the second
agent re-derives context it could have inherited.

**Open question for review:** should a failover mid-task instead *abort and roll back* to the
last clean state, then restart from scratch on the new backend? Cheaper to reason about,
safer for non-idempotent work, wasteful of everything already done. This is a real fork and I
would rather you picked it than have me assume. See Spike 3.

## 4. Rate-limit detection

The trigger for everything above. Truss must distinguish four outcomes — and only the third
should cause a failover:

| Outcome | Response |
|---|---|
| Success | done |
| Task failure (bad code, failing tests) | report; do **not** fail over — the next backend will fail too |
| Quota / rate limit exhausted | **fail over** |
| Transient (5xx, network, overload) | retry same backend with backoff, then fail over |

Conflating the second and third is the main way a tool like this wastes a second account's
quota on a task that was never going to succeed.

Detection is layered, most reliable first:

1. **Structured fields.** Claude's `api_error_status` (`null` on success) is the most likely
   carrier of an HTTP 429, alongside `is_error`, `subtype`, and `terminal_reason`.
2. **Process exit code.**
3. **Message-text matching** — last resort, quarantined in a single `detectors/` module with
   a fixture corpus, because these strings change without notice and must never be scattered
   through the codebase.

**This is the largest unknown in the plan.** A 429 cannot be manufactured on demand, so the
exact error envelope for either backend is unverified. See Spikes 1 and 2 — these should be
resolved before the router is built, not after.

## 5. Component design

```
truss.config.ts          user config: backends, order, autonomy, budgets
src/
  cli/                   commander entry; one file per command
  backends/
    types.ts             Backend interface + normalized result types
    claude.ts            adapter: argv construction, stream-json parsing
    cursor.ts            adapter
    detectors/           limit/error classification + fixture corpus
  core/
    router.ts            failover chain, retry/backoff, checkpoint-and-brief
    scheduler.ts         parallel fan-out, concurrency cap, cancellation
    checkpoint.ts        scratch-ref commits, handoff briefs
    manifest.ts          run record: who did what, when, at what cost
  git/
    worktree.ts          create / list / reap lanes
  report/                diff summaries, cost rollup, terminal output
```

### The Backend interface

Every backend is a subprocess that takes a prompt and a cwd, streams events, and terminates
with a result. Sketch:

```ts
interface Backend {
  readonly id: string;                  // "claude" | "cursor"
  available(): Promise<Availability>;   // installed? authed? quota known?
  capabilities: Capabilities;           // reportsCost, supportsBudgetCap, supportsResume…
  run(task: Task, opts: RunOpts): AgentRun;   // spawn; returns handle
}

interface AgentRun {
  events: AsyncIterable<AgentEvent>;    // normalized from stream-json
  result: Promise<NormalizedResult>;
  cancel(): Promise<void>;
}

interface NormalizedResult {
  ok: boolean;
  outcome: "success" | "task_failure" | "limit_exhausted" | "transient" | "cancelled";
  text: string;
  sessionId?: string;
  durationMs: number;
  cost?: { usd: number; tokens: TokenUsage };   // absent for Cursor — by design
  raw: unknown;                                  // never lose the original envelope
}
```

`capabilities` is what keeps the asymmetries honest: the reporter asks
`backend.capabilities.reportsCost` rather than assuming a number exists.

Adding a third backend (Codex, Aider, Gemini) should mean one file in `backends/` and one
detector fixture — nothing else.

### Command surface

```
truss run "<task>"              single task, failover chain
truss split "<task>"            decompose + fan out across worktrees
truss split -f tasks.yaml       explicit lane definitions
truss status                    backend availability, auth, last-known limits
truss lanes                     list active worktrees
truss diff <lane>               review one lane's changes
truss merge <lane>              merge a lane back
truss reap                      delete finished worktrees and scratch refs
```

`run` is milestone 1. Everything else builds on the same adapter + manifest.

## 6. Concurrency and safety

- **One worktree per lane, always.** Two agents in one tree will clobber each other. Truss
  should refuse to run parallel lanes without isolation rather than offer it as a flag.
- **Never auto-merge.** Lanes produce diffs for human review. Automatic merging of two
  agents' interpretations of the same task is how you get plausible nonsense on `main`.
- **Concurrency cap**, default 2–3. Ten parallel agents on one repo is disk and API thrash.
- **Everything is reapable.** Any worktree or scratch ref Truss creates is namespaced under
  `.truss/` and `refs/truss/` so `truss reap` is unambiguous and safe.
- **Autonomy is explicit and defaults low.** Both backends can run shell commands. Truss
  should never quietly upgrade autonomy to make a failover succeed.

## 7. Spikes to run before implementation

Ordered by how much they'd cost to get wrong:

1. **Claude limit envelope.** Capture the exact `--output-format json` payload, stderr, and
   exit code when a usage limit is hit. Requires catching a real limit — worth logging
   opportunistically rather than waiting for.
2. **Cursor limit envelope.** Same. Cursor's docs only document the success shape; the error
   shape is entirely undocumented. Requires installing `cursor-agent` first.
3. **Handoff quality.** Take a real mid-sized task, interrupt it halfway, and hand the
   checkpoint-and-brief to the other backend. Does it usefully continue, or does it thrash?
   This validates or kills §3 and should be run *before* the router is built.
4. **Event normalization.** Diff the two `stream-json` event streams to find the common
   subset worth surfacing in a live view.

## 8. Known limitations

To be stated in the README rather than discovered by users:

- **No shared context.** Each backend re-reads the repo from scratch. Parallel lanes pay
  context cost N times and can reach contradictory conclusions.
- **Partial cost visibility.** Cursor reports no spend. Totals will always be labelled.
- **Interactive sessions can't fail over.** Truss operates on headless invocations. A live
  interactive session that hits a limit is outside its reach; nothing hooks that moment.
- **Handoff is lossy.** Per §3 — filesystem plus summary, never reasoning.
