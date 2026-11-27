import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { Api } from "../../src/web/api";
import type { ItemView, LoopFileView, LoopStageView, LoopSummaryView, LoopView, Me, NewCaseInput } from "../../src/core/wire";
import { parseRoute, routeHash, startApp } from "../../src/web/app";
import { testUi } from "../helpers/dom";

// Task 12: the Loops list beside the cases, a plain outline of one loop, and a new case from a loop. Happy-dom over a stub Api: what the screens
// draw from the server's views, and what they post.

const A = "a".repeat(64), B = "b".repeat(64), C = "c".repeat(64), D = "d".repeat(64), E = "e".repeat(64);
const INVESTIGATION_STAGES: [string, string][] = [
  ["frame", "Frame"], ["plan", "Plan"], ["research", "Research"], ["assemble", "Assemble"], ["checks", "Checks"],
  ["evaluate", "Evaluate"], ["challenge", "Challenge"], ["publish", "Publish"], ["feedback", "Feedback"],
];
const summaries = (): LoopSummaryView[] => [
  { id: "investigation", title: "Investigation", about: "Frame a question, plan and run the research.", version: 1, hash: A, stages: INVESTIGATION_STAGES.map(([id]) => id), usable: true, problems: [], implicit: false, trusted: true, root: "sample" },
  { id: "triage", title: "Triage", about: "Frame the question, then run an investigation as a child case.", version: 2, hash: B, stages: ["frame", "investigate"], usable: true, problems: [], implicit: false, trusted: true, root: "sample" },
  { id: "broken", title: "Broken", about: "An imported loop.", version: 1, hash: null, stages: ["frame"], usable: false, problems: ["a loop manifest is accepted only from a trusted root"], implicit: false, trusted: false, root: "broken-0123456789ab" },
];
const item = (kind: string, id: string, title: string, source: ItemView["source"], hash: string | null): ItemView => ({ kind, id, title, source, hash });
const stage = (id: string, title: string, over: Partial<LoopStageView> = {}): LoopStageView => ({
  id, title, runs: "agent", role: id, gate: null, reviews: false, on_pass: null, on_fail: null, hash: E, inline: false, context: [], middleware: [],
  orchestration: { tools: [], model: null, fast_model: null, max_turns: null, send_back_cap: 3, subloop: null }, ...over,
});
const viewOf = (s: LoopSummaryView, stage_views: LoopStageView[]): LoopView => ({
  ...s, entry: stage_views[0]?.id ?? null, profile: "investigation", inputs: {}, outputs: {}, stage_views, caps: { max_depth: 2, max_children: 8 }, draft: null,
});
const investigation = (): LoopView => {
  const ids = INVESTIGATION_STAGES;
  return viewOf(summaries()[0]!, ids.map(([id, title], i) => stage(id, title, {
    gate: id === "plan" ? "plan" : id === "publish" ? "publish" : null,
    on_pass: ids[i + 1]?.[0] ?? null,
    on_fail: id === "evaluate" ? "assemble" : null,
  })));
};
const triage = (): LoopView => viewOf(summaries()[1]!, [
  stage("frame", "Frame", {
    on_pass: "investigate",
    context: [item("persona", "researcher", "Researcher", "root", C), item("rules", "base-rules", "Base rules", "root", A), item("skill", "ask-the-person", "Ask the person", "pinned", D)],
    middleware: [item("built-in", "query-guard", "The query guard", "built-in", null), item("built-in", "marking-policy", "The marking policy", "built-in", null)],
    orchestration: { tools: ["run_query", "ask_question"], model: { provider: "scripted", model: "sample-run", effort: "high" }, fast_model: null, max_turns: 12, send_back_cap: 3, subloop: null },
  }),
  stage("investigate", "Investigate", {
    runs: "loop", role: "subloop", inline: true,
    orchestration: { tools: [], model: null, fast_model: null, max_turns: null, send_back_cap: 3, subloop: { loop: "investigation", hash: A, inputs: { question: "case.question" }, returns: { cards: "cards" } } },
  }),
]);
const files = (): LoopFileView[] => [
  { file: "triage.v2.bbbbbbbbbbbb.loop.tar.gz", loop: "triage", version: 2, title: "Triage", hash: B, files: 42, bytes: 4096, plan: { write: 12, same: 30, conflicts: [] }, problem: null },
  { file: "other.v1.cccccccccccc.loop.tar.gz", loop: "other", version: 1, title: "Other", hash: C, files: 3, bytes: 512, plan: { write: 1, same: 0, conflicts: ['source "edr" (manifests/sources/edr.yaml) is already loaded with other content'] }, problem: null },
];

