# orch: plan

`orch` is a working name. It started as a portfolio project and is now built as a real product: accounts, stored keys and settings, with every run on the user's own key. It should still be fun to build, satisfying to watch, and a good piece of engineering to talk about.

## What it is

You give orch a goal. It drafts a process for getting there: a tree of steps, some in sequence and some in parallel. You shape that process however you like, deciding which roles and models handle which steps and what gets passed along. Then you run it and watch the tree come alive as agents work through it. You can step in at any point: pause a branch, edit a step, swap a model, re-run part of the tree.

The LLMs do the work. You do the orchestrating.

## The demo

The moment the project is built around:

1. You type "Compare the five most popular open-source vector databases for a small startup."
2. The planner sketches a tree on screen. "Research each database" fans out into five parallel branches. "Compare" and "write the recommendation" follow in sequence.
3. You drag in your panel: a cheap fast model as the researcher, a stronger model as the writer, and a critic from a different model family to pick holes in the draft.
4. You press run. The five research branches light up at once, each showing live tokens, spend and status. One stalls, so you pause it, tighten its instructions and resume.
5. The writer pulls the branches together, the critic objects to one claim, and the writer revises.
6. You click any step to see exactly what it was told, what it did and what it cost. Then you swap the writer for another model and re-run just that step to compare.

If that works smoothly, the project has done its job.

## Principles

1. You orchestrate. orch drafts the process, but you can change anything before and during a run.
2. Your roles, any model. Roles are yours to define, and each can use any model through one gateway.
3. Everything is visible. Every step shows its input, output, model, transcript and cost.
4. Spend is visible and capped. You see an estimate before running, live spend while it runs, and a cap it can't exceed.
5. Everything is recorded. A run is an event log, so any run can be replayed step by step after the fact.

## Core concepts

```
Panel
 └─ roles[]
      Role: name, job (plan | do | check | critique), instructions, tools,
            models[] (one, a ladder, or a jury), settings

Run
 ├─ goal, panel, budget cap
 ├─ status: drafting → ready → running ⇄ paused → done | stopped
 └─ root Step
      Step
       ├─ instructions and inputs
       ├─ mode: leaf | parallel (fan out over items) | sequence (ordered children)
       ├─ role (from the panel, overridable per step)
       ├─ attempts[]: model used, transcript, tool calls, output, cost,
       │              which input versions it read
       └─ children[]
```

- Panel: a reusable cast of roles.
- Run: one goal, one panel, one tree, one budget cap.
- Step: a node in the tree. Leaf steps do the work. Parallel steps fan out over a list. Sequence steps run their children in order and pass results forward.
- Attempt: one go at a step. Re-running a step creates a new attempt, so old results are kept for comparison.
- Event: an append-only record of everything that happens. The UI and replays are built from it.

A run that can't finish because a step failed ends as stopped, with the reason; there's no separate failed status. Re-running a step in a done run reopens it until that step finishes.

## Panels

A panel is the cast for a run: the roles you want and which model plays each one.

### Roles

orch has no fixed list of roles. You define each one:

- a name, such as "researcher", "devil's advocate", "analyst" or "editor";
- instructions on how the role should work;
- a job, which is the only thing the engine needs to know:
  - plan: drafts the tree;
  - do: carries out steps;
  - check: reviews a step's output and can send it back;
  - critique: argues against a draft or result and raises objections;
- the tools it may use;
- its model or models, plus settings such as reasoning effort.

A run needs at least one plan role and one do role, though a hand-written tree only needs the do role. Check and critique roles are optional extras you can add where they help. orch ships a few starter panels so a first run doesn't need any setup.

### More than one model in a role

- Single: one model plays the role.
- Ladder: start on a cheap model and move up to a stronger one if a check sends the work back.
- Jury: several models review the same output and vote, and you see where they disagree.

Ladders are for do roles and juries for check and critique roles; a single model works anywhere. A jury sends work back only when a strict majority of the votes cast say so, and replies that can't be parsed don't count either way.

### Comparing panels

Run the same tree with two panels side by side and compare the outputs, time and cost. It's the most fun way to see how models differ, and it makes great material for the write-up.

## How a run works

