import type { CardState, CaseState } from "../../core/state";
import type { Difference } from "../../core/wire";
import { cellText } from "../derive";
import { clear } from "../dom";
import type { CaseStore } from "../store";
import type { Ui } from "../ui";

export interface VerifyBlock { el: HTMLElement; update(state: CaseState): void }

export const MAY_HAVE_CHANGED = "The source may have changed since. A difference does not prove the original was wrong.";

/**
 * What re-validation found, under a card's provenance (spec §6.7). The verdict is the card's own `validated` from the fold; the row-level
 * difference is the server's reading of the two recorded results, asked for once per verification and never computed here.
 */
export function makeVerify(ui: Ui, store: CaseStore, id: string): VerifyBlock {
  const { h } = ui;
  const el = h("div", { class: "verify-slot" });
  let drawn = "";
  let difference: { seq: number; value: Difference | { reason: string } | "loading" | "failed" } | null = null;
  let budget = "";

  const unitOf = (c: CardState): string => ui.ref.sources.find((s) => s.id === c.source)?.cost.unit ?? "units";

  const rowsTable = (kind: "removed" | "added", caption: string, d: Difference): HTMLElement => {
    const rows = kind === "removed" ? d.removed : d.added;
    return h("div", { class: "diff-part" }, h("p", { class: "diff-label" }, `${rows.length} ${caption}`),
      h("table", { class: kind },
        h("thead", null, h("tr", null, d.columns.map((c) => h("th", null, c)))),
        h("tbody", null, rows.map((r) => h("tr", null, r.map((v) => h("td", null, cellText(v))))))));
  };

  const body = (c: CardState): HTMLElement | null => {
    const v = c.validated;
    if (v === null) return null;
    if (v.outcome === "matches") return h("div", { class: "verify matches tag-done" }, `Validated ${v.ts}: ${v.detail}`);
    if (v.outcome === "could_not_run") {
      const box = h("div", { class: "verify could-not attention" }, `Could not verify: ${v.detail}`);
      if (/a budget is needed/.test(v.detail)) {
        const unit = unitOf(c);
        const amount = (): number => (/^\d+(?:\.\d+)?$/.test(budget.trim()) ? Number(budget) : 0);
        const go = h("button", { type: "button", class: "action", data: { action: "verify-budget" }, on: { click: () => { go.disabled = true; void ui.send("verify_card", { card: id, budget: Number(budget) }).then((r) => { if (r === null) go.disabled = amount() <= 0 || store.at !== null; }); } } }) as HTMLButtonElement;
        const label = (): void => { go.textContent = `Verify: spend up to ${budget.trim() === "" ? "…" : budget.trim()} ${unit}`; go.disabled = store.at !== null || amount() <= 0; };
        label();
        box.append(" ", h("label", null, "Budget "), h("input", { type: "text", name: "Budget", placeholder: unit, value: budget, on: { input: (e) => { budget = (e.target as HTMLInputElement).value; label(); } } }), " ", go);
      }
      return box;
    }
    const box = h("div", { class: "verify differs attention" }, h("p", null, v.detail), h("p", { class: "may-have-changed" }, MAY_HAVE_CHANGED));
    const d = difference !== null && difference.seq === v.seq ? difference.value : "loading";
    if (store.at !== null) box.append(h("p", { class: "muted" }, "The rows that differ are shown in the live view."));
    else if (d === "loading") box.append(h("p", { class: "muted" }, "Reading the two results…"));
    else if (d === "failed") box.append(h("p", { class: "attention" }, "Could not read the difference."));
    else if ("reason" in d) box.append(h("p", { class: "reason" }, d.reason));
    else {
      box.append(h("p", { class: "same" }, `${d.same} rows the same`), rowsTable("removed", "only in the original", d), rowsTable("added", "only in the re-run", d));
      if (d.cut) box.append(h("p", { class: "muted" }, "showing the first 200"));
    }
    return box;
  };

  let last: CaseState | null = null;
  const repaint = (): void => {
    const state = last;
    if (state === null) return;
    const c = Object.hasOwn(state.cards, id) ? state.cards[id]! : null;
    const v = c?.validated ?? null;
    if (c === null || v === null) { if (drawn !== "") { clear(el); drawn = ""; } return; }
    if (v.outcome === "differs" && store.at === null && (difference === null || difference.seq !== v.seq)) {
      const seq = v.seq;
      difference = { seq, value: "loading" };
      const settle = (value: Difference | { reason: string } | "failed"): void => { if (difference?.seq === seq) { difference = { seq, value }; repaint(); } };
      ui.api.difference(store.id, id).then(settle, () => { settle("failed"); });
    }
    const sig = JSON.stringify([v, store.at !== null, difference?.seq === v.seq ? difference.value : null, unitOf(c)]);
    if (sig === drawn) return;
    drawn = sig;
    clear(el);
    const made = body(c);
    if (made !== null) el.append(made);
  };

  return { el, update(state) { last = state; repaint(); } };
}
