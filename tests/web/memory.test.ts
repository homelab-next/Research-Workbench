import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import type { Api } from "../../src/web/api";
import type { LessonView, Me, MemoryView, Reference } from "../../src/core/wire";
import { parseRoute, routeHash, startApp } from "../../src/web/app";
import { testUi } from "../helpers/dom";

// Task 13: the Memory page beside Cases and Loops. Happy-dom over a stub Api: what the page draws from GET /api/memory, and what it posts.

const H1 = "1".repeat(64), H2 = "2".repeat(64), H3 = "3".repeat(64), H4 = "4".repeat(64);
const MARKUP = "<img src=x onerror=1>";
const TYPE = { id: "unknown-device", title: "Unknown device", about: "A device on the network no one here recognises." };

const lesson = (over: Partial<LessonView> & Pick<LessonView, "id">): LessonView => ({
  case_type: TYPE.id, title: `Title of ${over.id}`, text: `Text of ${over.id}`, triggers: [], trigger_words: [], marking: "TLP:GREEN", proposed_marking: "TLP:GREEN",
  status: "proposed", hash: H1, supersedes: null, superseded_by: null,
  from: { words: "proposed by a person", case: null, kind: "person", model: false },
  proposed: { by: "analyst", ts: "2026-11-27T10:00:00.000Z" }, decided: null,
  history: [{ seq: 1, ts: "2026-11-27T10:00:00.000Z", what: "proposed", by: "analyst" }],
  ...over,
});
const lessons = (): LessonView[] => [
  lesson({
    id: "LESSON-3", title: "Read the lease table first", text: "The lease table names the device before any scan does.", hash: H3, marking: "TLP:GREEN",
    triggers: [{ observable: "mac" }, { source: "dhcp" }], trigger_words: ["observable mac is present", "source dhcp was used"],
    from: { words: "from CASE-1 (run run-1, product 1), written by the model of its feedback stage", case: "CASE-1", kind: "case", model: true },
    supersedes: "LESSON-2",
  }),
  lesson({
    id: "LESSON-2", title: "Ask where it is", text: "Ask the person where the device sits.", hash: H2, status: "accepted", superseded_by: null,
    from: { words: "seed ask-where of sample-seeds", case: null, kind: "seed", model: false },
    decided: { by: "analyst", ts: "2026-11-27T10:05:00.000Z", reason: null },
    history: [{ seq: 1, ts: "2026-11-27T10:00:00.000Z", what: "proposed", by: "workbench" }, { seq: 2, ts: "2026-11-27T10:05:00.000Z", what: "accepted", by: "analyst" }],
  }),
  lesson({
    id: "LESSON-1", title: "Scan everything", text: "Scan the whole range.", hash: H1, status: "rejected",
    decided: { by: "analyst", ts: "2026-11-27T10:06:00.000Z", reason: "too costly" },
    history: [{ seq: 1, ts: "2026-11-27T10:00:00.000Z", what: "proposed", by: "analyst" }, { seq: 3, ts: "2026-11-27T10:06:00.000Z", what: "rejected", by: "analyst" }],
  }),
];
const stray = (): LessonView => lesson({ id: "LESSON-4", case_type: "old-type", title: "From a type not loaded", hash: H4, status: "accepted" });
const view = (over: Partial<MemoryView> = {}): MemoryView => ({
  store: { origin: H1, head: { seq: 4, hash: H4 }, lessons: 4, skipped: 0 },
  groups: [{ type: TYPE, lessons: lessons() }, { type: null, lessons: [stray()] }],
  files: [{ file: "memory.TLP-GREEN.444444444444.memory.tar.gz", bytes: 2048, marking: "TLP:GREEN", lessons: 4, head: "444444444444", problem: null }],
  ...over,
});
const REF = {
  types: [{ id: "ip", title: "IP address" }, { id: "mac", title: "MAC address" }],
  sources: [{ id: "dhcp", title: "DHCP leases" }, { id: "dns", title: "DNS log" }],
  case_types: [TYPE],
} as unknown as Partial<Reference>;

interface Stub {
  win: Window; root: HTMLElement; calls: unknown[][];
  click(selector: string): void; fill(selector: string, text: string): void; pick(selector: string, value: string): void;
  q(selector: string): HTMLElement; all(selector: string): HTMLElement[]; settle(): Promise<void>; close(): Promise<void>;
}
let open: Stub | null = null;
afterEach(async () => { await open?.close(); open = null; });

