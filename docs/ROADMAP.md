# Truss — Roadmap

Milestones are ordered so each one is independently useful. The product is a
meta-harness that connects coding-agent CLIs; `truss run` is the inner loop
that talk and routines call.

## M0 — Spikes (no product code)

Resolve the unknowns in [ARCHITECTURE.md §8](./ARCHITECTURE.md#8-spikes) before
trusting the router with a second account's quota.

- [x] Install `cursor-agent`; confirm auth (done 2026-09-11 — v2026.09.10-fd3934a, authed)
- [x] Confirm a headless `cursor-agent -p --output-format json` round-trip
      ([report](./spikes/001-limit-envelopes.md) — `--trust` is required unattended)
- [x] Capture Claude's success envelope; limit envelope remains opportunistic
      ([report](./spikes/001-limit-envelopes.md))
- [x] Capture Cursor's documented success envelope; limit envelope remains opportunistic
      ([report](./spikes/001-limit-envelopes.md))
- [x] Run the handoff-quality experiment (Spike 3) — **decided: continue, no validity gate**
      ([report](./spikes/003-handoff-quality.md))
- [x] Record `stream-json` / JSONL event vocabularies
      ([report](./spikes/004-stream-json.md))
- [x] Re-check Solo — still no automatic quota failover; worktrees are a sharing
      layer, not isolation ([report](./spikes/005-solo.md))

- [x] Capture Claude's live quota telemetry (`rate_limit_event`)
      ([report](./spikes/006-quota-telemetry.md))

**Exit criterion:** limit detection can be written against captured fixtures, not
guesses. Real 429 payloads are still opportunistic; detectors prefer structured
fields and keep text matching quarantined **and scoped to error context**.

## M1 — Inner loop (`truss run`)

The failover router talk and routines sit on.

- [x] TS project scaffold: tsc, vitest, commander, `bin/truss`
- [x] `Backend` interface + capability flags
- [x] Claude adapter — argv, stream-json parsing, result normalization
- [x] Cursor adapter — same
- [x] Detector module + fixture corpus from M0
- [x] Router: ordered chain, transient retry with backoff, limit → failover
- [x] Checkpoint-and-brief handoff (per tool call — see Spike 3)
- [x] Run manifest + terminal report with per-backend attribution and labelled cost
- [x] Detection reads error context only, never the whole stream
      ([Spike 6](./spikes/006-quota-telemetry.md) — a task *about* rate limits
      was failing over on its own success text)
- [x] Transient retries fail over once exhausted, per ARCHITECTURE.md §5
- [x] Live quota telemetry from Claude's `rate_limit_event`, recorded per backend
- [x] `RouterEvent` lifecycle + live run view (`truss run`, `truss talk`),
      append-only off a terminal
- [x] Availability probes `--version`, not just `which`; a backend that cannot
      run is skipped rather than halting the chain
      ([Spike 7](./spikes/007-availability.md))
- [x] Tests and `fake.ts` are typechecked (`npm test` runs `tsconfig.check.json`)

**Exit criterion:** a task that exhausts Claude's quota finishes on Cursor, and
the report says honestly which backend did what.

**Still open:** a real 429 payload has never been captured, so the limit
fixtures remain synthetic. Quota telemetry makes this much less pressing for
Claude — `status` and `utilization` arrive on every run — but Cursor and Codex
still have to be classified from error text alone.

## M2 — Named agents (`truss talk`)

- [x] Bot identity (name, title, role) on disk under `~/.truss/bots/`
- [x] Durable per-bot memory (scratchpad)
- [x] Truss-owned transcript
- [x] `truss talk [bot]` — each turn becomes a routed run with role + memory + transcript

**Exit criterion:** you can message a named bot and the run uses the bot's role
and memory, not a vendor session.

## M3 — Skills

- [x] Shared markdown skill packs under `~/.truss/skills/`
- [x] Injected into the brief when named (`/review-pr`) or passed `--skill`

**Exit criterion:** the same skill text is what every backend sees.

## M4 — Local routines

- [x] Routine definitions on disk
- [x] `launchd` plists so a bot can run on a schedule
- [x] Honest about the Mac-awake limit

**Exit criterion:** `truss routines install <id>` loads a LaunchAgent that calls
`truss talk` while this Mac is awake.

## M5 — Codex adapter

- [x] Codex CLI (`codex exec --json`) as the OpenAI backend
- [x] One file in `backends/` + detector fixtures — nothing else

**Exit criterion:** adding Codex does not change the router.

## M6 — Fan-out (`truss split`) — later

- [ ] Worktree lifecycle: create, track, reap (`.truss/` + `refs/truss/`)
- [ ] Scheduler: concurrency cap, cancellation, failure isolation
- [ ] `tasks.yaml` lane definitions
- [ ] `truss lanes` / `diff` / `merge` / `reap`

**Exit criterion:** two backends work two lanes concurrently without touching
each other's files, and produce reviewable diffs.

## Speculative

Not commitments — ideas worth revisiting once M1–M5 are real.

- Thin chat UI as a skin on the same daemon
- Cloud computer so routines survive a closed laptop
- Quota forecasting: predict exhaustion from observed burn rate, route
  pre-emptively. No longer speculative for Claude — `rate_limit_event` already
  gives per-window utilization on every run
  ([Spike 6](./spikes/006-quota-telemetry.md)); what's missing is the policy,
  not the data. Cursor and Codex would stay blind.
- Cache an `unusable` verdict so a CLI installed without an account costs no
  spawn per run, with a re-probe once the user might have logged in
- Consensus mode: same task to N backends, diff the answers
- Expose Truss over MCP so a lead agent can open lanes itself
- Run cleanly as a supervised command inside Solo
