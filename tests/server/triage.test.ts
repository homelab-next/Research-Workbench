import { afterEach, beforeEach, expect, test } from "bun:test";
import type { CaseState } from "../../src/core/state";
import type { Entry } from "../../src/core/types";
import { card as madeCard } from "../helpers/entries";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served;
let id: string;
beforeEach(async () => { s = await served(); id = await s.newCase(); await s.toPublishGate(id); });
afterEach(async () => { expect(s.app.hub.read(id).state.skipped).toEqual([]); await s.close(); });

const state = (): Readonly<CaseState> => s.app.hub.read(id).state;
const cmd = (name: string, args: Record<string, unknown> = {}) => s.command(id, name, args);
const wrote = async (name: string, args: Record<string, unknown>): Promise<Entry[]> => {
  const before = s.entries(id).length;
  const r = await cmd(name, args);
  expect([name, r.status]).toEqual([name, 200]);
  return s.entries(id).slice(before);
};

test("keep puts a card in the target lane, and undo puts it back where it was", async () => {
  const card = state().incoming[1]!;
  await cmd("keep", { card });
  expect(state().cards[card]).toMatchObject({ place: "lane", lane: state().target });
  await cmd("undo");
  expect(state().incoming[1]).toBe(card);
});

test("keep with no lane in the case makes a lane called Kept first", async () => {
  const fresh = await s.newCase();
  s.app.hub.read(fresh).commit((st, ids) => [{ type: "card.created", actor: { kind: "human", id: "u" }, payload: { card: madeCard(ids.next("card"), { made_by: "human" }) } }]);
  const card = s.app.hub.read(fresh).state.incoming[0]!;
  const before = s.entries(fresh).length;
  const r = await s.command(fresh, "keep", { card });
  expect(r.status).toBe(200);
  expect(s.entries(fresh).slice(before).map((e) => e.type)).toEqual(["lane.created", "card.kept"]);
  const st = s.app.hub.read(fresh).state;
  expect(st.lanes.map((l) => l.title)).toEqual(["Kept"]);
  expect(st.cards[card]).toMatchObject({ place: "lane", lane: st.lanes[0]!.id });
  expect(st.skipped).toEqual([]);
});

test("move, discard, restore, send_back and pin each write their one entry", async () => {
  const [a, b] = state().incoming;
  const lanes = state().lanes;
  await cmd("keep", { card: a });
  await cmd("keep", { card: b });
  const to = lanes[lanes.length - 1]!.id;
  expect((await wrote("move", { card: a, lane: to, index: 0 })).map((e) => e.type)).toEqual(["card.moved"]);
  expect((await wrote("pin", { card: a, pinned: true })).map((e) => e.type)).toEqual(["card.pinned"]);
  expect(state().cards[a!]!.pinned).toBe(true);
  expect((await wrote("send_back", { card: a })).map((e) => e.type)).toEqual(["card.sent_back"]);
  expect((await wrote("discard", { card: a })).map((e) => e.type)).toEqual(["card.discarded"]);
  expect(state().discarded).toContain(a!);
  expect((await wrote("restore", { card: a })).map((e) => e.type)).toEqual(["card.restored"]);
  expect(state().incoming).toContain(a!);
});

test("undo reverses keep, move, discard and send_back, newest first", async () => {
  const [a, b, c, d] = state().incoming as [string, string, string, string];
  const lane0 = state().target!;
  await cmd("keep", { card: a });
  await cmd("keep", { card: b });
  await cmd("discard", { card: c });
  const after = state();
  await cmd("send_back", { card: a });
  await cmd("undo");
  expect(state().cards[a]).toMatchObject({ place: "lane", lane: lane0 });
  await cmd("undo");
  expect(state().cards[c]!.place).toBe("incoming");
  await cmd("undo");
  expect(state().cards[b]!.place).toBe("incoming");
  await cmd("undo");
  expect(state().cards[a]!.place).toBe("incoming");
  expect(state().incoming).toContain(d);
  expect(after.undoable.length).toBe(3);
  expect(state().undoable).toEqual([]);
  const moved = state().lanes.length > 1 ? state().lanes[1]!.id : null;
  await cmd("keep", { card: d });
  if (moved !== null) {
    await cmd("move", { card: d, lane: moved, index: 0 });
    await cmd("undo");
    expect(state().cards[d]).toMatchObject({ place: "lane", lane: lane0 });
  }
});