interface Stub {
  win: Window; root: HTMLElement; calls: unknown[][];
  click(selector: string): void; fill(selector: string, text: string): void; q(selector: string): HTMLElement; all(selector: string): HTMLElement[];
  settle(): Promise<void>; actions(): Record<string, () => void>; close(): Promise<void>;
}
let open: Stub | null = null;
afterEach(async () => { await open?.close(); open = null; });

/** startApp over a stub Api: every call is recorded; `over` replaces what a method answers. */
async function stub(opts: { role?: Me["role"]; hash?: string; over?: Partial<Api>; defaultLoop?: string } = {}): Promise<Stub> {
  const win = new Window({ url: `http://127.0.0.1:1/${opts.hash ?? ""}` });
  const doc = win.document as unknown as Document;
  const calls: unknown[][] = [];
  const rec = <T>(name: string, value: T, ...args: unknown[]): Promise<T> => { calls.push([name, ...args]); return Promise.resolve(value); };
  const api = {
    cases: () => rec("cases", []),
    loops: () => rec("loops", summaries()),
    loop: (id: string) => (id === "triage" ? rec("loop", triage(), id) : id === "investigation" ? rec("loop", investigation(), id) : Promise.reject(new Error("404"))),
    loopFiles: () => rec("loopFiles", files()),
    exportLoop: (id: string) => rec("exportLoop", { file: "triage.v2.bbbbbbbbbbbb.loop.tar.gz" }, id),
    importLoop: (file: string) => rec("importLoop", { root: "triage-bbbbbbbbbbbb", written: 12, same: 30 }, file),
    trustRoot: (root: string, typed: string) => rec("trustRoot", { ok: true as const }, root, typed),
    loopFilePath: (file: string) => `/api/loop-files/${file}`,
    newCase: (input: NewCaseInput) => rec("newCase", { refused: ["held here by the test"] }, input),
    entries: { open: () => () => {} },
    ...opts.over,
  } as unknown as Api;
  const ui = testUi(win, { api, me: { user: "analyst", role: opts.role ?? "analyst", origin: "http://127.0.0.1:1", markings: ["TLP:GREEN"], policy: {} as never, problems: [], cases: { store: "<data>/cases", on_complete: "keep" }, loops: { default: opts.defaultLoop ?? "investigation" } } });
  const root = doc.createElement("div");
  doc.body.append(root);
  const app = startApp(ui, root);
  const q = (selector: string): HTMLElement => {
    const found = root.querySelector(selector);
    if (found === null) throw new Error(`nothing matches ${selector}; the page says: ${(root.textContent ?? "").slice(0, 300)}`);
    return found as HTMLElement;
  };
  const s: Stub = {
    win, root, calls, q, all: (selector) => [...root.querySelectorAll(selector)] as HTMLElement[],
    click(selector) { q(selector).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event); },
    fill(selector, text) { const i = q(selector) as HTMLInputElement; i.value = text; i.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event); },
    async settle() { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); },
    actions: () => app.actions(),
    async close() { app.destroy(); await win.happyDOM.close(); },
  };
  open = s;
  await s.settle();
  return s;
}
const go = async (s: Stub, hash: string): Promise<void> => { s.win.location.hash = hash; await s.settle(); };
const text = (el: Element | null): string => el?.textContent ?? "";