async function stub(opts: { role?: Me["role"]; hash?: string; over?: Partial<Api>; memory?: () => MemoryView } = {}): Promise<Stub> {
  const win = new Window({ url: `http://127.0.0.1:1/${opts.hash ?? "#/memory"}` });
  const doc = win.document as unknown as Document;
  const calls: unknown[][] = [];
  const rec = <T>(name: string, value: T, ...args: unknown[]): Promise<T> => { calls.push([name, ...args]); return Promise.resolve(value); };
  const api = {
    cases: () => rec("cases", []),
    loops: () => rec("loops", []),
    memory: () => rec("memory", (opts.memory ?? view)()),
    proposeLesson: (input: unknown) => rec("proposeLesson", { id: "LESSON-5" }, input),
    acceptLesson: (id: string, hash: string, marking?: string) => rec("acceptLesson", { ok: true as const }, id, hash, marking),
    rejectLesson: (id: string, reason: string) => rec("rejectLesson", { ok: true as const }, id, reason),
    retireLesson: (id: string, reason: string) => rec("retireLesson", { ok: true as const }, id, reason),
    exportMemory: () => rec("exportMemory", { file: "memory.TLP-GREEN.555555555555.memory.tar.gz" }),
    loadMemory: (file: string, typed: string) => rec("loadMemory", { lessons: 4 }, file, typed),
    memoryFilePath: (file: string) => `/api/memory/files/${file}`,
    entries: { open: () => () => {} },
    ...opts.over,
  } as unknown as Api;
  const base = testUi(win);
  const ui = testUi(win, {
    api, ref: { ...base.ref, ...REF },
    me: { user: "analyst", role: opts.role ?? "analyst", origin: "http://127.0.0.1:1", markings: ["TLP:GREEN"], policy: {} as never, problems: [], cases: { store: "<data>/cases", on_complete: "keep" }, loops: { default: "investigation" } },
  });
  const root = doc.createElement("div");
  doc.body.append(root);
  const app = startApp(ui, root);
  const q = (selector: string): HTMLElement => {
    const found = root.querySelector(selector);
    if (found === null) throw new Error(`nothing matches ${selector}; the page says: ${(root.textContent ?? "").slice(0, 400)}`);
    return found as HTMLElement;
  };
  const s: Stub = {
    win, root, calls, q, all: (selector) => [...root.querySelectorAll(selector)] as HTMLElement[],
    click(selector) { q(selector).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event); },
    fill(selector, text) { const i = q(selector) as HTMLInputElement; i.value = text; i.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event); },
    pick(selector, value) { const i = q(selector) as HTMLSelectElement; i.value = value; i.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event); },
    async settle() { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); },
    async close() { app.destroy(); await win.happyDOM.close(); },
  };
  open = s;
  await s.settle();
  return s;
}
const text = (el: Element | null): string => el?.textContent ?? "";
const reads = (s: Stub): number => s.calls.filter((c) => c[0] === "memory").length;
const row = (id: string): string => `details.lesson[data-lesson=${id}]`;

