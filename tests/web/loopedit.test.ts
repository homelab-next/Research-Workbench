import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Json } from "../../src/core/canonical";
import type { Api } from "../../src/web/api";
import type { ItemView, LoopStageView, LoopSummaryView, LoopView, Reference } from "../../src/core/wire";
import { startApp } from "../../src/web/app";
import { testUi } from "../helpers/dom";

// Task 13: building a loop. Copy one from its screen, then edit it in forms over the server's draft: the stages in order, each stage's fields, its
// components' sources and a sub-loop's mapping; Check and Save post the draft, and what the server says is shown beside what it names.

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64), D = "d".repeat(64), E = "e".repeat(64), F = "f".repeat(64);
const PINNED = "0123456789abcdef".repeat(4);
const MARKUP = "<img src=x onerror=alert(1)>";
const SCRIPTED = { provider: "scripted", model: "sample-run", effort: null };
const LOCAL = { provider: "local", model: "small", effort: "low" };

type Body = Record<string, Json>;
const body = (id: string, title: string, order: number, over: Body = {}): Body => ({
  id, title, order, phase: null, runs: "agent", role: id, gate: null, reviews: false, tools: ["run_query", "list_cards"], schema: null, model: { ...SCRIPTED },
  on_pass: null, on_fail: null, ...over,
});
/** The draft of "mine", as the server gives it: three stages, every one inline. */
const mineDraft = (title = "Research"): Body => ({
  id: "mine", title: "Mine", about: "My loop.", profile: "investigation", entry: "frame",
  stages: [
    body("frame", "Frame", 1, { on_pass: "research" }),
    body("research", title, 2, { on_pass: "review" }),
    body("review", "Review", 3, { reviews: true, on_fail: "research", tools: [] }),
  ],
  inputs: { question: { type: "question", required: true } }, outputs: { product: { from: "product" } }, components: {}, uses: {},
});
const summary = (id: string, title: string, over: Partial<LoopSummaryView> = {}): LoopSummaryView => ({
  id, title, about: "", version: 3, hash: A, stages: [], usable: true, problems: [], implicit: false, trusted: true, root: "sample", case_type: null, ...over,
});
const item = (kind: string, id: string, title: string, source: ItemView["source"], hash: string | null): ItemView => ({ kind, id, title, source, hash });
const stageView = (id: string, title: string, over: Partial<LoopStageView> = {}): LoopStageView => ({
  id, title, runs: "agent", role: id, gate: null, reviews: false, on_pass: null, on_fail: null, hash: E, inline: true, context: [], middleware: [],
  orchestration: { tools: [], model: null, fast_model: null, max_turns: null, send_back_cap: 3, subloop: null }, ...over,
});
const mine = (draft: Body = mineDraft()): LoopView => ({
  ...summary("mine", "Mine", { stages: ["frame", "research", "review"] }), entry: "frame", profile: "investigation",
  inputs: { question: { type: "question", required: true } }, outputs: { product: { from: "product" } }, caps: { max_depth: 2, max_children: 8 },
  stage_views: [
    stageView("frame", "Frame", {
      context: [item("persona", "researcher", "Researcher", "root", B), item("rules", "base-rules", "Base rules", "root", C), item("goal", "frame", "Frame the question", "root", D)],
      middleware: [item("built-in", "marking-policy", "The marking policy", "built-in", null)],
    }),
    stageView("research", "Research", { context: [item("persona", "researcher", "Researcher", "root", B), item("rules", "base-rules", "Base rules", "root", C)] }),
    stageView("review", "Review", { reviews: true }),
  ],
  draft: draft as unknown as Json,
});
/** The sample's investigation: its stages named by id in a trusted root. */
const investigation = (): LoopView => ({
  ...summary("investigation", "Investigation", { version: 1, stages: ["frame"] }), entry: "frame", profile: "investigation",
  inputs: { question: { type: "question", required: true }, observables: { type: "observables", required: true }, window: { type: "window", required: true }, cards: { type: "cards", required: false } },
  outputs: { product: { from: "product" }, findings: { from: "findings" }, cards: { from: "cards.kept" } },
  caps: { max_depth: 2, max_children: 8 }, stage_views: [stageView("frame", "Frame", { inline: false })],
  draft: { id: "investigation", title: "Investigation", about: "", profile: "investigation", entry: "frame", stages: [body("frame", "Frame", 1)], inputs: {}, outputs: {}, components: {}, uses: {} },
});
const loops = (): LoopSummaryView[] => [
  summary("investigation", "Investigation", { version: 1 }), summary("mine", "Mine"), summary("triage", "Triage", { version: 2, hash: F }),
  summary("broken", "Broken", { usable: false, hash: null, trusted: false, root: "broken-0123456789ab", problems: ["a loop manifest is accepted only from a trusted root"] }),
];
const REF_TOOLS = ["find_routes", "run_query", "list_cards", "read_card", "ask_person"];

