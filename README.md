# Truss

A meta-harness that connects the coding agents you already pay for.

> Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Plan:
> [`docs/ROADMAP.md`](docs/ROADMAP.md).

Truss sits above Claude Code, Cursor Agent, and Codex. You talk to one named
agent; Truss routes the work onto whichever CLI still has quota. When one
account hits a limit, the run continues on the next. Vendor sessions never
cross; Truss owns the conversation, the memory, and the handoff.

```
truss setup                                   # first run: pick backends, order, autonomy
truss login                                   # sign in to any backend that needs it
truss status                                  # health, account, quota headroom
truss run "add tests for the parser"          # inner loop, no bot wrapper
truss talk builder "add tests for the parser" # bot: role, memory, skills, transcript
```

```
$ truss status

  ● claude  ready    logged in as you@example.com (team)
                     5h ███████░░░ 68%   7d ████░░░░░░ 43%
  ● cursor  ready    logged in as you@example.com
  ○ codex   broken   will not run
                     spawn …/codex-darwin-arm64/vendor/…/codex ENOENT
                     skipped by the router
```

On a terminal, a run renders live — the backend chain, the tool calls as they
land, quota headroom per window, and cost labelled by what's actually known:

```
  truss  mu13iddc-q9h3gz
  add tests for the parser

  ⚡ claude  →  ● cursor  →  · codex

  ⠹ cursor       18.2s
      ✓ Read     src/parser.ts
      ✓ Edit     src/parser.test.ts
      ▸ Bash     npm test

  ⚡ claude → cursor (limit exhausted)

  claude   5h █████████░ 94%   7d ████░░░░░░ 37%

  $0.4182 known  + cursor unreported · 6 checkpoints
```

Piped, or run from a `launchd` routine, the same events print append-only with
no escape sequences. `--plain` forces that.

## Signing in

**Truss never handles a credential.** Each CLI owns its own tokens, so
`truss login [backend]` hands the terminal to that vendor's own flow —
`claude auth login`, `cursor-agent login` — and Truss only ever *reads* the
state they keep (`claude auth status --json`, `cursor-agent status --format
json`) to report who you are signed in as and on what plan.

```
truss login              # any backend that needs it
truss login cursor       # just that one
truss logout cursor
```

## Configuring it

```
truss config                          # show current settings
truss config set autonomy medium      # low | medium | high
truss config set order claude,cursor  # failover order
truss setup --order claude,cursor --autonomy medium   # scriptable, no prompts
```

Autonomy is the setting that matters most:

| | what the agent may do |
|---|---|
| `low` | read and reason only — **edits are declined** |
| `medium` | edits auto-accepted, shell allowed |
| `high` | no remaining guardrails |

It defaults to `low`, which means a write task reports success having changed
nothing. That is deliberate, but it surprises everyone once.

## How it works

The bot is the outer loop. The vendor CLIs are the inner loop.

```
You → truss talk → Bot (role, memory, skills, transcript)
                 → Router (ordered chain of coding CLIs)
                 → claude | cursor-agent | codex
                 → this Mac
```

Claude Code, `cursor-agent`, and Codex all expose a headless mode that ends in a
result Truss can classify. Quota exhaustion fails over. Ordinary task failure
does **not** — the next backend would fail the same way.

Claude also reports live quota utilization on every run, so headroom is visible
before anything is exhausted. Detection reads that and the envelope's error
fields — never the agent's own output, which is how a task *about* rate limiting
ends up looking like a rate limit ([Spike 6](docs/spikes/006-quota-telemetry.md)).

Handoff is checkpoint-and-brief: the working tree is committed to a scratch ref
after each tool call, and the successor gets the original task, a diffstat, and
the bot's durable memory. Validated in
[Spike 3](docs/spikes/003-handoff-quality.md): continue, no validity gate.

## What it deliberately doesn't do

- **Share vendor conversation state.** `claude --resume` cannot resume a Cursor
  chat. Truss briefs the next CLI from disk. Useful, but lossy.
- **Pretend chat subscriptions can drive a computer.** ChatGPT Plus and Claude.ai
  chat stay out until they have a real CLI.
- **Keep working with the laptop closed.** Local-first. Routines use `launchd`
  and only fire while this Mac is awake. A cloud computer is later.
- **Auto-merge parallel lanes.** When fan-out exists, lanes produce diffs for
  review.
- **Report a single trustworthy cost number.** Claude reports spend; Cursor
  doesn't. Totals are labelled by what's actually known.
- **Grow a Solo-style GUI.** The live run view is terminal output from a
  headless run — no window, no daemon, no state of its own. A chat UI is a
  later skin.

## Requirements

- Node.js 22+
- git
- At least one of [Claude Code](https://claude.com/claude-code),
  [Cursor CLI](https://cursor.com/docs/cli), or
  [Codex CLI](https://developers.openai.com/codex/cli), authenticated

A backend you don't have an account for is skipped, not fatal — `truss status`
reports each one as `ready`, `broken`, or `missing` with the reason. You can
also drop it from the order: `truss config set order claude,cursor`.

## Install

```bash
npm install
npm run build
npm link          # puts `truss` on your PATH
```

If `npm link` wants root — npm's global prefix is often `/usr/local` — symlink
it into a directory you already own instead:

```bash
ln -sfn "$PWD/dist/cli.js" ~/.local/bin/truss
```

Then:

```bash
truss setup
truss login
truss run "what does this repo do?"
```

The symlink points at `dist/`, so after changing anything under `src/` run
`npm run build` before the new behaviour shows up. `npm test` typechecks and
runs the suite but emits nothing.

## License

MIT