test("the page lists lessons under their case type, proposals first", async () => {
  const s = await stub();
  expect(text(s.q("[data-screen=memory] h1"))).toBe("Memory");
  const groups = s.all(".memory-group");
  expect(groups.map((g) => g.dataset.type)).toEqual(["unknown-device", ""]);
  expect(text(groups[0]!.querySelector("h2"))).toBe("Unknown device");
  expect(text(groups[0]!.querySelector(".about"))).toBe(TYPE.about);
  expect(text(groups[1]!.querySelector("h2"))).toBe("No case type here now");
  expect([...groups[0]!.querySelectorAll("details.lesson")].map((d) => (d as HTMLElement).dataset.lesson)).toEqual(["LESSON-3", "LESSON-2", "LESSON-1"]);
  const head = s.q(`${row("LESSON-3")} > summary`);
  expect(text(head.querySelector(".id"))).toBe("LESSON-3");
  expect(text(head.querySelector(".title"))).toBe("Read the lease table first");
  expect(text(head.querySelector(".chip.marking"))).toBe("TLP:GREEN");
  expect(text(head.querySelector(".status"))).toBe("proposed");
  expect(text(head.querySelector(".from"))).toBe("from CASE-1 (run run-1, product 1), written by the model of its feedback stage");
  expect(text(s.q(`${row("LESSON-2")} > summary .status`))).toBe("shared");
  // a row opens to its text, triggers, provenance, what it supersedes, and its history
  const l3 = s.q(row("LESSON-3"));
  expect(text(l3.querySelector(".text"))).toBe("The lease table names the device before any scan does.");
  expect([...l3.querySelectorAll(".triggers li")].map((li) => li.textContent)).toEqual(["observable mac is present", "source dhcp was used"]);
  expect(text(l3.querySelector(".supersedes"))).toBe("A new version of LESSON-2");
  s.click(`${row("LESSON-3")} [data-action=open-case]`);
  await s.settle();
  expect(s.win.location.hash).toBe("#/case/CASE-1");
  await go(s, "#/memory");
  expect([...s.q(row("LESSON-1")).querySelectorAll(".history li")].map((li) => li.textContent)).toEqual([
    "#1 · 2026-11-27T10:00:00.000Z · proposed by analyst", "#3 · 2026-11-27T10:06:00.000Z · rejected by analyst",
  ]);
  expect(text(s.q(`${row("LESSON-1")} .reason`))).toBe("Reason: too costly");
  // no graph, no ring
  expect(s.root.querySelector("svg, canvas, .ring")).toBeNull();
});
const go = async (s: Stub, hash: string): Promise<void> => { s.win.location.hash = hash; await s.settle(); };

test("a lesson's title, text, trigger and provenance that look like markup are text: no element is made from them", async () => {
  const odd = lesson({
    id: "LESSON-9", status: "accepted", title: MARKUP, text: MARKUP, triggers: [{ finding: MARKUP }], trigger_words: [MARKUP],
    from: { words: MARKUP, case: null, kind: "person", model: false }, decided: { by: MARKUP, ts: "t", reason: MARKUP },
    history: [{ seq: 1, ts: "t", what: MARKUP, by: MARKUP }],
  });
  const s = await stub({ memory: () => view({ groups: [{ type: { id: "x", title: MARKUP, about: MARKUP }, lessons: [odd] }], files: [{ file: MARKUP, bytes: 1, marking: MARKUP, lessons: 1, head: MARKUP, problem: MARKUP }] }) });
  expect(s.root.querySelector("img")).toBeNull();
  expect(text(s.q(`${row("LESSON-9")} > summary .title`))).toBe(MARKUP);
  expect(text(s.q(`${row("LESSON-9")} .text`))).toBe(MARKUP);
  expect(text(s.q(`${row("LESSON-9")} .triggers li`))).toBe(MARKUP);
  expect(text(s.q(`${row("LESSON-9")} > summary .from`))).toBe(MARKUP);
  expect(text(s.q(".memory-group h2"))).toBe(MARKUP);
  // the propose form filled from it is text too
  s.click(`${row("LESSON-9")} [data-action=new-version]`);
  await s.settle();
  expect(s.root.querySelector("img")).toBeNull();
});

test("a proposal's row has Accept and Reject; a shared one has Retire and Propose a new version; a rejected one has neither", async () => {
  const s = await stub();
  const has = (id: string, action: string): boolean => s.root.querySelector(`${row(id)} [data-action=${action}]`) !== null;
  expect(["accept", "reject", "retire", "new-version"].map((a) => has("LESSON-3", a))).toEqual([true, true, false, false]);
  expect(["accept", "reject", "retire", "new-version"].map((a) => has("LESSON-2", a))).toEqual([false, false, true, true]);
  expect(["accept", "reject", "retire", "new-version"].map((a) => has("LESSON-1", a))).toEqual([false, false, false, false]);
});

test("Accept sends the hash the row was drawn with and the marking chosen, and the list is read again", async () => {
  const s = await stub();
  const before = reads(s);
  s.pick(`${row("LESSON-3")} [data-field=accept-marking]`, "TLP:AMBER");
  s.click(`${row("LESSON-3")} [data-action=accept]`);
  await s.settle();
  expect(s.calls.find((c) => c[0] === "acceptLesson")).toEqual(["acceptLesson", "LESSON-3", H3, "TLP:AMBER"]);
  expect(reads(s)).toBe(before + 1);
});