interface Stub {
  win: Window; root: HTMLElement; calls: unknown[][];
  click(selector: string | Element): void; fill(selector: string | Element, text: string): void; choose(selector: string | Element, value: string): void;
  q(selector: string): HTMLElement; all(selector: string): HTMLElement[];
  settle(): Promise<void>; close(): Promise<void>;
  /** The draft the latest Check or Save posted. */
  posted(): Body;
}
let open: Stub | null = null;
afterEach(async () => { await open?.close(); open = null; });

async function stub(opts: { hash: string; over?: Partial<Api>; views?: Record<string, LoopView> }): Promise<Stub> {
  const win = new Window({ url: `http://127.0.0.1:1/${opts.hash}` });
  const doc = win.document as unknown as Document;
  const calls: unknown[][] = [];
  const rec = <T>(name: string, value: T, ...args: unknown[]): Promise<T> => { calls.push([name, ...JSON.parse(JSON.stringify(args)) as unknown[]]); return Promise.resolve(value); };
  const views: Record<string, LoopView> = { mine: mine(), investigation: investigation(), ...opts.views };
  const api = {
    cases: () => rec("cases", []),
    loops: () => rec("loops", loops()),
    loop: (id: string) => (views[id] === undefined ? Promise.reject(new Error("404")) : rec("loop", views[id], id)),
    loopFiles: () => rec("loopFiles", []),
    exportLoop: (id: string) => rec("exportLoop", { file: `${id}.v3.aaaaaaaaaaaa.loop.tar.gz` }, id),
    loopFilePath: (file: string) => `/api/loop-files/${file}`,
    copyLoop: (id: string, to: { id: string; title: string }) => rec("copyLoop", { id: to.id }, id, to),
    checkLoop: (id: string, draft: unknown) => rec("checkLoop", { ok: true, problems: [] }, id, draft),
    saveLoop: (id: string, draft: unknown, version: number) => rec("saveLoop", { id, version: version + 1, hash: F }, id, draft, version),
    entries: { open: () => () => {} },
    ...opts.over,
  } as unknown as Api;
  const ref: Reference = {
    types: [], sources: [], pivots: [], objectives: [], phases: [], profile: { id: "investigation", title: "Investigation" }, send_back_cap: 3, playbooks: [], inventories: [], likelihood: [],
    stage_tools: REF_TOOLS, stage_models: [SCRIPTED, LOCAL], case_types: [],
  };
  const ui = testUi(win, { api, ref, me: { user: "analyst", role: "analyst", origin: "http://127.0.0.1:1", markings: ["TLP:GREEN"], policy: {} as never, problems: [], cases: { store: "<data>/cases", on_complete: "keep" }, loops: { default: "investigation" } } });
  const root = doc.createElement("div");
  doc.body.append(root);
  const app = startApp(ui, root);
  const q = (selector: string): HTMLElement => {
    const found = root.querySelector(selector);
    if (found === null) throw new Error(`nothing matches ${selector}; the page says: ${(root.textContent ?? "").slice(0, 400)}`);
    return found as HTMLElement;
  };
  const el = (t: string | Element): HTMLElement => (typeof t === "string" ? q(t) : t as HTMLElement);
  const s: Stub = {
    win, root, calls, q, all: (selector) => [...root.querySelectorAll(selector)] as HTMLElement[],
    click(t) { el(t).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event); },
    fill(t, text) { const i = el(t) as HTMLInputElement; i.value = text; i.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event); },
    choose(t, value) { const i = el(t) as HTMLSelectElement; i.value = value; i.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event); },
    async settle() { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); },
    async close() { app.destroy(); await win.happyDOM.close(); },
    posted() {
      const last = calls.filter((c) => c[0] === "checkLoop" || c[0] === "saveLoop").at(-1);
      if (last === undefined) throw new Error("nothing was posted");
      return last[2] as Body;
    },
  };
  open = s;
  await s.settle();
  return s;
}
const go = async (s: Stub, hash: string): Promise<void> => { s.win.location.hash = hash; await s.settle(); };
const text = (el: Element | null): string => el?.textContent ?? "";
const stageAt = (s: Stub, id: string): HTMLElement => s.q(`.stage-edit[data-stage="${id}"]`);
const field = (s: Stub, stage: string, name: string): HTMLElement => s.q(`.stage-edit[data-stage="${stage}"] [data-field="${name}"]`);
const check = async (s: Stub): Promise<Body> => { s.click("[data-action=check]"); await s.settle(); return s.posted(); };
const stagesOf = (d: Body): Body[] => d.stages as Body[];

