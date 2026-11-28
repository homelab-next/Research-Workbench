import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { eventSourceEntries, makeApi } from "../../src/web/api";
import type { Api, EntrySource } from "../../src/web/api";
import type { Entry, Marking, ModelChoice } from "../../src/core/types";
import type { BuilderFileView, BuilderSummaryView, BuilderView, CommandResult, LoopStageView, LoopSummaryView, LoopView, Me } from "../../src/core/wire";
import { startApp } from "../../src/web/app";
import { testUi } from "../helpers/dom";
import { EntryBuilder, card } from "../helpers/entries";

// Task 18: the builder's chat on the Loops screen and on a loop's screen. Happy-dom over a stub Api and a stub entry source: what the panel draws
// from a session's view and entries, and what it posts. Nothing is accepted or approved but by the person's own button.

const A = "a".repeat(64);
const MARKUP = "<script>alert(1)</script>";
const summaries = (): LoopSummaryView[] => [
  { id: "investigation", title: "Investigation", about: "Frame a question and research it.", version: 1, hash: A, stages: ["frame"], usable: true, problems: [], implicit: false, trusted: true, root: "sample", case_type: null },
  { id: "triage", title: "Triage", about: "Frame, then investigate as a child case.", version: 2, hash: A, stages: ["frame"], usable: true, problems: [], implicit: false, trusted: true, root: "sample", case_type: null },
];
const stage = (id: string): LoopStageView => ({
  id, title: "Frame", runs: "agent", role: id, gate: null, reviews: false, on_pass: null, on_fail: null, hash: A, inline: false, context: [], middleware: [],
  orchestration: { tools: [], model: null, fast_model: null, max_turns: null, send_back_cap: 3, subloop: null },
});
const loopView = (id: string): LoopView => ({ ...summaries().find((l) => l.id === id)!, entry: "frame", profile: "investigation", inputs: {}, outputs: {}, stage_views: [stage("frame")], caps: { max_depth: 2, max_children: 8 }, draft: null });
const builders = (): BuilderSummaryView[] => [
  { id: "BUILD-3", title: "Change the loop triage", loop: "triage", marking: "TLP:GREEN", created_ts: "2026-11-27T10:03:00.000Z", open_changes: 1, open_probes: 0, turns: 2 },
  { id: "BUILD-2", title: "Build a loop", loop: null, marking: "TLP:CLEAR", created_ts: "2026-11-27T10:02:00.000Z", open_changes: 0, open_probes: 0, turns: 0 },
  { id: "BUILD-1", title: "Change the loop triage", loop: "triage", marking: "TLP:GREEN", created_ts: "2026-11-27T10:01:00.000Z", open_changes: 0, open_probes: 0, turns: 1 },
];
const file = (over: Partial<BuilderFileView>): BuilderFileView => ({
  index: 0, path: "stages/frame.yaml", kind: "stage", id: "frame", new_file: false, decided: null, stale: false,
  lines: [{ op: " ", text: "kind: stage" }, { op: "-", text: "title: Frame" }, { op: "+", text: "title: Frame the question" }], ...over,
});
const SCOPE = { op: "+" as const, text: "id: scope" };
const emptyView = (id = "BUILD-3", marking: Marking = "TLP:GREEN"): BuilderView => ({ id, loop: "triage", marking, model: null, changes: [], probes: [] });
const withChange = (over: Partial<BuilderFileView>[] = [{}, { index: 1, path: "skills/scope.md", kind: "skill", id: "scope", new_file: true, lines: [SCOPE] }]): BuilderView => ({
  ...emptyView(), changes: [{ id: "chg-1", title: "Name the frame stage plainly", why: "the person asked for a clearer title", files: over.map(file) }],
});
const QUERY = "SELECT name FROM sqlite_master WHERE type = 'table'";
const withProbes = (decided: BuilderView["probes"][number]["decided"] = null): BuilderView => ({
  ...emptyView(), probes: [
    { id: "probe-1", kind: "query", source: "flows", pivot: null, value: null, text: QUERY, why: "to see what tables it holds", costly: false, decided },
    { id: "probe-2", kind: "pivot", source: "reputation", pivot: "address_to_verdict", value: { type: "ipv4", value: "198.51.100.7" }, text: null, why: "to see what a verdict looks like", costly: true, decided: null },
  ],
});

