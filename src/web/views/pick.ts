import type { CaseSummaryView } from "../../core/wire";
import { clear, syncList } from "../dom";
import { markingChip } from "../chips";
import { refusalLine } from "../refusal";
import type { Screen, Shell } from "../app";
import { MODES } from "./home";

/** Why Unload is off while the run is running: the server's own words for it. */
const RUNNING = "a run is running; pause or stop it first";

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

  /** The configuration's default loop, as the server names it: a case of it says nothing of its loop. */
  const DEFAULT_LOOP = ui.me.loops.default;
  /** The loops' titles, read once a case of another loop than the default is listed; a loop's id stands in until then. */
  let loopTitles: Map<string, string> | null = null;
  let askedLoops = false;
  let destroyed = false;
  const loopTitle = (id: string): string => loopTitles?.get(id) ?? id;
  const wantLoops = (): void => {
    if (askedLoops || !shell.cases().some((c) => c.loop !== DEFAULT_LOOP)) return;
    askedLoops = true;
    ui.api.loops().then((list) => { if (destroyed) return; loopTitles = new Map(list.map((l) => [l.id, l.title])); render(); }, () => {});
  };
  /** What a tile says of its loop and its links: the loop when not the default, its parent, the child it waits on. */
  const links = (c: CaseSummaryView): string => [c.loop === DEFAULT_LOOP ? "" : loopTitle(c.loop), c.parent ?? "", c.waiting_on ?? ""].join("|");

  const grid = h("div", { class: "grid" });
  const loadError = h("p", { class: "load-error say", role: "alert" });
  const filter = h("input", { type: "text", name: "Filter", placeholder: "Filter by title, id, marking or status" }) as HTMLInputElement;

  const shown = (): CaseSummaryView[] => newestFirst(shell.cases()).filter((c) => matches(c, filter.value));
  /** Why the last Unload from a tile's menu was refused, by case id: shown in that menu until the next try. */
  const unloadWhy = new Map<string, string>();
  const unloading = new Set<string>();
  const unload = (c: CaseSummaryView, button: HTMLButtonElement, slot: HTMLElement): void => {
    if (unloading.has(c.id)) return;
    unloading.add(c.id); button.disabled = true;
    unloadWhy.delete(c.id); clear(slot);
    void ui.api.unload(c.id).then((r) => {
      unloading.delete(c.id); button.disabled = false;
      if (r.ok) { ui.toast(`${c.id} was unloaded to the case store`); shell.refreshCases(); return; }
      const why = r.refused.join("; ");
      unloadWhy.set(c.id, why);
      clear(slot);
      const line = refusalLine(h, why, `unload:${c.id}`);
      if (line !== null) slot.appendChild(line);
    });
  };
  /** A loaded case's menu: Unload, off (with the reason as its title) while the run is running. */
  const makeMenu = (c: CaseSummaryView): HTMLElement => {
    const running = c.run_status === "running";
    const slot = h("div", { class: "menu-why" });
    const why = unloadWhy.get(c.id);
    if (why !== undefined) { const line = refusalLine(h, why, `unload:${c.id}`); if (line !== null) slot.appendChild(line); }
    const button = h("button", {
      type: "button", data: { action: "unload" }, name: `Unload ${c.id}`, disabled: running,
      title: running ? RUNNING : `Pack ${c.id} into the case store and take it off this list`,
    }, "Unload") as HTMLButtonElement;
    button.addEventListener("click", () => unload(c, button, slot));
    return h("details", { class: "tile-menu", data: { case: c.id } }, h("summary", { name: `More for ${c.id}`, title: `More for ${c.id}` }, "⋯"), h("div", { class: "menu-body" }, button, slot));
  };
  const makeTile = (c: CaseSummaryView): HTMLElement => {
    const name = fullName(c);
    const tile = h("button", { type: "button", class: "tile", name, title: name, on: { click: () => nav.go({ screen: "case", id: c.id }) } },
      h("span", { class: "head" }, c.title), h("span", { class: "desc" }, descriptor(c)),
      h("span", { class: "chips" }, markingChip(ui, c.marking), h("span", { class: "chip" }, `${c.incoming} incoming`), h("span", { class: "chip" }, `${c.kept} kept`),
        c.unload_failed === null ? null : h("span", { class: "chip unload-failed", title: c.unload_failed }, "unload failed"),
        c.loop === DEFAULT_LOOP ? null : h("span", { class: "chip loop", title: `A case of the loop ${loopTitle(c.loop)}` }, loopTitle(c.loop)),
        c.parent === null ? null : h("span", { class: "chip parent", title: `Made by ${c.parent}` }, `child of ${c.parent}`),
        c.waiting_on === null ? null : h("span", { class: "chip waiting-on", title: `Its run waits on ${c.waiting_on}` }, `waiting on ${c.waiting_on}`)));
    return h("div", { class: "tile-wrap" }, tile, makeMenu(c));
  };
  const render = (): void => {
    wantLoops();
    loadError.textContent = shell.casesStatus() === "failed" ? "The cases could not be loaded" : "";
    const list = shown();
    const items: Item[] = [{ k: "new" }, ...list.map((c): Item => ({ k: "case", c })), ...(list.length === 0 && shell.cases().length > 0 ? [{ k: "none" } as Item] : [])];
    syncList(grid, items, (i) => (i.k === "case" ? `${i.c.id}|${fullName(i.c)}|${i.c.unload_failed ?? ""}|${links(i.c)}` : i.k),
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

  const storeButton = h("button", { type: "button", class: "store-button", data: { action: "case-store" }, title: "The cases unloaded to the case store: search them and load one", on: { click: () => nav.go({ screen: "store" }) } }, "Case store");
  const el = h("main", { class: "top", data: { screen: "pick" }, tabindex: -1 }, h("h1", null, "Investigate: which one?"), h("div", { class: "filter" }, filter, storeButton), loadError, grid);
  render();
  return { el, update: render, focus() { filter.focus(); }, destroy() { destroyed = true; } };
}

/** A mode that is not built yet: its name and one honest line. */
export function soonView(shell: Shell, mode: string): Screen {
  const h = shell.ui.h;
  const label = MODES.find((m) => m.id === mode)?.label ?? mode;
  const el = h("main", { class: "top", data: { screen: "soon" }, tabindex: -1 }, h("h1", null, label), h("p", null, "Not built yet. This part comes after the investigation slice."));
  return { el, update() {}, focus() { el.focus(); } };
}
