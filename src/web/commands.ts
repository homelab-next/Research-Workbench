import type { CaseStore } from "./store";
import type { LensId, Nav } from "./app";
import type { Ui } from "./ui";
import { AT_GATE } from "./ui";

export type Intent =
  | { kind: "open_case"; id: string }
  | { kind: "go"; to: "home" | "investigate" }
  | { kind: "lens"; id: LensId }
  | { kind: "run" } | { kind: "pause" } | { kind: "accept_plan" } | { kind: "approve" }
  | { kind: "verify"; card: string }
  | { kind: "replay"; seq: number | null }
  | { kind: "ask"; text: string }
  | { kind: "state"; text: string }
  | { kind: "answer"; question: string; text: string }
  | { kind: "overrule"; finding: string }
  | { kind: "say"; text: string }
  | { kind: "playbook"; id: string; value: string };

const LENSES: readonly LensId[] = ["agent", "steps", "timeline", "graph", "narrative", "worklog", "discarded", "jobs", "pipeline", "replay"];
const NEEDS_CASE = "Open a case first: investigate CASE-1";
const CASE_ID = /^case-([0-9]+)$/;

export interface CommandContext { cases: { id: string; title: string }[]; in_case: boolean; cards: string[] }

/** Turns what was typed into one intent. Navigation happens only on the explicit words; anything else in a case is a question for the agent. */
export function parseCommand(text: string, ctx: CommandContext): Intent {
  const typed = text.trim();
  const l = typed.toLowerCase().replace(/\s+/g, " ");
  const say = (t: string): Intent => ({ kind: "say", text: t });
  const inCase = (intent: Intent): Intent => (ctx.in_case ? intent : say(NEEDS_CASE));
  const caseById = (word: string): Intent | null => {
    const m = CASE_ID.exec(word);
    if (m === null) return null;
    const found = ctx.cases.find((c) => c.id.toLowerCase() === word);
    return found ? { kind: "open_case", id: found.id } : say(`There is no case CASE-${m[1]}`);
  };
  if (l === "") return say("Type a command, for example: run");

  const direct = caseById(l);
  if (direct) return direct;
  if (l === "home" || l === "go to home" || l === "open home") return { kind: "go", to: "home" };
  if (l === "investigate" || l === "go to investigate" || l === "open investigate") return { kind: "go", to: "investigate" };

  const prefixed = /^(open|investigate|go to) (.+)$/.exec(l);
  if (prefixed) {
    const verb = prefixed[1]!;
    const rest = prefixed[2]!;
    const byId = caseById(rest);
    if (byId) return byId;
    if (verb !== "investigate" && (LENSES as readonly string[]).includes(rest)) return inCase({ kind: "lens", id: rest as LensId });
    if (verb === "investigate") {
      const hits = ctx.cases.filter((c) => c.title.toLowerCase().includes(rest));
      if (hits.length === 1) return { kind: "open_case", id: hits[0]!.id };
    }
  }

  if (l === "run") return inCase({ kind: "run" });
  if (l === "pause") return inCase({ kind: "pause" });
  if (l === "accept plan") return inCase({ kind: "accept_plan" });
  if (l === "approve") return inCase({ kind: "approve" });

  const verify = /^verify (\S+)$/.exec(l);
  if (verify) {
    if (!ctx.in_case) return say(NEEDS_CASE);
    return ctx.cards.includes(verify[1]!) ? { kind: "verify", card: verify[1]! } : say(`There is no card ${verify[1]}`);
  }
  const playbook = /^run playbook (\S+) on (\S+)$/i.exec(typed.replace(/\s+/g, " "));
  if (playbook) return inCase({ kind: "playbook", id: playbook[1]!, value: playbook[2]! });
  const state = /^state\s+(\S[\s\S]*)$/i.exec(typed);
  if (state) return inCase({ kind: "state", text: state[1]! });
  const answer = /^answer\s+(ask-[0-9]+)\s+(\S[\s\S]*)$/i.exec(typed);
  if (answer) return inCase({ kind: "answer", question: answer[1]!.toLowerCase(), text: answer[2]!.trim() });
  const overrule = /^overrule (\S+)$/.exec(l);
  if (overrule) return inCase({ kind: "overrule", finding: overrule[1]! });
  const replay = /^replay(?: ([0-9]+))?$/.exec(l);
  if (replay) return inCase({ kind: "replay", seq: replay[1] === undefined ? null : Number(replay[1]) });
  if (l === "summarize") return inCase({ kind: "ask", text: "Give a synopsis of this case." });

  return inCase({ kind: "ask", text: typed });
}

