import type { CardState, CaseState } from "../../core/state";
import type { Observable } from "../../core/types";
import { tag } from "../chips";
import type { TagKind } from "../chips";
import { markingChip } from "../chips";
import { makePivotPanel } from "../panels/pivot";
import type { PivotPanel } from "../panels/pivot";
import { makeVerify } from "../panels/verify";
import { cardStatus, cellText } from "../derive";
import { clear } from "../dom";
import type { Nav } from "../app";
import type { CaseStore } from "../store";
import { shortLocal, timeEl } from "../time";
import type { Ui } from "../ui";

export const CLOSED_ROWS = 3;
export const CELL_LIMIT = 200;

/** What a card needs from the work area around it. */
export interface CardEnv {
  ui: Ui; store: CaseStore; nav: Nav;
  isOpen(card: string): boolean;
  isNew(card: string): boolean;
  /** Open this card (closing the others unless one was marked keep-open). */
  toggle(card: string): void;
  /** Known values, and a number that changes when the set does. */
  known(): { values: Set<string>; version: number };
  readonly(): boolean;
  keep(card: string): void; discard(card: string): void; sendBack(card: string): void; pin(card: string, pinned: boolean): void; move(card: string, lane: string): void;
}
export interface CardView { el: HTMLElement; update(state: CaseState): void; /** Opens the Pivot panel inside the card, starting from `values`. */ pivot(values: Observable[]): void }

const cut = (text: string): string => (text.length > CELL_LIMIT ? `${text.slice(0, CELL_LIMIT)}…` : text);

