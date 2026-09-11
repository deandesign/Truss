# Truss — Roadmap

Milestones are ordered so each one is independently useful. Nothing here is built yet.

## M0 — Spikes (no product code)

Resolve the unknowns in [ARCHITECTURE.md §7](./ARCHITECTURE.md#7-spikes-to-run-before-implementation)
before committing to a router design.

- [x] Install `cursor-agent`; confirm auth (done 2026-09-11 — v2026.09.10-fd3934a, authed)
- [ ] Confirm a headless `cursor-agent -p --output-format json` round-trip
- [ ] Capture Claude's result envelope on a real usage limit
- [ ] Capture Cursor's result envelope on a real usage limit
- [ ] Run the handoff-quality experiment (Spike 3) — decide continue-vs-restart
- [ ] Record both `stream-json` event vocabularies
- [ ] Install Solo; verify it really lacks quota failover, cost tracking and worktrees
      ([ARCHITECTURE.md §9](./ARCHITECTURE.md#9-prior-art-solo-and-where-truss-differs))

**Exit criterion:** limit detection can be written against captured fixtures, not guesses.

## M1 — `truss run` (the failover router)

The smallest thing that solves the original problem.

- [ ] TS project scaffold: tsc, vitest, commander, `bin/truss`
- [ ] `Backend` interface + capability flags
- [ ] Claude adapter — argv, `stream-json` parsing, result normalization
- [ ] Cursor adapter — same
- [ ] Detector module + fixture corpus from M0
- [ ] Router: ordered chain, transient retry with backoff, limit → failover
- [ ] Checkpoint-and-brief handoff
- [ ] Run manifest + terminal report with per-backend attribution and labelled cost

**Exit criterion:** a task that exhausts Claude's quota finishes on Cursor, and the report
says honestly which backend did what.

## M2 — `truss split` (parallel fan-out)

- [ ] Worktree lifecycle: create, track, reap (`.truss/` + `refs/truss/`)
- [ ] Scheduler: concurrency cap, cancellation, failure isolation
- [ ] `tasks.yaml` lane definitions
- [ ] `truss lanes` / `diff` / `merge` / `reap`
- [ ] Live multi-lane progress view

**Exit criterion:** two backends work two lanes concurrently without touching each other's
files, and produce reviewable diffs.

## M3 — Ergonomics

- [ ] `truss.config.ts` with sane defaults
- [ ] `truss status` — availability, auth, last-known limit state
- [ ] Budget caps (native via `--max-budget-usd` where supported, wall-clock elsewhere)
- [ ] npm publish

## M4 — Speculative

Not commitments — ideas worth revisiting once M1–M3 are real.

- Third backend (Codex / Aider / Gemini) to prove the adapter boundary holds
- Quota forecasting: predict exhaustion from observed burn rate, route pre-emptively
- Consensus mode: same task to N backends, diff the answers, surface disagreement
- Shared context cache to cut the N-times context cost
- Expose Truss over MCP so a lead agent can open lanes itself
- Run cleanly as a supervised command inside Solo