interface Stub {
  win: Window; root: HTMLElement; calls: unknown[][];
  /** The entries the open stream is fed; `push` sends one to every stream open for that id. */
  feed: EntryBuilder; push(e: Entry): void; streams(): { id: string; prefix: string | undefined; open: boolean }[];
  view: BuilderView; refusal: string[] | null;
  click(selector: string): void; fill(selector: string, text: string): void; q(selector: string): HTMLElement; all(selector: string): HTMLElement[];
  key(selector: string, key: string, mods?: { shift?: boolean }): void;
  settle(): Promise<void>; close(): Promise<void>;
}
let open: Stub | null = null;
afterEach(async () => { await open?.close(); open = null; });

const ok = (seq = 1): CommandResult => ({ ok: true, seq });

async function stub(opts: { hash: string; view?: BuilderView; list?: BuilderSummaryView[]; models?: ModelChoice[]; role?: Me["role"] }): Promise<Stub> {
  const win = new Window({ url: `http://127.0.0.1:1/${opts.hash}` });
  const doc = win.document as unknown as Document;
  const calls: unknown[][] = [];
  const feed = new EntryBuilder("BUILD-3");
  feed.add("case.created", { id: "BUILD-3", title: "Change the loop triage", asked: "Build or change a loop", why: "a builder session", starting: [], window: { from: null, to: null }, objective: null, marking: "TLP:GREEN" }, { actor: { kind: "human", id: "analyst" } });
  const live: { id: string; prefix: string | undefined; open: boolean; onEntry: (e: Entry) => void }[] = [];
  const rec = <T>(name: string, value: T, ...args: unknown[]): Promise<T> => { calls.push([name, ...args]); return Promise.resolve(value); };
  const entries: EntrySource = {
    open(id, after, onEntry, _onDrop, prefix) {
      calls.push(["entries.open", id, after, prefix]);
      const s = { id, prefix, open: true, onEntry };
      live.push(s);
      for (const e of feed.entries) if (e.case === id && e.seq > after) onEntry(e);
      return () => { s.open = false; };
    },
  };
  const s = {} as Stub;
  s.view = opts.view ?? emptyView();
  s.refusal = null;
  const api = {
    cases: () => rec("cases", []),
    loops: () => rec("loops", summaries()),
    loop: (id: string) => rec("loop", loopView(id), id),
    loopFiles: () => rec("loopFiles", []),
    loopFilePath: (f: string) => `/api/loop-files/${f}`,
    builders: () => rec("builders", opts.list ?? builders()),
    newBuilder: (loop: string | null, marking: Marking) => rec("newBuilder", { id: "BUILD-4" }, loop, marking),
    builderView: (id: string) => rec("builderView", { ...s.view, id }, id),
    builderAsk: (id: string, text: string) => rec("builderAsk", ok(), id, text),
    builderDecide: (id: string, change: string, f: number, accept: boolean) =>
      rec("builderDecide", s.refusal === null ? ok() : { ok: false as const, refused: s.refusal }, id, change, f, accept),
    builderProbe: (id: string, probe: string, approve: boolean, budget: number | null) => rec("builderProbe", ok(), id, probe, approve, budget),
    builderModel: (id: string, choice: ModelChoice) => rec("builderModel", ok(), id, choice),
    entries,
  } as unknown as Api;
  const base = testUi(win);
  const ui = testUi(win, {
    api,
    me: { user: "analyst", role: opts.role ?? "analyst", origin: "http://127.0.0.1:1", markings: ["TLP:CLEAR", "TLP:GREEN", "TLP:AMBER", "TLP:AMBER+STRICT", "TLP:RED"], policy: {} as never, problems: [], cases: { store: "<data>/cases", on_complete: "keep" }, loops: { default: "investigation" } },
    ref: { ...base.ref, stage_models: opts.models ?? [{ provider: "scripted", model: "sample-run", effort: null }] },
  });
  const root = doc.createElement("div");
  doc.body.append(root);
  const app = startApp(ui, root);
  const q = (selector: string): HTMLElement => {
    const found = root.querySelector(selector);
    if (found === null) throw new Error(`nothing matches ${selector}; the page says: ${(root.textContent ?? "").slice(0, 400)}`);
    return found as HTMLElement;
  };
  Object.assign(s, {
    win, root, calls, feed, q, all: (selector: string) => [...root.querySelectorAll(selector)] as HTMLElement[],
    push(e: Entry) { for (const l of live) if (l.open && l.id === e.case) l.onEntry(e); },
    streams: () => live.map(({ id, prefix, open: o }) => ({ id, prefix, open: o })),
    click(selector: string) { q(selector).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event); },
    fill(selector: string, text: string) { const i = q(selector) as HTMLInputElement; i.value = text; i.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event); },
    key(selector: string, key: string, mods: { shift?: boolean } = {}) {
      const el = q(selector);
      el.focus();
      el.dispatchEvent(new win.KeyboardEvent("keydown", { key, shiftKey: mods.shift ?? false, bubbles: true, cancelable: true }) as unknown as Event);
    },
    async settle() { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); },
    async close() { app.destroy(); await win.happyDOM.close(); },
  });
  open = s;
  await s.settle();
  return s;
}
/** Opens BUILD-3 from the panel's list. */
async function openSession(s: Stub): Promise<void> {
  s.click(".builder-sessions [data-builder=BUILD-3] [data-action=open-builder]");
  await s.settle();
}
const text = (el: Element | null): string => el?.textContent ?? "";
const posted = (s: Stub, name: string): unknown[][] => s.calls.filter((c) => c[0] === name);

