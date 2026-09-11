# Truss

A meta-harness for coding agents.

> **Status: design draft.** No implementation yet. The design is in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the plan is in
> [`docs/ROADMAP.md`](docs/ROADMAP.md). Feedback on those is the point of this repo today.

## What it's for

Coding agents are sold as sessions but consumed as capacity. If you have both a Claude
subscription and a Cursor subscription, hitting a usage limit on one stops your work while
the other sits idle. And when a task is obviously parallel, there's no way to put two agents
on it without them overwriting each other's files.

Truss sits above the agent CLIs and owns the parts they can't own individually — routing,
isolation, and accounting — while they keep doing the coding.

```
truss run "add tests for the parser"      # fails over to another backend when quota runs out
truss split "refactor auth"               # fans out across isolated git worktrees
```

## How it works

Both Claude Code and `cursor-agent` expose a headless mode (`-p`) that emits a JSON result
envelope, and the two envelopes share most of their fields. Truss normalizes them behind a
small `Backend` interface, classifies each run's outcome, and routes accordingly — failing
over on quota exhaustion, but *not* on ordinary task failure, since the next backend would
fail the same way.

Parallel work gets one git worktree per lane, created and reaped by Truss, so no two agents
ever share a working tree.

## What it deliberately doesn't do

- **Share context between backends.** Each one re-reads the repo. Parallel lanes pay that
  cost N times and can reach contradictory conclusions. This is parallelism, not collaboration.
- **Hand off a conversation.** Vendor session stores are private and incompatible. When Truss
  fails over mid-task it checkpoints the working tree to a scratch ref and briefs the next
  agent with a summary and a diff. Useful, but lossy.
- **Auto-merge lanes.** Lanes produce diffs for human review.
- **Rescue an interactive session.** Truss works on headless invocations. A live session that
  hits a limit is out of reach.
- **Report a single trustworthy cost number.** Claude reports spend; Cursor doesn't. Totals
  are labelled by what's actually known.

## Requirements

- Node.js
- [Claude Code](https://claude.com/claude-code) and/or [Cursor CLI](https://cursor.com/docs/cli),
  authenticated
- git (worktree support)

## License

MIT