test("keeping a kept card, discarding a discarded card and undo with nothing to undo are refused and write nothing", async () => {
  const [a, b] = state().incoming as [string, string];
  await cmd("keep", { card: a });
  await cmd("discard", { card: b });
  const before = s.entries(id).length;
  expect(await cmd("keep", { card: a })).toEqual({ status: 409, body: { ok: false, refused: [`card ${a} is already kept`] } });
  expect(await cmd("keep", { card: b })).toEqual({ status: 409, body: { ok: false, refused: [`card ${b} is discarded; restore it first`] } });
  expect((await cmd("discard", { card: b })).status).toBe(409);
  expect((await cmd("restore", { card: a })).status).toBe(409);
  expect((await cmd("send_back", { card: b })).status).toBe(409);
  expect((await cmd("move", { card: b, lane: state().target, index: 0 })).status).toBe(409);
  expect((await cmd("keep", { card: "nope" })).status).toBe(409);
  expect((await cmd("move", { card: a, lane: "nope", index: 0 })).status).toBe(409);
  expect((await cmd("move", { card: a, lane: state().target, index: -1 })).status).toBe(400);
  expect(s.entries(id).length).toBe(before);
  while (state().undoable.length > 0) await cmd("undo");
  const empty = s.entries(id).length;
  expect(await cmd("undo")).toEqual({ status: 409, body: { ok: false, refused: ["nothing to undo"] } });
  expect(await cmd("undo", { target: 99999 })).toEqual({ status: 409, body: { ok: false, refused: ["nothing to undo"] } });
  expect(s.entries(id).length).toBe(empty);
});

test("the same keep sent twice at once keeps once", async () => {
  const card = state().incoming[0]!;
  const rs = await Promise.all([cmd("keep", { card }), cmd("keep", { card }), cmd("keep", { card })]);
  expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
  expect(s.entries(id).filter((e) => e.type === "card.kept" && e.payload.card === card).length).toBe(1);
});

test("a lane with cards cannot be removed; an empty one can", async () => {
  const card = state().incoming[0]!;
  await cmd("keep", { card });
  const lane = state().cards[card]!.lane!;
  const title = state().lanes.find((l) => l.id === lane)!.title;
  expect(await cmd("remove_lane", { lane })).toEqual({ status: 409, body: { ok: false, refused: [`lane ${title} still holds 1 cards`] } });
  const made = await wrote("add_lane", { title: "  Spare  " });
  expect(made.map((e) => e.type)).toEqual(["lane.created"]);
  const spare = state().lanes.find((l) => l.title === "Spare")!;
  expect((await wrote("set_target", { lane: spare.id })).map((e) => e.type)).toEqual(["lane.target_set"]);
  expect(state().target).toBe(spare.id);
  expect((await wrote("rename_lane", { lane: spare.id, title: "Spare two" })).map((e) => e.type)).toEqual(["lane.renamed"]);
  expect((await wrote("remove_lane", { lane: spare.id })).map((e) => e.type)).toEqual(["lane.removed"]);
  expect(state().lanes.some((l) => l.id === spare.id)).toBe(false);
  expect((await cmd("set_target", { lane: "nope" })).status).toBe(409);
  expect((await cmd("remove_lane", { lane: "nope" })).status).toBe(409);
});

test("a lane title is trimmed and must be 1 to 80 characters", async () => {
  const before = s.entries(id).length;
  for (const title of ["", "   ", "x".repeat(81), ` ${"x".repeat(81)} `]) {
    const r = await cmd("add_lane", { title });
    expect([title.length, r.status]).toEqual([title.length, 409]);
  }
  expect((await cmd("rename_lane", { lane: state().lanes[0]!.id, title: " " })).status).toBe(409);
  expect(s.entries(id).length).toBe(before);
  expect((await cmd("add_lane", { title: ` ${"x".repeat(80)} ` })).status).toBe(200);
  expect(state().lanes.at(-1)!.title).toBe("x".repeat(80));
});

test("an agent or system actor is never written by a triage command", async () => {
  const before = s.entries(id).length;
  const [a, b] = state().incoming as [string, string];
  const lane = state().target!;
  for (const [n, args] of [["keep", { card: a }], ["move", { card: a, lane, index: 0 }], ["pin", { card: a, pinned: true }], ["send_back", { card: a }], ["discard", { card: b }], ["restore", { card: b }], ["add_lane", { title: "L" }], ["undo", {}]] as const) await cmd(n, args);
  const mine = s.entries(id).slice(before);
  expect(mine.length).toBe(8);
  for (const e of mine) expect(e.actor).toEqual({ kind: "human", id: s.config.user });
});
