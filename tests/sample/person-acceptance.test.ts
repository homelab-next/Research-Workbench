import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fold } from "../../src/core/state";
import type { CaseState } from "../../src/core/state";
import { verifyCase } from "../../src/core/verify";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

type Turn = { actor: string; reply: Record<string, unknown> };

let s: Served | null = null;
afterEach(async () => { await s?.close(); s = null; });

const QUESTION = "Is 192.0.2.17 the meeting-room display?";
const ASK = { tool: "ask_person", args: { why: "It would explain the connections.", question: QUESTION, blocking: true } };

/** The sample's script, changed by `edit`, written back into the root (JSON is YAML). */
function rewriteScript(root: string, edit: (turns: Turn[]) => void): void {
  const f = join(root, "scripts", "sample-run.yaml");
  const body = Bun.YAML.parse(readFileSync(f, "utf8")) as { turns: Turn[] };
  edit(body.turns);
  writeFileSync(f, JSON.stringify(body, null, 1));
}

/** researcher-g1's first reply also asks the person, blocking. */
function asksFirst(turns: Turn[]): void {
  const first = turns.find((t) => t.actor === "researcher-g1")!;
  (first.reply.tool_calls as unknown[]).push(ASK);
}

const state = (id: string): CaseState => s!.app.hub.read(id).state;
const types = (id: string): string[] => s!.entries(id).map((e) => e.type);

const STATEMENT = "The display on the third floor was replaced on 2026-11-16.";
const PEERS = "{{card:Hosts that connected to the address: 198.51.100.77}}";
const ASSET = "{{card:Asset with the address, by asset list: 192.0.2.17}}";
const ACCOUNTS = "{{card:Accounts that signed in to the asset: ws-17.example.net}}";
const NOT_INTERNAL = "{{card:Asset with the address, by asset list: 198.51.100.77}}";
const ANSWER = `{{card:Answer to ask-1: ${QUESTION}}}`;
const SAID = `{{card:Statement: ${STATEMENT}}}`;

/** Both findings as the analyst proposes them for a later draft: f1 at `likelihood`, resting on the person's answer and statement. */
function findings(why: string, likelihood: string, basis: string): Record<string, unknown> {
  return { tool_calls: [
    { tool: "propose_assessment", args: {
      why, replaces: "f1", claim: "the account j.doe is behind the regular connections from ws-17.example.net to 198.51.100.77", likelihood, confidence: "moderate",
      confidence_basis: basis, cites: [PEERS, ASSET, ACCOUNTS, ANSWER, SAID], assumptions: ["The asset list is current."],
      reasoning: "ws-17.example.net connects every ten minutes, and j.doe signed in there shortly before it began.",
    } },
    { tool: "propose_assessment", args: {
      why: "Keep the second finding.", replaces: "f2", claim: "198.51.100.77 is not an internal host", likelihood: "almost certain", confidence: "high",
      confidence_basis: "The asset list is complete for internal hosts and had no row for the address.", cites: [NOT_INTERNAL], assumptions: [],
      reasoning: "An address absent from a complete asset list is not internal.",
    } },
  ] };
}
const done = (note: string): Record<string, unknown> => ({
  content: JSON.stringify({ done: true, change_kind: "first judgment", change_detail: "on this question", assumptions: ["The asset list is current."], note }),
});
const LIST = { tool_calls: [{ tool: "list_cards", args: { why: "See what was collected." } }] };
const PASS = { content: JSON.stringify({ pass: true, findings: [] }) };
const NOTHING = { content: JSON.stringify({ done: true, summary: "Nothing new to raise on this revision." }) };
const TITLE = { content: JSON.stringify({ title: "Regular connections to 198.51.100.77", note: "Sample run." }) };
const PERSON_BASIS = "The sign-in and asset records agree; that 192.0.2.17 is the display rests on the person's word.";

