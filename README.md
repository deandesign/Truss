# Truss

A meta-harness that connects the coding agents you already pay for.

> Design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Plan:
> [`docs/ROADMAP.md`](docs/ROADMAP.md).

Truss sits above Claude Code, Cursor Agent, and Codex. You talk to one named
agent; Truss routes the work onto whichever CLI still has quota. When one
account hits a limit, the run continues on the next. Vendor sessions never
cross; Truss owns the conversation, the memory, and the handoff.

```
truss talk builder "add tests for the parser"
truss run "add tests for the parser"          # inner loop, no bot wrapper
truss status                                  # installed, authed, quota headroom
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

```bash
npm install
npm run build
node dist/cli.js init
node dist/cli.js status
```

## License

MIT