test("the Loops screen and a loop's screen each have Build with help; New conversation makes a session for that loop with the chosen marking", async () => {
  const s = await stub({ hash: "#/loops" });
  const panel = s.q("[data-screen=loops] .builder-panel");
  expect(text(panel.querySelector("h2"))).toBe("Build with help");
  // on the Loops screen it is about no loop: the sessions about no loop
  expect(s.all(".builder-sessions [data-builder]").map((e) => e.dataset.builder)).toEqual(["BUILD-2"]);
  // the marking select is least restrictive first
  expect([...(s.q(".builder-new [aria-label=Marking]") as HTMLSelectElement).options].map((o) => o.value)).toEqual(["TLP:CLEAR", "TLP:GREEN", "TLP:AMBER", "TLP:AMBER+STRICT", "TLP:RED"]);
  (s.q(".builder-new [aria-label=Marking]") as HTMLSelectElement).value = "TLP:AMBER";
  s.click(".builder-new [data-action=new-builder]");
  await s.settle();
  expect(posted(s, "newBuilder")).toEqual([["newBuilder", null, "TLP:AMBER"]]);
  // the new session is open, its stream from the builders' path
  expect(s.streams().at(-1)).toEqual({ id: "BUILD-4", prefix: "builders", open: true });

  // on a loop's screen it is about that loop, newest first; a model picked goes with the new session
  s.win.location.hash = "#/loops/triage";
  await s.settle();
  expect(s.q("[data-screen=loop] .builder-panel h2").textContent).toBe("Build with help");
  expect(s.all(".builder-sessions [data-builder]").map((e) => e.dataset.builder)).toEqual(["BUILD-3", "BUILD-1"]);
  const model = s.q(".builder-new [aria-label=Model]") as HTMLSelectElement;
  model.value = "0";
  s.click(".builder-new [data-action=new-builder]");
  await s.settle();
  expect(posted(s, "newBuilder").at(-1)).toEqual(["newBuilder", "triage", "TLP:CLEAR"]);
  expect(posted(s, "builderModel").at(-1)).toEqual(["builderModel", "BUILD-4", { provider: "scripted", model: "sample-run", effort: null }]);
});

