import type { CaseState } from "../../core/state";
import type { Entry } from "../../core/types";
import type { Open } from "../app";
import { tag } from "../chips";
import type { TagKind } from "../chips";
import { describe } from "../describe";
import { syncList } from "../dom";
import { timeEl } from "../time";
import type { Ui, View } from "../ui";

interface Row { seq: number; ts: string; entry: Entry; card: string | null }

/** The entries the Timeline has a row for: each card, query, stage start and finish, gate, draft revision and published product. */
const SHOWN = new Set(["card.created", "query.issued", "stage.started", "stage.finished", "gate.waiting", "gate.passed", "draft.revised", "product.published"]);

const millis = (ts: string): number => { const t = Date.parse(ts); return Number.isNaN(t) ? 0 : t; };

/** Rows in time order, newest last. A card sits at its event time when it has one, else when it was made. */
export function timelineRows(state: CaseState, entries: readonly Entry[]): Row[] {
  const rows: Row[] = [];
  for (const entry of entries) {
    if (entry.seq > state.seq || !SHOWN.has(entry.type)) continue;
    if (entry.type === "card.created") {
      const id = entry.payload.card?.id;
      if (typeof id !== "string" || !Object.hasOwn(state.cards, id)) continue;
      rows.push({ seq: entry.seq, ts: state.cards[id]!.event_time ?? entry.ts, entry, card: id });
    } else rows.push({ seq: entry.seq, ts: entry.ts, entry, card: null });
  }
  return rows.sort((a, b) => millis(a.ts) - millis(b.ts) || a.seq - b.seq);
}

/** The Timeline lens: what happened and what was found, in the order it happened. Rows for cards that are not kept are muted. */
export function makeTimeline(ui: Ui, open: Open): View {
  const { h } = ui;
  const { store, nav } = open;
  const list = h("div", { class: "timeline" });
  const empty = h("p", { class: "empty" }, "Nothing has happened yet.");
  const el = h("div", { class: "lens lens-timeline", name: "Timeline" }, list, empty);
  let seen: CaseState | null = null;

  const actorTag = (entry: Entry): HTMLElement => { const t = tag(ui, entry.actor.kind as TagKind, entry.actor.kind, `Made by ${entry.actor.id}`); t.classList.add("actor-kind"); return t; };
  const make = (row: Row): HTMLElement => {
    const d = describe(row.entry, ui.ref);
    const kids = [timeEl(ui, row.ts, "local"), actorTag(row.entry), " ", h("span", { class: "what" }, d.what), d.detail === "" ? null : h("span", { class: "detail" }, ` ${d.detail}`)];
    const card = row.card;
    if (card === null) return h("div", { class: "timeline-row", data: { seq: String(row.seq) } }, kids);
    const go = (): void => nav.focusCard(card);
    return h("div", {
      class: "timeline-row card-row", role: "button", tabindex: 0, title: `Go to ${card}`, data: { seq: String(row.seq), about: card },
      on: { click: go, keydown: (e) => { const k = e as KeyboardEvent; if (k.key === "Enter" || k.key === " ") { k.preventDefault(); go(); } } },
    }, kids);
  };
  const paint = (node: HTMLElement, row: Row, state: CaseState): void => {
    if (row.card !== null) node.classList.toggle("muted", state.cards[row.card]!.place !== "lane");
  };

  return {
    el,
    update() {
      const state = store.shown;
      if (state === seen) return;
      seen = state;
      const rows = timelineRows(state, store.entries);
      empty.hidden = rows.length > 0;
      syncList(list, rows, (r) => String(r.seq), (r) => { const n = make(r); paint(n, r, state); return n; }, (n, r) => paint(n, r, state));
    },
  };
}
