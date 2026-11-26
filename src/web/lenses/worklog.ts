import type { CaseState } from "../../core/state";
import type { Entry } from "../../core/types";
import type { Open } from "../app";
import { tag } from "../chips";
import type { TagKind } from "../chips";
import { describe } from "../describe";
import { syncList } from "../dom";
import { utc } from "../time";
import type { Ui, View } from "../ui";

type Kind = Entry["actor"]["kind"];
const KINDS: readonly [Kind, string][] = [["human", "Human"], ["agent", "Agent"], ["system", "System"]];

/** Entry types the Activity view has a row for. A step.finished counts only when it was reused. */
export const ACTIVITY: ReadonlySet<string> = new Set([
  "card.created", "query.issued", "stage.started", "stage.finished", "stage.sent_back", "gate.waiting", "gate.passed",
  "draft.revised", "product.published", "playbook.started", "playbook.finished",
]);
const inActivity = (entry: Entry): boolean =>
  ACTIVITY.has(entry.type) || (entry.type === "step.finished" && typeof (entry.payload as { reused?: unknown }).reused === "string");

/** The entries to show, in the order of record, up to the state's seq. A card's event time plays no part. */
export function worklogRows(state: CaseState, entries: readonly Entry[], view: { every: boolean; kinds: ReadonlySet<Kind> }): Entry[] {
  return entries.filter((e) => e.seq <= state.seq && view.kinds.has(e.actor.kind) && (view.every || inActivity(e)));
}

/** The card a card.created row is about, when that card still exists. */
const cardOf = (state: CaseState, entry: Entry): string | null => {
  if (entry.type !== "card.created") return null;
  const id = entry.payload.card?.id;
  return typeof id === "string" && Object.hasOwn(state.cards, id) ? id : null;
};

/** The Worklog lens: what the system did (every entry on request), who made it and what it was, in UTC with milliseconds. */
export function makeWorklog(ui: Ui, open: Open): View {
  const { h } = ui;
  const { store, nav } = open;
  const shown = new Set<Kind>(["human", "agent", "system"]);
  let every = ui.prefs.get<unknown>("worklog.every", false) === true;
  let seen: unknown = null;
  let upTo = -1;
  const list = h("div", { class: "worklog" });
  const filter = h("div", { class: "filter", role: "group", name: "Show entries by" },
    h("label", null, h("input", {
      type: "checkbox", checked: every, name: "Every entry",
      on: { change: (e) => { every = (e.target as HTMLInputElement).checked; ui.prefs.set("worklog.every", every); repaint(); } },
    }), " Every entry"),
    ...KINDS.map(([kind, label]) =>
      h("label", null, h("input", {
        type: "checkbox", checked: true, name: label,
        on: { change: (e) => { if ((e.target as HTMLInputElement).checked) shown.add(kind); else shown.delete(kind); repaint(); } },
      }), ` ${label}`)));
  const el = h("div", { class: "lens lens-worklog", name: "Worklog" }, filter, list);

  const tagKind = (entry: Entry): HTMLElement => { const t = tag(ui, entry.actor.kind as TagKind, entry.actor.kind, "Who made this entry"); t.classList.add("actor-kind"); return t; };
  const make = (entry: Entry): HTMLElement => {
    const d = describe(entry, ui.ref);
    const kids = [
      h("time", { title: "UTC" }, utc(entry.ts)), tagKind(entry),
      " ", h("span", { class: "actor-id" }, entry.actor.id), " ", h("span", { class: "what" }, d.what),
      d.detail === "" ? null : h("span", { class: "detail" }, ` ${d.detail}`),
    ];
    const card = cardOf(store.shown, entry);
    if (card === null) return h("div", { class: "worklog-row", data: { seq: String(entry.seq) }, title: d.detail }, kids);
    const go = (): void => nav.focusCard(card);
    return h("div", {
      class: "worklog-row card-row", role: "button", tabindex: 0, title: `Go to ${card}`, data: { seq: String(entry.seq), about: card },
      on: { click: go, keydown: (e) => { const k = e as KeyboardEvent; if (k.key === "Enter" || k.key === " ") { k.preventDefault(); go(); } } },
    }, kids);
  };
  const paint = (node: HTMLElement, entry: Entry): void => {
    const card = node.dataset.about;
    if (card !== undefined) node.classList.toggle("muted", store.shown.cards[card]?.place !== "lane");
    void entry;
  };

  function repaint(): void {
    const state = store.shown;
    seen = state;
    upTo = state.seq;
    syncList(list, worklogRows(state, store.entries, { every, kinds: shown }), (e) => String(e.seq), (e) => { const n = make(e); paint(n, e); return n; }, paint);
  }
  return { el, update() { if (store.shown !== seen || store.shown.seq !== upTo) repaint(); } };
}