export interface PerformEnv { ui: Ui; nav: Nav; store: CaseStore | null }

/** Does what the intent says. `cleared` is whether the bar should empty itself; `say` is a line to show. */
export async function perform(intent: Intent, env: PerformEnv): Promise<{ cleared: boolean; say?: string }> {
  const { ui, nav, store } = env;
  const done = { cleared: true };
  switch (intent.kind) {
    case "say": return { cleared: false, say: intent.text };
    case "open_case": nav.go({ screen: "case", id: intent.id }); return done;
    case "go": nav.go({ screen: intent.to === "home" ? "home" : "pick" }); return done;
    case "lens": nav.openLens(intent.id); return done;
    case "verify": nav.focusCard(intent.card); return { cleared: await ui.act("verify_card", { card: intent.card }) };
    case "replay": nav.openLens("replay", intent.seq === null ? undefined : String(intent.seq)); return done;
    // a refusal is said under the bar that sent it, in the server's words (slice 10)
    case "state": case "answer": {
      let why: string | undefined;
      const r = intent.kind === "state"
        ? await ui.send("add_statement", { statement: intent.text, basis: "unstated" }, undefined, undefined, (w) => { why = w; })
        : await ui.send("answer_question", { question: intent.question, answer: intent.text, basis: "unstated" }, undefined, undefined, (w) => { why = w; });
      return r !== null ? done : { cleared: false, say: `Refused: ${why ?? "nothing was sent"}` };
    }
    // the values are chosen in the finding's form, where the draft they overrule is on screen
    case "overrule": nav.openLens("narrative", `overrule:${intent.finding}`); return { cleared: false, say: `Overrule ${intent.finding} from the Narrative lens` };
    case "ask": nav.ask(intent.text); return done;
    case "playbook": {
      const pb = ui.ref.playbooks.find((x) => x.id === intent.id);
      if (pb === undefined) return { cleared: false, say: `There is no playbook ${intent.id}` };
      if (pb.inputs.length !== 1) return { cleared: false, say: `${pb.title} takes ${pb.inputs.length} values; start it from a card's Pivot panel` };
      const window = store?.live.meta?.window ?? { from: null, to: null };
      const ok = await ui.act("run_playbook", { playbook: pb.id, inputs: [{ type: pb.inputs[0]!.type, value: intent.value }], window, why: `run playbook ${pb.id} on ${intent.value}` });
      if (ok) nav.openLens("jobs");
      return { cleared: ok };
    }
    case "pause": return { cleared: await ui.act("pause") };
    // A gate is passed only by its own button: the bar takes the person to the gate and says so.
    case "approve": nav.openLens("narrative", store?.live.run.waiting === "publish" ? AT_GATE : undefined); return { cleared: false, say: "Approve the draft from the Narrative lens" };
    case "accept_plan": nav.openLens("steps", store?.live.run.waiting === "plan" ? AT_GATE : undefined); return { cleared: false, say: "Accept the plan from the Steps lens" };
    case "run": {
      const status = store?.live.run.status ?? "none";
      if (status === "running") return { cleared: false, say: "The run is already going" };
      if (status === "waiting") return { cleared: false, say: "The run is waiting for you" };
      return { cleared: await ui.act(status === "paused" || status === "interrupted" ? "resume" : "start_run") };
    }
  }
}