test("the marking select of Accept offers the proposed marking and stricter ones only", async () => {
  const s = await stub();
  const select = s.q(`${row("LESSON-3")} [data-field=accept-marking]`) as HTMLSelectElement;
  expect([...select.querySelectorAll("option")].map((o) => (o as HTMLOptionElement).value)).toEqual(["TLP:GREEN", "TLP:AMBER", "TLP:AMBER+STRICT", "TLP:RED"]);
  expect(select.value).toBe("TLP:GREEN");
});

test("Reject and Retire send nothing until a reason is typed", async () => {
  const s = await stub();
  const reject = s.q(`${row("LESSON-3")} [data-action=reject]`) as HTMLButtonElement;
  expect(reject.disabled).toBe(true);
  s.click(`${row("LESSON-3")} [data-action=reject]`);
  s.fill(`${row("LESSON-3")} [data-field=reject-reason]`, "   ");
  s.click(`${row("LESSON-3")} [data-action=reject]`);
  await s.settle();
  expect(s.calls.some((c) => c[0] === "rejectLesson")).toBe(false);
  s.fill(`${row("LESSON-3")} [data-field=reject-reason]`, "says nothing new");
  expect((s.q(`${row("LESSON-3")} [data-action=reject]`) as HTMLButtonElement).disabled).toBe(false);
  s.click(`${row("LESSON-3")} [data-action=reject]`);
  await s.settle();
  expect(s.calls.find((c) => c[0] === "rejectLesson")).toEqual(["rejectLesson", "LESSON-3", "says nothing new"]);

  s.click(`${row("LESSON-2")} [data-action=retire]`);
  await s.settle();
  expect(s.calls.some((c) => c[0] === "retireLesson")).toBe(false);
  s.fill(`${row("LESSON-2")} [data-field=retire-reason]`, "the lease table moved");
  s.click(`${row("LESSON-2")} [data-action=retire]`);
  await s.settle();
  expect(s.calls.find((c) => c[0] === "retireLesson")).toEqual(["retireLesson", "LESSON-2", "the lease table moved"]);
});

test("a refusal is shown beside its button and the row stays", async () => {
  const s = await stub({ over: { acceptLesson: () => Promise.resolve({ ok: false as const, refused: ["the proposal changed since you saw it"] }) } });
  s.click(`${row("LESSON-3")} [data-action=accept]`);
  await s.settle();
  const act = s.q(`${row("LESSON-3")} [data-act=accept]`);
  expect(text(act.querySelector(".refusal"))).toBe("Refused: the proposal changed since you saw it");
  expect((s.q(row("LESSON-3")) as HTMLDetailsElement).open).toBe(true);
  expect(s.root.querySelectorAll(".refusal").length).toBe(1);
});

