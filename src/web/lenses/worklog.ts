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

/** The Worklog lens: every entry, with who made it and what it was, in UTC with milliseconds. */
export function makeWorklog(ui: Ui, open: Open): View {
  const { h } = ui;
  const { store } = open;
  const shown = new Set<Kind>(["human", "agent", "system"]);
  let seen: unknown = null;
  let upTo = -1;
  const list = h("div", { class: "worklog" });
  const filter = h("div", { class: "filter", role: "group", name: "Show entries by" }, KINDS.map(([kind, label]) =>
    h("label", null, h("input", {
      type: "checkbox", checked: true, name: label,
      on: { change: (e) => { if ((e.target as HTMLInputElement).checked) shown.add(kind); else shown.delete(kind); repaint(); } },
    }), ` ${label}`)));
  const el = h("div", { class: "lens lens-worklog", name: "Worklog" }, filter, list);

  const make = (entry: Entry): HTMLElement => {
    const d = describe(entry, ui.ref);
    return h("div", { class: "worklog-row", data: { seq: String(entry.seq) }, title: d.detail },
      h("time", { title: "UTC" }, utc(entry.ts)), tagKind(entry),
      " ", h("span", { class: "actor-id" }, entry.actor.id), " ", h("span", { class: "what" }, d.what));
  };
  const tagKind = (entry: Entry): HTMLElement => { const t = tag(ui, entry.actor.kind as TagKind, entry.actor.kind, "Who made this entry"); t.classList.add("actor-kind"); return t; };

  function repaint(): void {
    const state = store.shown;
    seen = state;
    upTo = state.seq;
    const rows = store.entries.slice(0, state.seq).filter((e) => shown.has(e.actor.kind));
    syncList(list, rows, (e) => String(e.seq), make, () => {});
  }
  return { el, update() { if (store.shown !== seen || store.shown.seq !== upTo) repaint(); } };
}
