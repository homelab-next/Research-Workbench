// `synth answer`: a published synthetic task case's known answer, set from its ground truth as the person. A --scripted setup built once with
// TINY_PARAMS under a fresh temporary folder; the task case is carried to a published product by entries (the test needs a published product,
// not a real run). Synthetic only.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TINY_PARAMS } from "pivot/synth/params";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import type { Actor, Draft, Entry, Marking, Product } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { synthAnswer } from "../../src/synth/answer";
import { buildSetup } from "../../src/synth/build";
import type { Built } from "../../src/synth/build";
import { setupOf, storyLabels } from "../../src/synth/setup";
import type { SynthContext } from "../../src/synth/setup";
import { readIndex, synthTasks, truthPath } from "../../src/synth/tasks";
import type { TruthFile } from "../../src/synth/tasks";

let tmp: string;
let built: Built;
let config: Config;
let out: string[];
let err: string[];

const assembler: Actor = { kind: "agent", id: "assemble", stage: "assemble", profile: "default", model: "scripted-m", effort: null, where: "machine" };
const ctx = (): SynthContext => {
  const { dir, setup } = setupOf(config);
  return { config, dir, setup, human: { kind: "human", id: config.user }, io: { log: (l) => out.push(l), error: (l) => err.push(l) } };
};
const human = (): Actor => ({ kind: "human", id: config.user });
const open = (): Workbench => Workbench.open(config.data_dir, { store: config.cases.store, memory: config.memory.store });

const productOf = (marking: Marking, summary: string): Product => ({
  objective: "Decide", question: "What happened?", marking, summary,
  key_findings: [{ id: "f1", statement: "The lookup ran.", likelihood: "roughly even chance", confidence: "low", confidence_basis: "one source", cites: [], assumptions: [], reasoning: "seeded" }],
  gaps_and_limits: "", alternatives: "", assessment: "No judgment.", sources: [], assumptions: [], change: "",
});

/** Publishes `products` products of the case, each marked `marking`, by entries. */
function publish(id: string, marking: Marking = "TLP:AMBER", products = 1): void {
  const wb = open();
  try {
    const s = wb.session(id);
    const from = s.state.published.length;
    for (let n = from + 1; n <= from + products; n++) {
      const product = productOf(marking, `Draft ${n}.`);
      const draft: Draft = { n, hash: sha256Hex(canonical(product as never)), author: assembler, product, reason: "first" };
      s.commit(() => [
        { type: "draft.revised", actor: assembler, payload: { draft } },
        { type: "product.published", actor: human(), payload: { n, draft_hash: draft.hash, head_hash: "b".repeat(64), dir: `products/${n}`, bundle: { blob: "c".repeat(64), bytes: 10 } } },
      ]);
    }
  } finally {
    wb.close();
  }
}

/** The case's entries and its fold's skipped list, read in a workbench closed again. */
function read(id: string): { entries: Entry[]; skipped: unknown[]; answers: Record<string, { product: number; seq: number; text: string }> } {
  const wb = open();
  try {
    const s = wb.session(id);
    return { entries: s.entries(), skipped: s.state.skipped, answers: s.state.answers as never };
  } finally {
    wb.close();
  }
}

const truthOf = (id: string): TruthFile => JSON.parse(readFileSync(truthPath(config, id), "utf8")) as TruthFile;

let first: string;
let second: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "synth-answer-"));
  mkdirSync(join(tmp, "home"));
  built = buildSetup(join(tmp, "setup"), { params: TINY_PARAMS, model: "scripted" }, null);
  config = loadConfig({ path: built.config, env: {}, home: join(tmp, "home") });
});
afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });
beforeEach(async () => {
  rmSync(join(built.dir, "data"), { recursive: true, force: true });
  mkdirSync(join(built.dir, "data"));
  out = [];
  err = [];
  const ids = built.setup.storylines.map((s) => s.id).sort();
  expect(await synthTasks(ctx(), { only: ids.slice(0, 2).map((id) => storyLabels(built.setup).get(id)!), marking: "TLP:GREEN" })).toBe(0);
  const index = readIndex(config).cases;
  first = index.find((c) => c.storyline === ids[0])!.case;
  second = index.find((c) => c.storyline === ids[1])!.case;
  out = [];
  err = [];
});