test("Copy asks for an id and a title, refuses an id with a space or a capital at the field, posts the copy and opens its edit screen", async () => {
  const s = await stub({ hash: "#/loops/investigation" });
  expect(s.root.querySelector(".copy-form:not([hidden])")).toBeNull();
  s.click("[data-screen=loop] [data-action=copy]");
  const form = s.q(".copy-form");
  expect(form.hidden).toBe(false);
  s.fill("[aria-label=\"Copy's title\"]", "My copy");
  for (const bad of ["my copy", "My-copy", ""]) {
    s.fill("[aria-label=\"Copy's id\"]", bad);
    s.click("[data-action=make-copy]");
    await s.settle();
    expect(text(form.querySelector(".field-problem"))).toBe("An id is lower-case letters, digits and -");
  }
  expect(s.calls.some((c) => c[0] === "copyLoop")).toBe(false);
  s.fill("[aria-label=\"Copy's id\"]", "my-copy");
  s.fill("[aria-label=\"Copy's title\"]", "");
  s.click("[data-action=make-copy]");
  await s.settle();
  expect(text(form.querySelector(".field-problem"))).toBe("A copy needs a title");
  s.fill("[aria-label=\"Copy's title\"]", "My copy");
  s.click("[data-action=make-copy]");
  await s.settle();
  expect(s.calls).toContainEqual(["copyLoop", "investigation", { id: "my-copy", title: "My copy" }]);
  expect(s.win.location.hash).toBe("#/loops/my-copy/edit");
  await s.close(); open = null;
  // a refusal is shown beside the form, and the screen stays
  const r = await stub({ hash: "#/loops/investigation", over: { copyLoop: () => Promise.resolve({ refused: ["there is already a loop \"my-copy\""] }) } });
  r.click("[data-action=copy]");
  r.fill("[aria-label=\"Copy's id\"]", "my-copy");
  r.fill("[aria-label=\"Copy's title\"]", "My copy");
  r.click("[data-action=make-copy]");
  await r.settle();
  expect(text(r.q(".copy-form .refusal"))).toBe("Refused: there is already a loop \"my-copy\"");
  expect(r.win.location.hash).toBe("#/loops/investigation");
});

