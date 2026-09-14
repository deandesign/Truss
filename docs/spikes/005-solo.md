# Spike 5 — Solo gap check

Re-read 2026-09-14 against [soloterm.com](https://soloterm.com/) and the
handoff / orchestration docs.

## Still true

- Solo launches the real CLIs you already have. Same boundary as Truss.
- Scratchpads, todos, locks, timers exist as durable coordination outside a
  chat transcript. Truss already adopted scratchpads for §3.
- Rate limiting in Solo's process-supervision sense (don't restart a crashed
  server forever) is unrelated to API usage limits.

## What changed since the first assessment

- Solo now documents git worktrees: linked checkouts can **share** todos and
  scratchpads while commands stay in the right tree. That is a sharing layer,
  not Truss-style isolation ("one agent per tree, Truss owns create/reap").
- Solo now has an explicit "hand off long-running work" workflow: when an
  agent's context or **quota** ends, write the scratchpad, launch a different
  configured tool, continue. The handoff is **manual / prompted**. Nothing
  in the docs detects a 429 from the inner CLI and automatically continues
  the same task on the next vendor.

## Wedge that remains

Automatic quota failover — classify the inner CLI's result, checkpoint, brief
the next backend, keep going — is still not Solo. Cost accounting is still
unmentioned. Truss stays a meta-harness that makes capacity fungible, not a Solo
plugin… unless Solo later ships that classifier.

## Positioning

Solo is a visible workspace; Truss is a framework that connects your CLIs.
`truss run` can still be a command Solo supervises.
