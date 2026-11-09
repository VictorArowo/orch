# orch

You give orch a goal. It drafts a plan as a tree of steps, some in sequence and some in parallel. You decide which roles and models handle which steps, and what each run may spend, then watch it run: parallel branches fan out, outputs flow to the steps that read them, checkers send work back, and spend ticks up against a hard cap.

It covers milestones 1 to 3 of [PLAN.md](PLAN.md), plus accounts and stored keys from milestone 5: the engine, a CLI, the planner, and a web app where each account drafts, edits and runs its own trees on its own OpenRouter key.

## The web app

You need Node 22 and pnpm.

```bash
pnpm install
```

Start the engine service and the web app together:

```bash
pnpm dev
```

Open http://localhost:3000 and create an account. Before anything can run, add your OpenRouter key in Settings, under API keys. Connect with OpenRouter creates a key for orch in your OpenRouter account through OpenRouter's OAuth flow; you can set a spending limit on it, or revoke it, from your OpenRouter dashboard. Pasting a key works too. Either way the key is encrypted before it's stored, decrypted only while a call is being made, and never shown again. OpenRouter bills you directly; orch never handles payment.

Then draft a plan from one of the example goals. The editor shows the tree on a canvas with a cost estimate per step. Click a step to change its instructions, role, model or reviewers. Run it, and the tree fills in live: steps not started are pencilled in, the steps working now are highlighted, finished ones are inked. Click any step to see what it was told, what it did, who reviewed it and what each call cost.

You can steer a run while it goes. Click a step and the side panel offers what fits its state: pause it (any call it has under way stops; a stopped call may still be billed, so it counts at its worst case), resume it, skip it so the steps after it go ahead, or edit its instructions, role, model and reviewers, which apply from its next attempt. Pause a whole box to hold a branch. A finished step can be re-run, on another model if you like, together with the steps that used its output; when steps are left reading outdated output, the run page offers to re-run them. A step that failed can be skipped, and the run carries on.

Settings also covers your profile, password, default panel and spending limits, and deleting the account (which deletes its runs, saved trees and stored key).

`pnpm dev` runs `orch serve` on port 4317 and the Next.js app on port 3000, which forwards `/api` to the engine. To run them separately, use `pnpm serve` and `pnpm --filter web dev`.

### Accounts and keys

Accounts live in the engine service, next to runs, so the embedded database works without a separate auth server.

- Passwords are hashed with scrypt. Sessions are random tokens in HttpOnly, SameSite=Lax cookies, stored only as hashes, and expire after 30 days. Changing the password signs out other devices. Sign-in attempts are rate-limited.
- Requests that change anything must be JSON, which browsers won't send cross-site without a CORS preflight the service never grants. Together with SameSite cookies, that blocks CSRF.
- Each stored key is encrypted with its own AES-256-GCM data key, bound to its account, and the data key is encrypted with a master key kept outside the database. A copy of the database alone exposes nothing usable. Set `ORCH_MASTER_KEY` in production; locally, `orch serve` makes one in `.orch/master.key`. `ORCH_MASTER_KEYS` lists several versions for rotation.
- Runs and saved trees belong to the account that made them, and every route checks ownership.

Set `ORCH_SECURE_COOKIES=1` when serving over HTTPS. Sign-in with GitHub or Google isn't built yet.

## The command line

The CLI runs trees locally without accounts, using `OPENROUTER_API_KEY` from `.env`. Try the example with mock models first:

```bash
pnpm orch run examples/vector-dbs.tree.json --panel panels/starter.json --cap 0.50 --mock
```

To run it against real models, copy `.env.example` to `.env` and put your OpenRouter key in it. orch reads the key from there and never prints or stores it.

```bash
cp .env.example .env
```

```bash
pnpm orch run examples/vector-dbs.tree.json --panel panels/starter.json --cap 0.50
```

The example makes about 20 model calls and should cost a few cents. The cap is a hard limit: before each call orch reserves the most that call could cost, so the run pauses rather than go over.

To have the panel's plan role draft a tree for your own goal:

```bash
pnpm orch plan "Compare the three best static site generators for a docs team" --panel panels/starter.json --mock
```

It prints the tree with each step's role, models and a cost estimate, and saves it under `plans/`. Edit the file if you want, then pass it to `orch run`. Or plan and run in one go; orch shows the tree and asks before it runs:

```bash
pnpm orch run --goal "Compare the three best static site generators for a docs team" --panel panels/starter.json --cap 0.50 --mock
```

Press Ctrl-C once to pause a run after the calls in flight finish. Press it twice to quit at once; `orch resume` picks up where it left off either way.

### Storage

Accounts, runs, events and the job queue live in Postgres. By default orch uses an embedded Postgres (PGlite) in `.orch/db`, so nothing else needs to be running. To use a real server instead, start the one in `docker-compose.yml` and point `DATABASE_URL` at it (`.env.example` has the URL):