test("a question is sent on Enter and shown as pending until agent.answered arrives", async () => {
  const s = await stub({ hash: "#/loops/triage" });
  await openSession(s);
  const box = s.q(".builder-open [aria-label='Ask the builder']") as HTMLTextAreaElement;
  box.value = "Add a scope skill to the frame stage";
  s.key(".builder-open [aria-label='Ask the builder']", "Enter");
  await s.settle();
  expect(posted(s, "builderAsk")).toEqual([["builderAsk", "BUILD-3", "Add a scope skill to the frame stage"]]);
  expect(box.value).toBe("");
  const asked = s.feed.add("agent.asked", { turn: "u1", text: "Add a scope skill to the frame stage", left_out: [], added: [] }, { actor: { kind: "human", id: "analyst" } });
  s.push(asked);
  await s.settle();
  const turn = s.q(".builder-turns [data-turn=u1]");
  expect(text(turn.querySelector(".question"))).toBe("Add a scope skill to the frame stage");
  expect(text(turn.querySelector(".status"))).toBe("thinking…");
  expect(turn.querySelector(".answer-text")).toBeNull();
  s.push(s.feed.add("agent.answered", { turn: "u1", request: "r1", text: "I have proposed a change for you to accept.", cites: [] }, { actor: { kind: "agent", id: "builder", stage: "builder", profile: "loop-builder", model: "m", effort: null, where: "machine" } as never }));
  await s.settle();
  expect(text(s.q(".builder-turns [data-turn=u1] .answer-text"))).toBe("I have proposed a change for you to accept.");
  expect(s.q(".builder-turns [data-turn=u1]").querySelector(".status")).toBeNull();
  // Shift+Enter is a new line, not a send
  box.value = "two";
  s.key(".builder-open [aria-label='Ask the builder']", "Enter", { shift: true });
  await s.settle();
  expect(posted(s, "builderAsk").length).toBe(1);
});

test("a proposed change shows one block per file with its path and its diff, each line starting with +, - or a space", async () => {
  const s = await stub({ hash: "#/loops/triage", view: withChange() });
  await openSession(s);
  const change = s.q(".builder-change[data-change=chg-1]");
  expect(text(change.querySelector(".change-title"))).toBe("Name the frame stage plainly");
  expect(text(change.querySelector(".change-why"))).toBe("the person asked for a clearer title");
  const files = [...change.querySelectorAll(".builder-file")] as HTMLElement[];
  expect(files.map((f) => f.dataset.file)).toEqual(["0", "1"]);
  expect(text(files[0]!.querySelector(".file-path"))).toBe("stages/frame.yaml");
  expect(text(files[0]!.querySelector(".file-state"))).toBe("changed");
  expect(text(files[1]!.querySelector(".file-path"))).toBe("skills/scope.md");
  expect(text(files[1]!.querySelector(".file-state"))).toBe("new file");
  const lines = [...files[0]!.querySelectorAll(".diff-line")] as HTMLElement[];
  expect(lines.map((l) => l.textContent)).toEqual([" kind: stage", "-title: Frame", "+title: Frame the question"]);
  expect(lines.map((l) => l.className)).toEqual(["diff-line diff-context", "diff-line diff-removed", "diff-line diff-added"]);
  expect([...files[1]!.querySelectorAll(".diff-line")].map((l) => l.textContent)).toEqual(["+id: scope"]);
  for (const f of files) {
    expect(text(f.querySelector("[data-action=accept]"))).toBe("Accept");
    expect(text(f.querySelector("[data-action=reject]"))).toBe("Reject");
  }
});

