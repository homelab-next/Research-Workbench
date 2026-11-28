import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CaseSession } from "../../src/core/session";
import type { Actor } from "../../src/core/types";
import { COMMANDS } from "../../src/server/commands";
import "../../src/server/app";
import { CASE_TYPE_WHY } from "../../src/pipeline/memory";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const engine: Actor = { kind: "system", id: "engine" };
const researcher: Extract<Actor, { kind: "agent" }> = { kind: "agent", id: "researcher-g1", stage: "research", profile: "investigation", model: "sample-run", effort: null, where: "machine" };

/** A model request of the researcher, then a question it asks while answering it. */
function ask(session: CaseSession, text: string, blocking: boolean): void {
  session.commit((st, ids) => [
    { type: "model.request", actor: researcher, run: st.run.id, stage: "research", payload: { request: ids.next("request"), provider: "scripted", model: "sample-run", effort: null, where: "machine", marking: "TLP:GREEN", pack: [], left_out: [], messages: session.blobs.put("{}"), tools: [] } },
    { type: "question.asked", actor: researcher, run: st.run.id, stage: "research", payload: { question: { id: ids.next("question"), text, why: "it matters", cards: [], about: [], blocking } } },
  ]);
}

test("answer_question answers in the server's name with basis 'unstated' when none is given; a requester may not", async () => {
  expect(COMMANDS.answer_question!.then).toBe("nothing");
  s = await served();
  const id = await s.newCase();
  await s.toPlanGate(id);
  const session = s.app.hub.read(id);
  ask(session, "Where is the access point AP-7?", false);
  const before = s.entries(id).length;
  const r = await s.command(id, "answer_question", { question: "ask-1", answer: "In the lobby." });
  expect(r.status).toBe(200);
  await s.app.hub.idle();
  const written = s.entries(id).slice(before);
  expect(written.map((e) => e.type)).toEqual(["card.created", "question.answered"]);
  expect(written.every((e) => e.actor.kind === "human" && e.actor.id === s!.config.user)).toBe(true);
  const state = s.app.hub.read(id).state;
  const card = state.cards[state.questions["ask-1"]!.answer!.card]!;
  expect(card).toMatchObject({ body: "In the lobby.", why: "did not say how", marking: "TLP:GREEN", person: { basis: "unstated", detail: "", answers: "ask-1" } });
  expect(state.skipped).toEqual([]);
  expect(await s.command(id, "answer_question", { question: "ask-1", answer: "again" })).toEqual({ status: 409, body: { ok: false, refused: [`ask-1 is already answered (card ${card.id}); add a statement to correct it`] } });
  await s.close();

  s = await served({ role: "requester" });
  const rid = s.app.hub.create({ title: "T", asked: "A", why: "W", starting: [], window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, objective: null, marking: "TLP:GREEN" }, { kind: "human", id: "x" }).id;
  const n = s.entries(rid).length;
  expect(await s.command(rid, "answer_question", { question: "ask-1", answer: "x" })).toEqual({ status: 403, body: { ok: false, refused: ["the requester view may not do answer question"] } });
  expect(s.entries(rid).length).toBe(n);
});

test("answering the question a run is held for resumes the run; answering another leaves it paused", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPlanGate(id);
  const session = s.app.hub.read(id);
  ask(session, "Where is the access point AP-7?", true);
  ask(session, "Is the printer new?", true);
  session.commit((st) => [{ type: "run.paused", actor: engine, run: st.run.id, payload: { reason: "waiting for the person's answers to ask-1 and ask-2", hold: { kind: "question", stage: "research" } } }]);
  const resumes = (): number => s!.entries(id).filter((e) => e.type === "run.resumed").length;
  const r0 = resumes();
  expect((await s.command(id, "answer_question", { question: "ask-1", answer: "In the lobby.", basis: "saw" })).status).toBe(200);
  await s.app.hub.idle();
  expect(s.app.hub.read(id).state.run.status).toBe("paused");
  expect(resumes()).toBe(r0);
  expect((await s.command(id, "answer_question", { question: "ask-2", answer: "Yes, since Monday.", basis: "told", detail: "the office said" })).status).toBe(200);
  await s.app.hub.idle();
  const after = s.entries(id);
  const answered = after.findLastIndex((e) => e.type === "question.answered");
  expect(after.slice(answered).some((e) => e.type === "run.resumed" && e.actor.kind === "human")).toBe(true);
  // the person answered every question the hold was for: the resume waives nothing
  const st = s.app.hub.read(id).state;
  expect([st.questions["ask-1"]!.waived, st.questions["ask-2"]!.waived]).toEqual([null, null]);
  expect(st.run.status).not.toBe("paused");
  expect(st.skipped).toEqual([]);
});

test("answering Frame's question of the case's type sets the type in the person's name and resumes the run; an answer that names no type is refused", async () => {
  const types = "kind: case-types\nid: sample-types\ntypes:\n  - { id: unknown-device, title: Unknown device }\n";
  s = await served({ before: (root) => writeFileSync(join(root, "case-types.yaml"), types) });
  const id = await s.newCase();
  await s.toPlanGate(id);
  const session = s.app.hub.read(id);
  const orchestrator: Extract<Actor, { kind: "agent" }> = { ...researcher, id: "orchestrator", stage: "frame" };
  // the question Frame puts to the person when the case has no type, and the hold the run waits on
  session.commit((st, ids) => [
    { type: "model.request", actor: orchestrator, run: st.run.id, stage: "frame", payload: { request: ids.next("request"), provider: "scripted", model: "sample-run", effort: null, where: "machine", marking: "TLP:GREEN", pack: [], left_out: [], messages: session.blobs.put("{}"), tools: [] } },
    { type: "question.asked", actor: orchestrator, run: st.run.id, stage: "frame", payload: { question: { id: ids.next("question"), text: "What is this case's type? Answer with a case type's id (unknown-device), or none.", why: CASE_TYPE_WHY, cards: [], about: [], blocking: true } } },
  ]);
  session.commit((st) => [{ type: "run.paused", actor: engine, run: st.run.id, payload: { reason: "waiting for the person's answer to ask-1", hold: { kind: "question", stage: "frame" } } }]);
  const n = s.entries(id).length;
  expect(await s.command(id, "answer_question", { question: "ask-1", answer: "a printer, I think" })).toEqual({ status: 409, body: { ok: false, refused: ["answer with a case type's id (unknown-device), or none"] } });
  expect(s.entries(id).length).toBe(n);
  expect((await s.command(id, "answer_question", { question: "ask-1", answer: "unknown-device" })).status).toBe(200);
  await s.app.hub.idle();
  const written = s.entries(id).slice(n);
  expect(written.slice(0, 3).map((e) => [e.type, e.actor.kind])).toEqual([["case.type_set", "human"], ["card.created", "human"], ["question.answered", "human"]]);
  expect(written.some((e) => e.type === "run.resumed" && e.actor.kind === "human")).toBe(true);
  const st = s.app.hub.read(id).state;
  expect(st.memory.type).toBe("unknown-device");
  expect(st.questions["ask-1"]!.waived).toBeNull();
  expect(st.skipped).toEqual([]);
});