/**
 * The whole case's script: the sample's, with researcher-g1 asking the person; draft 2 citing the answer and the statement; Evaluate failing f1's
 * likelihood, the analyst lowering it, and Challenge asking for it back (a conflict for the person); then one draft for each of the ruling, the
 * revised ruling and the overrule, each reviewed again and titled.
 */
function wholeCase(turns: Turn[]): void {
  asksFirst(turns);
  const of = (actor: string): Turn[] => turns.filter((t) => t.actor === actor);
  // draft 2 (the analyst's fifth turn) cites what the person said
  of("analyst")[4]!.reply = findings("Check 3 failed: one sentence held a confidence and a likelihood.", "very likely", PERSON_BASIS);
  // Evaluate fails f1 on draft 2
  of("evaluator")[3]!.reply = { content: JSON.stringify({ pass: false, findings: [{ check: "likelihood", where: "f1", message: "f1 overstates the likelihood: the flow records were cut off, so very likely is too strong" }] }) };
  // Challenge, on the draft made for Evaluate, asks for f1's likelihood back
  of("adversary")[1]!.reply = { tool_calls: [{ tool: "raise_challenge", args: {
    why: "The analyst lowered f1 for Evaluate.", severity: "must_address", text: "f1 understates the likelihood: the sign-ins and the asset list agree, so restore very likely", cites: [ACCOUNTS],
  } }] };
  of("adversary")[2]!.reply = { content: JSON.stringify({ done: true, summary: "f1 must be answered." }) };
  const more: Turn[] = [];
  const analyst = (why: string, likelihood: string, basis: string, note: string): void => {
    more.push({ actor: "analyst", reply: LIST }, { actor: "analyst", reply: findings(why, likelihood, basis) }, { actor: "analyst", reply: done(note) });
  };
  // draft 3: f1 lowered for Evaluate
  analyst("Evaluate: the flow records were cut off.", "likely", PERSON_BASIS, "Third draft.");
  // draft 4: the person ruled for Evaluate, and the analyst answers Challenge's point with the ruling
  analyst("The person ruled for Evaluate.", "likely", PERSON_BASIS, "Fourth draft.");
  (more.at(-2)!.reply.tool_calls as unknown[]).push({ tool: "answer_challenge", args: { why: "The person ruled on it.", challenge: "x1", answer: "The person ruled for Evaluate: f1 stays likely.", action: "rebutted" } });
  // the same product as draft 3, which Evaluate passed: only Challenge reviews it again, with the sample's own last adversary turn
  // draft 5: the person revised the ruling, for Challenge
  analyst("The person revised the ruling, for Challenge.", "very likely", PERSON_BASIS, "Fifth draft.");
  more.push({ actor: "evaluator", reply: PASS }, { actor: "adversary", reply: NOTHING });
  // draft 6: the person overruled f1; the analyst writes very likely again, and code holds the draft to the overrule
  analyst("The person overruled f1.", "very likely", "The person says the sign-ins are theirs to vouch for; the finding rests on the person's word.", "Sixth draft.");
  more.push({ actor: "evaluator", reply: PASS }, { actor: "adversary", reply: NOTHING }, { actor: "publisher", reply: TITLE });
  turns.push(...more);
}