test("a diff line, a path and a title that look like markup are text nodes: no element is made from them", async () => {
  const view = withChange([{ path: `stages/${MARKUP}.yaml`, lines: [{ op: "+", text: MARKUP }, { op: " ", text: "<img src=x onerror=alert(2)>" }] }]);
  view.changes[0]!.title = MARKUP;
  view.changes[0]!.why = "<b>bold</b>";
  const s = await stub({ hash: "#/loops/triage", view });
  await openSession(s);
  s.key(".builder-open [aria-label='Ask the builder']", "x");    // nothing typed is sent
  s.push(s.feed.add("agent.asked", { turn: "u1", text: MARKUP, left_out: [], added: [] }, { actor: { kind: "human", id: "analyst" } }));
  s.push(s.feed.add("agent.answered", { turn: "u1", request: "r1", text: `${MARKUP}<b>answer</b>`, cites: [] }, { actor: { kind: "agent", id: "builder", stage: "builder", profile: "loop-builder", model: "m", effort: null, where: "machine" } as never }));
  await s.settle();
  const panel = s.q(".builder-panel");
  expect(panel.querySelectorAll("script, img, b").length).toBe(0);
  expect(text(panel.querySelector(".change-title"))).toBe(MARKUP);
  expect(text(panel.querySelector(".change-why"))).toBe("<b>bold</b>");
  expect(text(panel.querySelector(".file-path"))).toBe(`stages/${MARKUP}.yaml`);
  expect([...panel.querySelectorAll(".diff-line")].map((l) => l.textContent)).toEqual([`+${MARKUP}`, " <img src=x onerror=alert(2)>"]);
  for (const l of panel.querySelectorAll(".diff-line")) expect(l.children.length).toBe(0);
  expect(text(panel.querySelector(".question"))).toBe(MARKUP);
  expect(text(panel.querySelector(".answer-text"))).toBe(`${MARKUP}<b>answer</b>`);
});

test("Accept and Reject act on one file: each posts that change and that index, and the other files stay undecided", async () => {
  const s = await stub({ hash: "#/loops/triage", view: withChange() });
  await openSession(s);
  s.click(".builder-file[data-file='1'] [data-action=accept]");
  await s.settle();
  expect(posted(s, "builderDecide")).toEqual([["builderDecide", "BUILD-3", "chg-1", 1, true]]);
  // the server says file 1 is accepted; file 0 is still open
  s.view = withChange([{}, { index: 1, path: "skills/scope.md", kind: "skill", id: "scope", new_file: true, lines: [SCOPE], decided: { accepted: true } }]);
  s.push(s.feed.add("builder.decided", { change: "chg-1", file: 1, accepted: true, written: null }, { actor: { kind: "human", id: "analyst" } }));
  await s.settle();
  expect(text(s.q(".builder-file[data-file='1'] .file-decided"))).toBe("Accepted");
  expect(s.q(".builder-file[data-file='1']").querySelector("[data-action=accept]")).toBeNull();
  expect(s.q(".builder-file[data-file='0']").querySelector(".file-decided")).toBeNull();
  expect(s.q(".builder-file[data-file='0'] [data-action=accept]")).toBeTruthy();
  s.click(".builder-file[data-file='0'] [data-action=reject]");
  await s.settle();
  expect(posted(s, "builderDecide").at(-1)).toEqual(["builderDecide", "BUILD-3", "chg-1", 0, false]);
  expect(posted(s, "builderDecide").length).toBe(2);
});

test("a refused accept shows its reasons at that file and the file stays undecided", async () => {
  const s = await stub({ hash: "#/loops/triage", view: withChange() });
  await openSession(s);
  s.refusal = ["stages/frame.yaml: the skill \"scope\" is not loaded; accept skills/scope.md first"];
  s.click(".builder-file[data-file='0'] [data-action=accept]");
  await s.settle();
  const f0 = s.q(".builder-file[data-file='0']");
  expect(text(f0.querySelector(".refusal"))).toBe("Refused: stages/frame.yaml: the skill \"scope\" is not loaded; accept skills/scope.md first");
  expect(f0.querySelector(".file-decided")).toBeNull();
  expect(f0.querySelector("[data-action=accept]")).toBeTruthy();
  expect(s.q(".builder-file[data-file='1']").querySelector(".refusal")).toBeNull();
});

test("a stale file says it changed since it was proposed and has no Accept", async () => {
  const s = await stub({ hash: "#/loops/triage", view: withChange([{ stale: true }]) });
  await openSession(s);
  const f = s.q(".builder-file[data-file='0']");
  expect(text(f.querySelector(".file-stale"))).toBe("This file changed on disk since it was proposed, so it cannot be accepted.");
  expect(f.querySelector("[data-action=accept]")).toBeNull();
  expect(f.querySelector("[data-action=reject]")).toBeTruthy();
});

