import { activeOverrules, blockers, CARD_REF, gateChanges, keepText, latestDraft, notedExceptions, overruleSays, proposalMarking, publishable, rulingText, runConflicts } from "../../core/state";
import type { CaseState, ConflictState, Overrule } from "../../core/state";
import { CONFIDENCES } from "../../core/types";
import type { Actor, Draft, Finding, Product } from "../../core/types";
import type { Preview } from "../../core/wire";
import type { Open } from "../app";
import { cardChip, markingChip, tag } from "../chips";
import type { Child } from "../dom";
import { clear, fileLink } from "../dom";
import { narrativeMarkdown, SECTION_TITLES, TEXT_SECTIONS } from "../markdown";
import type { TextSection } from "../markdown";
import { AT_GATE, REPLAY_REFUSAL, typingIn } from "../ui";
import type { Ui, View } from "../ui";
import { refusalLine } from "../refusal";
import { makeQuestions, shownQuestions } from "../views/questions";

export interface NarrativeView extends View {
  /** Opens the edit form and puts `[<card>]` at the caret of `section` (the one last focused, Summary at first). */
  cite(card: string, section?: string): void;
}

const TITLE = new Map<string, string>(SECTION_TITLES.map((s) => [s.id, s.title]));
const isText = (x: string): x is TextSection => (TEXT_SECTIONS as string[]).includes(x);
const byId = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });
const lines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
const names = (a: Actor): string => a.id;
const OVERRULE_ARG = "overrule:";
const LEAVE = "leave as it is";
const STAYS: readonly [string, string][] = [["", LEAVE], ["stay", "must stay"], ["drop", "drop it"]];
/** What a person's overrule set, in the words of the lens. */
const overruleLine = (o: Overrule): string => `${overruleSays(o)}. Note: ${o.note.trim()}`;

interface EditForm {
  base: string;
  el: HTMLElement;
  areas: Map<TextSection, HTMLTextAreaElement>;
  finding(id: string): { statement: HTMLTextAreaElement; likelihood: HTMLInputElement; confidence: HTMLSelectElement; basis: HTMLInputElement; cites: HTMLInputElement; assumptions: HTMLTextAreaElement; reasoning: HTMLTextAreaElement };
  reason: HTMLInputElement;
  save: HTMLButtonElement;
  sync(): void;
}