test("the home screen has a Loops tile for the analyst with the count of usable loops, and none for a requester", async () => {
  const s = await stub();
  const tile = s.q("[data-column=resources] [data-mode=loops]");
  expect(tile.querySelector(".label")!.textContent).toBe("Loops");
  expect(tile.querySelector(".count")!.textContent).toBe("2 usable");
  expect(tile.className).not.toContain("soon");
  s.click("[data-mode=loops]");
  await s.settle();
  expect(s.win.location.hash).toBe("#/loops");
  expect(s.q("[data-screen=loops] h1").textContent).toBe("Loops");
  await s.close(); open = null;
  const r = await stub({ role: "requester" });
  expect(r.root.querySelector("[data-mode=loops]")).toBeNull();
  expect(r.calls.some((c) => c[0] === "loops")).toBe(false);
  await go(r, "#/loops");
  expect(r.root.querySelector("[data-screen=loops]")).toBeNull();
});

test("the Loops screen lists each loop with its title, version, short hash, stages and about text", async () => {
  const s = await stub({ hash: "#/loops" });
  expect(s.all(".loop-tile").map((t) => t.dataset.loop)).toEqual(["investigation", "triage", "broken"]);
  const t = s.q(".loop-tile[data-loop=triage]");
  expect(text(t.querySelector(".head"))).toBe("Triage");
  expect(text(t.querySelector(".version"))).toBe("v2 · bbbbbbbbbbbb");
  expect(t.querySelector(".version")!.getAttribute("title")).toBe(B);
  expect(text(t.querySelector(".stages"))).toBe("Frame → Investigate");
  expect(text(t.querySelector(".about"))).toBe("Frame the question, then run an investigation as a child case.");
  expect(text(s.q(".loop-tile[data-loop=investigation] .stages"))).toBe(INVESTIGATION_STAGES.map(([, t]) => t).join(" → "));
  // the tile's title opens the loop's screen
  s.click(".loop-tile[data-loop=triage] [data-action=open-loop]");
  await s.settle();
  expect(s.win.location.hash).toBe("#/loops/triage");
});

test("New case from this loop goes to #/investigate/new/<id>, and the new-case form posts that loop", async () => {
  const s = await stub({ hash: "#/loops" });
  expect(text(s.q(".loop-tile[data-loop=triage] [data-action=new-from-loop]"))).toBe("New case from this loop");
  s.click(".loop-tile[data-loop=triage] [data-action=new-from-loop]");
  await s.settle();
  expect(s.win.location.hash).toBe("#/investigate/new/triage");
  expect(s.q("[data-screen=new] .loop-line").textContent).toBe("Loop: Triage");
  s.fill("[aria-label=Title]", "Odd traffic");
  s.fill("[aria-label='Starting value 1']", "198.51.100.7");
  s.click("[data-screen=new] button.primary");
  await s.settle();
  const posted = s.calls.find((c) => c[0] === "newCase")![1] as NewCaseInput;
  expect(posted.loop).toBe("triage");
  expect(posted.title).toBe("Odd traffic");
  expect(text(s.q("[data-screen=new] .refusals"))).toContain("held here by the test");
  // the plain form posts no loop: the server takes the default
  await go(s, "#/investigate/new");
  expect(s.root.querySelector("[data-screen=new] .loop-line")).toBeNull();
  s.fill("[aria-label=Title]", "Plain");
  s.click("[data-screen=new] button.primary");
  await s.settle();
  const plain = s.calls.filter((c) => c[0] === "newCase").at(-1)![1] as NewCaseInput;
  expect("loop" in plain).toBe(false);
  // and from the loop's own screen
  await go(s, "#/loops/triage");
  s.click("[data-screen=loop] [data-action=new-from-loop]");
  await s.settle();
  expect(s.win.location.hash).toBe("#/investigate/new/triage");
});

