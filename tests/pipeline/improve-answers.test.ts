// Slice 14, Task 3: a person attaches a known answer to a published product of a task case. The text and claims are written with every secret
// value redacted; answeredProducts tells what is answered and nothing of it; knownAnswerOf reads one answer at the entry Select recorded.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { Refused } from "../../src/core/refused";
import type { CaseSession } from "../../src/core/session";
import { fold } from "../../src/core/state";
import type { Actor, Draft, Entry, ExpectedFinding, Marking, Payloads, Product } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import type { EngineDeps } from "../../src/pipeline/engine";
import { AnswerRefused, answeredProducts, answerProblem, knownAnswerOf, setKnownAnswer, withdrawKnownAnswer } from "../../src/pipeline/improve/answers";
import type { KnownAnswerInput } from "../../src/pipeline/improve/answers";
import { EntryBuilder } from "../helpers/entries";

const human: Actor = { kind: "human", id: "analyst" };
const engine: Actor = { kind: "system", id: "engine" };
const assembler: Actor = { kind: "agent", id: "assemble", stage: "assemble", profile: "default", model: "scripted-m", effort: null, where: "machine" };
const SECRET = "Zq7-placeholder-secret-41";
const SCALE = ["remote", "unlikely", "even", "likely", "almost certain"];
const deps = { runner: { secrets: () => [SECRET] } } as unknown as Pick<EngineDeps, "runner">;
const blob = (c: string) => ({ blob: c.repeat(64), bytes: 10 });

const productOf = (marking: Marking, summary: string): Product => ({
  objective: "Decide", question: "Is 192.0.2.10 beaconing?", marking, summary,
  key_findings: [{ id: "f1", statement: "192.0.2.10 connects to 198.51.100.7 every 60 s", likelihood: "likely", confidence: "moderate", confidence_basis: "one source", cites: [], assumptions: [], reasoning: "periodic" }],
  gaps_and_limits: "", alternatives: "", assessment: "Likely beaconing.", sources: [], assumptions: [], change: "",
});
const draftOf = (n: number, product: Product): Draft => ({ n, hash: sha256Hex(canonical(product as never)), author: assembler, product, reason: "first" });
const findings: ExpectedFinding[] = [{ claim: "canary-claim the host beacons to the remote address each minute", likelihood: "likely", confidence: "moderate" }];

let dir: string;
let wb: Workbench;
const sessions: CaseSession[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "improve-answers-"));
  wb = Workbench.open(join(dir, "wb"), { onError: () => {} });
  sessions.length = 0;
});
afterEach(() => {
  for (const s of sessions) if (s.open) expect(s.state.skipped).toEqual([]);
  try { wb.close(); } catch { /* closed */ }
  rmSync(dir, { recursive: true, force: true });
});

/** A case marked `caseMarking` with product 1 (and product 2 when asked) published, each product marked `productMarking`. */
function published(caseMarking: Marking = "TLP:GREEN", productMarking: Marking = "TLP:AMBER", products = 1): { s: CaseSession; drafts: Draft[] } {
  const s = wb.createCase(
    { title: "t", asked: "Is 192.0.2.10 beaconing?", why: "alert", starting: [{ type: "ip", value: "192.0.2.10" }], window: { from: null, to: null }, objective: null, marking: caseMarking },
    human,
  );
  sessions.push(s);
  const drafts: Draft[] = [];
  for (let n = 1; n <= products; n++) {
    const draft = draftOf(n, productOf(productMarking, `Regular connections, draft ${n}.`));
    drafts.push(draft);
    s.commit(() => [
      { type: "draft.revised", actor: assembler, payload: { draft } },
      { type: "product.published", actor: human, payload: { n, draft_hash: draft.hash, head_hash: "b".repeat(64), dir: `products/${n}`, bundle: blob("c") } },
    ]);
  }
  return { s, drafts };
}
const input = (over: Partial<KnownAnswerInput> = {}): KnownAnswerInput => ({
  product: 1, text: "canary-text It was beaconing to a test address.", findings, marking: "TLP:AMBER", actor: human, ...over,
});
const answersOf = (s: CaseSession): Entry[] => s.entries().filter((e) => e.type === "answer.known" || e.type === "answer.withdrawn");