test("a probe shows what would run and where; Approve posts the approval, with the budget for a costly one; Reject posts the rejection", async () => {
  const s = await stub({ hash: "#/loops/triage", view: withProbes() });
  await openSession(s);
  const p1 = s.q(".builder-probe[data-probe=probe-1]");
  expect(text(p1.querySelector(".probe-query"))).toBe(QUERY);
  expect(text(p1.querySelector(".probe-source"))).toBe("on the source flows");
  expect(text(p1.querySelector(".probe-why"))).toBe("to see what tables it holds");
  expect(p1.querySelector("[aria-label=Budget]")).toBeNull();
  const p2 = s.q(".builder-probe[data-probe=probe-2]");
  expect(text(p2.querySelector(".probe-what"))).toBe("the pivot address_to_verdict on ipv4 198.51.100.7");
  expect(text(p2.querySelector(".probe-source"))).toBe("on the source reputation");
  expect(text(p2.querySelector(".probe-costly"))).toBe("costly");
  s.click(".builder-probe[data-probe=probe-1] [data-action=approve]");
  await s.settle();
  expect(posted(s, "builderProbe")).toEqual([["builderProbe", "BUILD-3", "probe-1", true, null]]);
  s.fill(".builder-probe[data-probe=probe-2] [aria-label=Budget]", "5");
  s.click(".builder-probe[data-probe=probe-2] [data-action=approve]");
  await s.settle();
  expect(posted(s, "builderProbe").at(-1)).toEqual(["builderProbe", "BUILD-3", "probe-2", true, 5]);
  s.click(".builder-probe[data-probe=probe-2] [data-action=reject]");
  await s.settle();
  expect(posted(s, "builderProbe").at(-1)).toEqual(["builderProbe", "BUILD-3", "probe-2", false, null]);
});

test("a decided probe shows its outcome, and a card's title and first rows when it ran", async () => {
  const s = await stub({ hash: "#/loops/triage", view: withProbes({ approved: true, outcome: "ran", detail: "3 rows", card: "c1" }) });
  s.feed.add("card.created", { card: card("c1", { title: "Tables of flows", columns: ["name"], rows: [["flows"], ["hosts"], ["<b>x</b>"]], row_count: 3, marking: "TLP:GREEN" }) }, { actor: { kind: "human", id: "analyst" } });
  await openSession(s);
  const p1 = s.q(".builder-probe[data-probe=probe-1]");
  expect(text(p1.querySelector(".probe-outcome"))).toBe("Approved: ran · 3 rows");
  expect(p1.querySelector("[data-action=approve]")).toBeNull();
  expect(text(p1.querySelector(".probe-card .card-title"))).toBe("c1 · Tables of flows");
  expect([...p1.querySelectorAll(".probe-card td")].map((c) => c.textContent)).toEqual(["flows", "hosts", "<b>x</b>"]);
  expect(p1.querySelectorAll("b").length).toBe(0);
  await s.close(); open = null;
  const r = await stub({ hash: "#/loops/triage", view: withProbes({ approved: false, outcome: "rejected", detail: "", card: null }) });
  await openSession(r);
  expect(text(r.q(".builder-probe[data-probe=probe-1] .probe-outcome"))).toBe("Rejected");
  expect(r.q(".builder-probe[data-probe=probe-1]").querySelector(".probe-card")).toBeNull();
});

test("the marking chip follows the view's marking", async () => {
  const s = await stub({ hash: "#/loops/triage" });
  await openSession(s);
  expect(text(s.q(".builder-panel .builder-head .marking"))).toBe("TLP:GREEN");
  // a probe's card raises the session's marking: the view says so, and the chip follows
  s.view = emptyView("BUILD-3", "TLP:AMBER");
  s.push(s.feed.add("card.created", { card: card("c1", { marking: "TLP:AMBER" }) }, { actor: { kind: "human", id: "analyst" } }));
  await s.settle();
  expect(text(s.q(".builder-panel .builder-head .marking"))).toBe("TLP:AMBER");
});

