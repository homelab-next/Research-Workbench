import { afterEach, expect, test } from "bun:test";
import { COMMANDS } from "../../src/server/commands";
import "../../src/server/app";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

let s: Served | undefined;
afterEach(async () => { await s?.close(); s = undefined; });

const NOTE = "It is the TV I installed.";

test("overrule_finding overrules in the server's name and the run reviews the new draft; a requester may not", async () => {
  expect(COMMANDS.overrule_finding!.then).toBe("advance");
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  const d = s.app.hub.read(id).state.drafts.at(-1)!;
  const f1 = d.product.key_findings[0]!;
  const other = ["almost certain", "very likely"].find((x) => x !== f1.likelihood)!;
  const before = s.entries(id).length;
  const r = await s.command(id, "overrule_finding", { finding: f1.id, draft_hash: d.hash, likelihood: other, confidence: null, stays: null, note: NOTE });
  expect(r.status).toBe(200);
  await s.app.hub.idle();
  const written = s.entries(id).slice(before);
  const o = written.find((e) => e.type === "finding.overruled")!;
  expect(o.actor).toEqual({ kind: "human", id: s.config.user });
  expect(o.payload).toEqual({ finding: f1.id, draft_hash: d.hash, likelihood: other, confidence: null, stays: null, note: NOTE });
  // at the publish gate the work goes back to Assemble (controller ruling 6), and the server drives the run on from there
  expect(written.find((e) => e.type === "stage.sent_back")!.payload).toMatchObject({ from: "publish", to: "assemble" });
  expect(written.some((e) => e.type === "stage.started" && e.payload.stage === "assemble")).toBe(true);
  // (the sample's script has no more Assemble turns, so the analyst's call is answered with an error and the run pauses there)
  expect(written.some((e) => e.type === "model.request" && e.actor.kind === "agent" && e.actor.id === "analyst")).toBe(true);
  const state = s.app.hub.read(id).state;
  expect(state.overrules[f1.id]).toMatchObject({ likelihood: other, note: NOTE });
  expect(state.skipped).toEqual([]);
  await s.close();

  s = await served({ role: "requester" });
  const rid = s.app.hub.create({ title: "T", asked: "A", why: "W", starting: [], window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, objective: null, marking: "TLP:GREEN" }, { kind: "human", id: "x" }).id;
  const n = s.entries(rid).length;
  expect(await s.command(rid, "overrule_finding", { finding: "f1", draft_hash: "h", likelihood: null, confidence: null, stays: true, note: NOTE }))
    .toEqual({ status: 403, body: { ok: false, refused: ["the requester view may not do overrule finding"] } });
  expect(s.entries(rid).length).toBe(n);
});

test("overrule_finding on a draft that is no longer the latest is 409 and writes nothing", async () => {
  s = await served();
  const id = await s.newCase();
  await s.toPublishGate(id);
  const d = s.app.hub.read(id).state.drafts.at(-1)!;
  const before = s.entries(id).length;
  const r = await s.command(id, "overrule_finding", { finding: d.product.key_findings[0]!.id, draft_hash: "0".repeat(64), likelihood: null, confidence: "high", stays: null, note: NOTE });
  expect(r).toEqual({ status: 409, body: { ok: false, refused: ["a newer draft arrived; look at it before overruling"] } });
  await s.app.hub.idle();
  expect(s.entries(id).length).toBe(before);
  // the arguments are checked before the engine sees them
  expect((await s.command(id, "overrule_finding", { finding: "f1", draft_hash: d.hash, likelihood: null, confidence: "sure", stays: null, note: NOTE })).status).toBe(400);
  expect(s.entries(id).length).toBe(before);
});
