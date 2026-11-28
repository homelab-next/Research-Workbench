// Slice 13, Task 11: a case's notebook and its type, as the person's commands. A note is written in the person's name; the case's type is set by
// the person, and during a run the same commit binds memory again, so the stage that starts next reads the lessons of that type.
import { afterEach, expect, test } from "bun:test";
import type { Actor, Entry } from "../../src/core/types";
import { COMMANDS } from "../../src/server/commands";
import "../../src/server/app";
import { CASE_TYPE_WHY } from "../../src/pipeline/memory";
import { served, withMemoryLoop } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served | undefined;
afterEach(async () => {
  if (s !== undefined) for (const c of s.wb.listCases()) expect(s.app.hub.read(c.id).state.skipped).toEqual([]);
  await s?.close();
  s = undefined;
});
const person = (x: Served): Actor => ({ kind: "human", id: x.config.user });

test("note_memory, revise_memory and drop_memory write the person's entries; a refusal is 409 with its reason", async () => {
  for (const name of ["note_memory", "revise_memory", "drop_memory", "set_case_type"]) expect(COMMANDS[name]!.then).toBe("nothing");
  s = await served();
  const id = await s.newCase();
  const n = s.entries(id).length;
  expect((await s.command(id, "note_memory", { kind: "fact", text: "The lobby AP-3 is on the second floor." })).status).toBe(200);
  expect((await s.command(id, "revise_memory", { item: "m1", kind: "decision", text: "Read the lobby AP-3's leases first." })).status).toBe(200);
  expect((await s.command(id, "drop_memory", { item: "m1", reason: "the leases were read" })).status).toBe(200);
  const written = s.entries(id).slice(n);
  expect(written.map((e) => [e.type, e.actor])).toEqual([
    ["memory.noted", person(s)], ["memory.revised", person(s)], ["memory.dropped", person(s)],
  ]);
  expect(written[0]!.payload).toEqual({ item: "m1", kind: "fact", text: "The lobby AP-3 is on the second floor.", cards: [] });
  expect(s.app.hub.read(id).state.memory.notes.m1).toMatchObject({ kind: "decision", text: "Read the lobby AP-3's leases first.", dropped: { reason: "the leases were read" } });
  const before = s.entries(id).length;
  expect(await s.command(id, "drop_memory", { item: "m1", reason: "again" })).toEqual({ status: 409, body: { ok: false, refused: ["note m1 was dropped"] } });
  expect(await s.command(id, "note_memory", { kind: "fact", text: "x", cards: ["c99"] })).toEqual({ status: 409, body: { ok: false, refused: ["unknown card: c99"] } });
  expect((await s.command(id, "note_memory", { kind: "rumour", text: "x" })).status).toBe(400);
  expect((await s.command(id, "note_memory", { kind: "fact", text: "x", actor: { kind: "agent" } })).status).toBe(400);
  expect(s.entries(id).length).toBe(before);
});

