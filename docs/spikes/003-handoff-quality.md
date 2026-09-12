# Spike 3 — Handoff quality: continue vs restart

**Question.** When a backend is interrupted mid-task, should Truss hand the partial work to
the next backend (*continue*), or roll back to the last clean state and start over
(*restart*)?

**Decision: continue, unconditionally.** No validity gate. Details below.

Run 2026-09-11. Claude Code 2.1.268 (sonnet) as the interrupted agent, `cursor-agent`
2026.09.10-fd3934a (auto model) as the successor.

## Method

A 60-test expression-language task, deliberately split across four modules that must be
built in dependency order: `lexer.js` → `parser.js` → `eval.js` → `index.js`. Spec and tests
were fixed up front; the agent could not modify them.

A control run built the whole thing from scratch in 48s. The repo was then reset and the run
repeated with a hard `kill -9` at 30s, producing a real interrupted state: lexer complete
(73 lines), the other three modules still stubs, **0/60 tests passing**.

Each arm then got the same successor backend, same autonomy, differing only in what it was
handed:

| Arm | Inherited | Prompt |
|---|---|---|
| A, A2 | the half-built tree | task + handoff brief (diffstat, "keep what's correct") |
| B | nothing (clean baseline) | task only |
| C2 | tree with `lexer.js` truncated mid-write | task + handoff brief |

Arm C2 simulates the nastier case: a limit that lands mid-file-write, leaving a file that
does not parse. The truncated lexer was the only version in history, so it could not be
recovered — it had to be repaired.

## Results

| Arm | Inherited | Outcome | Wall clock | Lines written | Inherited work |
|---|---|---|---|---|---|
| A | clean partial | 60/60 | 75s | 299 | lexer kept byte-identical |
| A2 | clean partial | 60/60 | 102s | 239 | lexer kept byte-identical |
| C2 | truncated file | 60/60 | 64s | 274 | repaired in place |
| B | nothing | 60/60 | 79s | 395 | n/a — rewrote everything |

**Every arm reached 60/60.** The arms separated on work done, not on success.

1. **Continue does not thrash.** This was the failure mode that would have killed the design
   — a successor that ignores the brief and rewrites everything anyway. It did not happen.
   In both clean-inheritance runs the successor verified the inherited lexer, left it
   byte-identical, and touched only the remaining stubs.
2. **Continue does 24–40% less writing** for an identical result (239–299 lines vs 395).
   Restart produced a completely different 138-line lexer, rediscovering solved work.
3. **Continue survives corruption without a gate.** Arm C2's successor detected the damage on
   its own — *"Lexer is mid-edit; parser/eval/index are stubs. I'll finish the lexer and
   implement the rest"* — repaired the file, and finished. It neither built on broken code
   nor started over. This is what removes the need for a parse-check before handoff.
4. **Wall clock is a wash.** 64–102s across all arms, overlapping ranges at n≤2. The saving
   is in tokens and quota, not latency. For Truss that is the right currency, but continue
   should not be described as faster.

## Incidental findings

**Test-based progress is useless as a checkpoint trigger.** The control run sat at 0/60 for
42 seconds and then jumped to 59/60. A half-built tree and an untouched tree score
identically, because nothing is testable until the final module wires it together. Anything
driving failover or progress display must read the backend's event stream, not the repo's
test suite. (The first interrupt attempt used "stop when ≥22 tests pass" and would never
have fired mid-task.)

**Checkpoint history is a recovery resource the successor will actively use.** Found by
accident: the first corruption arm was built by truncating a file in a tree that already had
a checkpoint commit containing the intact version. The successor located and restored it —
*"Checking checkpoint commits for a more complete lexer… Restoring the complete lexer from
the checkpoint."* That invalidated the arm, which was rebuilt as C2. But the behavior is
worth designing for: **checkpoint to a scratch ref per tool call, not once at failover.** It
costs almost nothing and gives the successor a ladder of known-good states to recover from.

## Limitations

Honest bounds on how far this generalizes:

- n=2 for clean inheritance, n=1 for corrupted. Enough to reject "continue thrashes", not
  enough to size the savings precisely.
- One task, one language, one direction (Claude → Cursor). The reverse direction is untested.
- The task fits comfortably in one context window. A task needing more would stress the
  handoff harder, since the successor would inherit work it cannot fully read.
- The interruption was `kill -9`, not a real 429. Mechanically equivalent for the handoff
  (uncommitted edits, no result text), but the graceful case — where the backend returns
  partial result text before stopping — should produce a *better* brief than what was tested
  here, not worse.

## Consequences for the design

- [ARCHITECTURE.md §3](../ARCHITECTURE.md#3-the-hard-part-failover-is-not-resumable-across-vendors)
  keeps checkpoint-and-brief; the open continue-vs-restart question is closed as *continue*.
- No parse/validity gate before handoff — finding 3 shows the successor handles corruption.
- Checkpoint per tool call rather than once at failover.
- Progress and failover signals come from the event stream, never from project tests.