test("Edit is offered for a usable loop in a trusted root, its stages inline or named by id (controller ruling); a loop from a root that is not trusted offers Copy alone, and one that is not usable neither", async () => {
  const s = await stub({ hash: "#/loops/mine", views: { untrusted: { ...mine(), id: "untrusted", trusted: false, root: "other-0123456789ab" }, broken: { ...mine(), id: "broken", usable: false, draft: null, stage_views: [] } } });
  expect(s.all("[data-screen=loop] [data-action=copy]").length).toBe(1);
  expect(s.all("[data-screen=loop] [data-action=edit]").length).toBe(1);
  await go(s, "#/loops/investigation");
  // the sample's investigation names its stages by id: a form save keeps every stage it does not edit as that reference
  expect(s.all("[data-screen=loop] [data-action=copy]").length).toBe(1);
  expect(s.all("[data-screen=loop] [data-action=edit]").length).toBe(1);
  await go(s, "#/loops/untrusted");
  expect(s.all("[data-screen=loop] [data-action=copy]").length).toBe(1);
  expect(s.all("[data-screen=loop] [data-action=edit]").length).toBe(0);
  await go(s, "#/loops/broken");
  expect(s.all("[data-screen=loop] [data-action=copy], [data-screen=loop] [data-action=edit]").length).toBe(0);
  await go(s, "#/loops/mine");
  s.click("[data-screen=loop] [data-action=edit]");
  await s.settle();
  expect(s.win.location.hash).toBe("#/loops/mine/edit");
  expect(s.all(".loop-form .stage-edit").map((e) => e.dataset.stage)).toEqual(["frame", "research", "review"]);
  // an edit screen of a loop from a root that is not trusted says why there are no forms
  await go(s, "#/loops/untrusted/edit");
  expect(s.root.querySelector(".loop-form")).toBeNull();
  expect(text(s.q("[data-screen=loop_edit] .say"))).toBe("This loop is not in a trusted root, so it cannot be edited here; copy it to make one that can be.");
});

test("moving a stage up changes the order in the draft that Save posts and nothing else", async () => {
  const s = await stub({ hash: "#/loops/mine/edit" });
  expect((s.q(".stage-edit[data-stage=frame] [data-action=move-up]") as HTMLButtonElement).disabled).toBe(true);
  expect((s.q(".stage-edit[data-stage=review] [data-action=move-down]") as HTMLButtonElement).disabled).toBe(true);
  s.click(".stage-edit[data-stage=review] [data-action=move-up]");
  await s.settle();
  expect(s.all(".stage-edit").map((e) => e.dataset.stage)).toEqual(["frame", "review", "research"]);
  s.click("[data-action=save]");
  await s.settle();
  const want = mineDraft();
  const st = stagesOf(want);
  want.stages = [st[0]!, st[2]!, st[1]!];
  expect(s.posted()).toEqual(want);
  expect(s.calls.find((c) => c[0] === "saveLoop")!.slice(3)).toEqual([3]);
});

