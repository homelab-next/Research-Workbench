// The scripted model's script for the seed loop synth-seed: for each storyline's public task, one goal, one free lookup on the task's
// seed route, and a product of one finding that says the lookup ran and judges nothing. It is made from the public tasks alone, never a
// ground truth, so nothing a seeded case publishes holds an answer (slice 14's Select copies a task's product into what Propose is told).
import type { PublicTask } from "pivot/synth/truth";

export const SEED_SCRIPT = "synth-seed";
export const SEED_FINDING = "The lookup the seeded plan named was run for the starting value; this product records what it returned and makes no judgment about it.";
export const SEED_NOTE = "Seeded synthetic task; the product judges nothing.";
const SEEDED = "This is a seeded synthetic task: the lookup the plan named was run and no judgment was made";

interface Turn { actor: string; when: string[]; reply: { content: string } | { tool_calls: { tool: string; args: Record<string, unknown> }[] } }

/** The turns of one task, each one of its actor's turns only for a request that holds the task's question. */
function taskTurns(t: PublicTask, pivotTitle: (id: string) => string | null, pivotTo: (id: string) => string | null): Turn[] {
  const start = t.starting[0];
  if (start === undefined) throw new Error(`the task of storyline ${t.storyline} has no starting value`);
  const route = t.seed_route;
  const first = route[0], last = route.at(-1);
  if (first === undefined || last === undefined) throw new Error(`the task of storyline ${t.storyline} has no seed route`);
  const title = pivotTitle(first);
  if (title === null) throw new Error(`the seed route of storyline ${t.storyline} names pivot ${first}, which is not loaded`);
  const to = pivotTo(last);
  if (to === null) throw new Error(`the seed route of storyline ${t.storyline} names pivot ${last}, which is not loaded`);
  const card = `{{card:${title}: ${start.value}}}`;
  const when = [t.question];
  const content = (x: unknown): Turn["reply"] => ({ content: JSON.stringify(x) });
  const narrative = (section: string, why: string, text: string) => ({ tool: "propose_narrative", args: { why, section, text, cites: [card] } });
  return [
    {
      actor: "orchestrator", when,
      reply: content({
        goals: [{ title: t.title, question: t.question, want: t.want }],
        window: { from: t.window.from, to: t.window.to },
        limits: { allow_unconfirmed: true, max_weight: null },
        notes: "A seeded synthetic task: one free lookup on the seed route, and no judgment.",
      }),
    },
    {
      actor: "planner", when,
      reply: content({
        goal: t.title,
        subgoals: [{ title: "The seeded lookup", question: `What does the seeded lookup return for ${start.value}?`, have: [{ type: start.type, value: start.value }], want: to, route: [...route] }],
      }),
    },
    { actor: "researcher-g1", when, reply: content({ outcome: "answered", found: [], note: "The seeded lookup ran; its card holds what it returned." }) },
    { actor: "analyst", when, reply: { tool_calls: [{ tool: "list_cards", args: { why: "See what the seeded lookup collected." } }] } },
    {
      actor: "analyst", when,
      reply: {
        tool_calls: [
          {
            tool: "propose_assessment",
            args: {
              why: "Record that the seeded lookup ran.",
              claim: SEED_FINDING,
              likelihood: "roughly even chance",
              confidence: "low",
              confidence_basis: `${SEEDED}.`,
              cites: [card],
              assumptions: [],
              reasoning: `${SEEDED}; the card holds what the lookup returned.`,
            },
          },
          narrative("summary", "Summarise the product.", `${SEEDED}.`),
          narrative("gaps_and_limits", "Say what the product does not show.", `${SEEDED}, so the product shows only what one lookup returned.`),
          narrative("alternatives", "Say what else could explain it.", `${SEEDED}, so no explanation was weighed.`),
          narrative("assessment", "Set out the reasoning.", `${SEEDED}; nothing was assessed.`),
        ],
      },
    },
    {
      actor: "analyst", when,
      reply: content({ done: true, change_kind: "first judgment", change_detail: "on this question", assumptions: ["The seeded task asks only that the lookup be run."], note: "A seeded synthetic task; no judgment was made." }),
    },
    { actor: "publisher", when, reply: content({ title: `[synthetic] ${t.title}`, note: SEED_NOTE }) },
  ];
}

/**
 * The scripted model's script for the seed loop: for each task, the turns of its five agents, each a turn only for a request that holds the
 * task's question. Reads nothing but the tasks and the registry's pivots (a pivot's title names the card a finding cites; the route's last
 * pivot's type is what the sub-goal wants). Every turn is written as JSON, which YAML reads as it is, so any text parses back to itself.
 */
export function seedScript(tasks: PublicTask[], pivotTitle: (id: string) => string | null, pivotTo: (id: string) => string | null): string {
  const sorted = [...tasks].sort((a, b) => (a.storyline < b.storyline ? -1 : a.storyline > b.storyline ? 1 : 0));
  const lines = [
    "kind: script",
    `id: ${SEED_SCRIPT}`,
    "title: Scripted seed runs of a synthetic setup's tasks",
    "# Synthetic. Written by `bun run synth build` from each storyline's public task alone: one goal, one free lookup on the task's seed",
    "# route, and a product of one finding that says the lookup ran and judges nothing. Each turn carries its task's question in `when`.",
    "turns:",
    ...sorted.flatMap((t) => taskTurns(t, pivotTitle, pivotTo)).map((turn) => `  - ${JSON.stringify(turn)}`),
    "",
  ];
  return lines.join("\n");
}