1. Draft. The plan role turns the goal into a tree, assigns a role to each step and estimates the cost. Small slips in its reply are repaired and listed; a plan that still fails validation goes back to the model with the problems, up to three attempts. Drafting has its own small cap, and when a run is drafted and started in one go, drafting counts against the run's cap too.
2. Shape. You edit the tree: add, remove or reorder steps, switch fan-out on or off, change roles and models, and set the budget cap. Nothing runs until you press run.
3. Run. The scheduler runs ready steps in parallel up to a concurrency limit. Each step gets only its own instructions and inputs, not the whole run's history, and returns structured output.
4. Review, if you added it. A check role reviews a step and can send it back with notes, twice by default. If the check still wants changes after that, the last output is accepted with a warning rather than failing the step. A critique role objects once, the step's role revises, and the revision goes through the check again.
5. Steer. At any point you can pause the run or a branch, edit a step, swap its model, skip it, or re-run it. Re-running a step marks everything that used its old output as stale and offers to re-run those too. Pausing a single step stops any call it has under way; that call may still be billed, so it counts at its full reservation. An edit applies from the step's next attempt, and a fan-out's template can be edited until it makes its branches. A skipped step counts as done with no output, so a run stopped by a failure can carry on. Open gap: re-running the step a fan-out reads its list from doesn't rebuild the fan-out, so the branches stay as they were.
6. Finish. The root step produces the result. It's shown next to the tree with a cost breakdown per step.

## Cost

- Estimate before you run, per step and for the whole tree, based on the models' prices and rough token counts per kind of step. It's a range: the low end assumes everything works first time at typical reply sizes, the high end that every check and critique sends work back and every reply uses its full limit. A fan-out whose list isn't known yet assumes the count its wording gives, or a range up to the fan-out limit.
- Live spend per step and for the run, in money rather than tokens.
- A hard cap. Before each model call, the engine reserves that call's worst-case cost against the cap and releases what isn't used afterwards. The worst case is the completion limit times the output price, plus the prompt's UTF-8 byte count times the input price, since a prompt can't have more tokens than bytes. That overstates the prompt about fourfold, but only until the call settles. A call that doesn't fit next to the calls in flight waits for them. When nothing more fits under the cap, the run pauses and asks.
- A call cut off by a crash or a hard stop may or may not have been billed, so it counts at its full reservation.
- Limits on tree depth and fan-out width, so a planner can't spawn 50 agents for a simple question. When a step returns a longer list than the fan-out limit allows, the extra items are dropped and the log records how many were asked for.

## Keys and models

People bring their own keys. orch never handles billing: the model provider or gateway bills the user directly.

### Which keys

1. A gateway key, in the first version. One key reaches every model on the gateway, and the gateway reports the real cost of each call, which the budget cap and live spend use. OpenRouter is the likely first choice because of its OAuth flow (below).
2. Direct provider keys (OpenAI, Anthropic, Google), later. orch picks the key that matches each model's provider and uses a built-in price table for estimates.
3. Local models through Ollama, later. They cost nothing and run on your machine, which suits ladders well: a free local model first, a paid one only when needed.

The panel editor only offers models that the user's keys can reach, so a role can't be given a model that will fail at run time.

### Storing keys on the hosted version

Keys are stored, because asking for them on every visit is tedious, and runs keep going on the server after the browser closes.

- Accounts. Sign-in with GitHub or Google. Keys belong to an account.
- Connect, don't paste. With OpenRouter, the user clicks "Connect OpenRouter" and approves once through OpenRouter's OAuth (PKCE) flow, and orch receives a key for that user. The user can set a spending limit on it and revoke it from their OpenRouter dashboard at any time. Pasting a key stays available as a fallback, and the settings page suggests creating a dedicated key with a limit.
- Encrypted at rest. Each key is encrypted with its own data key (AES-256-GCM), and the data keys are encrypted by a master key held outside the database, in a cloud KMS or at least a separate secret in the host's environment. A database leak on its own exposes nothing usable. Each record stores the key version, so the master key can be rotated.
- Write-only. Once saved, a key is never sent back to the browser. The settings page shows the provider, the last four characters, when it was added and when it was last used, with buttons to replace or delete it.
- Decrypted only at call time. The engine decrypts a key in memory just before a model call. Keys never appear in logs, error messages, the event log or replays. The logger redacts anything that looks like a key as a second line of defence.
- Checked on save. A cheap test call confirms the key works and shows its remaining credit or limit where the gateway reports it.
- Deleted for real. Removing a key, or deleting the account, deletes the stored ciphertext. Revoking an OAuth-issued key is also offered as a link to OpenRouter.

Running locally needs none of this: keys come from a `.env` file, and nothing leaves the machine except calls to the model providers.

## Interface