test("the propose form sends the type, title, text, marking and triggers, and refuses in place a text over 1200 characters", async () => {
  const s = await stub();
  const form = "[data-section=propose]";
  expect(text(s.q(`${form} h2`))).toBe("Propose a lesson");
  s.pick(`${form} [data-field=case-type]`, "unknown-device");
  s.fill(`${form} [data-field=title]`, "Look at the lease table");
  s.fill(`${form} [data-field=text]`, "x".repeat(1201));
  expect(text(s.q(`${form} .count`))).toBe("1201 / 1200");
  s.click(`${form} [data-action=propose]`);
  await s.settle();
  expect(s.calls.some((c) => c[0] === "proposeLesson")).toBe(false);
  expect(text(s.q(`${form} [data-act=propose] .refusal`))).toBe("Refused: the text is 1201 characters; a lesson's text is at most 1200");
  s.fill(`${form} [data-field=text]`, "The lease table names it.");
  s.pick(`${form} [data-field=marking]`, "TLP:AMBER");
  s.click(`${form} [data-action=add-trigger]`);
  s.pick(`${form} .trigger-row:nth-child(1) [data-field=trigger-value]`, "mac");
  s.click(`${form} [data-action=add-trigger]`);
  s.pick(`${form} .trigger-row:nth-child(2) [data-field=trigger-kind]`, "source");
  s.pick(`${form} .trigger-row:nth-child(2) [data-field=trigger-value]`, "dhcp");
  s.click(`${form} [data-action=add-trigger]`);
  s.pick(`${form} .trigger-row:nth-child(3) [data-field=trigger-kind]`, "finding");
  s.fill(`${form} .trigger-row:nth-child(3) [data-field=trigger-value]`, "unknown vendor");
  expect([...(s.q(`${form} .trigger-row:nth-child(1) [data-field=trigger-value]`) as HTMLSelectElement).querySelectorAll("option")].map((o) => o.textContent)).toEqual(["IP address", "MAC address"]);
  const before = reads(s);
  s.click(`${form} [data-action=propose]`);
  await s.settle();
  expect(s.calls.find((c) => c[0] === "proposeLesson")![1]).toEqual({
    case_type: "unknown-device", title: "Look at the lease table", text: "The lease table names it.", marking: "TLP:AMBER",
    triggers: [{ observable: "mac" }, { source: "dhcp" }, { finding: "unknown vendor" }],
  });
  expect(text(s.q(`${form} [data-act=propose] .said`))).toBe("Proposed LESSON-5");
  expect(reads(s)).toBe(before + 1);
  // the form is cleared, and at most 8 triggers may be added
  expect((s.q(`${form} [data-field=title]`) as HTMLInputElement).value).toBe("");
  for (let i = 0; i < 8; i++) s.click(`${form} [data-action=add-trigger]`);
  expect(s.all(`${form} .trigger-row`).length).toBe(8);
  expect((s.q(`${form} [data-action=add-trigger]`) as HTMLButtonElement).disabled).toBe(true);
  // a refusal from the server is shown beside Propose
  open = null; await s.close();
  const r = await stub({ over: { proposeLesson: () => Promise.resolve({ refused: ["the text holds a secret value; nothing was filed"] }) } });
  r.pick(`${form} [data-field=case-type]`, "unknown-device");
  r.fill(`${form} [data-field=title]`, "T");
  r.fill(`${form} [data-field=text]`, "x");
  r.click(`${form} [data-action=propose]`);
  await r.settle();
  expect(text(r.q(`${form} [data-act=propose] .refusal`))).toBe("Refused: the text holds a secret value; nothing was filed");
});

test("Propose a new version fills the form from the lesson and sends supersedes", async () => {
  const s = await stub({ memory: () => view({ groups: [{ type: TYPE, lessons: [lesson({ ...lessons()[0]!, id: "LESSON-2", status: "accepted", supersedes: null, marking: "TLP:AMBER" })] }] }) });
  s.click(`${row("LESSON-2")} [data-action=new-version]`);
  await s.settle();
  const form = "[data-section=propose]";
  expect(text(s.q(`${form} h2`))).toBe("Propose a new version of LESSON-2");
  expect((s.q(`${form} [data-field=title]`) as HTMLInputElement).value).toBe("Read the lease table first");
  expect((s.q(`${form} [data-field=text]`) as HTMLTextAreaElement).value).toBe("The lease table names the device before any scan does.");
  expect((s.q(`${form} [data-field=marking]`) as HTMLSelectElement).value).toBe("TLP:AMBER");
  expect(s.all(`${form} .trigger-row`).length).toBe(2);
  s.fill(`${form} [data-field=title]`, "Read the lease table before any scan");
  s.click(`${form} [data-action=propose]`);
  await s.settle();
  expect(s.calls.find((c) => c[0] === "proposeLesson")![1]).toEqual({
    case_type: "unknown-device", title: "Read the lease table before any scan", text: "The lease table names the device before any scan does.", marking: "TLP:AMBER",
    triggers: [{ observable: "mac" }, { source: "dhcp" }], supersedes: "LESSON-2",
  });
});

test("a lesson with no trigger says it applies to every case of its type", async () => {
  const s = await stub();
  expect(text(s.q(`${row("LESSON-2")} .triggers`))).toBe("Applies to every unknown-device case");
  expect(s.q(row("LESSON-2")).querySelectorAll(".triggers li").length).toBe(0);
});