test("a loop that is not usable shows its problems and has no New case button", async () => {
  const s = await stub({ hash: "#/loops" });
  const t = s.q(".loop-tile[data-loop=broken]");
  expect(t.className).toContain("unusable");
  expect([...t.querySelectorAll(".problems li")].map((li) => li.textContent)).toEqual(["a loop manifest is accepted only from a trusted root"]);
  expect(t.querySelector("[data-action=new-from-loop]")).toBeNull();
  expect(text(t.querySelector(".version"))).toBe("v1 · no hash");
  // its own screen says the same, and offers no new case
  await go(s, "#/loops/broken");
  expect(s.root.querySelector("[data-screen=loop] [data-action=new-from-loop]")).toBeNull();
});

test("a title, an about text and a problem that look like markup are drawn as text: no element is made from them", async () => {
  const markup = "<img src=x onerror=alert(1)>";
  const loops = (): LoopSummaryView[] => [{ ...summaries()[2]!, id: "odd", title: markup, about: "<b>bold</b> about", problems: ["<script>alert(2)</script>"] },
    { ...summaries()[1]!, title: markup }];
  const view = (): LoopView => ({ ...triage(), title: markup, about: "<b>bold</b> about",
    stage_views: triage().stage_views.map((st) => ({ ...st, title: `<i>${st.title}</i>`, context: [item("persona", "p", "<u>persona</u>", "root", C)] })) });
  const s = await stub({ hash: "#/loops", over: { loops: () => Promise.resolve(loops()), loop: () => Promise.resolve(view()) } });
  const odd = s.q(".loop-tile[data-loop=odd]");
  expect(text(odd.querySelector(".head"))).toBe(markup);
  expect(text(odd.querySelector(".about"))).toBe("<b>bold</b> about");
  expect(text(odd.querySelector(".problems li"))).toBe("<script>alert(2)</script>");
  expect(text(s.q(".loop-tile[data-loop=triage] .stages"))).toBe("<i>Frame</i> → <i>Investigate</i>");
  expect(s.root.querySelectorAll("img, b, i, u, script").length).toBe(0);
  await go(s, "#/loops/triage");
  expect(s.q("[data-screen=loop] h1").textContent).toBe(markup);
  expect(text(s.q(".stage[data-stage=frame] .stage-line"))).toStartWith("1. <i>Frame</i>");
  expect(text(s.q(".stage[data-stage=frame] .item .item-name"))).toBe("persona <u>persona</u>");
  expect(s.root.querySelectorAll("img, b, i, u, script").length).toBe(0);
});

test("the loop screen lists the stages in order with their gates and their send-back edges", async () => {
  const s = await stub({ hash: "#/loops/investigation" });
  const h = s.q("[data-screen=loop]");
  expect(h.querySelector("h1")!.textContent).toBe("Investigation");
  expect(text(h.querySelector(".loop-head .version"))).toBe("v1 · aaaaaaaaaaaa");
  expect(h.querySelector(".loop-head .version")!.getAttribute("title")).toBe(A);
  expect(text(h.querySelector(".loop-head .caps"))).toBe("depth cap 2 · children cap 8");
  expect(s.all(".loop-stages > li").map((li) => li.dataset.stage)).toEqual(INVESTIGATION_STAGES.map(([id]) => id));
  const lines = s.all(".loop-stages .stage-line").map((l) => l.textContent);
  expect(lines[0]).toBe("1. Frame · runs agent · on pass → Plan");
  expect(lines[1]).toBe("2. Plan · runs agent · plan gate · on pass → Research");
  expect(lines[5]).toBe("6. Evaluate · runs agent · on pass → Challenge · on fail → Assemble");
  expect(lines[7]).toBe("8. Publish · runs agent · publish gate · on pass → Feedback");
  expect(lines[8]).toBe("9. Feedback · runs agent");
  expect(s.q(".stage[data-stage=evaluate]").tagName.toLowerCase()).toBe("details");
});

