# orch

You give orch a goal and a tree of steps for reaching it. You decide which roles and models handle which steps, then watch the tree run: parallel branches fan out, outputs flow to the steps that read them, optional checkers send work back, and spend ticks up against a hard cap.

This is milestone 1 of [PLAN.md](PLAN.md): the engine and a CLI. The planner that drafts trees from a goal comes next, so for now trees are hand-written JSON files.

## Running it

You need Node 22 and pnpm.

```bash
pnpm install
```

Try the example with mock models first. It needs no key and costs nothing:

```bash
pnpm orch run examples/vector-dbs.tree.json --panel panels/starter.json --cap 0.50 --mock
```

To run it against real models through OpenRouter, copy `.env.example` to `.env` and put your OpenRouter key in it. orch reads the key from there and never prints or stores it.

```bash
cp .env.example .env
```

```bash
pnpm orch run examples/vector-dbs.tree.json --panel panels/starter.json --cap 0.50
```

The example makes about 20 model calls and should cost a few cents. The cap is a hard limit: before each call orch reserves the most that call could cost, so the run pauses rather than go over.

Press Ctrl-C once to pause a run after the calls in flight finish. Press it twice to quit at once; `orch resume` picks up where it left off either way.

### Storage

Runs, events and the job queue live in Postgres. By default orch uses an embedded Postgres (PGlite) in `.orch/db`, so nothing else needs to be running. To use a real server instead, start the one in `docker-compose.yml` and point `DATABASE_URL` at it (`.env.example` has the URL):

```bash
pnpm db:up
```

### Commands

```
orch run <tree.json> --panel <panel.json> --cap <usd> [--mock] [--concurrency n]
orch resume <run-id> [--cap <usd>]
orch rerun <run-id> <step-id>... [--model <id>]
orch show <run-id> [<step-id>]
orch runs
```

`run` also takes `--max-depth`, `--max-fan-out` and `--max-steps`. Every command takes `--db` to pick a database and `--no-live` to print events line by line instead of redrawing the tree. Use `pnpm orch ...` from the repo, or `pnpm build && pnpm link --global` for a plain `orch` command.

`show <run-id> <step-id>` prints every attempt at a step: the model, each call with its reservation, real cost and token counts, review verdicts and votes, and the full output.

## Trees

A tree has a goal and a root step. Each step is a leaf (one role does the work), a sequence (children run in order) or a parallel step (children run at once).

```json
{
  "goal": "Compare the five most popular open-source vector databases for a small startup.",
  "root": {
    "id": "root",
    "mode": "sequence",
    "children": [
      { "id": "pick", "role": "researcher", "output": "list", "instructions": "Name the five most popular..." },
      { "id": "research", "mode": "parallel", "itemsFrom": "pick",
        "template": { "title": "Research {{item}}", "role": "researcher", "check": "fact-checker" } },
      { "id": "compare", "role": "analyst", "inputs": ["research"] },
      { "id": "recommend", "role": "writer", "inputs": ["compare", "research"], "check": "editor", "critique": "critic" }
    ]
  }
}
```

- A parallel step either lists its `children` or fans out over `items`, or over the list another step returns (`itemsFrom`), making one child per item from its `template`.
- `inputs` names the steps whose outputs a step reads. Without it, a step in a sequence reads the step before it.
- `check` and `critique` name optional review roles. A check can send work back with notes up to `maxRetries` times (default 2). A critique raises objections and the step revises once.
- `model` overrides the role's model for one step. Steps without a `role` use the panel's first do role.

See [examples/vector-dbs.tree.json](examples/vector-dbs.tree.json) for the full example. Ids are optional except where other steps refer to them.

## Panels

A panel is a list of roles. Each role has a name, a job (`plan`, `do`, `check` or `critique`), instructions, and its models:

- `"model": "id"` for a single model;
- `"ladder": ["cheap", "stronger"]` for a do role that moves up a rung each time a check sends its work back;
- `"jury": ["a", "b", "c"]` for a check or critique role whose models vote, with a strict majority needed to send work back.

Settings such as `maxTokens`, `temperature` and `reasoningEffort` go in `settings`. [panels/starter.json](panels/starter.json) is the panel used above.

## How it works

Everything that happens in a run is an event in an append-only log: steps starting, budget reservations, model calls finishing, reviews, send-backs. Run state is never stored directly. It is folded from the log, which is what makes resuming and (later) replay straightforward.

Ready leaf steps go onto a job queue in Postgres. Workers claim jobs with `FOR UPDATE SKIP LOCKED` under a lease they keep renewing, and every decision that touches the budget or the queue happens under a per-run row lock. A worker that loses its lease can't write to the run any more. When a process dies, `orch resume` hands its jobs back straight away if it can tell the process is gone, or once the lease runs out if it can't.

Each step works through a small state machine that reads only the log: start an attempt, call the model, check, critique, accept or send back. After a crash it continues from the last event, so finished steps aren't redone and at most the calls that were in flight are lost.

Before each model call orch reserves its worst case: the prompt's UTF-8 byte count as a token bound, plus the full completion limit, at the model's price. After the call it reconciles to the cost OpenRouter reports. If a call doesn't fit next to the calls in flight it waits for them to settle. If it can't fit even then, the step is blocked, and when nothing else can run the run pauses with the amount it needs. An interrupted call may or may not have been billed, so it counts at its full reservation. Money is kept as integer nanodollars so totals compare exactly against the cap.

Re-running a step starts a new attempt and keeps the old ones. Each attempt records the version of every input it read, so steps that read an output which has since changed show as stale, and so do the steps that read those.

## Tests

```bash
pnpm test
```

The tests use the mock gateway and an in-memory PGlite, so they need no key, network or Docker. They cover the scheduler, reservations and reconciliation, pausing on the cap, ladders, checks, juries and critiques, stale tracking on re-runs, and resuming after a simulated crash. To run the store tests against the Docker Postgres as well:

```bash
ORCH_TEST_DATABASE_URL=postgres://orch:orch@localhost:5433/orch pnpm test
```

## Layout

```
src/core      panels, trees, events, the state fold, budget maths, prompts, the step state machine
src/store     the Store interface and its SQL implementation for Postgres and PGlite
src/gateway   OpenRouter, the mock, and key redaction
src/engine    the scheduler and workers
src/cli       the orch command and its tree view
```
