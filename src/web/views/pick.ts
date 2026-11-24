import type { CaseSummaryView } from "../../core/wire";
import { syncList } from "../dom";
import { markingChip } from "../chips";
import type { Screen, Shell } from "../app";
import { MODES } from "./home";

/** Run status in words. */
export function runWords(status: CaseSummaryView["run_status"]): string {
  switch (status) {
    case "none": return "not started";
    case "waiting": return "waiting for you";
    default: return status;
  }
}

/** Newest first: by creation time, then by case number. */
export function newestFirst(cases: readonly CaseSummaryView[]): CaseSummaryView[] {
  const n = (id: string): number => Number(id.replace(/^\D+/, ""));
  return [...cases].sort((a, b) => (a.created_ts === b.created_ts ? n(b.id) - n(a.id) : a.created_ts < b.created_ts ? 1 : -1));
}

type Item = { k: "new" } | { k: "case"; c: CaseSummaryView } | { k: "none" };

export function pickView(shell: Shell): Screen {
  const { ui, nav } = shell;
  const h = ui.h;
  const phaseTitle = (c: CaseSummaryView): string => (c.phase === null ? "not started" : (ui.ref.phases.find((p) => p.id === c.phase)?.title ?? c.phase));
  const descriptor = (c: CaseSummaryView): string => `${c.id} · ${phaseTitle(c)} · ${runWords(c.run_status)}`;
  const fullName = (c: CaseSummaryView): string => `${c.title} · ${descriptor(c)} · ${c.marking} · ${c.incoming} incoming · ${c.kept} kept`;
  const matches = (c: CaseSummaryView, q: string): boolean => {
    const needle = q.trim().toLowerCase();
    return needle === "" || [c.title, c.id, c.marking, c.run_status, runWords(c.run_status)].join(" ").toLowerCase().includes(needle);
  };

  const grid = h("div", { class: "grid" });
  const filter = h("input", { type: "text", name: "Filter", placeholder: "Filter by title, id, marking or status" }) as HTMLInputElement;

  const shown = (): CaseSummaryView[] => newestFirst(shell.cases()).filter((c) => matches(c, filter.value));
  const makeTile = (c: CaseSummaryView): HTMLElement => {
    const name = fullName(c);
    return h("button", { type: "button", class: "tile", name, title: name, on: { click: () => nav.go({ screen: "case", id: c.id }) } },
      h("span", { class: "head" }, c.title), h("span", { class: "desc" }, descriptor(c)),
      h("span", { class: "chips" }, markingChip(ui, c.marking), h("span", { class: "chip" }, `${c.incoming} incoming`), h("span", { class: "chip" }, `${c.kept} kept`)));
  };
  const render = (): void => {
    const list = shown();
    const items: Item[] = [{ k: "new" }, ...list.map((c): Item => ({ k: "case", c })), ...(list.length === 0 && shell.cases().length > 0 ? [{ k: "none" } as Item] : [])];
    syncList(grid, items, (i) => (i.k === "case" ? `${i.c.id}|${fullName(i.c)}` : i.k),
      (i) => {
        if (i.k === "new") return h("button", { type: "button", class: "tile proposed", name: "New investigation", title: "New investigation", on: { click: () => nav.go({ screen: "new" }) } }, "+ New investigation");
        if (i.k === "none") return h("p", { class: "nomatch", role: "status" }, "Nothing matches");
        return makeTile(i.c);
      },
      () => {});
  };

  filter.addEventListener("input", render);
  filter.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = shown()[0];
      if (first) nav.go({ screen: "case", id: first.id });
    } else if (e.key === "Escape") {
      e.stopPropagation();
      if (filter.value !== "") { filter.value = ""; render(); } else nav.up();
    }
  });

  const el = h("main", { class: "top", data: { screen: "pick" }, tabindex: -1 }, h("h1", null, "Investigate: which one?"), h("div", { class: "filter" }, filter), grid);
  render();
  return { el, update: render, focus() { filter.focus(); } };
}

/** A mode that is not built yet: its name and one honest line. */
export function soonView(shell: Shell, mode: string): Screen {
  const h = shell.ui.h;
  const label = MODES.find((m) => m.id === mode)?.label ?? mode;
  const el = h("main", { class: "top", data: { screen: "soon" }, tabindex: -1 }, h("h1", null, label), h("p", null, "Not built yet. This part comes after the investigation slice."));
  return { el, update() {}, focus() { el.focus(); } };
}