test("a stage opens to Context, Middleware and Orchestration, and every item shows its source and its short hash", async () => {
  const s = await stub({ hash: "#/loops/triage" });
  const frame = s.q(".stage[data-stage=frame]") as HTMLDetailsElement;
  expect(frame.open).toBe(false);
  expect([...frame.querySelectorAll(".stage-body h3")].map((x) => x.textContent)).toEqual(["Context", "Middleware", "Orchestration"]);
  const ctx = [...frame.querySelectorAll("[data-group=context] .item")];
  expect(ctx.map((li) => li.querySelector(".item-name")!.textContent)).toEqual(["persona Researcher", "rules Base rules", "skill Ask the person"]);
  expect(ctx.map((li) => li.querySelector(".source")!.textContent)).toEqual(["root", "root", "pinned"]);
  expect(ctx.map((li) => li.querySelector(".hash")!.textContent)).toEqual([C.slice(0, 12), A.slice(0, 12), D.slice(0, 12)]);
  expect(ctx.map((li) => li.querySelector(".hash")!.getAttribute("title"))).toEqual([C, A, D]);
  const orch = [...frame.querySelectorAll("[data-group=orchestration] li")].map((li) => li.textContent);
  expect(orch).toEqual(["tools run_query, ask_question", "model scripted sample-run · effort high", "turn cap 12", "send-back cap 3"]);
  // the stage itself is hashed too
  expect(frame.querySelector("summary .hash")!.getAttribute("title")).toBe(E);
});

test("a built-in item says built in and shows no hash; a pinned item says pinned", async () => {
  const s = await stub({ hash: "#/loops/triage" });
  const mid = [...s.q(".stage[data-stage=frame] [data-group=middleware]").querySelectorAll(".item")];
  expect(mid.map((li) => li.querySelector(".item-name")!.textContent)).toEqual(["built-in The query guard", "built-in The marking policy"]);
  for (const li of mid) {
    expect(li.querySelector(".source")!.textContent).toBe("built in");
    expect(li.querySelector(".hash")).toBeNull();
  }
  const pinned = s.all(".stage[data-stage=frame] [data-group=context] .item").find((li) => li.dataset.kind === "skill")!;
  expect(pinned.querySelector(".source")!.textContent).toBe("pinned");
  // an inline stage says so on its line
  expect(text(s.q(".stage[data-stage=investigate] summary .source"))).toBe("inline");
});

test("a sub-loop stage links to the loop it runs", async () => {
  const s = await stub({ hash: "#/loops/triage" });
  expect(text(s.q(".stage[data-stage=investigate] .stage-line"))).toBe("2. Investigate · runs loop");
  const sub = s.q(".stage[data-stage=investigate] [data-group=orchestration] .subloop");
  expect(text(sub.querySelector("[data-action=open-subloop]"))).toBe("investigation");
  expect(sub.querySelector(".hash")!.getAttribute("title")).toBe(A);
  expect([...sub.querySelectorAll(".mapping li")].map((li) => li.textContent)).toEqual(["input question ← case.question", "returns cards as cards"]);
  s.click(".stage[data-stage=investigate] [data-action=open-subloop]");
  await s.settle();
  expect(s.win.location.hash).toBe("#/loops/investigation");
  expect(s.q("[data-screen=loop] h1").textContent).toBe("Investigation");
});