test("setKnownAnswer writes answer.known by the person with the product's draft hash, and the fold reads it back", () => {
  const { s, drafts } = published();
  setKnownAnswer(s, deps, input(), SCALE);
  const [e] = answersOf(s);
  expect(e!.type).toBe("answer.known");
  expect(e!.actor).toEqual(human);
  expect(e!.payload).toEqual({ product: 1, draft_hash: drafts[0]!.hash, text: input().text, findings, marking: "TLP:AMBER" });
  const a = s.state.answers["1"]!;
  expect(a).toMatchObject({ product: 1, draft_hash: drafts[0]!.hash, text: input().text, findings, marking: "TLP:AMBER", by: "analyst", seq: e!.seq, hash: e!.hash });
  // a later one for the product replaces it; with no likelihood scale known, any term is taken
  setKnownAnswer(s, deps, input({ text: "It was a health check.", findings: [{ claim: "a health check", likelihood: "unscaled-term", confidence: "high" }], marking: "TLP:RED" }));
  expect(s.state.answers["1"]!.text).toBe("It was a health check.");
  expect(s.state.answers["1"]!.marking).toBe("TLP:RED");
  expect(fold(s.entries())).toEqual(s.state);
});

test("each refusal is said in its words and writes nothing", () => {
  const { s } = published("TLP:GREEN", "TLP:AMBER");
  const cases: [Partial<KnownAnswerInput>, string][] = [
    [{ actor: assembler }, "only a person sets a known answer"],
    [{ actor: engine }, "only a person sets a known answer"],
    [{ product: 2 }, "there is no published product 2 in this case"],
    [{ text: "" }, "a known answer's text is 1 to 600 characters"],
    [{ text: "   " }, "a known answer's text is 1 to 600 characters"],
    [{ text: "x".repeat(601) }, "a known answer's text is 1 to 600 characters"],
    [{ findings: Array.from({ length: 13 }, () => findings[0]!) }, "a known answer has at most 12 expected findings"],
    [{ findings: [{ ...findings[0]!, claim: "" }] }, "an expected finding's claim is 1 to 300 characters"],
    [{ findings: [{ ...findings[0]!, claim: "y".repeat(301) }] }, "an expected finding's claim is 1 to 300 characters"],
    [{ findings: [{ ...findings[0]!, likelihood: "probable" }] }, "probable is not a likelihood term of this case's standard"],
    [{ marking: "TLP:GREEN" }, "a known answer is marked at least TLP:AMBER, as its case and its product are"],
  ];
  const before = s.entries().length;
  for (const [over, sentence] of cases) {
    let caught: unknown = null;
    try { setKnownAnswer(s, deps, input(over), SCALE); } catch (e) { caught = e; }
    expect(caught, sentence).toBeInstanceOf(AnswerRefused);
    expect(caught).toBeInstanceOf(Refused);
    expect((caught as Error).message).toBe(sentence);
  }
  expect(s.entries().length).toBe(before);
  // the limits themselves are taken
  setKnownAnswer(s, deps, input({ text: "x".repeat(600), findings: Array.from({ length: 12 }, () => ({ ...findings[0]!, claim: "y".repeat(300) })) }), SCALE);
  expect(answersOf(s).length).toBe(1);

  // an improve case holds no known answer
  const imp = wb.createCase({ title: "i", asked: "Improve", why: "w", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:AMBER" }, human);
  sessions.push(imp);
  imp.commit(() => [{ type: "improve.requested", actor: human, payload: { target: "investigation", case_type: "beaconing", tasks: 1, candidates: 1 } }]);
  expect(imp.state.improve.request).not.toBeNull();
  expect(() => setKnownAnswer(imp, deps, input(), SCALE)).toThrow("a probe child and an improve case hold no known answer");
  expect(answersOf(imp)).toEqual([]);

  // a probe child holds none either
  const b = new EntryBuilder("CASE-11");
  b.add("case.created", { id: "CASE-11", title: "p", asked: "q", why: "w", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:AMBER", loop: "investigation" }, { actor: engine });
  b.add("subloop.child", { parent: "CASE-7", run: "run-1", stage: "probe", attempt: 1, loop: "investigation", input_hash: "0b".repeat(32), depth: 1, floor: "TLP:AMBER" }, { actor: engine });
  b.add("probe.child", { improve: "CASE-7", origin: "o".repeat(12), probe: "base/T1", candidate: "base", task: "T1", plan_gate: "accept", max_lookups: 10 }, { actor: engine });
  const child = fold(b.entries);
  expect(child.skipped).toEqual([]);
  expect(child.improve.probe_of).not.toBeNull();
  const { actor: _a, ...plain } = input();
  expect(answerProblem(child, plain, SCALE)).toBe("a probe child and an improve case hold no known answer");
  expect(answerProblem(s.state, plain, SCALE)).toBeNull();
});

test("a secret value in the text or a claim is written redacted", () => {
  const { s } = published();
  setKnownAnswer(s, deps, input({ text: `It used the key ${SECRET} to log in.`, findings: [{ claim: `the token ${SECRET} was reused`, likelihood: "likely", confidence: "high" }] }), SCALE);
  const [e] = answersOf(s);
  const raw = JSON.stringify(e!.payload);
  expect(raw).not.toContain(SECRET);
  expect((e!.payload as Payloads["answer.known"]).text).toBe("It used the key [redacted secret] to log in.");
  expect((e!.payload as Payloads["answer.known"]).findings[0]!.claim).toBe("the token [redacted secret] was reused");
});

test("a secret value typed as a likelihood term is written redacted when no scale is given", () => {
  const { s } = published();
  setKnownAnswer(s, deps, input({ findings: [{ claim: "the host beacons", likelihood: `very ${SECRET}`, confidence: "high" }] }), null);
  const [e] = answersOf(s);
  expect(JSON.stringify(e!.payload)).not.toContain(SECRET);
  expect((e!.payload as Payloads["answer.known"]).findings[0]!.likelihood).toBe("very [redacted secret]");
});

test("withdrawKnownAnswer removes it; with no reason, or for a product with none, it is refused", () => {
  const { s } = published("TLP:GREEN", "TLP:AMBER", 2);
  setKnownAnswer(s, deps, input(), SCALE);
  const before = s.entries().length;
  expect(() => withdrawKnownAnswer(s, deps, { product: 1, reason: "  ", actor: human })).toThrow("withdrawing a known answer needs a reason");
  expect(() => withdrawKnownAnswer(s, deps, { product: 2, reason: "wrong", actor: human })).toThrow("there is no known answer for product 2");
  expect(() => withdrawKnownAnswer(s, deps, { product: 1, reason: "wrong", actor: assembler })).toThrow(AnswerRefused);
  expect(s.entries().length).toBe(before);
  withdrawKnownAnswer(s, deps, { product: 1, reason: "it was a different host", actor: human });
  const last = s.entries().at(-1)!;
  expect(last.type).toBe("answer.withdrawn");
  expect(last.payload).toEqual({ product: 1, reason: "it was a different host" });
  expect(s.state.answers).toEqual({});
  expect(() => withdrawKnownAnswer(s, deps, { product: 1, reason: "again", actor: human })).toThrow("there is no known answer for product 1");
});

test("a secret value in a withdraw reason is written redacted and never reaches the ledger", () => {
  const { s } = published();
  setKnownAnswer(s, deps, input(), SCALE);
  withdrawKnownAnswer(s, deps, { product: 1, reason: `the key ${SECRET} was in it`, actor: human });
  const last = s.entries().at(-1)!;
  expect(last.payload).toEqual({ product: 1, reason: "the key [redacted secret] was in it" });
  expect(JSON.stringify(s.entries())).not.toContain(SECRET);
});

test("answeredProducts lists number, draft hash, marking, seq and hash and nothing of the text", () => {
  const { s: session, drafts } = published("TLP:GREEN", "TLP:AMBER", 2);
  setKnownAnswer(session, deps, input({ product: 2, marking: "TLP:RED" }), SCALE);
  setKnownAnswer(session, deps, input(), SCALE);
  const s = session.state;
  const list = answeredProducts(s);
  expect(list).toEqual([
    { product: 1, draft_hash: drafts[0]!.hash, marking: "TLP:AMBER", seq: s.answers["1"]!.seq, hash: s.answers["1"]!.hash },
    { product: 2, draft_hash: drafts[1]!.hash, marking: "TLP:RED", seq: s.answers["2"]!.seq, hash: s.answers["2"]!.hash },
  ]);
  expect(JSON.stringify(answeredProducts(s))).not.toContain("canary");
  expect(answeredProducts(published().s.state)).toEqual([]);
});

test("knownAnswerOf reads the answer at the seq and hash given, not a later one for the same product", () => {
  const { s } = published();
  setKnownAnswer(s, deps, input(), SCALE);
  const first = answersOf(s)[0]!;
  setKnownAnswer(s, deps, input({ text: "A later answer.", findings: [], marking: "TLP:RED" }), SCALE);
  const second = answersOf(s)[1]!;
  const entries = s.entries();
  expect(knownAnswerOf(entries, { seq: first.seq, hash: first.hash })).toEqual({ text: input().text, findings, marking: "TLP:AMBER", product: 1 });
  expect(knownAnswerOf(entries, { seq: second.seq, hash: second.hash })).toEqual({ text: "A later answer.", findings: [], marking: "TLP:RED", product: 1 });
  // what it returns is a copy: changing it changes no entry
  const got = knownAnswerOf(entries, { seq: first.seq, hash: first.hash })!;
  got.findings.push({ claim: "x", likelihood: "likely", confidence: "low" });
  expect((first.payload as Payloads["answer.known"]).findings).toEqual(findings);
});

test("knownAnswerOf is null for a seq whose entry is not an answer.known, or whose hash differs", () => {
  const { s } = published();
  setKnownAnswer(s, deps, input(), SCALE);
  const known = answersOf(s)[0]!;
  const entries = s.entries();
  expect(knownAnswerOf(entries, { seq: known.seq, hash: "f".repeat(64) })).toBeNull();
  expect(knownAnswerOf(entries, { seq: 1, hash: entries[0]!.hash })).toBeNull();
  expect(knownAnswerOf(entries, { seq: 999, hash: known.hash })).toBeNull();
  // an answer.known the fold skipped (by an agent) is no answer
  s.commit((st) => [{ type: "answer.known", actor: assembler, payload: { product: 1, draft_hash: st.published[0]!.draft_hash, text: "agent's", findings: [], marking: "TLP:AMBER" } }]);
  const skipped = s.entries().at(-1)!;
  expect(knownAnswerOf(s.entries(), { seq: skipped.seq, hash: skipped.hash })).toBeNull();
  expect(s.state.skipped.map((x) => x.reason)).toEqual(["a known answer is a person's"]);
  // the test's own skipped entry is not left for afterEach to see
  s.close();
});

test("an expected finding marked the person's to say is written with asks: true and read back with it; unmarked, the key is absent; asks other than a boolean is refused", () => {
  const { s } = published();
  const mixed = [
    { claim: "the device belongs to the owner", likelihood: "likely", confidence: "high", asks: true },
    { claim: "the host beacons", likelihood: "likely", confidence: "moderate", asks: false },
    { claim: "the printer is on the guest network", likelihood: "likely", confidence: "moderate" },
  ] as unknown as ExpectedFinding[];
  setKnownAnswer(s, deps, input({ findings: mixed }), SCALE);
  const e = answersOf(s)[0]!;
  const written = (e.payload as Payloads["answer.known"]).findings;
  expect(written[0]).toEqual({ claim: "the device belongs to the owner", likelihood: "likely", confidence: "high", asks: true });
  expect(written[1]).toEqual({ claim: "the host beacons", likelihood: "likely", confidence: "moderate" });
  expect(Object.hasOwn(written[2]!, "asks")).toBe(false);
  expect(s.state.answers["1"]!.findings).toEqual(written);
  expect(knownAnswerOf(s.entries(), { seq: e.seq, hash: e.hash })!.findings).toEqual(written);
  const n = s.entries().length;
  expect(() => setKnownAnswer(s, deps, input({ findings: [{ ...findings[0]!, asks: "yes" }] as unknown as ExpectedFinding[] }), SCALE)).toThrow("an expected finding's asks is true or false");
  expect(s.entries().length).toBe(n);
});