test("Enter never accepts or approves: with focus on Accept nothing is posted until it is activated, and Enter in the composer posts only an ask", async () => {
  const view = withChange();
  view.probes = withProbes().probes;
  const s = await stub({ hash: "#/loops/triage", view });
  await openSession(s);
  for (const sel of [".builder-file[data-file='0'] [data-action=accept]", ".builder-probe[data-probe=probe-1] [data-action=approve]"]) {
    s.key(sel, "Enter");
    s.key(sel, "Enter", { shift: true });
    s.key(sel, " ");
  }
  await s.settle();
  expect(posted(s, "builderDecide")).toEqual([]);
  expect(posted(s, "builderProbe")).toEqual([]);
  (s.q(".builder-open [aria-label='Ask the builder']") as HTMLTextAreaElement).value = "yes, accept it";
  s.key(".builder-open [aria-label='Ask the builder']", "Enter");
  await s.settle();
  expect(posted(s, "builderAsk")).toEqual([["builderAsk", "BUILD-3", "yes, accept it"]]);
  expect(posted(s, "builderDecide")).toEqual([]);
  expect(posted(s, "builderProbe")).toEqual([]);
  s.click(".builder-file[data-file='0'] [data-action=accept]");
  await s.settle();
  expect(posted(s, "builderDecide")).toEqual([["builderDecide", "BUILD-3", "chg-1", 0, true]]);
});

test("leaving the screen closes the session's stream", async () => {
  const s = await stub({ hash: "#/loops/triage" });
  await openSession(s);
  expect(s.streams()).toEqual([{ id: "BUILD-3", prefix: "builders", open: true }]);
  s.win.location.hash = "#/loops";
  await s.settle();
  expect(s.streams()[0]!.open).toBe(false);
  // and opening another session closes the one before
  s.win.location.hash = "#/loops/triage";
  await s.settle();
  await openSession(s);
  s.click(".builder-sessions [data-builder=BUILD-1] [data-action=open-builder]");
  await s.settle();
  expect(s.streams().map((x) => [x.id, x.open])).toEqual([["BUILD-3", false], ["BUILD-3", false], ["BUILD-1", true]]);
});

test("the Api's builder calls go to the builder routes, and the entry source reads a builder session's stream from /api/builders", async () => {
  const seen: [string, string, unknown][] = [];
  const fetcher = async (req: Request): Promise<Response> => {
    seen.push([req.method, new URL(req.url).pathname, req.method === "POST" ? await req.json() : null]);
    return Response.json(req.url.endsWith("/api/builders") && req.method === "POST" ? { id: "BUILD-1" } : req.url.endsWith("/view") ? emptyView("BUILD-1") : req.method === "GET" ? [] : { ok: true, seq: 2 });
  };
  const urls: string[] = [];
  const win = { EventSource: class { constructor(u: string) { urls.push(u); } addEventListener(): void {} close(): void {} } } as unknown as globalThis.Window;
  const api = makeApi(fetcher, "http://127.0.0.1:1", eventSourceEntries(win, "http://127.0.0.1:1"));
  expect(await api.newBuilder("triage", "TLP:GREEN")).toEqual({ id: "BUILD-1" });
  await api.builders(); await api.builderView("BUILD-1"); await api.builderAsk("BUILD-1", "hello");
  await api.builderDecide("BUILD-1", "chg-1", 0, true); await api.builderProbe("BUILD-1", "probe-1", true, 5);
  await api.builderModel("BUILD-1", { provider: "scripted", model: "m", effort: null });
  expect(seen).toEqual([
    ["POST", "/api/builders", { loop: "triage", marking: "TLP:GREEN" }], ["GET", "/api/builders", null], ["GET", "/api/builders/BUILD-1/view", null],
    ["POST", "/api/builders/BUILD-1/ask", { text: "hello" }], ["POST", "/api/builders/BUILD-1/decide", { change: "chg-1", file: 0, accept: true }],
    ["POST", "/api/builders/BUILD-1/probe", { probe: "probe-1", approve: true, budget: 5 }], ["POST", "/api/builders/BUILD-1/model", { choice: { provider: "scripted", model: "m", effort: null } }],
  ]);
  api.entries.open("BUILD-1", 3, () => {}, () => {}, "builders")();
  api.entries.open("CASE-1", 0, () => {}, () => {})();
  expect(urls).toEqual(["http://127.0.0.1:1/api/builders/BUILD-1/entries?after=3", "http://127.0.0.1:1/api/cases/CASE-1/entries?after=0"]);
});