/** The Narrative lens (guide §5.3, spec §9.5): the draft, how the review stands, and the publish gate. Everything shown comes from the fold, the preview the server computes, and the recorded text. */
export function makeNarrative(ui: Ui, open: Open, arg: string | null = null): NarrativeView {
  const { h } = ui;
  const { store, nav } = open;
  const el = h("div", { class: "lens lens-narrative", name: "Narrative" });
  const state = (): CaseState => store.shown;
  const ro = (): boolean => store.at !== null;
  const draftOf = (): Draft | null => latestDraft(state());
  const owns = <T,>(o: Record<string, T>, k: string): boolean => Object.hasOwn(o, k);
  const kept = (id: string): boolean => owns(state().cards, id) && state().cards[id]!.place === "lane";
  /** A draft can be edited while a run is going on: before the gate too (spec §9.5). */
  const canEdit = (s: CaseState): boolean => latestDraft(s) !== null && s.run.status !== "none" && s.run.status !== "finished";
  const runGoing = (s: CaseState): boolean => s.run.status !== "none" && s.run.status !== "finished";

  let destroyed = false;
  let edit: EditForm | null = null;
  let lastSection: TextSection = "summary";
  const caret = new Map<TextSection, number>();
  let saving = false;
  let rejecting = false;
  let rejectReason = "";
  let rejectStop = false;
  const answers = new Map<string, string>();
  const ruleNotes = new Map<string, string>();
  /** Conflicts whose "Change the ruling" the person has opened. */
  const changing = new Set<string>();
  const kinds = new Map<string, string>();
  const proposalText = new Map<string, string>();
  const proposalEdit = new Set<string>();
  let fallback: string | null = null;
  let focusFallback = false;
  let tab: string | null = null;
  let preview: { seq: number; value: Preview | "failed" } | null = null;
  let asked = -1;
  let pickerAt: HTMLElement | null = null;
  let focusedAtGate = false;
  /** The draft the Approve focus was offered for: a new draft offers it again. */
  let focusedFor: string | null = null;
  // a one-shot: the person asked to be taken to the gate (Shift+Enter, the brief's button, the command bar), from where focus was then
  let armed = arg === AT_GATE;
  const armedFrom = armed ? ui.doc.activeElement : null;
  /** `overrule:<finding>` (the command bar's `overrule f1`): that finding's form is opened, and focus put in its note, once. */
  let focusOverrule: string | null = arg !== null && arg.startsWith(OVERRULE_ARG) ? arg.slice(OVERRULE_ARG.length) : null;
  /** The draft the one-shot was armed for: it is for the gate waiting when the person asked, not a later one. */
  let armedFor: string | null | undefined;
  /** Commands sent and not yet seen: the answer's seq once it has come (the press stays off until that entry is here), null while the answer is awaited. */
  const inflight = new Map<string, number | null>();
  let inflightVersion = 0;
  /** What the server said when it refused a command, by the same key, shown beside the control that sent it until it is sent again (slice 10). */
  const refusals = new Map<string, string>();
  /** What the person chose for "Unload after publishing", by run id; nothing is stored, and a run not seen yet starts from the setting. */
  const unloadChoice = new Map<string, boolean>();
  /** The files each published bundle's recorded manifest lists, by product number. */
  const bundles = new Map<number, string[] | "loading" | "failed">();
  let bundlesVersion = 0;

  const draftBox = h("div", { class: "draft" });
  const headBox = h("div", { class: "head-box" });
  const bodyBox = h("div", { class: "body-box" });
  const toolsBox = h("div", { class: "tools-box" });
  const reviewBox = h("div", { class: "review-box" });
  const previewBox = h("div", { class: "preview-box" });
  const gateBox = h("div", { class: "gate-box" });
  const copyBox = h("div", { class: "copy-box" });
  const proposalsBox = h("div", { class: "proposals-box" });
  const questions = makeQuestions(ui, open);
  const questionsBox = questions.el;
  draftBox.append(headBox, bodyBox);
  el.append(questionsBox, draftBox, toolsBox, gateBox, reviewBox, previewBox, copyBox, proposalsBox);

  // ---------- repainting a part only when what it shows has changed ----------
  const sigs = new Map<HTMLElement, unknown[]>();
  const keyOf = (n: Element | null): string | null => n === null ? null : [
    n.tagName, n.getAttribute("aria-label") ?? "", n.getAttribute("data-action") ?? "",
    n.closest("[data-challenge]")?.getAttribute("data-challenge") ?? "", n.closest("[data-conflict]")?.getAttribute("data-conflict") ?? "", n.closest("[data-proposal]")?.getAttribute("data-proposal") ?? "",
    n.closest("[data-question]")?.getAttribute("data-question") ?? "", n.closest("[data-finding]")?.getAttribute("data-finding") ?? "", n.getAttribute("data-tab") ?? "", n.getAttribute("data-pick") ?? "",
  ].join("|");
  const paint = (box: HTMLElement, sig: unknown[], build: () => Node[]): void => {
    const was = sigs.get(box);
    if (was !== undefined && was.length === sig.length && was.every((x, i) => x === sig[i])) return;
    sigs.set(box, sig);
    const active = ui.doc.activeElement;
    const key = active !== null && box.contains(active) ? keyOf(active) : null;
    clear(box);
    for (const n of build()) box.appendChild(n);
    if (key !== null) {
      const again = [...box.querySelectorAll("input, button, textarea, select")].find((n) => keyOf(n) === key) as HTMLElement | undefined;
      if (again !== undefined) {
        again.focus();
        const t = again as HTMLInputElement;
        if (typeof t.setSelectionRange === "function" && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) { try { t.setSelectionRange(t.value.length, t.value.length); } catch { /* not a text field */ } }
      }
    }
  };

  /** Sends a command once: until the server has answered and its entries are here, the same press does nothing. */
  const guarded = (key: string, command: string, args: Record<string, unknown>, then?: () => void): void => {
    if (inflight.has(key)) return;
    inflight.set(key, null); inflightVersion++;
    refusals.delete(key);
    render();
    void ui.send(command, args, undefined, undefined, (why) => { refusals.set(key, why); }).then((r) => {
      if (r === null) inflight.delete(key); else { inflight.set(key, r.seq); then?.(); }
      inflightVersion++;
      render();
    });
  };
  const loadBundle = (n: number): void => {
    if (bundles.has(n)) return;
    bundles.set(n, "loading");
    const entry = [...store.entries].reverse().find((e) => e.type === "product.published" && e.payload.n === n);
    const done = (v: string[] | "failed"): void => { bundles.set(n, v); bundlesVersion++; render(); };
    if (entry === undefined || entry.type !== "product.published") { done("failed"); return; }
    ui.api.blobText(store.id, entry.payload.bundle.blob).then((text) => {
      const files = (JSON.parse(text) as { manifest?: { files?: { name?: unknown }[] } }).manifest?.files;
      if (!Array.isArray(files)) { done("failed"); return; }
      done([...files.flatMap((f) => (typeof f.name === "string" && /^[a-z0-9.]+$/.test(f.name) ? [f.name] : [])), "manifest.json"]);
    }).catch(() => done("failed"));
  };

  // ---------- text with citations as chips ----------
  const chipFor = (id: string): Node => (owns(state().cards, id) ? cardChip(ui, id, (c) => nav.focusCard(c), !kept(id)) : ui.doc.createTextNode(id));
  const withChips = (text: string): Child[] => {
    const out: Child[] = [];
    let at = 0;
    for (const m of text.matchAll(CARD_REF)) {
      out.push(text.slice(at, m.index));
      out.push(chipFor(m[0].toLowerCase()));
      at = m.index + m[0].length;
    }
    out.push(text.slice(at));
    return out;
  };
  const paragraphs = (text: string): HTMLElement[] =>
    text.trim() === "" ? [h("p", { class: "empty" }, "Nothing written.")] : text.split(/\n{2,}/).map((t) => h("p", null, withChips(t)));

  // ---------- overrules ----------
  interface OverruleFields { likelihood: string; confidence: string; stays: string; note: string }
  const overruleVals = new Map<string, OverruleFields>();
  const overruleOpen = new Set<string>(focusOverrule === null ? [] : [focusOverrule]);
  /** Bumped when a finding's Overrule form is opened or closed, so the findings are drawn again. */
  let overruleVersion = 0;
  const fieldsOf = (id: string): OverruleFields => {
    let v = overruleVals.get(id);
    if (v === undefined) { v = { likelihood: "", confidence: "", stays: "", note: "" }; overruleVals.set(id, v); }
    return v;
  };
  /** What the person overruled on this finding, the overrules it replaced, and the form to overrule it again or withdraw it. */
  const overruleView = (s: CaseState, d: Draft, id: string): Child[] => {
    const o = owns(s.overrules, id) ? s.overrules[id]! : null;
    const active = activeOverrules(s).some((x) => x.finding === id);
    const past: Overrule[] = o === null ? [] : active ? o.earlier : [...o.earlier, o];
    const v = fieldsOf(id);
    const key = `overrule:${id}`;
    const busy = (): boolean => inflight.has(key);
    const noted = (): boolean => v.note.trim() !== "";
    const nothingSet = (): boolean => v.likelihood === "" && v.confidence === "" && v.stays === "";
    const send = (withdraw: boolean): void => {
      if (ro() || busy() || !noted() || (!withdraw && nothingSet())) return;
      const args = withdraw
        ? { finding: id, draft_hash: d.hash, likelihood: null, confidence: null, stays: null, note: v.note.trim() }
        : { finding: id, draft_hash: d.hash, likelihood: v.likelihood === "" ? null : v.likelihood, confidence: v.confidence === "" ? null : v.confidence, stays: v.stays === "stay" ? true : v.stays === "drop" ? false : null, note: v.note.trim() };
      guarded(key, "overrule_finding", args, () => { overruleVals.delete(id); overruleOpen.delete(id); });
    };
    const select = (name: string, options: readonly [string, string][], value: string, set: (x: string) => void): HTMLSelectElement => {
      const el2 = h("select", { name, disabled: ro(), on: { change: (e) => { set((e.target as HTMLSelectElement).value); sync(); } } }, options.map(([val, text]) => h("option", { value: val }, text))) as HTMLSelectElement;
      el2.value = value;
      return el2;
    };
    const likelihood = select(`Likelihood of ${id}`, [["", LEAVE], ...ui.ref.likelihood.map((t): [string, string] => [t, t])], v.likelihood, (x) => { v.likelihood = x; });
    const confidence = select(`Confidence of ${id}`, [["", LEAVE], ...CONFIDENCES.map((c): [string, string] => [c, c])], v.confidence, (x) => { v.confidence = x; });
    const stays = select(`Whether ${id} stays`, STAYS, v.stays, (x) => { v.stays = x; if (x === "drop") { v.likelihood = ""; v.confidence = ""; } });
    const note = h("textarea", {
      name: `Note on overruling ${id}`, value: v.note, disabled: ro(), placeholder: "Why (needed): what you know that the draft does not",
      on: { input: (e) => { v.note = (e.target as HTMLTextAreaElement).value; sync(); } },
    }) as HTMLTextAreaElement;
    const go = h("button", { type: "button", class: "primary", name: `Send the overrule of ${id}`, data: { action: "overrule" }, on: { click: () => { send(false); } } }, "Send the overrule") as HTMLButtonElement;
    const withdraw = active ? h("button", { type: "button", data: { action: "withdraw-overrule" }, on: { click: () => { send(true); } } }, "Withdraw the overrule") as HTMLButtonElement : null;
    function sync(): void {
      const dropped = v.stays === "drop";
      if (dropped) { likelihood.value = ""; confidence.value = ""; }
      likelihood.disabled = ro() || dropped; confidence.disabled = ro() || dropped;
      go.disabled = ro() || busy() || nothingSet() || !noted();
      go.title = ro() ? REPLAY_REFUSAL : nothingSet() ? "Choose what to set" : !noted() ? "An overrule needs a note" : `Overrule ${id}: code holds every draft to it`;
      if (withdraw !== null) {
        withdraw.disabled = ro() || busy() || !noted();
        withdraw.title = ro() ? REPLAY_REFUSAL : !noted() ? "Withdrawing needs a note" : `Withdraw your overrule of ${id}: the analyst assesses it again`;
      }
    }
    sync();
    // Overrule is a button on the finding, always in view; it opens the form in place (it was a fold before slice 10, and people did not find it)
    const body = h("div", { class: "overrule-body", hidden: !overruleOpen.has(id) },
      h("p", { class: "overrule-heading" }, `Overrule ${id}`),
      h("label", null, "Likelihood ", likelihood), h("label", null, "Confidence ", confidence), h("label", null, "Stays ", stays),
      note, h("div", { class: "actions" }, go, withdraw), refusalLine(h, refusals.get(key), `n:${key}`),
      h("p", { class: "note" }, "Code holds every draft to your overrule, and neither reviewer may move it back. While a run is in progress the draft goes back to the analyst to rewrite the finding's basis and reasoning when the current stage ends; at the publish gate it waits under Your changes until you send it back. An overrule passes no gate."));
    const toggle = h("button", {
      type: "button", class: "overrule-toggle", name: `Overrule ${id}`, data: { action: "open-overrule" }, aria: { expanded: String(overruleOpen.has(id)) },
      title: overruleOpen.has(id) ? `Close the Overrule form of ${id}` : `Set ${id}'s likelihood, confidence or place yourself, with a note`,
      on: { click: () => {
        if (overruleOpen.has(id)) overruleOpen.delete(id); else overruleOpen.add(id);
        overruleVersion++;
        render();
      } },
    }, "Overrule") as HTMLButtonElement;
    const form = h("div", { class: "overrule-form" }, toggle, body);
    return [
      active && o !== null ? h("p", { class: "overrule-now" }, `You overruled: ${overruleLine(o)}`) : null,
      past.map((x) => h("p", { class: "overrule-earlier" }, `Earlier: ${overruleLine(x)}`)),
      form,
    ];
  };
  /** Findings the person dropped that the draft no longer holds: listed so that the overrule can be withdrawn. */
  const droppedView = (s: CaseState, d: Draft): HTMLElement | null => {
    const gone = activeOverrules(s).filter((o) => o.stays === false && !d.product.key_findings.some((f) => f.id === o.finding));
    return gone.length === 0 ? null : h("div", { class: "dropped-findings" }, h("p", { class: "label" }, "Findings you dropped"),
      gone.map((o) => h("div", { class: "finding dropped", data: { finding: o.finding } }, h("span", { class: "finding-id" }, o.finding), h("p", { class: "statement" }, "dropped from the draft by your overrule"), overruleView(s, d, o.finding))));
  };

  // ---------- the draft, read ----------
  const finding = (s: CaseState, d: Draft, f: Finding): HTMLElement =>
    h("div", { class: "finding", data: { finding: f.id } },
      h("span", { class: "finding-id", title: `Finding ${f.id}: reviewers, checks and the controller name it so` }, f.id),
      h("p", { class: "statement" }, f.statement),
      h("p", { class: "likelihood" }, `Likelihood: ${f.likelihood}`),
      h("p", { class: "confidence" }, `Confidence: ${f.confidence} — ${f.confidence_basis}`),
      h("div", { class: "evidence" }, h("span", { class: "label" }, "Evidence "), f.cites.length === 0 ? "No card cited." : f.cites.map((c) => [chipFor(c), " "])),
      h("div", { class: "assumptions" }, h("span", { class: "label" }, "Assumptions"), f.assumptions.length === 0 ? h("p", { class: "empty" }, "None stated.") : h("ul", null, f.assumptions.map((a) => h("li", null, a)))),
      h("div", { class: "reasoning" }, h("span", { class: "label" }, "Reasoning "), tag(ui, "agent", "judgment", "Reasoning is a judgment, not evidence"), " ", f.reasoning),
      overruleView(s, d, f.id));

  const readBody = (s: CaseState, d: Draft): Node[] =>
    SECTION_TITLES.map(({ id, title }) => {
      const kids: Child[] = [h("h3", { class: "section-title" }, title)];
      if (id === "key_findings") kids.push(d.product.key_findings.length === 0 ? h("p", { class: "empty" }, "No findings.") : d.product.key_findings.map((f) => finding(s, d, f)), droppedView(s, d));
      else kids.push(paragraphs(d.product[id]));
      return h("section", { class: "narr-section", data: id === "key_findings" ? { section: id } : { section: id, drop: "cite" } }, kids);
    });

  // ---------- the edit form ----------
  const insertAt = (ta: HTMLTextAreaElement, section: TextSection, text: string, replaceHash: boolean): void => {
    const v = ta.value;
    let pos = Math.min(caret.get(section) ?? v.length, v.length);
    let before = v.slice(0, pos);
    if (replaceHash && before.endsWith("#")) before = before.slice(0, -1);
    else if (!replaceHash && before !== "" && !/\s$/.test(before)) before += " ";
    const rest = v.slice(pos);
    const gap = !replaceHash && rest !== "" && !/^\s/.test(rest) ? " " : "";
    ta.value = `${before}${text}${gap}${rest}`;
    const at = before.length + text.length;
    caret.set(section, at);
    ta.focus();
    try { ta.setSelectionRange(at, at); } catch { /* not supported */ }
  };
  const closePicker = (): void => { pickerAt?.remove(); pickerAt = null; };
  const openPicker = (ta: HTMLTextAreaElement, section: TextSection, host: HTMLElement): void => {
    closePicker();
    const cards = Object.values(state().cards).filter((c) => c.place === "lane").sort((a, b) => byId(a.id, b.id));
    const items: Child[] = cards.length === 0
      ? [h("p", { class: "empty" }, "No kept cards to cite. Keep a card first.")]
      : cards.map((c) => h("button", { type: "button", class: "pick", data: { pick: c.id }, title: `Cite ${c.id}`, on: { click: () => { closePicker(); insertAt(ta, section, `[${c.id}]`, true); } } }, `${c.title} (${c.id})`));
    pickerAt = h("div", { class: "picker", role: "listbox", name: "Kept cards", on: { keydown: (e) => { if ((e as KeyboardEvent).key === "Escape") { e.stopPropagation(); closePicker(); ta.focus(); } } } }, items);
    host.appendChild(pickerAt);
  };

  const buildEdit = (d: Draft): EditForm => {
    const areas = new Map<TextSection, HTMLTextAreaElement>();
    const fields = new Map<string, ReturnType<EditForm["finding"]>>();
    const sections: HTMLElement[] = [];
    for (const { id, title } of SECTION_TITLES) {
      if (id === "key_findings") {
        sections.push(h("section", { class: "edit-section", data: { section: id } }, h("h3", { class: "section-title" }, title), d.product.key_findings.map((f) => {
          const field = <E extends HTMLElement>(node: E): E => node;
          const statement = field(h("textarea", { name: `Statement of ${f.id}`, value: f.statement }) as HTMLTextAreaElement);
          const likelihood = field(h("input", { type: "text", name: `Likelihood of ${f.id}`, value: f.likelihood }) as HTMLInputElement);
          const confidence = field(h("select", { name: `Confidence of ${f.id}` }, CONFIDENCES.map((c) => h("option", { value: c }, c))) as HTMLSelectElement);
          confidence.value = f.confidence;
          const basis = field(h("input", { type: "text", name: `Basis of ${f.id}`, value: f.confidence_basis }) as HTMLInputElement);
          const cites = field(h("input", { type: "text", name: `Cites of ${f.id}`, value: f.cites.join(", "), placeholder: "c1, c2" }) as HTMLInputElement);
          const assumptions = field(h("textarea", { name: `Assumptions of ${f.id}`, value: f.assumptions.join("\n"), placeholder: "One per line" }) as HTMLTextAreaElement);
          const reasoning = field(h("textarea", { name: `Reasoning of ${f.id}`, value: f.reasoning }) as HTMLTextAreaElement);
          fields.set(f.id, { statement, likelihood, confidence, basis, cites, assumptions, reasoning });
          const row = (label: string, input: HTMLElement): HTMLElement => h("label", { class: "edit-row" }, h("span", { class: "label" }, label), input);
          return h("fieldset", { class: "edit-finding", data: { finding: f.id } }, h("legend", null, `Finding ${f.id}`),
            row("Statement", statement), row("Likelihood", likelihood), row("Confidence", confidence), row("Basis", basis), row("Cites", cites), row("Assumptions", assumptions), row("Reasoning (judgment)", reasoning));
        })));
        continue;
      }
      const host = h("section", { class: "edit-section", data: { section: id, drop: "cite" } });
      const ta = h("textarea", {
        name: title, value: d.product[id], placeholder: "Type # to cite a kept card",
        on: {
          focus: () => { lastSection = id; },
          input: () => {
            const t = areas.get(id)!;
            const at = t.selectionStart ?? t.value.length;
            caret.set(id, at);
            if (t.value.slice(0, at).endsWith("#")) openPicker(t, id, host); else closePicker();
          },
          keyup: () => { const t = areas.get(id)!; caret.set(id, t.selectionEnd ?? t.value.length); },
          click: () => { const t = areas.get(id)!; caret.set(id, t.selectionEnd ?? t.value.length); },
          blur: () => { const t = areas.get(id)!; caret.set(id, t.selectionEnd ?? t.value.length); },
        },
      }) as HTMLTextAreaElement;
      areas.set(id, ta);
      host.append(h("h3", { class: "section-title" }, title), ta);
      sections.push(host);
    }
    const reason = h("input", { type: "text", name: "Reason for the edit", placeholder: "Reason for the edit", on: { input: () => form.sync() } }) as HTMLInputElement;
    const save = h("button", { type: "button", class: "primary", data: { action: "save" }, on: { click: () => { void saveEdit(); } } }, `Save as draft ${d.n + 1}`) as HTMLButtonElement;
    const el2 = h("div", { class: "edit-form", name: "Edit the draft" }, sections,
      h("div", { class: "edit-foot" }, reason, save, h("button", { type: "button", data: { action: "cancel" }, on: { click: () => { edit = null; closePicker(); render(); } } }, "Cancel")),
      h("p", { class: "note" }, "An edit goes back through checks, evaluation and challenge before it can be published."));
    const form: EditForm = {
      base: d.hash, el: el2, areas, finding: (id) => fields.get(id)!, reason, save,
      sync() {
        const blank = reason.value.trim() === "";
        save.disabled = ro() || blank || saving;
        save.title = ro() ? REPLAY_REFUSAL : blank ? "An edit needs a reason" : `Save this as draft ${d.n + 1}; it goes back through review`;
      },
    };
    return form;
  };

  /** The whole product as the form now holds it: what the person did not touch is as it was. */
  const productOf = (d: Draft, f: EditForm): Product => ({
    ...d.product,
    ...Object.fromEntries(TEXT_SECTIONS.map((id) => [id, f.areas.get(id)!.value])),
    key_findings: d.product.key_findings.map((x) => {
      const v = f.finding(x.id);
      return {
        id: x.id, statement: v.statement.value, likelihood: v.likelihood.value, confidence: v.confidence.value as Finding["confidence"], confidence_basis: v.basis.value,
        cites: v.cites.value.split(",").map((c) => c.trim()).filter((c) => c !== ""), assumptions: lines(v.assumptions.value), reasoning: v.reasoning.value,
      };
    }),
  });
  const saveEdit = async (): Promise<void> => {
    const d = draftOf();
    if (edit === null || d === null || saving) return;
    const reason = edit.reason.value.trim();
    if (reason === "") { ui.toast("An edit needs a reason"); return; }
    saving = true; edit.sync();
    try { await ui.act("revise", { product: productOf(d, edit), reason }); } finally { saving = false; edit?.sync(); }
  };
  const startEdit = (): void => {
    const d = draftOf();
    if (edit !== null || d === null) return;
    caret.clear();
    edit = buildEdit(d);
    render();
  };

  // ---------- tools: Edit and Copy ----------
  const copy = async (): Promise<void> => {
    const md = narrativeMarkdown(state(), ui.ref);
    if (md === "") return;
    try {
      const clip = (ui.win.navigator as Navigator | undefined)?.clipboard;
      if (clip === undefined || clip === null || typeof clip.writeText !== "function") throw new Error("there is no clipboard");
      await clip.writeText(md);
      fallback = null; focusFallback = false;
      ui.toast("Copied as Markdown");
    } catch {
      fallback = md; focusFallback = true;
      ui.toast("The clipboard refused the text; it is shown below to copy by hand");
    }
    if (!destroyed) render();
  };
  const toolsView = (s: CaseState, d: Draft): Node[] => {
    const out: Node[] = [];
    if (edit === null) {
      const can = canEdit(s);
      out.push(h("button", {
        type: "button", data: { action: "edit" }, disabled: ro() || !can,
        title: ro() ? REPLAY_REFUSAL : can ? "Edit the draft; the new revision goes back through review" : "A draft can be edited while a run is in progress",
        on: { click: () => { startEdit(); edit?.areas.get("summary")?.focus(); } },
      }, "Edit"));
    }
    out.push(h("button", { type: "button", data: { action: "copy" }, title: `Copy draft ${d.n} as Markdown, with each citation's provenance`, on: { click: () => { void copy(); } } }, "Copy as Markdown"));
    return out;
  };

  // ---------- the head ----------
  const headView = (s: CaseState, d: Draft): Node[] => {
    const pub = s.published.length === 0 ? null : s.published[s.published.length - 1]!;
    const published = pub !== null && pub.draft_hash === d.hash ? pub : null;
    const kids: Child[] = [`Draft ${d.n} · ${d.hash.slice(0, 8)} · by ${names(d.author)}`, " ", markingChip(ui, d.product.marking)];
    if (published !== null) {
      loadBundle(published.n);
      const files = bundles.get(published.n);
      kids.push(h("span", { class: "published" }, ` Published as product ${published.n}`), " ",
        files === undefined || files === "loading" ? "(reading the file list…)" : files === "failed" ? "(the file list could not be read)"
          : files.map((f) => [fileLink(h, ui.api.bundlePath(store.id, published.n, f), f), " "]));
    }
    return [h("p", { class: "draft-head" }, kids)];
  };

  // ---------- the review ----------
  const findingsList = (fs: { where: string; message: string }[]): HTMLElement | null =>
    fs.length === 0 ? null : h("ul", { class: "findings" }, fs.map((f) => h("li", null, `${f.where}: ${f.message}`)));
  const answerForm = (s: CaseState, id: string): HTMLElement => {
    const box = h("textarea", {
      name: `Answer to ${id}`, value: answers.get(id) ?? "", disabled: ro(), placeholder: "Your answer",
      on: { input: (e) => { answers.set(id, (e.target as HTMLTextAreaElement).value); button.disabled = ro() || (answers.get(id) ?? "").trim() === ""; } },
    });
    const kind = h("select", {
      name: `Kind of answer to ${id}`, disabled: ro(),
      on: { change: (e) => { kinds.set(id, (e.target as HTMLSelectElement).value); } },
    }, h("option", { value: "revised" }, "Revised"), h("option", { value: "rebutted" }, "Rebutted")) as HTMLSelectElement;
    kind.value = kinds.get(id) ?? "revised";
    const button = h("button", {
      type: "button", class: "primary", data: { action: "answer" }, disabled: ro() || (answers.get(id) ?? "").trim() === "", title: ro() ? REPLAY_REFUSAL : `Answer challenge ${id}`,
      on: { click: () => {
        const text = (answers.get(id) ?? "").trim();
        if (text === "") return;
        refusals.delete(`challenge:${id}`);
        void ui.send("answer_challenge", { challenge: id, answer: text, action: kind.value }, undefined, undefined, (why) => { refusals.set(`challenge:${id}`, why); inflightVersion++; render(); })
          .then((r) => { if (r !== null) { answers.delete(id); kinds.delete(id); } });
      } },
      name: `Answer challenge ${id}`,
    }, "Answer") as HTMLButtonElement;
    void s;
    return h("div", { class: "answer-form" }, box, kind, button, refusalLine(h, refusals.get(`challenge:${id}`), `n:challenge:${id}`));
  };
  /**
   * Reviewers who disagree: both positions and the points behind them, and the person's three ways to rule (follow one reviewer, follow the other, or a
   * note of their own). Once ruled, the ruling and the ones it replaced are shown, and while the conflict's run is in progress the ruling can be changed.
   */
  const conflictView = (s: CaseState, c: ConflictState): HTMLElement => {
    const title = (id: string): string => s.run.stages.find((x) => x.id === id)?.title ?? id;
    const kids: Child[] = [
      tag(ui, c.ruling === null ? "attention" : "done", c.ruling === null ? "reviewers disagree" : "ruled"), " ", h("span", { class: "finding-id" }, c.finding),
      h("p", { class: "text" }, c.reason),
      c.points.length === 0 ? null : h("ul", { class: "points" }, c.points.map((x) => h("li", null, x))),
    ];
    const changeable = " The ruling holds until you change it; you can change it while the run is in progress";
    const ruleForm = (): HTMLElement => {
      const busy = inflight.has(`rule:${c.id}`);
      const rule = (follow: string | null): void => { guarded(`rule:${c.id}`, "rule_conflict", { conflict: c.id, follow, note: (ruleNotes.get(c.id) ?? "").trim() }, () => { ruleNotes.delete(c.id); }); };
      const noted = (): boolean => (ruleNotes.get(c.id) ?? "").trim() !== "";
      const byNote = h("button", {
        type: "button", data: { action: "rule-note" }, disabled: ro() || busy || !noted(), title: ro() ? REPLAY_REFUSAL : `Rule with your note alone.${changeable}`,
        on: { click: () => { if (noted()) rule(null); } },
      }, "Rule with this note") as HTMLButtonElement;
      const follow = (stage: string, says: string): HTMLElement => h("button", {
        type: "button", class: "primary", data: { action: `follow-${stage}` }, disabled: ro() || busy,
        title: ro() ? REPLAY_REFUSAL : `Follow ${title(stage)} (${says}); with your note if you wrote one.${changeable}`,
        on: { click: () => { rule(stage); } },
      }, `Follow ${title(stage)}: ${says}`);
      return h("div", { class: "rule-form" },
        follow(c.raised_by, c.asks), follow(c.changed_for, keepText(c)),
        h("textarea", {
          name: `Ruling note on ${c.id}`, value: ruleNotes.get(c.id) ?? "", disabled: ro(), placeholder: "Your note (optional with a reviewer, enough on its own)",
          on: { input: (e) => { ruleNotes.set(c.id, (e.target as HTMLTextAreaElement).value); byNote.disabled = ro() || busy || !noted(); } },
        }),
        byNote, refusalLine(h, refusals.get(`rule:${c.id}`), `n:rule:${c.id}`));
    };
    if (c.ruling !== null) {
      kids.push(h("p", { class: "ruling" }, `Ruled: ${rulingText(s, c)}`));
      for (const r of [...(c.earlier_rulings ?? [])].reverse()) kids.push(h("p", { class: "ruling-earlier" }, `Earlier: ${rulingText(s, { ...c, ruling: r })} (replaced)`));
      if (c.run !== null && c.run === s.run.id && runGoing(s)) {
        const more = h("details", { class: "change-ruling", on: { toggle: () => { if (more.open) changing.add(c.id); else changing.delete(c.id); } } },
          h("summary", null, "Change the ruling"),
          s.run.waiting === "publish" ? h("p", { class: "note" }, "A changed ruling waits under Your changes, by Approve, until you send the draft back with it.") : null,
          ruleForm()) as HTMLDetailsElement;
        more.open = changing.has(c.id);
        kids.push(more);
      }
    } else {
      kids.push(ruleForm());
    }
    return h("div", { class: `conflict${c.ruling === null ? " open" : ""}`, data: { conflict: c.id } }, kids);
  };
  const reviewView = (s: CaseState, d: Draft): Node[] => {
    const r = owns(s.reviews, d.hash) ? s.reviews[d.hash]! : null;
    const out: Child[] = [h("h3", { class: "section-title" }, "Review of this revision")];
    if (r === null) { out.push(h("p", { class: "empty" }, "This revision has not been reviewed yet.")); return [h("section", { class: "review" }, out)]; }
    if (r.rejected !== null) out.push(h("p", { class: "rejected" }, tag(ui, "attention", "rejected"), ` You rejected this revision: ${r.rejected.reason}${r.rejected.stop ? " (and stopped the run)" : ""}`));
    const mark = (pass: boolean): HTMLElement => h("span", { class: pass ? "pass" : "fail" }, pass ? "✓" : "✗");
    out.push(h("div", { class: "checks" }, r.checks.length === 0 ? h("p", { class: "empty" }, "No form checks yet.") : r.checks.map((c) =>
      h("div", { class: `check-row${c.pass ? "" : " failed"}` }, mark(c.pass), ` ${c.check}`, findingsList(c.findings)))));
    out.push(r.evaluation === null
      ? h("div", { class: "evaluation-row pending" }, "Evaluation: not yet")
      : h("div", { class: `evaluation-row${r.evaluation.pass ? "" : " failed"}` }, mark(r.evaluation.pass), " Evaluation", findingsList(r.evaluation.findings)));
    for (const id of r.challenges) {
      if (!owns(s.challenges, id)) continue;
      const c = s.challenges[id]!;
      const must = c.severity === "must_address";
      out.push(h("div", { class: `challenge${must ? " must" : ""}`, data: { challenge: id } },
        tag(ui, must ? "attention" : "human", must ? "must address" : "consider"), ` ${id} `, c.cites.map((x) => [chipFor(x), " "]),
        h("p", { class: "text" }, c.text),
        c.status === "answered"
          ? h("p", { class: "answer" }, tag(ui, "done", c.action ?? "answered"), ` ${c.answer ?? ""}`)
          : answerForm(s, id)));
    }
    for (const c of runConflicts(s)) out.push(conflictView(s, c));
    const pub = s.published.length > 0 && s.published[s.published.length - 1]!.draft_hash === d.hash;
    if (!pub) {
      const why = blockers(s, d.hash);
      out.push(why.length === 0
        ? h("p", { class: "blockers-none tag tag-done" }, "Nothing blocks publishing")
        : h("div", { class: "blockers-box" }, h("p", { class: "blockers-title tag tag-attention" }, "Cannot be published yet"), h("ul", { class: "blockers" }, why.map((w) => h("li", null, w)))));
      // a failed check whose manifest says it does not block: shown, so that what is published with it is seen, but it does not stop Approve
      const noted = notedExceptions(s, d.hash);
      if (noted.length > 0) out.push(h("div", { class: "noted-box" }, h("p", { class: "noted-title tag tag-human" }, "Noted exceptions (not blocking)"), h("ul", { class: "noted" }, noted.map((w) => h("li", null, w)))));
    }
    return [h("section", { class: "review" }, out)];
  };

  // ---------- the bundle preview ----------
  const wantsPreview = (s: CaseState): boolean => !ro() && s.run.waiting === "publish" && latestDraft(s) !== null;
  const ensurePreview = (s: CaseState): void => {
    if (!wantsPreview(s)) return;
    const seq = store.live.seq;
    if (asked === seq) return;
    asked = seq;
    const done = (value: Preview | "failed"): void => { if (!destroyed && asked === seq) { preview = { seq, value }; render(); } };
    ui.api.preview(store.id).then(done, () => done("failed"));
  };
  const currentPreview = (): Preview | "failed" | null => (preview !== null && preview.seq === store.live.seq ? preview.value : null);
  const previewView = (): Node[] => {
    const v = currentPreview();
    if (v === null) return [h("section", { class: "preview" }, h("h3", { class: "section-title" }, "Bundle preview"), h("p", { class: "empty" }, "Reading the preview…"))];
    const head = h("h3", { class: "section-title" }, "Bundle preview");
    if (v === "failed") return [h("section", { class: "preview" }, head, h("p", { class: "empty" }, "The preview could not be read."))];
    if ("reasons" in v) return [h("section", { class: "preview" }, head, h("div", { class: "reasons" }, h("p", null, "The bundle cannot be made yet:"), h("ul", null, v.reasons.map((r) => h("li", null, r)))))];
    const files: Record<string, string> = { ...v.files, "manifest.json": JSON.stringify(v.manifest, null, 2) };
    const all = Object.keys(files);
    const shown = tab !== null && all.includes(tab) ? tab : all[0]!;
    return [h("section", { class: "preview" }, head,
      h("div", { class: "tabs", role: "tablist", name: "Files" }, all.map((f) =>
        h("button", { type: "button", role: "tab", class: f === shown ? "active" : "", aria: { selected: String(f === shown) }, data: { tab: f }, on: { click: () => { tab = f; sigs.delete(previewBox); render(); } } }, f))),
      h("pre", { class: "preview-text" }, files[shown]!))];
  };

  // ---------- the gate ----------
  const gateView = (s: CaseState, d: Draft): Node[] => {
    if (s.run.waiting !== "publish") return [];
    const wantsUnload = (): boolean => unloadChoice.get(s.run.id ?? "") ?? ui.me.cases.on_complete === "unload";
    const why = blockers(s, d.hash);
    const pv = currentPreview();
    const reasons = pv !== null && pv !== "failed" && "reasons" in pv ? pv.reasons : [];
    // fail closed: nothing is approved before the server's own check of this exact ledger has come back clean
    const checked = pv !== null && pv !== "failed";
    const can = why.length === 0 && checked && reasons.length === 0 && !inflight.has("approve");
    const why2 = why.length > 0 ? [...why, ...reasons.filter((r) => !why.includes(r))].join("; ")
      : pv === null ? "Checking…" : pv === "failed" ? "The draft could not be checked" : reasons.length > 0 ? reasons.join("; ") : inflight.has("approve") ? "Publishing…" : `Publish draft ${d.n} as it is`;
    // the person's changes since this draft was made wait for their one send-back (slice 10): Approve says plainly that it publishes without them
    const changes = gateChanges(s, store.entries);
    const unload = h("label", { class: "gate-unload", title: `When this run has published, pack the case into the case store (${ui.me.cases.store}) and take it off the list` },
      h("input", { type: "checkbox", name: "Unload after publishing", data: { action: "unload-after" }, disabled: ro() || ui.me.role !== "analyst", checked: wantsUnload(), on: { change: (e) => { unloadChoice.set(s.run.id ?? "", (e.target as HTMLInputElement).checked); } } }),
      " Unload after publishing");
    const approve = h("button", {
      type: "button", class: "primary", data: { action: "approve" }, disabled: ro() || !can,
      title: ro() ? REPLAY_REFUSAL : why2,
      on: { click: () => { guarded("approve", "approve", { draft_hash: d.hash, unload_after: wantsUnload() }); } },
    }, changes.length === 0 ? `Approve: publish draft ${d.n}` : `Approve without my changes: publish draft ${d.n}`);
    const reject = h("button", {
      type: "button", data: { action: "reject" }, disabled: ro(), title: ro() ? REPLAY_REFUSAL : "Reject this draft and say why",
      on: { click: () => { rejecting = true; sigs.delete(gateBox); render(); (gateBox.querySelector("[aria-label='Reason for rejecting the draft']") as HTMLElement | null)?.focus(); } },
    }, "Reject");
    const out: Node[] = [h("div", { class: "gate-buttons" }, approve, unload, reject)];
    const approveRefused = refusalLine(h, refusals.get("approve"), "n:approve");
    if (approveRefused !== null) out.push(approveRefused);
    // what the person may still want to settle before passing the gate, beside its button; neither line passes or holds the gate
    const asking = shownQuestions(s).filter((q) => q.answer === null);
    const holding = activeOverrules(s);
    if (asking.length > 0 || holding.length > 0) {
      out.push(h("div", { class: "gate-notes" },
        asking.length === 0 ? null : h("p", { class: "gate-open-questions tag tag-attention", title: "Answer it in Questions for you; an answer passes no gate" },
          `${asking.length} ${asking.length === 1 ? "question is" : "questions are"} still open: ${asking.map((q) => `${q.id} (${q.text})`).join("; ")}`),
        holding.length === 0 ? null : h("p", { class: "gate-overrules tag tag-human", title: "Code holds every draft to these; withdraw one under its finding" },
          `${holding.length} ${holding.length === 1 ? "overrule is" : "overrules are"} active: ${holding.map((o) => `${o.finding} (${overruleSays(o)})`).join("; ")}`)));
    }
    if (changes.length > 0) {
      const n = changes.length;
      const busy = inflight.has("send-back");
      out.push(h("div", { class: "your-changes" },
        h("p", { class: "label" }, `Your changes since draft ${d.n} was made (not sent yet)`),
        h("ul", null, changes.map((c) => h("li", { data: { change: c.kind } }, h("span", { class: "finding-id" }, c.finding ?? c.id), ` ${c.text}`))),
        h("button", {
          type: "button", class: "primary", data: { action: "send-back-changes" }, disabled: ro() || busy,
          title: ro() ? REPLAY_REFUSAL : `Send draft ${d.n} back to Assemble with ${n === 1 ? "this change" : `these ${n} changes`} as the reason; it passes no gate`,
          on: { click: () => { guarded("send-back", "send_back_changes", { draft_hash: d.hash }); } },
        }, `Send back to Assemble with my changes (${n})`),
        refusalLine(h, refusals.get("send-back"), "n:send-back"),
        h("p", { class: "unsent-warning tag tag-attention" }, `Your ${n} ${n === 1 ? "change is" : "changes are"} not in draft ${d.n}. Approve publishes draft ${d.n} without ${n === 1 ? "it" : "them"}; send ${n === 1 ? "it" : "them"} back to Assemble first to have ${n === 1 ? "it" : "them"} taken in.`)));
    }
    if (rejecting) {
      const stop = h("input", { type: "checkbox", name: "and stop the run", disabled: ro(), checked: rejectStop, on: { change: (e) => { rejectStop = (e.target as HTMLInputElement).checked; } } }) as HTMLInputElement;
      const confirm = h("button", {
        type: "button", class: "primary", data: { action: "confirm-reject" }, disabled: ro() || rejectReason.trim() === "",
        on: { click: () => {
          const reason = rejectReason.trim();
          if (reason === "") return;
          refusals.delete("reject");
          void ui.send("reject", { reason, stop: stop.checked }, undefined, undefined, (why) => { refusals.set("reject", why); sigs.delete(gateBox); render(); })
            .then((r) => { if (r !== null) { rejecting = false; rejectReason = ""; rejectStop = false; render(); } });
        } },
      }, "Reject the draft") as HTMLButtonElement;
      const box = h("input", {
        type: "text", class: "ask-text", name: "Reason for rejecting the draft", value: rejectReason, disabled: ro(),
        on: {
          input: (e) => { rejectReason = (e.target as HTMLInputElement).value; confirm.disabled = ro() || rejectReason.trim() === ""; },
          keydown: (e) => { if ((e as KeyboardEvent).key === "Escape") { e.stopPropagation(); rejecting = false; render(); } },
        },
      });
      out.push(h("div", { class: "ask" }, box, h("label", null, stop, " and stop the run"), confirm, h("button", { type: "button", data: { action: "cancel-reject" }, on: { click: () => { rejecting = false; render(); } } }, "Cancel"), refusalLine(h, refusals.get("reject"), "n:reject")));
    }
    return out;
  };

  // ---------- proposals ----------
  const proposalsView = (s: CaseState): Node[] => {
    const open = Object.values(s.proposals).filter((p) => p.kind === "narrative" && p.status === "open").sort((a, b) => byId(a.id, b.id));
    return open.map((p) => {
      if (p.kind !== "narrative") return h("div");
      const editing = proposalEdit.has(p.id);
      // the marking of the model request that wrote the text, which the draft takes when it is accepted; unknown text cannot be accepted
      const marked = proposalMarking(store.entries, p.seq);
      const unknown = "The marking of this text is unknown, so it cannot be put in the draft";
      const kids: Child[] = [h("p", { class: "proposal-head" }, `Proposed ${TITLE.get(p.section) ?? p.section} · by ${p.by}`, " ",
        marked === null ? tag(ui, "attention", "marking unknown", unknown) : markingChip(ui, marked))];
      if (!editing) {
        kids.push(h("div", { class: "text" }, paragraphs(p.text)));
        kids.push(h("div", { class: "actions" },
          h("button", {
            type: "button", class: "primary", data: { action: "accept-proposal" }, disabled: ro() || !canEdit(s) || inflight.has(`accept:${p.id}`) || marked === null,
            title: ro() ? REPLAY_REFUSAL : marked === null ? unknown : latestDraft(s) === null ? "There is no draft yet to put this in" : !canEdit(s) ? "A draft can be edited while a run is in progress" : "Put this in the draft as a new revision; it goes back through review",
            on: { click: () => { guarded(`accept:${p.id}`, "accept_proposal", { proposal: p.id }); } },
          }, "Accept"),
          h("button", { type: "button", data: { action: "edit-proposal" }, disabled: ro(), on: { click: () => { proposalEdit.add(p.id); proposalText.set(p.id, p.text); sigs.delete(proposalsBox); render(); } } }, "Edit"),
          h("button", { type: "button", data: { action: "discard-proposal" }, disabled: ro(), on: { click: () => { void ui.act("reject_proposal", { proposal: p.id, reason: "discarded" }); } } }, "Discard")));
        kids.push(refusalLine(h, refusals.get(`accept:${p.id}`), `n:accept:${p.id}`));
      } else {
        const accept = h("button", {
          type: "button", class: "primary", data: { action: "accept-edited" }, disabled: ro() || !canEdit(s) || inflight.has(`accept:${p.id}`) || marked === null || (proposalText.get(p.id) ?? "").trim() === "",
          title: marked === null ? unknown : latestDraft(s) === null ? "There is no draft yet to put this in" : undefined,
          on: { click: () => { const t = proposalText.get(p.id) ?? ""; if (t.trim() !== "") guarded(`accept:${p.id}`, "accept_proposal", { proposal: p.id, text: t }); } },
        }, "Accept as edited") as HTMLButtonElement;
        kids.push(h("textarea", {
          name: `Text proposed in ${p.id}`, value: proposalText.get(p.id) ?? p.text, disabled: ro(),
          on: { input: (e) => { proposalText.set(p.id, (e.target as HTMLTextAreaElement).value); accept.disabled = ro() || marked === null || (proposalText.get(p.id) ?? "").trim() === ""; } },
        }), h("div", { class: "actions" }, accept,
          h("button", { type: "button", data: { action: "cancel-proposal-edit" }, on: { click: () => { proposalEdit.delete(p.id); proposalText.delete(p.id); sigs.delete(proposalsBox); render(); } } }, "Cancel")),
          refusalLine(h, refusals.get(`accept:${p.id}`), `n:accept:${p.id}`));
      }
      return h("div", { class: "proposal proposed", data: { proposal: p.id } }, kids);
    });
  };

  // ---------- painting ----------
  const render = (): void => {
    if (destroyed) return;
    const s = state();
    const d = draftOf();
    if (edit !== null && (d === null || d.hash !== edit.base)) {
      // the revision the form was made from is no longer the latest: this person's own save, or somebody else's
      if (d !== null && d.author.kind !== "human") ui.toast("A new draft arrived; what you typed was not saved");
      edit = null; closePicker();
    }
    for (const [k, seq] of [...inflight]) if (seq !== null && store.live.seq >= seq) { inflight.delete(k); inflightVersion++; }
    ensurePreview(s);
    const published = d !== null && s.published.length > 0 && s.published[s.published.length - 1]!.draft_hash === d.hash;
    draftBox.classList.toggle("proposed", !published);
    draftBox.hidden = d === null;
    questions.update();
    paint(headBox, [d, s.published, store.id, bundlesVersion], () => (d === null ? [] : headView(s, d)));
    paint(bodyBox, edit !== null ? [edit] : [d, s.cards, s.overrules, s.conflicts, ro(), inflightVersion, ui.ref.likelihood, overruleVersion], () => (d === null ? [h("p", { class: "empty" }, "No draft yet.")] : edit !== null ? [edit.el] : readBody(s, d)));
    if (focusOverrule !== null && d !== null && edit === null) {
      const at = focusOverrule;
      const box = [...bodyBox.querySelectorAll("[data-finding]")].find((n) => n.getAttribute("data-finding") === at);
      const noteBox = box?.querySelector(".overrule-form textarea") as HTMLTextAreaElement | null | undefined;
      if (noteBox !== null && noteBox !== undefined && el.isConnected) { focusOverrule = null; noteBox.focus(); }
      else if (box === undefined) { focusOverrule = null; ui.toast(`There is no finding ${at} in draft ${d.n}`); }
    }
    if (d === null) {
      paint(toolsBox, [null], () => []); paint(gateBox, [null], () => []); paint(reviewBox, [null], () => []); paint(previewBox, [null], () => []);
      if (el.querySelector(".no-draft") === null) el.insertBefore(h("p", { class: "empty no-draft" }, "No draft yet."), questionsBox.nextSibling);
    } else {
      el.querySelector(".no-draft")?.remove();
      paint(toolsBox, [d.hash, edit, ro(), s.run.status, s.cards === s.cards], () => toolsView(s, d));
      paint(gateBox, [d.hash, s.run, s.reviews, s.challenges, s.published, s.questions, s.overrules, preview, store.live.seq, rejecting, ro(), ui.me.role, inflightVersion], () => gateView(s, d));
      paint(reviewBox, [d.hash, s.reviews, s.challenges, s.conflicts, s.run, s.published, s.cards, ro(), inflightVersion], () => reviewView(s, d));
      paint(previewBox, [wantsPreview(s), preview, store.live.seq, tab], () => (wantsPreview(s) ? previewView() : []));
    }
    // the first time Approve can be pressed, a person who came here for the gate is on it (Approve waits for the server's check, so this cannot be done on opening)
    if (d !== null && d.hash !== focusedFor) { focusedFor = d.hash; focusedAtGate = false; }
    if (armed) {
      if (armedFor === undefined) armedFor = s.run.waiting === "publish" && d !== null ? d.hash : null;
      if (armedFor === null || d?.hash !== armedFor || s.run.waiting !== "publish") armed = false;
    }
    if (!focusedAtGate && el.isConnected) {
      const ap = gateBox.querySelector("[data-action=approve]:not([disabled])") as HTMLElement | null;
      const at = ui.doc.activeElement;
      if (ap !== null) {
        focusedAtGate = true;
        // asked for the gate and focus has not moved since; else only a person on the page or in this lens
        const asked = armed && at === armedFrom;
        armed = false;
        // never from a field the person types in, even one in this lens
        if (!typingIn(at) && (asked || at === null || at === ui.doc.body || el.contains(at) || at.closest("[data-area=lens]") !== null)) ap.focus();
      }
    }
    paint(copyBox, [fallback], () => (fallback === null ? [] : [h("div", { class: "copy-fallback" },
      h("p", null, "Select all and copy:"),
      h("textarea", { name: "Markdown to copy", value: fallback, readonly: true }),
      h("button", { type: "button", data: { action: "close-copy" }, on: { click: () => { fallback = null; render(); } } }, "Close"))]));
    if (focusFallback) {
      focusFallback = false;
      const ta = copyBox.querySelector("textarea") as HTMLTextAreaElement | null;
      if (ta !== null) { ta.focus(); ta.select(); }
    }
    paint(proposalsBox, [s.proposals, proposalEdit.size, ro(), s.cards, s.run.status, s.drafts.length, inflightVersion], () => proposalsView(s));
    edit?.sync();
  };

  // a preview that could not be read is asked for again when the person comes back to the lens
  el.addEventListener("focusin", () => { if (preview !== null && preview.value === "failed" && preview.seq === store.live.seq) { asked = -1; preview = null; render(); } });
  return {
    el,
    update: render,
    destroy() { destroyed = true; closePicker(); },
    cite(card, section) {
      const s = state();
      if (ro()) { ui.toast(REPLAY_REFUSAL); return; }
      if (draftOf() === null) { ui.toast("There is no draft yet to cite in"); return; }
      if (!canEdit(s)) { ui.toast("A draft can be edited while a run is in progress"); return; }
      startEdit();
      const id: TextSection = section !== undefined && isText(section) ? section : lastSection;
      const ta = edit?.areas.get(id);
      if (ta === undefined) return;
      lastSection = id;
      closePicker();
      insertAt(ta, id, `[${card}]`, false);
    },
  };
}
