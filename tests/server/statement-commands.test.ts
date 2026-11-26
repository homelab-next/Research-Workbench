import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../../src/server/commands";
import "../../src/server/app";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

test("add_statement writes the card in the server's name and moves nothing; a requester may not", async () => {
  s = await served();
  const id = await s.newCase();
  const before = s.entries(id).length;
  const r = await s.command(id, "add_statement", { statement: "The device at 192.0.2.17 is the meeting-room TV.", basis: "saw", detail: "I looked", about: [{ type: "address", value: "192.0.2.17" }] });
  expect(r.status).toBe(200);
  await s.app.hub.idle();
  const written = s.entries(id).slice(before);
  expect(written.map((e) => e.type)).toEqual(["card.created"]);
  expect(written[0]!.actor.kind).toBe("human");
  const state = s.app.hub.read(id).state;
  const card = Object.values(state.cards).find((c) => c.person !== undefined)!;
  expect(card).toMatchObject({ place: "incoming", marking: "TLP:GREEN", why: "saw it myself: I looked", person: { basis: "saw", answers: null } });
  expect(state.run.status).toBe("none");
  expect(state.skipped).toEqual([]);
  // a refusal is the server's ordinary refusal
  const bad = await s.command(id, "add_statement", { statement: " ", basis: "saw" });
  expect(bad).toEqual({ status: 409, body: { ok: false, refused: ["a statement needs text"] } });
  await s.close();

  s = await served({ role: "requester" });
  const rid = s.app.hub.create({ title: "T", asked: "A", why: "W", starting: [], window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, objective: null, marking: "TLP:GREEN" }, { kind: "human", id: "x" }).id;
  const n = s.entries(rid).length;
  expect(await s.command(rid, "add_statement", { statement: "x", basis: "told" })).toEqual({ status: 403, body: { ok: false, refused: ["the requester view may not do add statement"] } });
  expect(s.entries(rid).length).toBe(n);
});

test("the three person command files are loaded: add_statement is defined, and app.ts imports each file once", () => {
  expect(Object.hasOwn(COMMANDS, "add_statement")).toBe(true);
  expect(COMMANDS.add_statement!.then).toBe("nothing");
  const app = readFileSync(join(import.meta.dir, "../../src/server/app.ts"), "utf8");
  for (const file of ["./statement-commands", "./overrule-commands", "./question-commands"]) {
    expect(app.split("\n").filter((l) => l.trim() === `import "${file}";`).length).toBe(1);
  }
});
