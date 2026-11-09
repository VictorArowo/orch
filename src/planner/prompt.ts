import type { ChatMessage } from "../core/events.js";
import type { Panel, Role } from "../core/panel.js";
import type { Limits } from "../core/tree.js";

// The planner sees the goal, the roles it may assign, the limits and the tree
// format with one worked example. Nothing else.

const EXAMPLE = {
  goal: "Compare the five most popular open-source vector databases for a small startup.",
  root: {
    id: "root",
    title: "Compare vector databases",
    mode: "sequence",
    children: [
      {
        id: "pick",
        title: "Pick the five databases",
        mode: "leaf",
        role: "researcher",
        output: "list",
        instructions: "Name the five most popular open-source vector databases, by GitHub stars and production use. Names only.",
      },
      {
        id: "research",
        title: "Research each database",
        mode: "parallel",
        itemsFrom: "pick",
        template: {
          title: "Research {{item}}",
          mode: "leaf",
          role: "researcher",
          check: "fact-checker",
          instructions: "Summarise {{item}} for a small startup: licence, hosting options, strengths, weaknesses, rough cost at 1-10M vectors, operational effort.",
        },
      },
      {
        id: "recommend",
        title: "Write the recommendation",
        mode: "leaf",
        role: "writer",
        inputs: ["research"],
        critique: "critic",
        instructions: "Recommend one database for a five-person startup building a RAG feature, name a runner-up, and say when the answer would change.",
      },
    ],
  },
};

const FORMAT = `The plan is JSON: {"goal": "...", "root": <step>}. A step has:
- "id": short, lowercase, letters, digits, - and _. Must be unique. Needed on any step another step refers to.
- "title": a few words.
- "mode": "leaf" (one role does the work), "sequence" (children run in order) or "parallel" (children run at the same time).
- "instructions": for leaves, exactly what to produce. The step sees only these instructions and its inputs, never the rest of the plan, so make them self-contained.
- "role": for leaves, the name of a do role.
- "inputs": ids of earlier steps whose outputs this step needs. Leave it out to read the previous step of a sequence.
- "output": "list" when the step returns a list another step fans out over. Leave it out otherwise.
- "check": a check role, only on steps where a review is worth paying for.
- "critique": a critique role, only on a final or high-stakes draft.
- "children": the steps of a sequence or parallel step.
- For a parallel step that does the same work for each item: "items" (a fixed list) or "itemsFrom" (the id of a leaf with "output": "list"), plus a "template" step. "{{item}}" in the template's title and instructions is replaced by each item. Template steps have no ids.`;

const GUIDELINES = `- Use as few steps as the goal needs. A simple factual question is a single leaf step.
- Run independent work in parallel, then combine it in a later step.
- When the things to fan out over aren't known yet, add a leaf that lists them and use itemsFrom.
- Give the final writing step the combined inputs it needs.
- Assign the cheapest suitable role; save stronger roles for synthesis and writing.
- Add check and critique roles sparingly: each one adds model calls.`;

function roleLine(r: Role): string {
  const what = r.instructions.trim().replace(/\s+/g, " ");
  return `- ${r.name} (${r.job})${what ? `: ${what}` : ""}`;
}

export function planMessages(opts: { goal: string; panel: Panel; limits: Limits; planner: Role }): ChatMessage[] {
  const { goal, panel, limits, planner } = opts;
  const assignable = panel.roles.filter((r) => r.job !== "plan");
  const system = [
    `You are the "${planner.name}" in a team of AI agents. You plan work as a tree of steps that other agents will carry out.`,
    planner.instructions.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
  const user = [
    `Goal: ${goal}`,
    `Roles you can assign (name, job, what they do):\n${assignable.map(roleLine).join("\n")}`,
    `Limits: at most ${limits.maxDepth} levels including the root, at most ${limits.maxFanOut} children or items per step, at most ${limits.maxSteps} steps in all.`,
    FORMAT,
    `Guidelines:\n${GUIDELINES}`,
    `An example plan for a different goal (its role names are only illustrative):\n${JSON.stringify(EXAMPLE, null, 2)}`,
    `Reply with only the JSON plan for the goal above.`,
  ].join("\n\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

export function retryMessage(problems: string[]): ChatMessage {
  return {
    role: "user",
    content: `That plan can't be used:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nReply with the corrected plan, as JSON only.`,
  };
}