test("Export posts the export and then names the file; a refusal is shown at the button", async () => {
  let n = 0;
  const s = await stub({
    hash: "#/loops/triage",
    over: { exportLoop: (id: string) => { n++; return Promise.resolve(n === 1 ? { file: `${id}.v2.bbbbbbbbbbbb.loop.tar.gz` } : { refused: ["the loop names a value that is a secret; nothing was written"] }); } },
  });
  s.click("[data-action=export]");
  await s.settle();
  expect(n).toBe(1);
  expect(text(s.q(".export-row .said"))).toBe("Exported to triage.v2.bbbbbbbbbbbb.loop.tar.gz in the loop store");
  s.click("[data-action=export]");
  await s.settle();
  const refusal = s.q(".export-row .refusal");
  expect(refusal.textContent).toBe("Refused: the loop names a value that is a secret; nothing was written");
  expect(text(s.q(".export-row .said"))).toBe("");
});

test("Loop files lists each file with what an import would do; Import and Trust post, and Trust is disabled until the folder's name is typed", async () => {
  const s = await stub({ hash: "#/loops" });
  const rows = s.all(".loop-file");
  expect(rows.map((r) => r.dataset.file)).toEqual(files().map((f) => f.file));
  expect(text(rows[0]!.querySelector(".plan"))).toBe("12 to write, 30 already here");
  expect(text(rows[1]!.querySelector(".conflicts li"))).toBe('source "edr" (manifests/sources/edr.yaml) is already loaded with other content');
  expect((rows[1]!.querySelector("[data-action=import-loop]") as HTMLButtonElement).disabled).toBe(true);
  s.click(".loop-file[data-file='triage.v2.bbbbbbbbbbbb.loop.tar.gz'] [data-action=import-loop]");
  await s.settle();
  expect(s.calls).toContainEqual(["importLoop", "triage.v2.bbbbbbbbbbbb.loop.tar.gz"]);
  expect(text(s.q(".loop-file[data-file='triage.v2.bbbbbbbbbbbb.loop.tar.gz'] .said"))).toBe("Imported into triage-bbbbbbbbbbbb: 12 written, 30 already here");
  // the roots that are not trusted: the broken loop's
  const root = s.q(".untrusted-root[data-root=broken-0123456789ab]");
  const trust = root.querySelector("[data-action=trust]") as HTMLButtonElement;
  expect(trust.disabled).toBe(true);
  s.fill("[aria-label='Type broken-0123456789ab to trust it']", "broken");
  expect((s.q(".untrusted-root [data-action=trust]") as HTMLButtonElement).disabled).toBe(true);
  s.fill("[aria-label='Type broken-0123456789ab to trust it']", "broken-0123456789ab");
  expect((s.q(".untrusted-root [data-action=trust]") as HTMLButtonElement).disabled).toBe(false);
  s.click(".untrusted-root [data-action=trust]");
  await s.settle();
  expect(s.calls).toContainEqual(["trustRoot", "broken-0123456789ab", "broken-0123456789ab"]);
  // after a trust the loops and the files are read again
  expect(s.calls.filter((c) => c[0] === "loops").length).toBeGreaterThanOrEqual(2);
  await s.close(); open = null;
  // a refused import and a refused trust are shown at their buttons
  const r = await stub({ hash: "#/loops", over: {
    importLoop: () => Promise.resolve({ refused: ["the loop file changed since it was listed"] }),
    trustRoot: () => Promise.resolve({ refused: ["that folder is not an imported root"] }),
  } });
  r.click(".loop-file[data-file='triage.v2.bbbbbbbbbbbb.loop.tar.gz'] [data-action=import-loop]");
  await r.settle();
  expect(text(r.q(".loop-file[data-file='triage.v2.bbbbbbbbbbbb.loop.tar.gz'] .refusal"))).toBe("Refused: the loop file changed since it was listed");
  r.fill("[aria-label='Type broken-0123456789ab to trust it']", "broken-0123456789ab");
  r.click(".untrusted-root [data-action=trust]");
  await r.settle();
  expect(text(r.q(".untrusted-root .refusal"))).toBe("Refused: that folder is not an imported root");
});

