# Spike 7 — Installed is not usable, and no account is not a task failure

Run 2026-09-14. Prompted by a plain constraint: only Claude and Cursor are
available to test with; there is no Codex account.

## Finding 1 — `which` answers the wrong question

`available()` resolved the binary on PATH and reported `installed: true`. On
this machine `which codex` succeeds, and running it does not:

```
$ codex --version
Error: spawn /Users/…/node_modules/@openai/codex-darwin-arm64/vendor/
  aarch64-apple-darwin/codex/codex ENOENT
$ echo $?
1
```

The npm wrapper is present; the vendored native binary it execs is gone. So the
CLI is installed, discoverable, and cannot run. A `--version` probe separates
the three cases cleanly — claude `0`, cursor-agent `0`, codex `1` — and costs
nothing, so `Availability` now carries `usable` alongside `installed` and the
router skips on `usable`.

## Finding 2 — the failure mode this was hiding

A backend that cannot run exits 1 with an empty stdout and the spawn error on
stderr. With no parseable envelope, `classify()` fell through to text matching,
found nothing it recognised, and returned `task_failure`.

**`task_failure` halts the chain** — correctly, since a second backend would
fail the same way on genuinely bad code. But the task never ran. Observed
consequence, with the chain ordered `codex → claude`:

| | before | after |
|---|---|---|
| codex | spawned, ENOENT → `task_failure` | skipped, reason shown |
| claude | **never tried** | ran, succeeded |
| run | `task_failure`, exit 1 | `success`, exit 0 |

A broken or unowned backend anywhere ahead of a working one silently
disabled the whole chain. It presented as the task being broken.

## Rule adopted

A new outcome, `unusable`: the backend itself cannot run — broken install, not
logged in, no account. It advances the chain like `limit_exhausted` but:

- does **not** write a limit mark, since no quota was spent;
- does **not** brief the successor, since no work was produced.

Detection, in precedence order before limits:

- HTTP `401` / `403` → `unusable`. `402` stays `limit_exhausted` (payment
  required means the account exists and is out of road).
- Error text: `ENOENT`, `command not found`, `not logged in`,
  `run <x> login`, `unauthorized`, `invalid api key`, `authentication failed`.

Checked ahead of `LIMIT_PATTERNS` so `401 Unauthorized` cannot be read as a
spent account and burn a failover.

## Finding 3 — the tests were not typechecked

`tsconfig.json` excluded `src/**/*.test.ts` and `src/backends/fake.ts`, and
vitest transpiles without checking. So the test scaffolding was free to drift
from the interfaces it doubles, and it had: adding a required `usable` field to
`Availability` broke seven router tests at runtime with no type error, and
`fake.ts`'s `result(outcome, text = outcome)` had been inferring
`text: Outcome` rather than `string` — every call passing real prose was a
latent error nothing could see.

`tsconfig.check.json` includes everything with `noEmit`, and `npm test` runs it
before vitest. The build still excludes tests from `dist/`.

## Note for anyone with a CLI installed but no account

The probe passes (the binary runs), so the first run of each chain spends one
spawn discovering `unusable` before moving on. Cheap, but not free. Dropping
the backend from `order` in `~/.truss/config.json` avoids it entirely.
