import { afterEach, beforeEach, expect, test } from "bun:test";
import type { Json } from "../../src/core/canonical";
import { liveNotes } from "../../src/core/state";
import { BUILDER_TOOL_NAMES, STAGE_TOOL_NAMES, TOOL_NAMES, TOOLS } from "../../src/agents/tools";
import { DEFAULT_MAX_NOTES, dropMemory } from "../../src/pipeline/notes";
import { fixture, person } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
beforeEach(() => { f = fixture(false); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});
const view = (r: { view: Json }): Record<string, Json> => r.view as Record<string, Json>;
const note = (text: string, extra: Record<string, Json> = {}) => f.call("note_memory", { kind: "fact", text, why: "later stages need it", ...extra });

test("note_memory writes memory.noted as the agent and answers with the id", async () => {
  f.ctx.link = { run: "run-1", stage: "research", job: "job-2" };
  const r = await note("AP-3 serves the lobby");
  expect(r).toMatchObject({ ok: true, view: { noted: "m1", notes: 1 }, marking: null });
  const e = f.s.entries().at(-1)!;
  expect(e).toMatchObject({ type: "memory.noted", run: "run-1", stage: "research", job: "job-2", actor: { kind: "agent", id: "researcher-g1" }, payload: { item: "m1", kind: "fact", text: "AP-3 serves the lobby", cards: [] } });
  expect(view(await note("another"))).toMatchObject({ noted: "m2", notes: 2 });
});

test("the forty-first note is refused with the reason, and after a person drops one the next is taken", async () => {
  f.ctx.max_notes = 3;
  for (const t of ["a", "b", "c"]) expect((await note(t)).ok).toBe(true);
  const r = await note("d");
  expect(r.ok).toBe(false);
  expect(r.summary).toBe("the notebook holds 3 notes, the most it may; a person may drop one");
  dropMemory(f.s, { item: "m2", reason: "stale", actor: person });
  expect(view(await note("d"))).toMatchObject({ noted: "m4", notes: 3 });
  // the default
  expect(DEFAULT_MAX_NOTES).toBe(40);
  delete f.ctx.max_notes;
  for (let i = 0; i < 40 - 3; i++) expect((await note(`n${i}`)).ok).toBe(true);
  expect(liveNotes(f.s.state).length).toBe(40);
  expect((await note("one too many")).summary).toBe("the notebook holds 40 notes, the most it may; a person may drop one");
});

test("a refusal is the tool's error result, scrubbed, and nothing is written", async () => {
  const before = f.s.entries().length;
  const r = await note("x", { cards: ["c-not-there"] });
  expect(r).toMatchObject({ ok: false, summary: "unknown card: c-not-there", view: { error: "unknown card: c-not-there" } });
  const blank = await note("   ");
  expect(blank.summary).toBe("a note needs text");
  const long = await note("x".repeat(601));
  expect(long).toMatchObject({ ok: false });
  expect(long.summary).toContain("invalid arguments");
  expect(f.s.entries().length).toBe(before);
});

test("a stage manifest may list note_memory; a stage that does not list it may not call it: this stage may not use note_memory", async () => {
  const ok = await f.call("note_memory", { kind: "pointer", text: "t", why: "w" }, ["note_memory"]);
  expect(ok.ok).toBe(true);
  const refused = await f.call("note_memory", { kind: "pointer", text: "t2", why: "w" }, ["list_cards"]);
  expect(refused).toMatchObject({ ok: false, summary: "this stage may not use note_memory" });
  expect(TOOLS.note_memory.description).toBe("Write a short note into this case's notebook for the stages and runs that come after you: a fact learned, a decision made, or a pointer to a card. A note is not evidence; cite cards, not notes.");
});

test("STAGE_TOOL_NAMES has seventeen names and note_memory is the last", () => {
  expect(STAGE_TOOL_NAMES.length).toBe(17);
  expect(STAGE_TOOL_NAMES.at(-1)).toBe("note_memory");
  expect([...TOOL_NAMES]).toEqual([...STAGE_TOOL_NAMES, ...BUILDER_TOOL_NAMES]);
});
