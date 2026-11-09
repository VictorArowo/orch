// A stand-in planner for the mock gateway. It reads the goal and the role list
// out of the planner prompt and returns a plausible tree for one of a few
// shapes: a single step for a short question, a fan-out comparison, a plan
// built part by part, or a researched report.

interface MockRole {
  name: string;
  job: string;
}

const NUMBER_WORDS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

function countIn(text: string): number | undefined {
  const lower = text.toLowerCase();
  const digits = /\b([2-9]|10)\b/.exec(lower);
  if (digits) return Number(digits[1]);
  const i = NUMBER_WORDS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(lower));
  return i >= 0 ? i + 2 : undefined;
}

export function mockListLength(text: string): number {
  return countIn(text) ?? 5;
}

export function mockPlan(prompt: string): unknown {
  const goal = /^Goal: (.*)$/m.exec(prompt)?.[1]?.trim() ?? "the goal";
  const sentence = /[.?!]$/.test(goal) ? goal : `${goal}.`;
  const roles: MockRole[] = [...prompt.matchAll(/^- (.+?) \((do|check|critique)\)/gm)].map((m) => ({ name: m[1]!, job: m[2]! }));
  const fanOut = Number(/at most (\d+) children/.exec(prompt)?.[1] ?? 8);
  const doRoles = roles.filter((r) => r.job === "do").map((r) => r.name);
  const gather = doRoles[0] ?? "researcher";
  const analyse = doRoles[1] ?? gather;
  const write = doRoles[doRoles.length - 1] ?? gather;
  const check = roles.find((r) => r.job === "check")?.name;
  const critique = roles.find((r) => r.job === "critique")?.name;
  const n = Math.min(countIn(goal) ?? 4, fanOut);
  const lower = goal.toLowerCase();
  const withReview = (step: Record<string, unknown>, kind: "check" | "critique") => {
    const role = kind === "check" ? check : critique;
    return role ? { ...step, [kind]: role } : step;
  };

  // A short question gets one step.
  if (lower.endsWith("?") && goal.split(/\s+/).length <= 12 && !/compare|plan|versus|\bvs\b/.test(lower)) {
    return { goal, root: { id: "answer", title: "Answer the question", mode: "leaf", role: write, instructions: `Answer directly and briefly: ${goal}` } };
  }

  if (/compar|versus|\bvs\b|which .*(best|should)|alternatives|choose|options/.test(lower)) {
    return {
      goal,
      root: {
        id: "root",
        title: "Compare the options",
        mode: "sequence",
        children: [
          {
            id: "pick",
            title: `Pick the ${n} options`,
            mode: "leaf",
            role: gather,
            output: "list",
            instructions: `List the ${n} options most worth comparing for this goal: ${sentence} Names only.`,
          },
          {
            id: "research",
            title: "Research each option",
            mode: "parallel",
            itemsFrom: "pick",
            template: withReview(
              {
                title: "Research {{item}}",
                mode: "leaf",
                role: gather,
                instructions: "Summarise {{item}} against what matters for the goal: strengths, weaknesses, cost and risks. Short bullet points.",
              },
              "check",
            ),
          },
          {
            id: "compare",
            title: "Compare side by side",
            mode: "leaf",
            role: analyse,
            inputs: ["research"],
            instructions: "Build a comparison table across the criteria that matter most, then name the two or three differences that decide it.",
          },
          withReview(
            {
              id: "recommend",
              title: "Write the recommendation",
              mode: "leaf",
              role: write,
              inputs: ["compare", "research"],
              instructions: "Recommend one option, name a runner-up, and say when the answer would change.",
            },
            "critique",
          ),
        ],
      },
    };
  }

  if (/\bplan\b|itinerary|schedule|roadmap|curriculum|learn/.test(lower)) {
    return {
      goal,
      root: {
        id: "root",
        title: "Build the plan",
        mode: "sequence",
        children: [
          {
            id: "constraints",
            title: "Pin down the constraints",
            mode: "leaf",
            role: gather,
            instructions: `List the constraints, assumptions and success criteria for: ${goal}`,
          },
          {
            id: "phases",
            title: "Split it into phases",
            mode: "leaf",
            role: analyse,
            output: "list",
            instructions: `Split the plan into ${Math.min(n, 4)} phases, in order. Short names only.`,
          },
          {
            id: "detail",
            title: "Detail each phase",
            mode: "parallel",
            itemsFrom: "phases",
            template: { title: "Plan {{item}}", mode: "leaf", role: gather, inputs: ["constraints"], instructions: "Detail {{item}}: what happens, how long it takes and what it needs." },
          },
          withReview(
            { id: "assemble", title: "Assemble the plan", mode: "leaf", role: write, inputs: ["constraints", "detail"], instructions: "Combine the phases into one plan with a timeline and the main risks." },
            "check",
          ),
        ],
      },
    };
  }

  return {
    goal,
    root: {
      id: "root",
      title: "Research and write it up",
      mode: "sequence",
      children: [
        { id: "outline", title: "Outline the sections", mode: "leaf", role: gather, output: "list", instructions: `List the ${Math.min(n, 5)} questions a good answer has to cover for: ${goal}` },
        {
          id: "sections",
          title: "Research each section",
          mode: "parallel",
          itemsFrom: "outline",
          template: { title: "Research: {{item}}", mode: "leaf", role: gather, instructions: "Answer {{item}} with specifics and say what is uncertain." },
        },
        withReview(
          { id: "write", title: "Write it up", mode: "leaf", role: write, inputs: ["sections"], instructions: "Write a clear, well-organised answer to the goal from the research. Lead with the conclusion." },
          "critique",
        ),
      ],
    },
  };
}
