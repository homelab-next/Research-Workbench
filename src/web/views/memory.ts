import type { LessonView, MemoryView } from "../../core/wire";
import { MARKINGS } from "../../core/types";
import type { Marking, Trigger } from "../../core/types";
import { markingChip } from "../chips";
import { clear } from "../dom";
import { refusalLine } from "../refusal";
import type { Screen, Shell } from "../app";

/** A lesson's limits, as the store holds them (slice 13). */
export const MAX_TITLE = 120;
export const MAX_TEXT = 1200;
export const MAX_TRIGGERS = 8;

type TriggerKind = "observable" | "source" | "finding";
interface TriggerDraft { kind: TriggerKind; value: string }
interface Draft { case_type: string; title: string; text: string; marking: Marking; triggers: TriggerDraft[]; supersedes: string | null }

const STATUS_WORDS: Record<LessonView["status"], string> = { proposed: "proposed", accepted: "shared", rejected: "rejected", retired: "retired", superseded: "superseded" };
const KIND_WORDS: [TriggerKind, string][] = [["observable", "an observable type is present"], ["source", "a source was used"], ["finding", "a finding mentions"]];

/** The marking a proposal may be accepted at: its own and every stricter one, least strict first. */
export function acceptMarkings(marking: Marking): Marking[] {
  const at = MARKINGS.indexOf(marking);
  return at < 0 ? MARKINGS.slice(-1) : MARKINGS.slice(at);
}
const triggerOf = (t: TriggerDraft): Trigger => (t.kind === "observable" ? { observable: t.value } : t.kind === "source" ? { source: t.value } : { finding: t.value });
const draftOf = (t: Trigger): TriggerDraft => ("observable" in t ? { kind: "observable", value: t.observable } : "source" in t ? { kind: "source", value: t.source } : { kind: "finding", value: t.finding });

/**
 * The Memory page (slice 13): the shared lessons, grouped by case type, each a row that opens to its text, triggers, provenance and history; the
 * person's own Accept, Reject and Retire; a form to propose a lesson or a new version of one; and the memory files with Export and Load. Every
 * title, text, trigger, provenance, reason and file name here is only ever text. Simple lists: no graph and no ring.
 */
