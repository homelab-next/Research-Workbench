import { GROUPS, SORTS, orderIncoming } from "../derive";
import type { IncomingGroup, IncomingSort, IncomingView } from "../derive";
import { syncList } from "../dom";
import type { CaseState } from "../../core/state";
import type { CaseStore } from "../store";
import type { Ui, View } from "../ui";

const SORT_LABEL: Record<IncomingSort, string> = { arrived: "Arrived", event_time: "Event time", step: "Step", source: "Source", started_by: "Started by", status: "Status" };
const GROUP_LABEL: Record<IncomingGroup, string> = { none: "No groups", step: "Step", source: "Source", started_by: "Started by", type: "Type" };

/** What `prefs` holds may be anything; only a known choice is used. */
export function readIncomingView(ui: Ui): IncomingView {
  const raw = ui.prefs.get<unknown>("incoming", null);
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    sort: (SORTS as readonly unknown[]).includes(o.sort) ? (o.sort as IncomingSort) : "arrived",
    reverse: o.reverse === true,
    group: (GROUPS as readonly unknown[]).includes(o.group) ? (o.group as IncomingGroup) : "none",
  };
}

type Item = { kind: "group"; name: string } | { kind: "card"; id: string };

/** Incoming: the sort and group bar, the cards waiting for triage, and the key hints. */
export function makeIncoming(ui: Ui, store: CaseStore, card: (id: string, state: CaseState) => HTMLElement, patch: (id: string, state: CaseState) => void): View {
  const { h } = ui;
  let view = readIncomingView(ui);
  const choose = <T extends string>(name: string, label: string, values: readonly T[], words: Record<T, string>, pick: (v: T) => void): HTMLSelectElement =>
    h("select", { name: label, on: { change: (e) => pick((e.target as HTMLSelectElement).value as T) } },
      values.map((v) => h("option", { value: v }, words[v]))) as HTMLSelectElement;
  const change = (next: IncomingView): void => { view = next; ui.prefs.set("incoming", next); update(); };
  const sort = choose("sort", "Sort by", SORTS, SORT_LABEL, (v) => change({ ...view, sort: v }));
  const group = choose("group", "Group by", GROUPS, GROUP_LABEL, (v) => change({ ...view, group: v }));
  const reverse = h("button", { type: "button", class: "reverse", name: "Reverse order", title: "Reverse the order", on: { click: () => change({ ...view, reverse: !view.reverse }) } }, "↑↓");
  const bar = h("div", { class: "incoming-bar" }, sort, reverse, group);
  const list = h("div", { class: "incoming-list" });
  const empty = h("p", { class: "empty muted" }, "Nothing waiting");
  const foot = h("div", { class: "incoming-foot muted" }, "J/K move · Space keep · X discard · ? keys");
  const el = h("div", { class: "incoming column", tabindex: 0, data: { area: "incoming" }, name: "Incoming" }, bar, list, empty, foot);

  function update(): void {
    const state = store.shown;
    sort.value = view.sort; group.value = view.group;
    reverse.classList.toggle("on", view.reverse);
    const groups = orderIncoming(state, view);
    const items: Item[] = groups.flatMap((g): Item[] => [...(g.group === null ? [] : [{ kind: "group" as const, name: g.group }]), ...g.cards.map((id): Item => ({ kind: "card", id }))]);
    syncList(list, items, (i) => (i.kind === "group" ? `group:${i.name}` : i.id),
      (i) => (i.kind === "group" ? h("h3", { class: "group" }, i.name) : card(i.id, state)),
      (e, i) => { if (i.kind === "card") patch(i.id, state); else if (e.textContent !== i.name) e.textContent = i.name; });
    empty.hidden = items.length > 0;
  }
  return { el, update };
}