```bash
pnpm db:up
```

### Commands

```
orch plan "<goal>" --panel <panel.json> [--out <file>] [--plan-cap <usd>] [--mock]
orch run <tree.json> --panel <panel.json> --cap <usd> [--mock] [--concurrency n]
orch run --goal "<goal>" --panel <panel.json> --cap <usd> [--yes] [--mock]
orch resume <run-id> [--cap <usd>]
orch rerun <run-id> <step-id>... [--model <id>] [--cascade]
orch skip <run-id> <step-id>...
orch show <run-id> [<step-id>]
orch runs
orch serve [--port <n>]
```

Drafting a tree may spend up to `--plan-cap` (default $0.10) across its attempts. With `run --goal` that cost also counts against the run's cap. `plan` and `run` also take `--max-depth`, `--max-fan-out` and `--max-steps`. Every command takes `--db` to pick a database and `--no-live` to print events line by line instead of redrawing the tree. Use `pnpm orch ...` from the repo, or `pnpm build && pnpm link --global` for a plain `orch` command.

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

## Planning and estimates

The planner sends the plan role the goal, the panel's other roles with their jobs and instructions, the depth and fan-out limits, the tree format and one worked example, and asks for JSON. Small slips in the reply are repaired and listed: unknown fields, role names in the wrong case, a review role with the wrong job, duplicate ids, inputs that point nowhere, too many fixed items. Anything that would change what the plan means, such as a tree that is too deep or steps that wait on each other, goes back to the model with the problems listed, up to three attempts in all.

Estimates are a range per step and for the whole tree. The low end assumes every step works first time with a typical reply size (about 300 tokens for text, 40 for a list or a verdict). The high end assumes every check sends work back as often as it can, every critique forces a revision, ladders climb to the top, and every reply uses its whole token limit. Input sizes come from the expected outputs of the steps a step reads. A fan-out over another step's list assumes the count its wording gives ("the five most popular"), or 3 up to the fan-out limit when it doesn't say.

[examples/goals.json](examples/goals.json) holds eleven varied goals for tuning the planner, each with a note on what a sensible tree looks like. `pnpm plan:goals --mock` plans them all and prints one row per goal with its shape, estimate and drafting cost; without `--mock` it uses the real plan model, within `--cap` (default $0.50). [examples/planned/](examples/planned) holds the trees the tuned planner drafted for those goals with the starter panel; a test checks they still validate.

## Panels

A panel is a list of roles. Each role has a name, a job (`plan`, `do`, `check` or `critique`), instructions, and its models:

- `"model": "id"` for a single model;
- `"ladder": ["cheap", "stronger"]` for a do role that moves up a rung each time a check sends its work back;
- `"jury": ["a", "b", "c"]` for a check or critique role whose models vote, with a strict majority needed to send work back.

Settings such as `maxTokens`, `temperature` and `reasoningEffort` go in `settings`, and `description` is the one line shown wherever the panel is picked.

orch ships six panels in [panels/](panels). They all cast the same roles (planner, researcher, analyst, writer, fact-checker, editor and critic), so any tree runs on any of them and you can compare what the cast changes:

- starter: cheap models research and step up when sent back, Gemini Flash compares, Claude Sonnet writes, and a critic from another family pushes back.
- budget: small, fast models in every role, for trying a plan out cheaply.
- heavyweight: the strongest models throughout, at ten or more times the cost.
- mixed: each role on a different model family, so no model reviews its own family's work.
- open-weights: DeepSeek, Qwen, Kimi and Llama only.
- solo: Claude Sonnet in every role, as a baseline.

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

The tests use a mock gateway in place of OpenRouter and an in-memory PGlite, so they need no key, network or Docker, and never spend anything. The web app and the engine service have no mock mode; only the CLI's `--mock` flag uses the mock models. They cover accounts, sessions and key encryption, the engine service and its event streams, the canvas layout and tree edits, the planner (repairs, retries and its cap), estimates, the scheduler, reservations and reconciliation, pausing on the cap, ladders, checks, juries and critiques, stale tracking on re-runs, and resuming after a simulated crash. To run the store tests against the Docker Postgres as well:

```bash
ORCH_TEST_DATABASE_URL=postgres://orch:orch@localhost:5433/orch pnpm test
```

## Layout

```
src/core      panels, trees, events, the state fold, budget maths, estimates, prompts, the step state machine
src/store     the Store interface and its SQL implementation for Postgres and PGlite
src/planner   the planner prompt, plan repairs, and the retry loop
src/server    the engine service: accounts, sessions, encrypted keys, saved trees, runs and event streams
src/view      the canvas's view of a tree or a run, its layout, and the editor's tree edits
web/          the Next.js app
src/gateway   OpenRouter, the mock (including mock plans), and key redaction
src/engine    the scheduler and workers
src/cli       the orch command and its tree view
```
