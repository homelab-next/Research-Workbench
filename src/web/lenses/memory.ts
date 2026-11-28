import { liveNotes, NOTE_TEXT_MAX } from "../../core/state";
import type { NoteState } from "../../core/state";
import { MARKINGS, NOTE_KINDS } from "../../core/types";
import type { NoteKind } from "../../core/types";
import type { CaseMemoryView, LessonView } from "../../core/wire";
import type { Open } from "../app";
import { cardChip, markingChip } from "../chips";
import { clear } from "../dom";
import { refusalLine } from "../refusal";
import type { Ui, View } from "../ui";
import { proposeFromNote } from "../views/memory";

const STATUS_WORDS: Record<LessonView["status"], string> = { proposed: "waiting for a person", accepted: "shared", rejected: "rejected", retired: "retired", superseded: "superseded" };

/** The children given, without the ones left out (an append would write a null as the text "null"). */
const present = (...kids: (Node | string | null)[]): (Node | string)[] => kids.filter((k): k is Node | string => k !== null);

/** Why a note's text cannot be sent as it is; null when it may go. */
export function noteProblem(text: string): string | null {
  if (text.trim() === "") return "a note needs its text";
  if (text.length > NOTE_TEXT_MAX) return `the note is ${text.length} characters; a note is at most ${NOTE_TEXT_MAX}`;
  return null;
}

/** The counts of what a binding left out, in words; "" when nothing was. */
export function leftOutWords(l: { marking: number; trigger: number; cap: number }): string {
  return [
    l.marking === 0 ? null : `${l.marking} not offered: stricter than this case`,
    l.trigger === 0 ? null : `${l.trigger} not offered: their triggers did not match`,
    l.cap === 0 ? null : `${l.cap} over the limit`,
  ].filter((x): x is string => x !== null).join(" · ");
}

/**
 * The Memory lens (slice 13): the case's type (with Frame's proposal to confirm), its notebook (the person adds, revises and drops notes; an
 * agent's notes say which stage wrote them), and the shared lessons its run was given, each with the trigger that matched it. The type and the
 * notebook are read from the state on screen, so Replay shows them as they were; the lessons are the server's view of the latest binding, read
 * when the lens opens and again whenever a new binding arrives. Every note, lesson, reason and title is only ever text. Simple lists only.
 */
