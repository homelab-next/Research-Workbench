// Final review I3: the send-back's reason, given to Assemble as "Why the work came back to you", is the current run's, stands until an Assemble
// pass writes a draft, and is as strict as the model text it copies.
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Actor, EntryInput, Marking, Product } from "../../src/core/types";
import { draftOf } from "../../src/agents/draft";
import { loadPipeline } from "../../src/pipeline/manifests";
import type { Pipeline } from "../../src/pipeline/manifests";
import { reviewPointsPart } from "../../src/pipeline/review-points";
import { fixture, person } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

const ENGINE: Actor = { kind: "system", id: "engine" };
const agentOf = (id: string, stage: string): Actor => ({ kind: "agent", id, stage, profile: "investigation", model: "m", effort: null, where: "machine" });
const analyst = agentOf("analyst", "assemble");
const evaluator = agentOf("evaluator", "evaluate");
const adversary = agentOf("adversary", "challenge");
const SECRET = "f1 overstates it: the RED card shows SECRET-DETAIL";

const product = (summary: string): Product => ({
  objective: "o", question: "q", marking: "TLP:GREEN", summary,
  key_findings: [{ id: "f1", statement: "We assess it is likely that it is idle.", likelihood: "likely", confidence: "moderate", confidence_basis: "b", cites: [], assumptions: [], reasoning: "r" }],
  gaps_and_limits: "g", alternatives: "a", assessment: "s", sources: [], assumptions: [], change: "c",
});

let f: Fixture;
let pipeline: Pipeline;
beforeEach(() => {
  f = fixture(false);
  const loaded = loadPipeline(f.sample.registry);
  if (loaded.pipeline === null) throw new Error(loaded.problems.join("; "));
  pipeline = loaded.pipeline;
});
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});

const commit = (make: (run: string | null) => EntryInput[]): void => { f.s.commit((s) => make(s.run.id)); };
function startRun(): void {
  f.s.commit((_s, ids) => [{
    type: "run.started", actor: person,
    payload: { run: ids.next("run"), pipeline: pipeline.id, pipeline_hash: pipeline.hash, stages: pipeline.stages.map(({ id, title, phase, runs, gate, reviews, model }) => ({ id, title, phase, runs, gate, reviews, model })) },
  }]);
}
const started = (stage: string, attempt = 1): void => commit((run) => [{ type: "stage.started", actor: ENGINE, run, stage, payload: { stage, attempt } }]);
const finished = (stage: string, outcome: "pass" | "fail", reason: string | null = null): void =>
  commit((run) => [{ type: "stage.finished", actor: ENGINE, run, stage, payload: { stage, attempt: 1, outcome, draft_hash: null, output: null, reason } }]);
function request(actor: Actor, stage: string, marking: Marking): void {
  f.s.commit((s, ids) => [{
    type: "model.request", actor, run: s.run.id, stage,
    payload: { request: ids.next("request"), provider: "scripted", model: "m", effort: null, where: "machine", marking, pack: [], left_out: [], messages: f.s.blobs.put("{}"), tools: [] },
  }]);
}
function draft(author: Actor, summary: string): string {
  const d = draftOf(product(summary), f.s.state.drafts.length + 1, author, "r");
  commit((run) => [{ type: "draft.revised", actor: author, run, ...(author.kind === "agent" ? { stage: "assemble" } : {}), payload: { draft: d } }]);
  return d.hash;
}
const sentBack = (from: string, reason: string): void => commit((run) => [{ type: "stage.sent_back", actor: ENGINE, run, stage: "assemble", payload: { from, to: "assemble", reason, count: 1 } }]);
const part = () => reviewPointsPart(f.s, pipeline, "assemble");

/** Draft 1 by the analyst on the GREEN case, then Evaluate, its model sent TLP:RED, fails it with the secret and sends the work back. */
function evaluatedRed(): void {
  startRun();
  started("assemble");
  request(analyst, "assemble", "TLP:GREEN");
  const h = draft(analyst, "first");
  finished("assemble", "pass");
  started("evaluate");
  request(evaluator, "evaluate", "TLP:RED");
  commit((run) => [{ type: "evaluation.made", actor: evaluator, run, stage: "evaluate", payload: { draft_hash: h, pass: false, findings: [{ check: "support", where: "f1", message: SECRET }] } }]);
  finished("evaluate", "fail", SECRET);
  sentBack("evaluate", SECRET);
  started("assemble", 2);
}

test("a send-back of a run that is over is not given to the next run's Assemble (final review I3)", () => {
  evaluatedRed();
  expect(part()).toMatchObject({ marking: "TLP:RED" });
  expect(part()!.text).toContain(`Why the work came back to you (from Evaluate): ${SECRET}`);
  draft(person, "the person's edit");
  expect(part()).toMatchObject({ marking: "TLP:RED" });
  commit((run) => [{ type: "run.finished", actor: person, run, payload: { outcome: "stopped", reason: "enough" } }]);
  startRun();
  const p = part();
  // the reason was the earlier run's: it is not why this pass exists, and its RED text does not reach a GREEN part
  expect(p?.text ?? "").not.toContain("Why the work came back to you");
  expect(p?.text ?? "").not.toContain("SECRET-DETAIL");
});

test("the reason carries the marking of the requests of the pass that wrote it, though the point itself is no longer listed (final review I3)", () => {
  startRun();
  started("assemble");
  request(analyst, "assemble", "TLP:GREEN");
  const h = draft(analyst, "first");
  finished("assemble", "pass");
  started("challenge");
  request(adversary, "challenge", "TLP:RED");
  f.s.commit((s, ids) => [{ type: "challenge.raised", actor: adversary, run: s.run.id, stage: "challenge", payload: { challenge: { id: ids.next("challenge"), draft_hash: h, severity: "consider", text: SECRET, cites: [] } } }]);
  finished("challenge", "fail", SECRET);
  sentBack("challenge", SECRET);
  started("assemble", 2);
  // a person's edit: the advisory challenge on draft 1 is no longer listed, but the send-back still says why the pass exists
  draft(person, "the person's edit");
  const p = part()!;
  expect(p.text).toContain(`Why the work came back to you (from Challenge): ${SECRET}`);
  expect(p.text).not.toContain("x1 (consider");
  expect(p.marking).toBe("TLP:RED");
});

test("an Assemble pass that fails (more research) does not answer the send-back: the pass after Research still reads why (final review I3)", () => {
  evaluatedRed();
  request(analyst, "assemble", "TLP:RED");
  finished("assemble", "fail", "more research is needed: where is it");
  started("research");
  finished("research", "pass");
  started("assemble", 3);
  const p = part()!;
  expect(p.text).toContain(`Why the work came back to you (from Evaluate): ${SECRET}`);
  expect(p.marking).toBe("TLP:RED");
  // a pass that wrote a draft answers it
  request(analyst, "assemble", "TLP:RED");
  draft(analyst, "second");
  finished("assemble", "pass");
  started("evaluate", 2);
  expect(part()?.text ?? "").not.toContain("Why the work came back to you");
});