test("answer on a published task case writes answer.known by the person: the truth's summary, its findings, the floor marking", async () => {
  publish(first, "TLP:AMBER");
  expect(await synthAnswer(ctx(), { case: first, product: null })).toBe(0);
  expect(err).toEqual([]);
  const t = truthOf(first);
  const r = read(first);
  const known = r.entries.filter((e) => e.type === "answer.known");
  expect(known.length).toBe(1);
  expect(known[0]!.actor).toEqual(human());
  const p = known[0]!.payload as { product: number; text: string; findings: unknown; marking: Marking };
  expect(p.product).toBe(1);
  expect(p.text).toBe(t.summary);
  expect(p.findings).toEqual(t.findings);
  // the floor: the strictest of the case's (TLP:GREEN) and the product's (TLP:AMBER)
  expect(p.marking).toBe("TLP:AMBER");
  expect(r.skipped).toEqual([]);
  expect(out).toEqual([`known answer set for product 1 of ${first} from ${storyLabels(built.setup).get(t.storyline)} (TLP:AMBER)`]);
});

test("answer before the case is published is refused with the sentence and writes nothing", async () => {
  const before = read(first).entries.length;
  expect(await synthAnswer(ctx(), { case: first, product: null })).toBe(1);
  expect(err).toEqual([`${first} has published no product; publish it first`]);
  expect(read(first).entries.length).toBe(before);
});

test("answer on a case that has no truth, and on a case whose truth names another origin, is refused", async () => {
  // a case made by hand, with no truth beside it
  const wb = open();
  let bare: string;
  try {
    bare = wb.createCase({ title: "t", asked: "q", why: "w", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN" }, human()).id;
  } finally {
    wb.close();
  }
  publish(bare);
  expect(await synthAnswer(ctx(), { case: bare, product: null })).toBe(1);
  expect(err).toEqual([`there is no ground truth beside ${bare}`]);
  // the truth of the first case, its origin changed: written for another case
  publish(first);
  const file = truthPath(config, first);
  const t = truthOf(first);
  writeFileSync(file, JSON.stringify({ ...t, origin: "f".repeat(64) }));
  err = [];
  expect(await synthAnswer(ctx(), { case: first, product: null })).toBe(1);
  expect(err).toEqual([`the ground truth beside ${first} was written for another case`]);
  // the second case's truth copied beside the first: its case is not this one
  writeFileSync(file, readFileSync(truthPath(config, second)));
  err = [];
  expect(await synthAnswer(ctx(), { case: first, product: null })).toBe(1);
  expect(err).toEqual([`the ground truth beside ${first} was written for another case`]);
  expect(read(first).entries.some((e) => e.type === "answer.known")).toBe(false);
  expect(read(bare).entries.some((e) => e.type === "answer.known")).toBe(false);
});

test("--product names the product; a product the case did not publish is refused in setKnownAnswer's words", async () => {
  publish(first, "TLP:GREEN", 2);
  expect(await synthAnswer(ctx(), { case: first, product: 1 })).toBe(0);
  expect(Object.keys(read(first).answers)).toEqual(["1"]);
  expect(out.at(-1)).toContain("known answer set for product 1 of");
  expect(out.at(-1)).toEndWith("(TLP:GREEN)");
  expect(await synthAnswer(ctx(), { case: first, product: 7 })).toBe(1);
  expect(err).toEqual(["there is no published product 7 in this case"]);
  // with no --product, the latest published product
  expect(await synthAnswer(ctx(), { case: first, product: null })).toBe(0);
  expect(Object.keys(read(first).answers).sort()).toEqual(["1", "2"]);
});

test("an answer set twice replaces the first, as improve answer does", async () => {
  publish(first);
  expect(await synthAnswer(ctx(), { case: first, product: null })).toBe(0);
  expect(await synthAnswer(ctx(), { case: first, product: null })).toBe(0);
  const r = read(first);
  const known = r.entries.filter((e) => e.type === "answer.known");
  expect(known.length).toBe(2);
  expect(Object.keys(r.answers)).toEqual(["1"]);
  expect(r.answers["1"]!.seq).toBe(known[1]!.seq);
  expect(r.skipped).toEqual([]);
});