test("a whole case with the person: a statement, a question and its answer, a ruling revised, a finding overruled, published on the person's word, and replayed", async () => {
  s = await served({ before: (root) => rewriteScript(root, wholeCase) });
  const id = await s.newCase();
  const session = s.app.hub.read(id);
  const live = new Map<number, CaseState>();
  session.subscribe((e, st) => { live.set(e.seq, st as CaseState); });
  const person = { kind: "human", id: s.config.user } as const;

  // the person adds what they know before the run
  expect((await s.command(id, "add_statement", { statement: STATEMENT, basis: "saw", about: [{ type: "address", value: "192.0.2.17" }] })).status).toBe(200);
  const said = Object.values(state(id).cards).find((c) => c.person !== undefined)!;
  expect(said.person).toMatchObject({ basis: "saw", answers: null });

  // the planner proposes, the person accepts; Research asks, and the run is held after Research's pass
  await s.toPublishGate(id);
  let st = state(id);
  expect(st.questions["ask-1"]).toMatchObject({ text: QUESTION, blocking: true, stage: "research", answer: null });
  expect(st.run.status).toBe("paused");
  expect(st.run.hold).toEqual({ kind: "question", stage: "research" });
  expect(st.run.pause_reason).toStartWith("waiting for the person's answer to ask-1");
  expect(st.run.stages.find((x) => x.id === "research")!.status).toBe("passed");
  expect(types(id)).not.toContain("draft.revised");

  // the person answers; the run goes on by itself, and Evaluate and Challenge disagree on f1
  const answered = await s.command(id, "answer_question", { question: "ask-1", answer: "Yes. I mounted it in March.", basis: "did" });
  expect(answered.status).toBe(200);
  await s.app.hub.idle();
  st = state(id);
  const answer = st.questions["ask-1"]!.answer!;
  expect(st.cards[answer.card]!.person).toMatchObject({ basis: "did", answers: "ask-1" });
  // nobody pressed resume: the answer let the run go on
  expect(s.entries(id).filter((e) => e.seq > answer.seq && e.type === "run.resumed").map((e) => e.actor)).toEqual([person]);
  expect(st.conflicts.k1).toMatchObject({ finding: "f1", change: "likelihood", raised_by: "challenge", changed_for: "evaluate", ruling: null });
  expect(st.run.status).toBe("paused");

  // the person rules for Evaluate; the run reaches the publish gate on a draft that holds it
  expect((await s.command(id, "rule_conflict", { conflict: "k1", follow: "evaluate", note: "the flow records were cut off" })).status).toBe(200);
  await s.app.hub.idle();
  st = state(id);
  expect(st.run.waiting).toBe("publish");
  expect(st.drafts.at(-1)!.product.key_findings.find((f) => f.id === "f1")!.likelihood).toBe("likely");

  // at the gate the person revises the ruling, for Challenge, and sends the draft back with it (slice 10: nothing goes back by itself); the gate is
  // reached again holding the new ruling
  const ruledOn = st.drafts.at(-1)!.hash;
  expect((await s.command(id, "rule_conflict", { conflict: "k1", follow: "challenge", note: "the sign-ins settle it" })).status).toBe(200);
  await s.app.hub.idle();
  expect(state(id).drafts.at(-1)!.hash).toBe(ruledOn);
  expect((await s.command(id, "send_back_changes", { draft_hash: ruledOn })).status).toBe(200);
  await s.app.hub.idle();
  st = state(id);
  expect(st.conflicts.k1!.earlier_rulings).toHaveLength(1);
  expect(st.run.waiting).toBe("publish");
  expect(st.drafts.at(-1)!.product.key_findings.find((f) => f.id === "f1")!.likelihood).toBe("very likely");

  // the person overrules f1: the next draft holds the overrule though the analyst wrote very likely, and is reviewed again
  const drafts = st.drafts.length;
  expect((await s.command(id, "overrule_finding", {
    finding: "f1", draft_hash: st.drafts.at(-1)!.hash, likelihood: "almost certain", confidence: null, stays: null, note: "I set up ws-17 for j.doe myself.",
  })).status).toBe(200);
  await s.app.hub.idle();
  expect(state(id).drafts.length).toBe(drafts);
  expect((await s.command(id, "send_back_changes", { draft_hash: st.drafts.at(-1)!.hash })).status).toBe(200);
  await s.app.hub.idle();
  st = state(id);
  expect(st.overrules.f1).toMatchObject({ likelihood: "almost certain", by: s.config.user });
  expect(st.drafts.length).toBe(drafts + 1);
  const last = st.drafts.at(-1)!;
  expect(last.product.key_findings.find((f) => f.id === "f1")!.likelihood).toBe("almost certain");
  expect(st.run.waiting).toBe("publish");
  expect(st.reviews[last.hash]!.passed_stages).toEqual(expect.arrayContaining(["evaluate", "challenge"]));

  // a statement added at the gate is the person's, and not something the draft rests on
  expect((await s.command(id, "add_statement", { statement: "The display is due to be moved again next month.", basis: "told" })).status).toBe(200);
  expect((await s.command(id, "approve")).status).toBe(200);
  await s.app.hub.idle();
  st = state(id);
  expect(st.published).toHaveLength(1);
  expect(types(id).filter((t) => t === "product.published")).toHaveLength(1);

  // the product says which findings rest on the person's word, and how the person knows
  const out = join(session.dir, st.published[0]!.dir);
  const md = readFileSync(join(out, "product.md"), "utf8");
  expect(md).toContain(`Rests on the person's statements: [${answer.card}] (did it myself), [${said.id}] (saw it myself). Statements, not data from a source.`);
  const sources = last.product.sources.find((x) => x.source === "the person")!;
  expect(sources.quality).toContain(`${said.id} (saw it myself; cited by f1)`);
  expect(sources.quality).toContain(`${answer.card} (did it myself; cited by f1)`);
  const late = Object.values(st.cards).find((c) => c.person !== undefined && c.id !== said.id && c.id !== answer.card)!;
  expect(md).not.toContain(`[${late.id}]`);

  // only the person's entries carry the person's authority; no agent passed a gate
  const entries = s.entries(id);
  for (const t of ["finding.overruled", "question.answered", "review.ruled", "gate.passed", "product.published"]) {
    for (const e of entries.filter((x) => x.type === t)) expect(e.actor).toEqual(person);
  }
  expect(entries.find((e) => e.type === "question.asked")!.actor).toMatchObject({ kind: "agent" });

  // the case replays exactly, and verifies
  expect(st.skipped).toEqual([]);
  expect(fold(entries)).toEqual(st);
  const answeredAt = entries.find((e) => e.type === "question.answered")!.seq;
  const overruledAt = entries.find((e) => e.type === "finding.overruled")!.seq;
  const revisedAt = entries.filter((e) => e.type === "review.ruled")[1]!.seq;
  for (const n of [answeredAt, revisedAt, overruledAt]) expect(fold(entries, n)).toEqual(live.get(n)!);
  for (const [n, at] of live) expect(session.stateAt(n)).toEqual(at);
  const rep = verifyCase(session.dir);
  expect(rep.ok).toBe(true);
  expect(rep.blobs.bad).toEqual([]);
});