test("the routes parse and print: #/loops, #/loops/triage, #/loops/triage/edit, #/investigate/new/triage", () => {
  for (const h of ["#/loops", "#/loops/triage", "#/loops/triage/edit", "#/investigate/new/triage", "#/investigate/new"]) expect(routeHash(parseRoute(h))).toBe(h);
  expect(parseRoute("#/loops")).toEqual({ screen: "loops" });
  expect(parseRoute("#/loops/triage")).toEqual({ screen: "loop", id: "triage" });
  expect(parseRoute("#/loops/triage/edit")).toEqual({ screen: "loop_edit", id: "triage" });
  expect(parseRoute("#/investigate/new/triage")).toEqual({ screen: "new", loop: "triage" });
  expect(parseRoute("#/investigate/new")).toEqual({ screen: "new" });
  for (const bad of ["#/loops/..", "#/loops/a..b", "#/loops/-x", "#/loops/a b", "#/loops/triage/other", "#/investigate/new/a%2Fb", "#/loops/triage/edit/x"]) expect(parseRoute(bad)).toEqual({ screen: "home" });
});

test("Escape on a loop screen goes to the Loops list, and on the list goes home", async () => {
  const s = await stub({ hash: "#/loops/triage" });
  s.actions().up!();
  await s.settle();
  expect(s.win.location.hash).toBe("#/loops");
  s.actions().up!();
  await s.settle();
  expect(s.win.location.hash).toBe("#/");
  // a new case from a loop steps up to that loop
  await go(s, "#/investigate/new/triage");
  s.actions().up!();
  await s.settle();
  expect(s.win.location.hash).toBe("#/loops/triage");
});

// ---- Task 13's follow-ups to Task 12

test("the case list takes the default loop from the server: with triage the default, a triage case names no loop and an investigation case does", async () => {
  const at = { title: "t", marking: "TLP:GREEN", created_ts: "2026-11-27T10:00:00.000Z", run_status: "none", phase: null, incoming: 0, kept: 0, unload_failed: null, parent: null, waiting_on: null } as const;
  const s = await stub({
    hash: "#/investigate", defaultLoop: "triage",
    over: { cases: () => Promise.resolve([{ ...at, id: "CASE-1", title: "Of triage", loop: "triage" }, { ...at, id: "CASE-2", title: "Of investigation", loop: "investigation" }]) },
  });
  await go(s, "#/");
  await go(s, "#/investigate");
  const tile = (id: string): HTMLElement => s.all(".tile-wrap").find((w) => w.querySelector(".tile")!.getAttribute("aria-label")!.includes(` · ${id} · `))!;
  expect(tile("CASE-1").querySelector(".chip.loop")).toBeNull();
  expect(text(tile("CASE-2").querySelector(".chip.loop"))).toBe("Investigation");
});

test("Export names the file with a link that downloads it, and each file of the loop store has a Download link; a name that is not a loop file's gets no link", async () => {
  const s = await stub({ hash: "#/loops/triage" });
  s.click("[data-action=export]");
  await s.settle();
  const link = s.q(".export-row a");
  expect(link.getAttribute("href")).toBe("/api/loop-files/triage.v2.bbbbbbbbbbbb.loop.tar.gz");
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  expect(link.textContent).toBe("Download");
  await go(s, "#/loops");
  const links = s.all(".loop-file a");
  expect(links.map((a) => a.getAttribute("href"))).toEqual(files().map((f) => `/api/loop-files/${f.file}`));
  expect(links.map((a) => a.textContent)).toEqual(["Download", "Download"]);
  await s.close(); open = null;
  const odd = await stub({ hash: "#/loops", over: { loopFiles: () => Promise.resolve([{ ...files()[0]!, file: "../evil.v1.bbbbbbbbbbbb.loop.tar.gz" }]) } });
  expect(odd.all(".loop-file a")).toEqual([]);
  expect(text(odd.q(".loop-file .download"))).toBe("Download");
});
