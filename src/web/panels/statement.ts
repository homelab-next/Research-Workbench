import { BASIS_TEXT } from "../../core/state";
import { MARKINGS, PERSON_BASES } from "../../core/types";
import type { Marking, Observable, PersonBasis } from "../../core/types";
import { clear } from "../dom";
import type { CaseStore } from "../store";
import type { Ui, View } from "../ui";

const MAX_ABOUT = 20;

/** "Add what you know": the statement, how you know it, what it is about, and a marking no lower than the case's. It sends `add_statement`; the card arrives on the stream. */
export function makeStatementForm(ui: Ui, store: CaseStore): View {
  const { h } = ui;
  const text = h("textarea", { name: "What you know", placeholder: "What do you know that the data does not say?", on: { input: () => paint() } }) as HTMLTextAreaElement;
  const basis = h("select", { name: "How you know" }, PERSON_BASES.map((b) => h("option", { value: b }, BASIS_TEXT[b]))) as HTMLSelectElement;
  basis.value = "unstated";
  const detail = h("input", { type: "text", name: "How you know, in detail", placeholder: "How you know (optional)" }) as HTMLInputElement;
  const rowsBox = h("div", { class: "about-rows" });
  const rows: { el: HTMLElement; type: HTMLSelectElement; value: HTMLInputElement }[] = [];
  const marking = h("select", { name: "Marking" }) as HTMLSelectElement;
  const addValue = h("button", { type: "button", class: "action", data: { action: "add-value" }, on: { click: () => { newRow(); paint(); } } }, "Add another value") as HTMLButtonElement;
  const add = h("button", { type: "button", class: "action", data: { action: "add-statement" }, on: { click: () => { void send(); } } }, "Add") as HTMLButtonElement;
  const summary = h("summary", null, "Add what you know");
  const el = h("details", { class: "statement-form" }, summary,
    h("div", { class: "form-body" }, text, h("label", null, "How you know ", basis), detail, h("p", { class: "muted" }, "What it is about"), rowsBox, addValue,
      h("label", null, "Marking ", marking), add)) as HTMLDetailsElement;

  function newRow(): void {
    const n = rows.length + 1;
    const type = h("select", { name: `About type ${n}` }, ui.ref.types.map((t) => h("option", { value: t.id }, t.title))) as HTMLSelectElement;
    const value = h("input", { type: "text", name: `About value ${n}`, placeholder: "a value this is about (optional)", on: { input: () => paint() } }) as HTMLInputElement;
    const row = { el: h("div", { class: "about-row" }, type, value), type, value };
    rows.push(row);
    rowsBox.append(row.el);
  }
  newRow();

  let shownCase: Marking | null | undefined;
  const readOnly = (): boolean => store.at !== null;
  function paint(): void {
    const ro = readOnly();
    const caseMarking = store.shown.meta?.marking ?? null;
    if (caseMarking !== shownCase) {
      shownCase = caseMarking;
      const chosen = marking.value;
      clear(marking);
      marking.append(h("option", { value: "" }, "the case's marking"));
      if (caseMarking !== null) for (const m of MARKINGS.slice(MARKINGS.indexOf(caseMarking) + 1)) marking.append(h("option", { value: m }, m));
      marking.value = [...marking.options].some((o) => o.value === chosen) ? chosen : "";
    }
    for (const c of [text, basis, detail, marking]) c.disabled = ro;
    for (const r of rows) { r.type.disabled = ro; r.value.disabled = ro; }
    addValue.disabled = ro || rows.length >= MAX_ABOUT;
    add.disabled = ro || text.value.trim() === "";
  }

  async function send(): Promise<void> {
    if (readOnly() || text.value.trim() === "") return;
    const about: Observable[] = rows.flatMap((r) => (r.value.value.trim() === "" ? [] : [{ type: r.type.value, value: r.value.value.trim() }]));
    add.disabled = true;
    const sent = await ui.send("add_statement", {
      statement: text.value.trim(), basis: basis.value as PersonBasis, detail: detail.value.trim(), about, marking: marking.value === "" ? null : (marking.value as Marking),
    });
    if (sent === null) { paint(); return; }                // a refusal leaves the form as typed
    text.value = ""; basis.value = "unstated"; detail.value = "";
    while (rows.length > 1) rows.pop()!.el.remove();
    rows[0]!.value.value = "";
    marking.value = "";
    el.open = false;
    paint();
  }

  paint();
  return { el, update: paint };
}