test("set_case_type confirms what Frame proposed, during the run, and the next stage's request holds the lessons", async () => {
  s = await served({ before: (root) => withMemoryLoop(root) });
  const { lesson } = s.wb.memory.propose({ case_type: "unknown-device", title: "Read the lease table first", text: "LOBBYMARK: the lease table names the device first.", triggers: [], marking: "TLP:GREEN", supersedes: null }, { kind: "person" }, person(s));
  s.wb.memory.accept(lesson.id, { actor: person(s), hash: lesson.hash });
  const id = await s.newCase({ loop: "memo" });
  expect((await s.command(id, "start_run")).status).toBe(200);
  await s.app.hub.idle();
  const held = s.app.hub.read(id).state;
  expect(held.run).toMatchObject({ status: "paused", hold: { kind: "question", stage: "frame" } });
  expect(held.memory.proposed_type?.type).toBe("unknown-device");
  expect(s.entries(id).some((e) => e.type === "model.request" && e.stage === "plan")).toBe(false);
  const n = s.entries(id).length;
  expect((await s.command(id, "set_case_type", { type: "unknown-device" })).status).toBe(200);
  await s.app.hub.idle();
  const written = s.entries(id).slice(n);
  expect(written.slice(0, 4).map((e) => [e.type, e.actor.kind])).toEqual([["case.type_set", "human"], ["memory.bound", "human"], ["card.created", "human"], ["question.answered", "human"]]);
  expect(written.some((e) => e.type === "run.resumed" && e.actor.kind === "human")).toBe(true);
  // the answer card is the person's, and says the workbench worded it (final review Minor 8)
  expect((written[2]!.payload as { card: { why: string } }).card.why).toBe("did not say how: the workbench worded this answer from the case type the person set");
  const st = s.app.hub.read(id).state;
  expect(st.memory.type).toBe("unknown-device");
  expect(Object.values(st.questions).find((q) => q.why === CASE_TYPE_WHY)!.waived).toBeNull();
  expect(st.run.waiting).toBe("plan");
  type Req = Extract<Entry, { type: "model.request" }>;
  const plan = s.entries(id).filter((e): e is Req => e.type === "model.request" && e.stage === "plan");
  expect(plan.length).toBeGreaterThan(0);
  expect(plan[0]!.payload.pack.filter((p) => p.kind === "shared-lesson").map((p) => p.id)).toEqual([lesson.id]);
});

test("set_case_type to a type that is not loaded is refused", async () => {
  s = await served({ before: (root) => withMemoryLoop(root) });
  const id = await s.newCase();
  const n = s.entries(id).length;
  expect(await s.command(id, "set_case_type", { type: "printer" })).toEqual({ status: 409, body: { ok: false, refused: ['there is no case type "printer"'] } });
  expect((await s.command(id, "set_case_type", { type: 7 })).status).toBe(400);
  expect((await s.command(id, "set_case_type", {})).status).toBe(400);
  expect(s.entries(id).length).toBe(n);
  // a loaded type, and then none: each the person's
  expect((await s.command(id, "set_case_type", { type: "phishing" })).status).toBe(200);
  expect((await s.command(id, "set_case_type", { type: null })).status).toBe(200);
  expect(s.entries(id).slice(n).map((e) => [e.type, e.payload, e.actor])).toEqual([["case.type_set", { type: "phishing" }, person(s)], ["case.type_set", { type: null }, person(s)]]);
  expect(s.app.hub.read(id).state.memory.type).toBeNull();
});

// ---------- final review I5: no credential's value in a note or a statement ----------

test("a credential's value in a note, its revision, a drop's reason or a statement is redacted before the ledger", async () => {
  const value = "s3cr3t-Value-0123456789";
  s = await served({ credential: { name: "PROBE_CRED", value } });
  const id = await s.newCase();
  const n = s.entries(id).length;
  expect((await s.command(id, "note_memory", { kind: "fact", text: `the key is ${value}` })).status).toBe(200);
  expect((await s.command(id, "revise_memory", { item: "m1", kind: "fact", text: `still ${value}` })).status).toBe(200);
  expect((await s.command(id, "drop_memory", { item: "m1", reason: `it held ${value}` })).status).toBe(200);
  expect((await s.command(id, "add_statement", { statement: `the password is ${value}`, basis: "saw", detail: `typed ${value}` })).status).toBe(200);
  const written = s.entries(id).slice(n);
  expect(JSON.stringify(written)).not.toContain(value);
  expect(written.map((e) => e.type)).toEqual(["memory.noted", "memory.revised", "memory.dropped", "card.created"]);
  expect(written[0]!.payload).toMatchObject({ text: "the key is [redacted secret]" });
  expect(written[1]!.payload).toMatchObject({ text: "still [redacted secret]" });
  expect(written[2]!.payload).toMatchObject({ reason: "it held [redacted secret]" });
  const card = (written[3]!.payload as { card: { body: string; title: string; why: string } }).card;
  expect(card.body).toBe("the password is [redacted secret]");
  expect(card.title).not.toContain(value);
  expect(card.why).toContain("typed [redacted secret]");
});