export function makeMemory(ui: Ui, open: Open): View {
  const { h } = ui;
  const { store, nav } = open;
  let view: CaseMemoryView | null = null;
  let failed = false;
  let destroyed = false;
  let asked = 0;
  /** What the server's view was last read for: the live binding, the run's status and the type. */
  let readFor = "";
  /** What was typed in each field, by key ("note-text", "revise:m1", "drop:m1"), kept across repaints. */
  const typed = new Map<string, string>();
  let noteKind: NoteKind = NOTE_KINDS[0]!;
  /** The case type the person picked in the select; null follows the case's own. */
  let typeChoice: string | null = null;
  const revising = new Set<string>();
  const refused = new Map<string, string>();
  const busy = new Set<string>();
  /** Bumped by any change of the lens's own that the next paint must show. */
  let local = 0;
  let painted: unknown[] = [];

  const typePart = h("section", { class: "memory-part", data: { part: "type" } });
  const notePart = h("section", { class: "memory-part", data: { part: "notebook" } });
  const lessonPart = h("section", { class: "memory-part", data: { part: "lessons" } });
  const el = h("div", { class: "lens lens-memory", name: "Memory" }, typePart, notePart, lessonPart);

  const liveKey = (): string => `${store.live.memory.bound?.seq ?? ""}|${store.live.run.status}|${store.live.memory.type ?? ""}`;
  const read = (): void => {
    readFor = liveKey();
    const mine = ++asked;
    ui.api.caseMemory(store.id).then((v) => {
      if (destroyed || mine !== asked) return;
      view = v; failed = false; paint();
    }, () => { if (destroyed || mine !== asked) return; failed = true; paint(); });
  };
  const replaying = (): boolean => store.at !== null;
  const titleOf = (id: string): string => ui.ref.case_types.find((t) => t.id === id)?.title ?? id;

  /** Sends a command of the person's; its refusal is kept under `key`, drawn beside the control that sent it. */
  const send = (key: string, command: string, args: Record<string, unknown>, done?: () => void): void => {
    if (busy.has(key)) return;
    busy.add(key); refused.delete(key); local++; paint();
    void ui.send(command, args, undefined, undefined, (why) => { refused.set(key, why); }).then((r) => {
      busy.delete(key);
      if (destroyed) return;
      if (r !== null) done?.();
      local++; paint();
    });
  };
  /** A refusal said in place without asking the server. */
  const refuse = (key: string, why: string): void => { refused.set(key, why); local++; paint(); };

  // ---------- the case's type ----------

  const paintType = (): void => {
    clear(typePart);
    const m = store.shown.memory;
    const off = replaying();
    const proposal = m.type === null ? m.proposed_type : null;
    const select = h("select", {
      data: { field: "case-type", key: "case-type" }, name: "Case type", disabled: off,
      on: { change: (e) => { typeChoice = (e.target as HTMLSelectElement).value; } },
    }, h("option", { value: "" }, "None"), ui.ref.case_types.map((t) => h("option", { value: t.id }, t.title))) as HTMLSelectElement;
    select.value = typeChoice ?? m.type ?? "";
    typePart.append(...present(
      h("h3", null, "Case type"),
      h("p", { class: "case-type" }, m.type === null ? "No case type" : titleOf(m.type)),
      proposal === null ? null : h("div", { class: "type-proposal" },
        h("p", { class: "suggests" }, `Frame suggests: ${titleOf(proposal.type)}`), " ",
        h("button", {
          type: "button", class: "primary", data: { action: "confirm-type", key: "confirm-type" }, disabled: off || busy.has("confirm-type"), title: `Make ${titleOf(proposal.type)} this case's type`,
          on: { click: () => send("confirm-type", "set_case_type", { type: proposal.type }, () => { typeChoice = null; }) },
        }, "Confirm"),
        h("p", { class: "why muted" }, proposal.why),
        refusalLine(h, refused.get("confirm-type"), `memory:${store.id}:confirm-type`)),
      h("div", { class: "act", data: { act: "set-type" } }, select, " ",
        h("button", {
          type: "button", data: { action: "set-type", key: "set-type" }, disabled: off || busy.has("set-type"), title: "Set this case's type; None clears it",
          on: { click: () => { const v = typeChoice ?? m.type ?? ""; send("set-type", "set_case_type", { type: v === "" ? null : v }, () => { typeChoice = null; }); } },
        }, "Set"),
        refusalLine(h, refused.get("set-type"), `memory:${store.id}:set-type`)),
      view !== null && view.reads.shared && m.type === null ? h("p", { class: "no-shared muted" }, "This case has no type, so no shared lesson is offered to it.") : null));
  };

  // ---------- the notebook ----------

  const who = (n: NoteState): string => (n.by === "agent" && n.stage !== null ? `noted by ${n.author} at the ${n.stage} stage` : `noted by ${n.author}`);

  const noteRow = (n: NoteState): HTMLElement => {
    const off = replaying();
    const reviseKey = `revise:${n.id}`, dropKey = `drop:${n.id}`;
    const body: (HTMLElement | string | null)[] = [];
    if (revising.has(n.id) && !off) {
      const field = h("textarea", {
        data: { field: "revise-text", key: reviseKey }, name: `New text of ${n.id}`, value: typed.get(reviseKey) ?? n.text,
        on: { input: (e) => { typed.set(reviseKey, (e.target as HTMLTextAreaElement).value); } },
      }) as HTMLTextAreaElement;
      const save = (): void => {
        const text = typed.get(reviseKey) ?? n.text;
        const why = noteProblem(text);
        if (why !== null) { refuse(reviseKey, why); return; }
        send(reviseKey, "revise_memory", { item: n.id, kind: n.kind, text, cards: n.cards }, () => { revising.delete(n.id); typed.delete(reviseKey); });
      };
      body.push(h("div", { class: "revise", data: { act: "revise" } }, field,
        h("button", { type: "button", class: "primary", data: { action: "save-revision", key: `save:${n.id}` }, disabled: busy.has(reviseKey), on: { click: save } }, "Save"),
        h("button", { type: "button", data: { action: "cancel-revision", key: `cancel:${n.id}` }, on: { click: () => { revising.delete(n.id); typed.delete(reviseKey); refused.delete(reviseKey); local++; paint(); } } }, "Cancel"),
        refusalLine(h, refused.get(reviseKey), `memory:${store.id}:${reviseKey}`)));
    } else body.push(h("span", { class: "text" }, n.text));
    const reason = (): string => (typed.get(dropKey) ?? "").trim();
    const drop = h("button", {
      type: "button", data: { action: "drop", key: `dropbtn:${n.id}` }, disabled: off || reason() === "" || busy.has(dropKey), title: "Type why it is dropped first",
      on: { click: () => { if (replaying() || reason() === "") return; send(dropKey, "drop_memory", { item: n.id, reason: reason() }, () => { typed.delete(dropKey); }); } },
    }, "Drop") as HTMLButtonElement;
    return h("li", { class: "note", data: { note: n.id, kind: n.kind } },
      h("div", { class: "note-head" }, h("span", { class: "kind chip" }, n.kind), " ", ...body),
      n.cards.length === 0 ? null : h("div", { class: "cards" }, n.cards.map((c) => cardChip(ui, c, (card) => nav.focusCard(card)))),
      h("p", { class: "muted" }, h("span", { class: "who" }, who(n)), n.revised === null ? null : h("span", { class: "revised" }, `; revised by ${n.revised.by}`)),
      h("div", { class: "note-actions" },
        h("button", {
          type: "button", data: { action: "revise", key: `revisebtn:${n.id}` }, disabled: off || revising.has(n.id), title: "Change this note's text",
          on: { click: () => { revising.add(n.id); local++; paint(); (notePart.querySelector(`[data-key="${reviseKey}"]`) as HTMLElement | null)?.focus(); } },
        }, "Revise"),
        h("span", { class: "act", data: { act: "drop" } },
          h("input", {
            type: "text", data: { field: "drop-reason", key: dropKey }, name: `Why drop ${n.id}`, placeholder: "why it no longer holds", disabled: off, value: typed.get(dropKey) ?? "",
            on: { input: (e) => { typed.set(dropKey, (e.target as HTMLInputElement).value); drop.disabled = replaying() || reason() === "" || busy.has(dropKey); } },
          }), drop),
        h("button", {
          type: "button", data: { action: "propose-lesson", key: `propose:${n.id}` }, disabled: off, title: "Open the Memory page with a lesson proposed from this note",
          on: { click: () => {
            if (replaying()) return;
            proposeFromNote(ui, { case: store.id, item: n.id, case_type: store.live.memory.type ?? "", text: n.text, marking: store.live.meta?.marking ?? MARKINGS[0]! });
            nav.go({ screen: "memory" });
          } },
        }, "Propose as a lesson")),
      refusalLine(h, refused.get(dropKey), `memory:${store.id}:${dropKey}`));
  };

  const addForm = (): HTMLElement => {
    const off = replaying();
    const text = typed.get("note-text") ?? "";
    const count = h("span", { class: `note-count${text.length > NOTE_TEXT_MAX ? " over" : ""}`, role: "status" }, `${text.length} / ${NOTE_TEXT_MAX}`);
    const kind = h("select", {
      data: { field: "note-kind", key: "note-kind" }, name: "Kind of note", disabled: off,
      on: { change: (e) => { noteKind = (e.target as HTMLSelectElement).value as NoteKind; } },
    }, NOTE_KINDS.map((k) => h("option", { value: k }, k))) as HTMLSelectElement;
    kind.value = noteKind;
    const add = (): void => {
      if (replaying()) return;
      const t = typed.get("note-text") ?? "";
      const why = noteProblem(t);
      if (why !== null) { refuse("add-note", why); return; }
      send("add-note", "note_memory", { kind: noteKind, text: t }, () => { typed.delete("note-text"); });
    };
    return h("div", { class: "note-add act", data: { act: "add-note" } },
      h("h3", { class: "sub" }, "Add a note"), kind,
      h("textarea", {
        data: { field: "note-text", key: "note-text" }, name: "Note", placeholder: "A fact, a decision or a pointer worth keeping for this case", disabled: off, value: text,
        on: { input: (e) => { const v = (e.target as HTMLTextAreaElement).value; typed.set("note-text", v); count.textContent = `${v.length} / ${NOTE_TEXT_MAX}`; count.classList.toggle("over", v.length > NOTE_TEXT_MAX); } },
      }), count,
      h("button", { type: "button", class: "primary", data: { action: "add-note", key: "add-note" }, disabled: off || busy.has("add-note"), on: { click: add } }, "Add"),
      refusalLine(h, refused.get("add-note"), `memory:${store.id}:add-note`));
  };

  const paintNotes = (): void => {
    clear(notePart);
    const s = store.shown;
    const live = liveNotes(s);
    const dropped = s.memory.order.map((id) => s.memory.notes[id]).filter((n): n is NoteState => n !== undefined && n.dropped !== null).reverse();
    notePart.append(...present(
      h("h3", null, "Notebook"),
      view !== null && !view.reads.notes ? h("p", { class: "no-notebook muted" }, "This case's loop does not offer the notebook to its stages.") : null,
      live.length === 0 ? h("p", { class: "muted" }, "No notes in the notebook.") : h("ol", { class: "notes", role: "list" }, live.map(noteRow)),
      addForm(),
      dropped.length === 0 ? null : h("details", { class: "dropped-notes" },
        h("summary", null, `Dropped notes (${dropped.length})`),
        h("ul", { role: "list" }, dropped.map((n) => h("li", { class: "dropped-note", data: { note: n.id } },
          h("span", { class: "kind chip" }, n.kind), " ", h("span", { class: "text" }, n.text), " ",
          h("span", { class: "dropped-why muted" }, `dropped by ${n.dropped!.by}: ${n.dropped!.reason}`)))))));
  };

  // ---------- the shared lessons a run was given ----------

  const replayLine = (): HTMLElement | null => {
    if (store.at === null) return null;
    const at = store.at;
    const then = store.shown.memory.bound;
    const latest = view?.bound ?? null;
    const words = then === null ? `At entry #${at} no binding of shared lessons was in force.`
      : latest !== null && latest.seq === then.seq ? `At entry #${at} the binding of entry #${then.seq} was in force: the lessons below.`
      : `At entry #${at} the binding of entry #${then.seq} was in force; the lessons below are of the latest binding${latest === null ? "" : `, entry #${latest.seq}`}.`;
    return h("p", { class: "replay-binding" }, words);
  };

  const paintLessons = (): void => {
    clear(lessonPart);
    lessonPart.append(...present(h("h3", null, "Shared lessons loaded"), replayLine()));
    if (view === null) { lessonPart.append(h("p", { class: failed ? "load-error say" : "muted", role: failed ? "alert" : "status" }, failed ? "The case's memory could not be read" : "Reading the case's memory…")); return; }
    const b = view.bound;
    if (b === null) lessonPart.append(h("p", { class: "no-binding muted" }, "No run of this case has loaded shared lessons."));
    else {
      lessonPart.append(h("p", { class: "bound-at muted" }, `Bound at entry #${b.seq}, from the store at entry ${b.store_head}`));
      lessonPart.append(b.lessons.length === 0 ? h("p", { class: "no-lessons muted" }, "No shared lesson was offered to this run.")
        : h("ul", { class: "loaded-lessons", role: "list" }, b.lessons.map((l) => h("li", { class: "loaded-lesson", data: { lesson: l.id } },
          h("div", { class: "lesson-head" }, h("span", { class: "id" }, l.id), " ", h("span", { class: "title" }, l.title), " ", markingChip(ui, l.marking),
            l.still_shared ? null : [" ", h("span", { class: "chip no-longer" }, "no longer shared")]),
          h("p", { class: "lesson-text" }, l.text),
          h("p", { class: "why" }, `Offered because: ${l.matched.join("; ")}`),
          h("p", { class: "stages muted" }, `Went to: ${l.stages.join(", ")}`),
          h("p", { class: "from muted" }, `From: ${l.from}`)))));
      const left = leftOutWords(b.left_out);
      if (left !== "") lessonPart.append(h("p", { class: "left-out muted" }, left));
    }
    if (view.proposed.length > 0) {
      lessonPart.append(h("h3", { class: "sub" }, "Lessons proposed from this case"),
        h("ul", { class: "proposed-lessons", role: "list" }, view.proposed.map((l) => h("li", { class: "proposed-lesson", data: { lesson: l.id, status: l.status } },
          h("span", { class: "id" }, l.id), " ", h("span", { class: "title" }, l.title), " ", h("span", { class: "chip status" }, STATUS_WORDS[l.status] ?? l.status), " ",
          h("button", { type: "button", class: "link-button", data: { action: "open-memory" }, title: "Open the Memory page, where a person accepts or rejects it", on: { click: () => nav.go({ screen: "memory" }) } }, "Memory page")))));
    }
  };

  /** Draws what changed; focus (and a field's caret) stays where it was. */
  function paint(): void {
    const next = [store.shown.memory, store.at, view, failed, local];
    if (next.length === painted.length && next.every((x, i) => x === painted[i])) return;
    painted = next;
    const active = ui.doc.activeElement as HTMLElement | null;
    const key = active !== null && el.contains(active) ? active.getAttribute("data-key") : null;
    const typing = active !== null && (active.tagName === "TEXTAREA" || active.tagName === "INPUT");
    const caret = key !== null && typing ? [(active as HTMLInputElement).selectionStart, (active as HTMLInputElement).selectionEnd] : null;
    paintType(); paintNotes(); paintLessons();
    if (key === null) return;
    const again = el.querySelector(`[data-key="${key}"]`) as HTMLElement | null;
    if (again === null) return;
    again.focus();
    if (caret !== null && caret[0] !== null) { try { (again as HTMLInputElement).setSelectionRange(caret[0], caret[1] ?? caret[0]); } catch { /* a select has no caret */ } }
  }

  read();
  paint();
  return {
    el,
    update() {
      if (liveKey() !== readFor) read();
      paint();
    },
    destroy() { destroyed = true; },
  };
}