export function memoryView(shell: Shell): Screen {
  const { ui, nav } = shell;
  const h = ui.h;
  let memory: MemoryView | null = null;
  let failed = false;
  let destroyed = false;
  let asked = 0;
  /** The rows the person opened, kept open across a read. */
  const opened = new Set<string>();
  /** What each control last said, or why it was refused, by its key ("accept:LESSON-3", "propose", "export", "load:<file>"). */
  const said = new Map<string, string>();
  const refused = new Map<string, string>();
  const busy = new Set<string>();
  /** What was typed into each reason or confirmation box, and the marking chosen for each Accept, kept across reads. */
  const typed = new Map<string, string>();
  const chosen = new Map<string, Marking>();

  const caseTypes = (): { id: string; title: string }[] => ui.ref.case_types ?? [];
  const firstValue = (kind: TriggerKind): string =>
    kind === "observable" ? (ui.ref.types[0]?.id ?? "") : kind === "source" ? (ui.ref.sources[0]?.id ?? "") : "";
  const blank = (): Draft => ({ case_type: caseTypes()[0]?.id ?? "", title: "", text: "", marking: MARKINGS[0]!, triggers: [], supersedes: null });
  let draft: Draft = blank();

  const groupList = h("div", { class: "memory-groups" });
  const formHost = h("section", { class: "memory-propose", data: { section: "propose" } });
  const fileHost = h("section", { class: "memory-files" });
  const loadError = h("p", { class: "load-error say", role: "alert" });
  const storeLine = h("p", { class: "muted store-line" });

  const read = (): void => {
    const mine = ++asked;
    ui.api.memory().then((v) => {
      if (destroyed || mine !== asked) return;
      memory = v; failed = false;
      render();
    }, () => { if (destroyed || mine !== asked) return; failed = true; render(); });
  };

  /** Runs one act of the person's: its refusal or what it said is kept under its key, and the store is read again whatever came back. */
  const act = <T>(key: string, work: () => Promise<T | { refused: string[] }>, done: (r: T) => void): void => {
    if (busy.has(key)) return;
    busy.add(key); said.delete(key); refused.delete(key); render();
    void work().then((r) => {
      busy.delete(key);
      if (destroyed) return;
      if (typeof r === "object" && r !== null && "refused" in r) refused.set(key, r.refused.join("; "));
      else done(r as T);
      render();
      read();
    }, () => {
      busy.delete(key);
      if (destroyed) return;
      refused.set(key, "The server did not answer.");
      render();
    });
  };
  const decided = (r: { ok: true } | { ok: false; refused: string[] }): { done: true } | { refused: string[] } => (r.ok ? { done: true } : { refused: r.refused });

  // ---------- a lesson's row ----------

  const reasonAct = (l: LessonView, verb: "reject" | "retire"): HTMLElement => {
    const key = `${verb}:${l.id}`;
    const label = verb === "reject" ? "Reject" : "Retire";
    const ready = (): boolean => (typed.get(key) ?? "").trim() !== "" && !busy.has(key);
    const send = (): void => {
      if (!ready()) return;
      opened.add(l.id);
      const reason = (typed.get(key) ?? "").trim();
      act(key, async () => decided(verb === "reject" ? await ui.api.rejectLesson(l.id, reason) : await ui.api.retireLesson(l.id, reason)), () => { typed.delete(key); });
    };
    const button = h("button", { type: "button", data: { action: verb }, name: `${label} ${l.id}`, disabled: !ready(), title: "Type a reason first", on: { click: send } }, label) as HTMLButtonElement;
    const box = h("input", {
      type: "text", data: { field: `${verb}-reason` }, name: `Why ${verb} ${l.id}`, placeholder: verb === "reject" ? "Why it is not shared" : "Why it is no longer shared", value: typed.get(key) ?? "",
      on: {
        input: (e) => { typed.set(key, (e.target as HTMLInputElement).value); button.disabled = !ready(); },
        keydown: (e) => { if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); send(); } },
      },
    });
    return h("div", { class: "act", data: { act: verb } }, box, button, refusalLine(h, refused.get(key), key));
  };

  const acceptAct = (l: LessonView): HTMLElement => {
    const key = `accept:${l.id}`;
    const select = h("select", {
      data: { field: "accept-marking" }, name: `Marking to share ${l.id} at`,
      on: { change: (e) => { chosen.set(l.id, (e.target as HTMLSelectElement).value as Marking); } },
    }, acceptMarkings(l.marking).map((m) => h("option", { value: m }, m))) as HTMLSelectElement;
    select.value = chosen.get(l.id) ?? l.marking;
    const hash = l.hash;
    const send = (): void => {
      opened.add(l.id);
      const marking = chosen.get(l.id) ?? l.marking;
      act(key, async () => decided(await ui.api.acceptLesson(l.id, hash, marking)), () => { chosen.delete(l.id); });
    };
    return h("div", { class: "act", data: { act: "accept" } }, select,
      h("button", { type: "button", class: "primary", data: { action: "accept" }, name: `Accept ${l.id}`, disabled: busy.has(key), title: "Share this lesson with every case of its type", on: { click: send } }, "Accept"),
      refusalLine(h, refused.get(key), key));
  };

  const newVersion = (l: LessonView): void => {
    draft = { case_type: l.case_type, title: l.title, text: l.text, marking: l.marking, triggers: l.triggers.map(draftOf), supersedes: l.id };
    said.delete("propose"); refused.delete("propose");
    paintForm();
    (formHost.querySelector("[data-field=title]") as HTMLElement | null)?.focus();
  };

  const lessonRow = (l: LessonView): HTMLElement => {
    const actions: HTMLElement[] = [];
    if (l.status === "proposed") actions.push(acceptAct(l), reasonAct(l, "reject"));
    if (l.status === "accepted") {
      actions.push(reasonAct(l, "retire"), h("div", { class: "act", data: { act: "new-version" } },
        h("button", { type: "button", data: { action: "new-version" }, name: `Propose a new version of ${l.id}`, on: { click: () => newVersion(l) } }, "Propose a new version")));
    }
    const triggers = l.trigger_words.length === 0
      ? h("p", { class: "triggers" }, `Applies to every ${l.case_type} case`)
      : h("div", null, h("p", { class: "label" }, "Applies when all of these hold:"), h("ul", { class: "triggers", role: "list" }, l.trigger_words.map((w) => h("li", null, w))));
    const row = h("details", { class: `lesson status-${l.status}`, data: { lesson: l.id, status: l.status }, on: { toggle: (e) => { if ((e.target as HTMLDetailsElement).open) opened.add(l.id); else opened.delete(l.id); } } },
      h("summary", null,
        h("span", { class: "id" }, l.id), " ", h("span", { class: "title" }, l.title), " ", markingChip(ui, l.marking), " ",
        h("span", { class: "status" }, STATUS_WORDS[l.status] ?? l.status), " ", h("span", { class: "from muted" }, l.from.words)),
      h("div", { class: "lesson-body" },
        h("p", { class: "text" }, l.text),
        triggers,
        h("p", { class: "provenance" }, `Proposed by ${l.proposed.by} at ${l.proposed.ts}; ${l.from.words}`,
          l.from.case === null ? null : [" ", h("button", { type: "button", class: "link-button", data: { action: "open-case" }, name: `Open ${l.from.case}`, on: { click: () => nav.go({ screen: "case", id: l.from.case! }) } }, `Open ${l.from.case}`)]),
        l.supersedes === null ? null : h("p", { class: "supersedes" }, `A new version of ${l.supersedes}`),
        l.superseded_by === null ? null : h("p", { class: "superseded-by" }, `Replaced by ${l.superseded_by}`),
        l.decided?.reason == null ? null : h("p", { class: "reason" }, `Reason: ${l.decided.reason}`),
        h("ul", { class: "history", role: "list", name: `History of ${l.id}` }, l.history.map((e) => h("li", null, `#${e.seq} · ${e.ts} · ${e.what} by ${e.by}`))),
        actions.length === 0 ? null : h("div", { class: "lesson-actions" }, actions)));
    if (opened.has(l.id)) (row as HTMLDetailsElement).open = true;
    return row;
  };

  const groupSection = (g: MemoryView["groups"][number]): HTMLElement =>
    h("section", { class: "memory-group", data: { type: g.type?.id ?? "" } },
      h("h2", null, g.type === null ? "No case type here now" : g.type.title),
      g.type === null ? h("p", { class: "about muted" }, "Lessons whose case type is not loaded here now: none of them is offered to a case.") : h("p", { class: "about" }, g.type.about),
      g.lessons.length === 0 ? h("p", { class: "muted" }, "No lessons of this type yet") : h("div", { class: "lesson-list", role: "list" }, g.lessons.map(lessonRow)));

  // ---------- the propose form ----------

  const optionsFor = (kind: TriggerKind): [string, string][] =>
    kind === "observable" ? ui.ref.types.map((t) => [t.id, t.title]) : kind === "source" ? ui.ref.sources.map((s) => [s.id, s.title]) : [];
  const triggerRow = (t: TriggerDraft, i: number): HTMLElement => {
    const kind = h("select", {
      data: { field: "trigger-kind" }, name: `Trigger ${i + 1}: kind`,
      on: { change: (e) => { t.kind = (e.target as HTMLSelectElement).value as TriggerKind; t.value = firstValue(t.kind); paintForm(`[data-field=trigger-kind]`, i); } },
    }, KIND_WORDS.map(([k, w]) => h("option", { value: k }, w))) as HTMLSelectElement;
    kind.value = t.kind;
    let value: HTMLElement;
    if (t.kind === "finding") {
      value = h("input", { type: "text", data: { field: "trigger-value" }, name: `Trigger ${i + 1}: words`, placeholder: "words a finding holds", value: t.value, on: { input: (e) => { t.value = (e.target as HTMLInputElement).value; } } });
    } else {
      const options = optionsFor(t.kind);
      if (t.value !== "" && !options.some(([v]) => v === t.value)) options.push([t.value, t.value]);
      const sel = h("select", { data: { field: "trigger-value" }, name: `Trigger ${i + 1}: ${t.kind}`, on: { change: (e) => { t.value = (e.target as HTMLSelectElement).value; } } },
        options.map(([v, label]) => h("option", { value: v }, label))) as HTMLSelectElement;
      sel.value = t.value;
      value = sel;
    }
    return h("li", { class: "trigger-row" }, kind, value,
      h("button", { type: "button", data: { action: "remove-trigger" }, name: `Remove trigger ${i + 1}`, on: { click: () => { draft.triggers.splice(i, 1); paintForm(); } } }, "Remove"));
  };

  /** Why the draft cannot be sent as it is, said in place; null when it may go. */
  const problem = (): string | null => {
    if (draft.case_type === "") return "choose a case type";
    if (draft.title.trim() === "") return "a lesson needs a title";
    if (draft.title.length > MAX_TITLE) return `the title is ${draft.title.length} characters; a lesson's title is at most ${MAX_TITLE}`;
    if (draft.text.trim() === "") return "a lesson needs its text";
    if (draft.text.length > MAX_TEXT) return `the text is ${draft.text.length} characters; a lesson's text is at most ${MAX_TEXT}`;
    if (draft.triggers.length > MAX_TRIGGERS) return `a lesson has at most ${MAX_TRIGGERS} triggers`;
    if (draft.triggers.some((t) => t.value.trim() === "")) return "every trigger needs its value";
    return null;
  };
  const propose = (): void => {
    const why = problem();
    if (why !== null) { said.delete("propose"); refused.set("propose", why); paintForm("[data-action=propose]"); return; }
    const body = {
      case_type: draft.case_type, title: draft.title, text: draft.text, marking: draft.marking, triggers: draft.triggers.map(triggerOf),
      ...(draft.supersedes === null ? {} : { supersedes: draft.supersedes }),
    };
    if (busy.has("propose")) return;
    busy.add("propose"); said.delete("propose"); refused.delete("propose"); paintForm();
    void ui.api.proposeLesson(body).then((r) => {
      busy.delete("propose");
      if (destroyed) return;
      if ("refused" in r) refused.set("propose", r.refused.join("; "));
      else { said.set("propose", `Proposed ${r.id}`); draft = { ...blank(), case_type: draft.case_type, marking: draft.marking }; }
      paintForm("[data-action=propose]");
      read();
    }, () => { busy.delete("propose"); if (destroyed) return; refused.set("propose", "The server did not answer."); paintForm(); });
  };

  /** Draws the form from the draft; `keep` (and the trigger row `at`) names the control to give focus back to. */
  const paintForm = (keep?: string, at?: number): void => {
    clear(formHost);
    const types: [string, string][] = caseTypes().map((t) => [t.id, t.title]);
    if (draft.case_type !== "" && !types.some(([v]) => v === draft.case_type)) types.push([draft.case_type, draft.case_type]);
    const typeSelect = h("select", { data: { field: "case-type" }, name: "Case type", on: { change: (e) => { draft.case_type = (e.target as HTMLSelectElement).value; } } },
      types.length === 0 ? h("option", { value: "" }, "No case types are loaded") : types.map(([v, label]) => h("option", { value: v }, label))) as HTMLSelectElement;
    typeSelect.value = draft.case_type;
    const count = h("span", { class: "count", role: "status" }, `${draft.text.length} / ${MAX_TEXT}`);
    const markingSelect = h("select", { data: { field: "marking" }, name: "Marking", on: { change: (e) => { draft.marking = (e.target as HTMLSelectElement).value as Marking; } } },
      MARKINGS.map((m) => h("option", { value: m }, m))) as HTMLSelectElement;
    markingSelect.value = draft.marking;
    const full = draft.triggers.length >= MAX_TRIGGERS;
    formHost.append(
      h("h2", null, draft.supersedes === null ? "Propose a lesson" : `Propose a new version of ${draft.supersedes}`),
      h("p", { class: "muted" }, "A lesson is shared only when a person accepts it. It reaches a case of its type as a note, never as rules."),
      h("label", { class: "field" }, "Case type ", typeSelect),
      h("label", { class: "field" }, "Title ", h("input", { type: "text", data: { field: "title" }, name: "Title", value: draft.title, on: { input: (e) => { draft.title = (e.target as HTMLInputElement).value; } } })),
      h("label", { class: "field" }, "Text ", h("textarea", { data: { field: "text" }, name: "Text", value: draft.text, on: { input: (e) => { draft.text = (e.target as HTMLTextAreaElement).value; count.textContent = `${draft.text.length} / ${MAX_TEXT}`; count.classList.toggle("over", draft.text.length > MAX_TEXT); } } }), count),
      h("label", { class: "field" }, "Marking ", markingSelect),
      h("div", { class: "field" }, h("p", { class: "label" }, draft.triggers.length === 0 ? "Triggers: none, so it applies to every case of its type" : "Triggers: all must hold"),
        h("ol", { class: "trigger-rows" }, draft.triggers.map(triggerRow)),
        h("button", { type: "button", data: { action: "add-trigger" }, name: "Add a trigger", disabled: full, title: full ? `A lesson has at most ${MAX_TRIGGERS} triggers` : "Add a trigger",
          on: { click: () => { if (draft.triggers.length >= MAX_TRIGGERS) return; draft.triggers.push({ kind: "observable", value: firstValue("observable") }); paintForm("[data-action=add-trigger]"); } } }, "Add a trigger")),
      h("div", { class: "act", data: { act: "propose" } },
        h("button", { type: "button", class: "primary", data: { action: "propose" }, name: "Propose", disabled: busy.has("propose"), on: { click: propose } }, "Propose"),
        draft.supersedes === null ? null : h("button", { type: "button", data: { action: "cancel-version" }, on: { click: () => { draft = blank(); said.delete("propose"); refused.delete("propose"); paintForm(); } } }, "Propose a new lesson instead"),
        h("span", { class: "said", role: "status" }, said.get("propose") ?? ""),
        refusalLine(h, refused.get("propose"), "propose")));
    if (keep !== undefined) {
      const scope = at === undefined ? formHost : formHost.querySelectorAll(".trigger-row")[at] ?? formHost;
      (scope.querySelector(keep) as HTMLElement | null)?.focus();
    }
  };

  // ---------- the memory files ----------

  const fileRow = (f: MemoryView["files"][number]): HTMLElement => {
    const key = `load:${f.file}`;
    const ready = (): boolean => f.problem === null && (typed.get(key) ?? "").trim().toLowerCase() === f.head && !busy.has(key);
    const send = (): void => {
      if (!ready()) return;
      const value = typed.get(key) ?? "";
      act(key, () => ui.api.loadMemory(f.file, value), (r) => { typed.delete(key); said.set(key, `Loaded: the store holds ${r.lessons} lessons`); });
    };
    const button = h("button", { type: "button", data: { action: "load" }, name: `Load ${f.file}`, disabled: !ready(), title: "Type the 12 characters shown to load it", on: { click: send } }, "Load") as HTMLButtonElement;
    return h("article", { class: "memory-file", role: "listitem", data: { file: f.file } },
      h("div", { class: "memory-file-head" }, h("span", { class: "file" }, f.file), h("span", { class: "chip" }, f.marking), h("span", { class: "chip" }, `${f.lessons} lessons`),
        h("span", { class: "chip" }, `${f.bytes} bytes`)),
      f.problem === null ? null : h("p", { class: "problem muted" }, f.problem),
      h("p", { class: "muted" }, "Loading replaces the store here, and only with the same store further on. Type the 12 characters of its head to confirm: ", h("span", { class: "head" }, f.head)),
      h("div", { class: "memory-file-actions" },
        h("input", {
          type: "text", data: { field: "load-typed" }, name: `Type the head of ${f.file} to load it`, placeholder: f.head, value: typed.get(key) ?? "",
          on: { input: (e) => { typed.set(key, (e.target as HTMLInputElement).value); button.disabled = !ready(); }, keydown: (e) => { if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); send(); } } },
        }),
        button, h("span", { class: "said", role: "status" }, said.get(key) ?? "")),
      refusalLine(h, refused.get(key), key));
  };
  const paintFiles = (): void => {
    clear(fileHost);
    const files = memory?.files ?? [];
    fileHost.append(h("h2", null, "Memory files"));
    fileHost.append(h("div", { class: "memory-export" },
        h("button", { type: "button", data: { action: "export" }, disabled: busy.has("export"), title: "Write the store's file into the memory files folder",
          on: { click: () => act("export", () => ui.api.exportMemory(), (r) => { said.set("export", `Exported to ${r.file}`); }) } }, "Export"),
        h("span", { class: "said", role: "status" }, said.get("export") ?? ""),
        refusalLine(h, refused.get("export"), "export")));
    if (memory === null) return;
    fileHost.append(files.length === 0
      ? h("p", { class: "muted", role: "status" }, "The memory files folder holds no file. Export the store, or copy a received file into it.")
      : h("div", { class: "memory-file-list", role: "list" }, files.map(fileRow)));
  };

  // ---------- the page ----------

  const render = (): void => {
    loadError.textContent = failed ? "The memory store could not be read" : "";
    const focused = ui.doc.activeElement;
    const keep = focused !== null && (groupList.contains(focused) || fileHost.contains(focused)) ? (focused as HTMLElement).getAttribute("aria-label") : null;
    clear(groupList);
    if (memory !== null) {
      const s = memory.store;
      storeLine.textContent = `${s.lessons} lessons in the store, at entry ${s.head.seq}${s.skipped > 0 ? `; ${s.skipped} entries of the store were skipped` : ""}`;
      for (const g of memory.groups) groupList.appendChild(groupSection(g));
      if (memory.groups.length === 0) groupList.appendChild(h("p", { class: "muted", role: "status" }, "No case types are loaded, and the store holds no lesson"));
    }
    paintFiles();
    if (keep !== null) {
      for (const b of Array.from(el.querySelectorAll("button, input, select")) as HTMLElement[]) if (b.getAttribute("aria-label") === keep) { b.focus(); break; }
    }
  };

  const el = h("main", { class: "top memory", data: { screen: "memory" }, tabindex: -1 },
    h("h1", null, "Memory"),
    h("p", { class: "muted" }, "Lessons shared across cases of one type. A proposal waits for a person; a shared lesson reaches a case of its type as a note."),
    loadError, storeLine, groupList, formHost, fileHost);
  paintForm();
  render();
  read();
  return { el, update() {}, focus() { el.focus(); }, destroy() { destroyed = true; } };
}