test("removing a stage that another stage's on_fail names leaves that select on none and says so", async () => {
  const s = await stub({ hash: "#/loops/mine/edit" });
  s.click(".stage-edit[data-stage=research] [data-action=remove]");
  await s.settle();
  expect(s.all(".stage-edit").map((e) => e.dataset.stage)).toEqual(["frame", "review"]);
  expect((field(s, "review", "on_fail") as HTMLSelectElement).value).toBe("");
  expect([...(field(s, "review", "on_fail") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "frame", "review"]);
  expect(text(stageAt(s, "review").querySelector(".edge-note"))).toBe("on fail named Research, which was removed: it is none now");
  expect(text(stageAt(s, "frame").querySelector(".edge-note"))).toBe("on pass named Research, which was removed: it is none now");
  const d = await check(s);
  expect(stagesOf(d).map((x) => [x.id, x.on_pass, x.on_fail])).toEqual([["frame", null, null], ["review", null, null]]);
});

test("setting a gate, reviews, on pass, on fail, the tools, the model and max_turns each change exactly that field of that stage in the posted draft", async () => {
  const s = await stub({ hash: "#/loops/mine/edit" });
  const want = mineDraft();
  const research = stagesOf(want)[1]!;
  const same = async (): Promise<void> => { expect(await check(s)).toEqual(want); };

  s.choose(field(s, "research", "gate"), "plan"); research.gate = "plan"; await same();
  s.click(field(s, "research", "reviews")); research.reviews = true; await same();
  s.choose(field(s, "research", "on_pass"), ""); research.on_pass = null; await same();
  s.choose(field(s, "research", "on_fail"), "frame"); research.on_fail = "frame"; await same();
  expect(s.all(".stage-edit[data-stage=research] [data-tool]").map((e) => e.dataset.tool)).toEqual(REF_TOOLS);
  s.click(".stage-edit[data-stage=research] [data-tool=read_card]"); research.tools = ["run_query", "list_cards", "read_card"]; await same();
  s.click(".stage-edit[data-stage=research] [data-tool=run_query]"); research.tools = ["list_cards", "read_card"]; await same();
  const model = field(s, "research", "model") as HTMLSelectElement;
  expect([...model.options].map((o) => o.textContent)).toEqual(["scripted sample-run · effort default", "local small · effort low"]);
  s.choose(model, [...model.options][1]!.value); research.model = { ...LOCAL }; await same();
  s.fill(field(s, "research", "max_turns"), "7"); research.max_turns = 7; await same();
  s.fill(field(s, "research", "max_turns"), ""); delete research.max_turns; await same();
  s.fill(field(s, "research", "title"), "Research, renamed"); research.title = "Research, renamed"; await same();
  s.choose(field(s, "research", "runs"), "script"); research.runs = "script"; await same();
  expect(text(stageAt(s, "research").querySelector(".stage-name"))).toBe("2. Research, renamed");
});

test("adding a sub-loop stage offers the usable loops, then one select per required input and per output of the loop chosen", async () => {
  const s = await stub({ hash: "#/loops/mine/edit" });
  s.choose("[data-field=add-kind]", "subloop");
  s.fill("[data-field=add-id]", "Child run");
  s.click("[data-action=add-stage]");
  await s.settle();
  expect(text(s.q(".add-stage .field-problem"))).toBe("A stage id is lower-case letters, digits, _ and -, and not one this loop has");
  s.fill("[data-field=add-id]", "child-run");
  s.click("[data-action=add-stage]");
  await s.settle();
  expect(s.all(".stage-edit").map((e) => e.dataset.stage)).toEqual(["frame", "research", "review", "child-run"]);
  const which = field(s, "child-run", "loop") as HTMLSelectElement;
  // the usable loops but this one: a loop that runs itself is refused whatever the cap
  expect([...which.options].map((o) => o.value)).toEqual(["", "investigation", "triage"]);
  s.choose(which, "investigation");
  await s.settle();
  expect(s.calls).toContainEqual(["loop", "investigation"]);
  expect(s.all(".stage-edit[data-stage=child-run] [data-input]").map((e) => e.dataset.input)).toEqual(["question", "observables", "window", "cards"]);
  expect([...(s.q(".stage-edit[data-stage=child-run] [data-input=question]") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["case.question"]);
  expect([...(s.q(".stage-edit[data-stage=child-run] [data-input=cards]") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "cards.kept"]);
  expect(s.all(".stage-edit[data-stage=child-run] [data-output]").map((e) => e.dataset.output)).toEqual(["product", "findings", "cards"]);
  expect([...(s.q(".stage-edit[data-stage=child-run] [data-output=cards]") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["", "cards"]);
  expect([...(s.q(".stage-edit[data-stage=child-run] [data-output=product]") as HTMLSelectElement).options].map((o) => o.value)).toContain("draft_section:summary");
  s.choose(".stage-edit[data-stage=child-run] [data-output=cards]", "cards");
  s.choose(".stage-edit[data-stage=child-run] [data-output=product]", "draft_section:summary");
  s.choose(".stage-edit[data-stage=child-run] [data-input=cards]", "cards.kept");
  // a sub-loop stage has no tools, model or turn cap to set
  expect(stageAt(s, "child-run").querySelector("[data-tool], [data-field=model], [data-field=max_turns]")).toBeNull();
  const d = await check(s);
  expect(stagesOf(d)[3]).toEqual({
    id: "child-run", title: "child-run", order: 4, phase: null, runs: "loop", role: "subloop", gate: null, reviews: false, tools: [], schema: null, model: null,
    on_pass: null, on_fail: null, loop: "investigation",
    inputs: { question: "case.question", observables: "case.observables", window: "case.window", cards: "cards.kept" },
    returns: { cards: { as: "cards" }, product: { as: "draft_section", section: "summary" } },
  });
  // a copy of a stage under a new id is the same body under that id, last
  s.choose("[data-field=add-kind]", "copy:research");
  s.fill("[data-field=add-id]", "research-2");
  s.click("[data-action=add-stage]");
  await s.settle();
  expect(stagesOf(await check(s))[4]).toEqual({ ...stagesOf(mineDraft())[1]!, id: "research-2", order: 5 });
});

test("a component's source set to pinned posts { pinned: <hash> } under that stage and component, and root posts nothing for it", async () => {
  const s = await stub({ hash: "#/loops/mine/edit" });
  const row = s.q(".stage-edit[data-stage=frame] tr[data-component=\"persona:researcher\"]");
  expect(text(row.querySelector(".hash"))).toBe(B.slice(0, 12));
  expect(row.querySelector(".hash")!.getAttribute("title")).toBe(B);
  // the goal and what is built in are not components
  expect(s.all(".stage-edit[data-stage=frame] tr[data-component]").map((r) => r.dataset.component)).toEqual(["persona:researcher"]);
  // rules are the profile's, for every stage
  expect(s.all(".every-stage tr[data-component]").map((r) => r.dataset.component)).toEqual(["rules:base-rules"]);
  const hashBox = row.querySelector("[data-field=pinned]") as HTMLInputElement;
  expect(hashBox.hidden).toBe(true);
  s.choose(row.querySelector("[data-field=source]")!, "pinned");
  expect(hashBox.hidden).toBe(false);
  s.fill(hashBox, "not a hash");
  expect(text(row.querySelector(".field-problem"))).toBe("A pinned hash is 64 lower-case hex characters");
  expect((await check(s)).components).toEqual({});
  s.fill(hashBox, PINNED);
  expect(row.querySelector(".field-problem")).toBeNull();
  expect((await check(s)).components).toEqual({ frame: { "persona:researcher": { pinned: PINNED } } });
  const rules = s.q(".every-stage tr[data-component=\"rules:base-rules\"]");
  s.choose(rules.querySelector("[data-field=source]")!, "pinned");
  s.fill(rules.querySelector("[data-field=pinned]")!, C);
  expect((await check(s)).components).toEqual({ frame: { "persona:researcher": { pinned: PINNED } }, "*": { "rules:base-rules": { pinned: C } } });
  s.choose(row.querySelector("[data-field=source]")!, "root");
  expect((await check(s)).components).toEqual({ "*": { "rules:base-rules": { pinned: C } } });
  s.choose(rules.querySelector("[data-field=source]")!, "root");
  expect(await check(s)).toEqual(mineDraft());
});

test("Check lists the server's problems, each beside its stage when it names one, and writes nothing", async () => {
  const s = await stub({
    hash: "#/loops/mine/edit",
    over: { checkLoop: (_id: string, draft: unknown) => { s0.calls.push(["checkLoop", "mine", JSON.parse(JSON.stringify(draft))]); return Promise.resolve({ ok: false, problems: ['loop "mine": stage "research": tool "x" is not in the fixed tool list', "components.review: \"persona:x\" is not a component of stage review", "loops/mine.yaml: the file could not be read"] }); } },
  });
  const s0 = s;
  s.click("[data-action=check]");
  await s.settle();
  expect(s.all(".stage-edit[data-stage=research] .problems li").map((li) => li.textContent)).toEqual(['loop "mine": stage "research": tool "x" is not in the fixed tool list']);
  expect(s.all(".stage-edit[data-stage=review] .problems li").map((li) => li.textContent)).toEqual(["components.review: \"persona:x\" is not a component of stage review"]);
  expect(s.all(".loop-form > .problems li").map((li) => li.textContent)).toEqual(["loops/mine.yaml: the file could not be read"]);
  expect(s.calls.some((c) => c[0] === "saveLoop")).toBe(false);
  await s.close(); open = null;
  const ok = await stub({ hash: "#/loops/mine/edit" });
  ok.click("[data-action=check]");
  await ok.settle();
  expect(text(ok.q(".loop-form .said"))).toBe("No problems: this draft would save");
  expect(ok.calls.some((c) => c[0] === "saveLoop")).toBe(false);
});

test("Save posts the draft with the loaded version and then shows the new version and hash", async () => {
  const s = await stub({ hash: "#/loops/mine/edit" });
  s.fill("[aria-label=\"Loop title\"]", "Mine, edited");
  s.fill("[aria-label=\"About\"]", "About, edited.");
  s.click("[data-action=save]");
  await s.settle();
  const save = s.calls.find((c) => c[0] === "saveLoop")!;
  expect(save).toEqual(["saveLoop", "mine", { ...mineDraft(), title: "Mine, edited", about: "About, edited." }, 3]);
  const said = s.q(".loop-form .said");
  expect(text(said)).toBe(`Saved as version 4 · ${F.slice(0, 12)}`);
  expect(said.querySelector("[title]")!.getAttribute("title")).toBe(F);
  // the next save carries the version just saved
  s.fill("[aria-label=\"About\"]", "Again.");
  s.click("[data-action=save]");
  await s.settle();
  expect(s.calls.filter((c) => c[0] === "saveLoop").at(-1)!.at(-1)).toBe(4);
});

test("a refused save keeps every field as typed and shows the reasons; a stale version says the loop changed since you opened it", async () => {
  let answer: string[] = ['loop "mine": stage "research": a stage that runs an agent needs a model'];
  const s = await stub({ hash: "#/loops/mine/edit", over: { saveLoop: (id: string, draft: unknown, version: number) => { s1.calls.push(["saveLoop", id, draft, version]); return Promise.resolve({ refused: answer }); } } });
  const s1 = s;
  s.fill("[aria-label=\"Loop title\"]", "Typed title");
  s.fill(field(s, "research", "title"), "Typed stage");
  s.fill(field(s, "research", "max_turns"), "9");
  s.choose(field(s, "research", "gate"), "plan");
  s.click("[data-action=save]");
  await s.settle();
  expect(text(s.q(".loop-form .save-row .refusal"))).toBe('Refused: loop "mine": stage "research": a stage that runs an agent needs a model');
  expect(s.all(".stage-edit[data-stage=research] .problems li").map((li) => li.textContent)).toEqual(['loop "mine": stage "research": a stage that runs an agent needs a model']);
  expect((s.q("[aria-label=\"Loop title\"]") as HTMLInputElement).value).toBe("Typed title");
  expect((field(s, "research", "title") as HTMLInputElement).value).toBe("Typed stage");
  expect((field(s, "research", "max_turns") as HTMLInputElement).value).toBe("9");
  expect((field(s, "research", "gate") as HTMLSelectElement).value).toBe("plan");
  answer = ["the loop changed since you opened it"];
  s.click("[data-action=save]");
  await s.settle();
  expect(text(s.q(".loop-form .save-row .refusal"))).toBe("Refused: the loop changed since you opened it");
  expect((field(s, "research", "title") as HTMLInputElement).value).toBe("Typed stage");
});

test("leaving with unsaved changes asks once; leaving after a save does not", async () => {
  const s = await stub({ hash: "#/loops/mine/edit" });
  // nothing changed: it leaves at once
  await go(s, "#/loops");
  expect(s.root.querySelector("[data-screen=loops]")).not.toBeNull();
  await go(s, "#/loops/mine/edit");
  s.fill("[aria-label=\"About\"]", "Changed.");
  await go(s, "#/loops");
  expect(s.win.location.hash).toBe("#/loops/mine/edit");
  expect(s.root.querySelector("[data-screen=loop_edit]")).not.toBeNull();
  expect(text(s.q(".leave-ask"))).toBe("This loop has changes that are not saved. Go there again to leave them, or Save first.");
  expect((s.q("[aria-label=\"About\"]") as HTMLTextAreaElement).value).toBe("Changed.");
  await go(s, "#/loops");
  expect(s.root.querySelector("[data-screen=loops]")).not.toBeNull();
  // after a save, nothing is asked
  await go(s, "#/loops/mine/edit");
  s.fill("[aria-label=\"About\"]", "Changed and saved.");
  s.click("[data-action=save]");
  await s.settle();
  await go(s, "#/loops");
  expect(s.root.querySelector("[data-screen=loops]")).not.toBeNull();
});

test("a stage title that looks like markup is the value of an input and a text node, never an element", async () => {
  const s = await stub({ hash: "#/loops/mine/edit", views: { mine: mine(mineDraft(MARKUP)) } });
  expect((field(s, "research", "title") as HTMLInputElement).value).toBe(MARKUP);
  expect(text(stageAt(s, "research").querySelector(".stage-name"))).toBe(`2. ${MARKUP}`);
  expect([...(field(s, "frame", "on_pass") as HTMLSelectElement).options].map((o) => o.textContent)).toContain(MARKUP);
  expect(s.root.querySelectorAll("img").length).toBe(0);
  expect(s.root.querySelectorAll("[onerror]").length).toBe(0);
});