test("Export shows the file it wrote; Load sends the file and what was typed", async () => {
  const s = await stub();
  s.click("[data-action=export]");
  await s.settle();
  expect(text(s.q(".memory-export .said"))).toBe("Exported to memory.TLP-GREEN.555555555555.memory.tar.gz");
  const f = ".memory-file[data-file='memory.TLP-GREEN.444444444444.memory.tar.gz']";
  expect(text(s.q(`${f} .head`))).toBe("444444444444");
  expect((s.q(`${f} [data-action=load]`) as HTMLButtonElement).disabled).toBe(true);
  s.click(`${f} [data-action=load]`);
  await s.settle();
  expect(s.calls.some((c) => c[0] === "loadMemory")).toBe(false);
  s.fill(`${f} [data-field=load-typed]`, "444444444444");
  s.click(`${f} [data-action=load]`);
  await s.settle();
  expect(s.calls.find((c) => c[0] === "loadMemory")).toEqual(["loadMemory", "memory.TLP-GREEN.444444444444.memory.tar.gz", "444444444444"]);
  expect(text(s.q(`${f} .said`))).toBe("Loaded: the store holds 4 lessons");
  open = null; await s.close();
  const r = await stub({ over: { exportMemory: () => Promise.resolve({ refused: ["the store is empty"] }) } });
  r.click("[data-action=export]");
  await r.settle();
  expect(text(r.q(".memory-export .refusal"))).toBe("Refused: the store is empty");
});

test("the home screen has a Memory tile in Resources with the count of proposals, and it goes to #/memory", async () => {
  const s = await stub({ hash: "" });
  const tile = s.q("[data-column=resources] [data-mode=memory]");
  expect(text(tile.querySelector(".label"))).toBe("Memory");
  expect(text(tile.querySelector(".count"))).toBe("1 to review");
  expect((tile.previousElementSibling as HTMLElement).dataset.mode).toBe("loops");
  s.click("[data-mode=memory]");
  await s.settle();
  expect(s.win.location.hash).toBe("#/memory");
  open = null; await s.close();
  const pending = await stub({ hash: "", over: { memory: () => new Promise<MemoryView>(() => {}) } });
  expect(text(pending.q("[data-mode=memory] .count"))).toBe("…");
  open = null; await pending.close();
  const failed = await stub({ hash: "", over: { memory: () => Promise.reject(new Error("500")) } });
  expect(text(failed.q("[data-mode=memory] .count"))).toBe("");
});

test("#/memory parses to the memory screen and back; a requester is sent home", async () => {
  expect(parseRoute("#/memory")).toEqual({ screen: "memory" });
  expect(routeHash({ screen: "memory" })).toBe("#/memory");
  expect(parseRoute("#/memory/x")).toEqual({ screen: "home" });
  const s = await stub();
  expect(s.root.querySelector("[data-screen=memory]")).not.toBeNull();
  (s.win.document as unknown as Document).dispatchEvent(new s.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event);
  await s.settle();
  expect(s.win.location.hash).toBe("#/");
  open = null; await s.close();
  const r = await stub({ role: "requester" });
  expect(r.root.querySelector("[data-screen=memory]")).toBeNull();
  expect(r.root.querySelector("[data-screen=home]")).not.toBeNull();
  expect(r.calls.some((c) => c[0] === "memory")).toBe(false);
});

test("the page makes no element with innerHTML and sets no inline style", () => {
  const src = readFileSync(join(import.meta.dir, "../../src/web/views/memory.ts"), "utf8");
  expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|createElement|setAttribute|\.style\b|cssText/);
});

test("each memory file has a download link to its path on this server, and a path that is not a memory file's gets no link", async () => {
  const s = await stub();
  const links = s.all(".memory-file a.download");
  expect(links.map((a) => [a.getAttribute("href"), a.hasAttribute("download"), a.getAttribute("rel"), text(a)]))
    .toEqual([["/api/memory/files/memory.TLP-GREEN.444444444444.memory.tar.gz", true, "noopener noreferrer", "Download"]]);
  const { memoryFileLink } = await import("../../src/web/links");
  const h = (await import("../../src/web/dom")).makeH(s.win.document as unknown as Document);
  for (const bad of ["/api/memory/files/../ledger.sqlite", "/api/memory/files/memory.TLP-GREEN.444444444444.memory.tar.gz/..", "https://example.com/memory.TLP-GREEN.444444444444.memory.tar.gz", "/api/loop-files/x.v1.444444444444.loop.tar.gz"]) {
    const el = memoryFileLink(h, bad, "Download");
    expect([bad, el.tagName]).toEqual([bad, "SPAN"]);
  }
  expect(memoryFileLink(h, "/api/memory/files/memory.TLP-AMBER%2BSTRICT.444444444444.memory.tar.gz", "Download").tagName).toBe("A");
});