- Goal box, with a few example goals.
- Panel editor: your roles as rows, each with its job, instructions and models, and a running cost estimate.
- Tree editor: the plan as a tree or canvas. Click a step to edit its instructions and role, and drag to restructure.
- Live run view: the same tree, animated as steps start, stream, finish or stall, with spend ticking against the cap and pause and re-run controls on every step.
- Step inspector: input, output, model, transcript, tool calls and cost for each attempt, side by side when there's more than one.
- Replay: scrub through a finished run from the event log and watch the tree build and fill in again, much like jev-chess's move-by-move viewer.

## Architecture

TypeScript throughout. kestrel pairs a Rust engine with a Next.js app; orch keeps the engine in TypeScript too.

- Web app: Next.js and React, with live updates streamed from the event log over server-sent events.
- Engine: a separate TypeScript service that owns the scheduler, the role loops, budgets and steering. Runs keep going when the browser closes.
- Durability: steps run as jobs from a Postgres-backed queue, so a run survives a restart. That's simpler than Temporal or Inngest and enough for this project. Locally, an embedded Postgres (PGlite) runs the same schema, so no server is needed.
- Storage: Postgres for accounts, encrypted keys, runs, steps, attempts and the event log.
- Accounts: email and password for now, held by the engine service next to runs, since the embedded database can only be opened by one process. GitHub and Google sign-in come later, once OAuth apps exist for them.
- Mock models are only for the automated tests and the CLI's `--mock` flag. The engine service and web app always call real models.
- Models: one gateway, most likely OpenRouter, using each user's own key. See [Keys and models](#keys-and-models).
- Tools: web search and page fetch, both read-only to start. The fetcher refuses private and internal addresses, and fetched pages are treated as untrusted text, never as instructions.

## Scope

First version:

- Goal to drafted tree, a tree editor, run, live view, steering and re-runs.
- Panels with your own roles, the four jobs, ladders and juries, and starter panels.
- Cost estimate, live spend and a hard cap.
- The step inspector and replay.
- A public demo of recorded runs that visitors can replay without signing in or spending anything.
- Accounts with stored, encrypted gateway keys, connected through OpenRouter's OAuth or pasted, so signed-in users can run live.

Later, if it's still fun:

- Side-by-side panel comparison in the UI.
- Direct provider keys and local models through Ollama.
- More tools, such as a sandboxed code runner and vetted MCP servers.
- Saving trees as reusable templates.

## Milestones

1. Engine and CLI. Event log, step tree, scheduler, budget reservations, and panels read from a config file. A CLI runs one goal end to end and prints the tree with the role, model, output and cost for every step. (Done.)
2. Planner. Goal to tree with roles and estimates. Try it on ten varied goals and tune it until the trees look sensible. (Done.)
3. Tree editor and live run view. Shape a plan in the browser, run it, and watch it live. (Done.)
4. Steering. Pause, edit, swap models and re-run, including stale-output tracking. (Done.)
5. Inspector, replay and public demo. Record three or four good runs and make them replayable on the site. (Accounts, connecting OpenRouter and encrypted key storage were brought forward and are done.)
6. Write-up. A post in the style of the others, for example "the same goal with three panels": what the trees looked like, where models disagreed, and what each run cost.

## Open decisions

- Name.
- Tree or canvas: decided, a node canvas (React Flow), drawn like a score: parallel steps joined by a bracket, pending work pencilled in, the step playing highlighted, finished work inked.
- Gateway: OpenRouter is the likely choice for its OAuth flow. Vercel AI Gateway, used in jev-chess, is the alternative, but it would mean pasted keys only.
- Where the master key lives: a cloud KMS (AWS, GCP) or a separate secret in the host's environment.
- Hosting: where the public demo lives, and whether live runs are possible there at all.

## Prior art

Useful to read before building, and to reference in the write-up:

- Anthropic, "How we built our multi-agent research system": an orchestrator and parallel sub-agents, about 15× the tokens of a chat. https://www.anthropic.com/engineering/multi-agent-research-system
- Cognition on what works in multi-agent setups: reviewers with fresh context, and only one writer at a time. https://cognition.com/blog/multi-agents-working
- Claude Code dynamic workflows: orchestration as a resumable script with per-agent tokens shown live. https://code.claude.com/docs/en/workflows.md
- Kimi Agent Swarm: the most visible consumer swarm, where you watch sub-agents spawn and report. https://www.kimi.com/en/help/agent/agent-swarm
- Gemini Deep Research: shows its plan and lets you edit it before starting. https://support.google.com/gemini/answer/15719111
- The MAST failure taxonomy, for the problems you'll hit: steps repeating, agents not knowing when to stop, and lost context. https://arxiv.org/abs/2503.13657