test("resumed without an answer, the run reaches the gate and the draft's gaps name the question", async () => {
  s = await served({ before: (root) => rewriteScript(root, asksFirst) });
  const id = await s.newCase();
  await s.toPublishGate(id);
  expect(state(id).run.status).toBe("paused");
  expect(state(id).run.hold).toEqual({ kind: "question", stage: "research" });
  expect((await s.command(id, "resume")).status).toBe(200);
  await s.app.hub.idle();
  const st = state(id);
  expect(st.run.waiting).toBe("publish");
  expect(st.questions["ask-1"]!.waived).toMatchObject({ by: s.config.user });
  expect(st.drafts.at(-1)!.product.gaps_and_limits).toContain(`Questions the person has not answered:\n- ask-1: ${QUESTION}`);
  expect(st.skipped).toEqual([]);
});

test("the unchanged sample script asks nothing and publishes as before", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  expect(state(id).run.waiting).toBe("publish");
  expect((await s.command(id, "approve")).status).toBe(200);
  await s.app.hub.idle();
  const st = state(id);
  expect(st.questions).toEqual({});
  expect(st.overrules).toEqual({});
  expect(st.published.length).toBe(1);
  expect(types(id)).not.toContain("question.asked");
  expect(st.skipped).toEqual([]);
});