/** One card, patched in place: the root node lives as long as the card is listed; its contents are rebuilt only when what they show changed. */
export function makeCardView(env: CardEnv, id: string): CardView {
  const { ui } = env;
  const h = ui.h;
  const el = h("article", { class: "card", tabindex: 0, data: { card: id, drop: "card" }, on: {
    click: (e) => { if (!insideControl(e.target)) env.toggle(id); },
    dblclick: (e) => { if (!insideControl(e.target) && placeOf() === "incoming") env.keep(id); },
  } });
  let last: unknown[] | null = null;
  let current: CardState | null = null;
  let panel: PivotPanel | null = null;
  const verify = makeVerify(ui, env.store, id);
  const placeOf = (): string => current?.place ?? "incoming";

  const tags = (c: CardState): HTMLElement[] => {
    const out: HTMLElement[] = [];
    if (c.place === "incoming" && env.isNew(c.id)) out.push(tag(ui, "human", "new", "Not opened yet"));
    const status = cardStatus(c);
    if (status === "partial" && c.coverage !== null && c.coverage.kind === "partial") {
      out.push(tag(ui, "attention", "partial", `${c.coverage.reason}${c.coverage.detail === undefined ? "" : ` — ${c.coverage.detail}`}`));
    } else if (status === "proven negative") out.push(tag(ui, "done", "proven negative", "Nothing found, and the source was fully searched"));
    else if (status === "nothing found") out.push(tag(ui, "human", "nothing found", "Nothing found; this does not prove it is not there"));
    if (c.pinned) out.push(tag(ui, "human", "pinned"));
    out.push(tag(ui, c.made_by as TagKind, c.made_by));
    if (c.validated !== null) {
      const v = c.validated;
      if (v.outcome === "matches") out.push(tag(ui, "done", `validated ${shortLocal(v.ts, new Date())}`, v.detail));
      else out.push(tag(ui, "attention", v.outcome === "differs" ? "differs" : "could not verify", v.detail));
    }
    return out;
  };

  const valueCell = (c: CardState, col: number, v: unknown, known: Set<string>): HTMLElement => {
    const text = cellText(v);
    const type = c.column_types[col];
    const long = text.length > CELL_LIMIT;
    const props = { class: long ? "long" : undefined, title: long ? text : undefined };
    if (type === null || type === undefined || text === "") return h("td", props, cut(text));
    const obs: Observable = { type, value: text };
    const chip = h("button", {
      type: "button", class: known.has(`${type}|${text}`) ? "chip value" : "chip value proposed", name: `${type} ${text}`, title: long ? text : `${type} ${text}`,
      disabled: env.readonly(),
      on: { click: () => { if (!env.readonly()) env.nav.pivot(c.id, [obs]); } },
    }, cut(text));
    return h("td", props, chip);
  };

  const table = (c: CardState, open: boolean, known: Set<string>): HTMLElement => {
    const head = c.columns.map((name, col) => {
      const type = c.column_types[col];
      if (type === null || type === undefined) return h("th", null, name);
      const seen = new Set<string>();
      const values: Observable[] = [];
      for (const row of c.rows) {
        const text = cellText(row[col]);
        if (text !== "" && !seen.has(text)) { seen.add(text); values.push({ type, value: text }); }
      }
      return h("th", null, h("button", { type: "button", class: "col", name: `All ${name} values`, title: `Pivot on every ${type} in ${name}`, disabled: env.readonly(), on: { click: () => { if (!env.readonly()) env.nav.pivot(c.id, values); } } }, name));
    });
    const rows = open ? c.rows : c.rows.slice(0, CLOSED_ROWS);
    return h("table", null, h("thead", null, h("tr", null, head)), h("tbody", null, rows.map((row) => h("tr", null, c.columns.map((_n, col) => valueCell(c, col, row[col], known))))));
  };

  /** Every distinct typed value in the preview rows, in order of appearance (at most 12): what the Pivot action starts from. */
  const typedValues = (c: CardState): Observable[] => {
    const seen = new Set<string>();
    const out: Observable[] = [];
    for (const row of c.rows) {
      c.column_types.forEach((type, col) => {
        const text = cellText(row[col]);
        if (type === null || type === undefined || text === "" || seen.has(`${type}|${text}`) || out.length >= 12) return;
        seen.add(`${type}|${text}`);
        out.push({ type, value: text });
      });
    }
    return out;
  };

  const dl = (c: CardState, state: CaseState): HTMLElement => {
    const q = c.query !== null && Object.hasOwn(state.queries, c.query) ? state.queries[c.query]! : null;
    const rows: [string, HTMLElement | string][] = [];
    rows.push(["Source", env.ui.ref.sources.find((s) => s.id === c.source)?.title ?? c.source ?? "none"]);
    rows.push(["Query", q === null ? "none" : h("pre", { class: "query" }, q.text)]);
    const why = q?.why ?? c.why;
    rows.push(["Why", q !== null && q.by.kind === "agent" ? `reasoning as stated by the agent: ${why}` : why]);
    rows.push(["By", q === null ? `${c.made_by}` : `${q.by.kind} ${q.by.id}`]);
    rows.push(["Marking", markingChip(ui, c.marking)]);
    rows.push(["When", timeEl(ui, q?.issued_ts ?? c.created_ts, "utc")]);
    const job = q === null ? null : env.store.entries[q.issued_seq - 1]?.job ?? null;
    if (job !== null) rows.push(["Job", job]);
    if (q !== null && q.status === "failed" && q.error !== null) rows.push(["Failed", q.error]);
    rows.push(["Coverage", c.coverage === null ? "not recorded" : c.coverage.kind === "full" ? "full" : `partial: ${c.coverage.reason}${c.coverage.detail === undefined ? "" : ` — ${c.coverage.detail}`}`]);
    rows.push(["If empty", c.empty === "proven-negative" ? "proven negative" : c.empty === "not-seen" ? "not seen" : "not applicable"]);
    for (const note of c.quality_notes) rows.push(["Quality note", note]);
    return h("dl", { class: "provenance" }, rows.flatMap(([k, v]) => [h("dt", null, k), h("dd", null, v)]));
  };

  const actions = (c: CardState, state: CaseState): HTMLElement => {
    const ro = env.readonly();
    const button = (action: string, label: string, onClick: (() => void) | null): HTMLElement =>
      h("button", { type: "button", class: "action", data: { action }, disabled: ro || onClick === null, on: onClick === null ? undefined : { click: onClick } }, label);
    const row: HTMLElement[] = [
      button("pivot", "Pivot…", () => env.nav.pivot(c.id, typedValues(c))),
      button("verify", "Verify", () => { void ui.send("verify_card", { card: c.id }); }),
      button("cite", "Cite", () => env.nav.cite(c.id)),
    ];
    if (c.place === "incoming") row.push(button("keep", "Keep", () => env.keep(c.id)));
    if (c.place === "lane") {
      const others = state.lanes.filter((l) => l.id !== c.lane);
      row.push(h("select", { name: "Move", disabled: ro || others.length === 0, on: { change: (e) => { const v = (e.target as HTMLSelectElement).value; if (v !== "") env.move(c.id, v); } } },
        h("option", { value: "" }, "Move…"), others.map((l) => h("option", { value: l.id }, l.title))));
      row.push(button("send_back", "Back to Incoming", () => env.sendBack(c.id)));
    }
    if (c.place !== "discarded") row.push(button("discard", "Discard", () => env.discard(c.id)));
    row.push(button("pin", c.pinned ? "Unpin" : "Pin", () => env.pin(c.id, !c.pinned)));
    return h("div", { class: "actions", role: "toolbar", name: "Card actions" }, row);
  };

  return {
    el,
    pivot(values) {
      panel ??= makePivotPanel(ui, env.store, env.nav, id);
      panel.setValues(values);
      last = null;                                   // the panel joins the card on its next draw
    },
    update(state) {
      const c = Object.hasOwn(state.cards, id) ? state.cards[id]! : null;
      if (c === null) return;
      panel?.update();
      const open = env.isOpen(id);
      const q = c.query !== null && Object.hasOwn(state.queries, c.query) ? state.queries[c.query] : undefined;
      const known = env.known();
      const typed = c.column_types.some((t) => t !== null);
      const sig: unknown[] = [c, open, c.place === "incoming" && env.isNew(id), q, open ? state.lanes : null, typed ? known.version : 0, env.readonly()];
      if (last !== null && sig.every((x, i) => x === last![i])) return;
      last = sig; current = c;
      clear(el);
      el.classList.toggle("open", open);
      el.append(
        h("div", { class: "card-head" }, h("span", { class: "title" }, c.title), h("span", { class: "tags" }, tags(c))),
        h("p", { class: "body" }, c.body),
      );
      if (c.rows.length > 0) el.appendChild(table(c, open, known.values));
      if (open) {
        el.appendChild(h("p", { class: "rowcount muted" }, `${c.rows.length} of ${c.row_count} rows`));
        verify.update(state);
        el.append(dl(c, state), verify.el, actions(c, state));
        if (panel !== null) el.append(panel.el);
      }
    },
  };
}

/** True for a click that landed on something with a job of its own. */
function insideControl(target: EventTarget | null): boolean {
  const node = target as Element | null;
  return node !== null && typeof node.closest === "function" && node.closest("button, select, input, [role=toolbar]") !== null;
}

/** The card views of one case, made on first use and kept, so a card that moves between columns keeps its node. */
export function makeCardPool(env: CardEnv): { el(id: string, state: CaseState): HTMLElement; patch(id: string, state: CaseState): void; pivot(id: string, state: CaseState, values: Observable[]): void; forget(id: string): void } {
  const views = new Map<string, CardView>();
  const view = (id: string): CardView => {
    let v = views.get(id);
    if (v === undefined) { v = makeCardView(env, id); views.set(id, v); }
    return v;
  };
  return {
    el(id, state) { const v = view(id); v.update(state); return v.el; },
    patch(id, state) { view(id).update(state); },
    pivot(id, state, values) { const v = view(id); v.pivot(values); v.update(state); },
    forget(id) { views.delete(id); },
  };
}
