import type { LoopFileView, LoopSummaryView } from "../../core/wire";
import type { H } from "../dom";
import { clear } from "../dom";
import { refusalLine } from "../refusal";
import type { Screen, Shell } from "../app";

/** The configuration's default loop (`loops.default`): a case of it says nothing about its loop on the case list. */
export const DEFAULT_LOOP = "investigation";

/** The first 12 hex of a hash: how every hash is shown; the whole hash is the element's title. */
export const short = (hash: string): string => hash.slice(0, 12);
/** A chip holding the short hash, the whole hash its title; null for an item with no hash (a built-in one). */
export const hashChip = (h: H, hash: string | null): HTMLElement | null => (hash === null ? null : h("span", { class: "chip hash", title: hash }, short(hash)));
/** `v<version> · <12 hex>`, the whole hash as the title. */
export const versionLine = (h: H, l: Pick<LoopSummaryView, "version" | "hash">): HTMLElement =>
  h("span", { class: "version", ...(l.hash === null ? {} : { title: l.hash }) }, `v${l.version ?? "?"} · ${l.hash === null ? "no hash" : short(l.hash)}`);
/** A loop's problems, each a line of text. */
export const problemList = (h: H, problems: readonly string[]): HTMLElement => h("ul", { class: "problems", role: "list" }, problems.map((p) => h("li", null, p)));

/**
 * The Loops screen (slice 12): one tile per loop the registry holds, usable or not, with New case from this loop on a usable one; under the grid the
 * files of the loop store with Import, and each root that is not trusted with Trust this root. Every title, about text, problem and file name from a
 * loop or a loop file is only ever text here.
 */
export function loopsView(shell: Shell): Screen {
  const { ui, nav } = shell;
  const h = ui.h;
  let loops: LoopSummaryView[] | null = null;
  let loopsFailed = false;
  let files: LoopFileView[] | null = null;
  let filesFailed = false;
  let destroyed = false;
  let asked = 0;
  /** Each usable loop's stage titles, once its view is read; its stage ids until then. */
  const titles = new Map<string, string[]>();
  /** What the last Import or Trust of a file or root said, or why it was refused: shown beside its button until the next try. */
  const said = new Map<string, string>();
  const refused = new Map<string, string>();
  const busy = new Set<string>();
  /** What was typed into each root's confirmation box, kept across repaints. */
  const typed = new Map<string, string>();

  const grid = h("div", { class: "grid loops-grid" });
  const fileList = h("div", { class: "loop-file-list", role: "list" });
  const rootList = h("div", { class: "untrusted-roots", role: "list" });
  const loadError = h("p", { class: "load-error say", role: "alert" });

  const read = (): void => {
    const mine = ++asked;
    ui.api.loops().then((list) => {
      if (destroyed || mine !== asked) return;
      loops = list; loopsFailed = false;
      render();
      for (const l of list) {
        if (!l.usable) continue;
        ui.api.loop(l.id).then((v) => {
          if (destroyed) return;
          titles.set(l.id, v.stage_views.map((s) => s.title));
          render();
        }, () => {});
      }
    }, () => { if (destroyed || mine !== asked) return; loopsFailed = true; render(); });
    ui.api.loopFiles().then((list) => {
      if (destroyed || mine !== asked) return;
      files = list; filesFailed = false;
      fileList.dataset.ready = "";
      render();
    }, () => { if (destroyed || mine !== asked) return; filesFailed = true; render(); });
  };

  const loopTile = (l: LoopSummaryView): HTMLElement => {
    const stages = titles.get(l.id) ?? l.stages;
    return h("article", { class: l.usable ? "loop-tile" : "loop-tile unusable", role: "listitem", data: { loop: l.id } },
      h("button", { type: "button", class: "link-button", data: { action: "open-loop" }, name: `Open the loop ${l.title}`, title: `Open the loop ${l.title}`, on: { click: () => nav.go({ screen: "loop", id: l.id }) } },
        h("span", { class: "head" }, l.title)),
      versionLine(h, l),
      h("p", { class: "stages" }, stages.join(" → ")),
      h("p", { class: "about" }, l.about),
      l.usable
        ? h("button", { type: "button", class: "primary", data: { action: "new-from-loop" }, name: `New case from the loop ${l.title}`, on: { click: () => nav.go({ screen: "new", loop: l.id }) } }, "New case from this loop")
        : problemList(h, l.problems));
  };

  const importFile = (f: LoopFileView): void => {
    if (busy.has(f.file)) return;
    busy.add(f.file); said.delete(f.file); refused.delete(f.file); render();
    void ui.api.importLoop(f.file).then((r) => {
      busy.delete(f.file);
      if (destroyed) return;
      if ("refused" in r) refused.set(f.file, r.refused.join("; "));
      else { said.set(f.file, `Imported into ${r.root}: ${r.written} written, ${r.same} already here`); read(); }
      render();
    });
  };
  const fileRow = (f: LoopFileView): HTMLElement => {
    const blocked = f.plan === null || f.plan.conflicts.length > 0;
    return h("article", { class: "loop-file", role: "listitem", data: { file: f.file } },
      h("div", { class: "loop-file-head" }, h("span", { class: "file" }, f.file), h("span", { class: "title" }, f.title), versionLine(h, f),
        h("span", { class: "chip" }, `${f.files} files`)),
      f.plan === null ? null : h("p", { class: "plan" }, `${f.plan.write} to write, ${f.plan.same} already here`),
      f.plan === null || f.plan.conflicts.length === 0 ? null : h("ul", { class: "conflicts", role: "list" }, f.plan.conflicts.map((c) => h("li", null, c))),
      f.problem === null ? null : h("p", { class: "problem muted" }, f.problem),
      h("div", { class: "loop-file-actions" },
        h("button", { type: "button", data: { action: "import-loop" }, name: `Import ${f.file}`, disabled: blocked || busy.has(f.file),
          title: blocked ? "This file cannot be imported as things are: see why above" : "Import into a root that is not trusted", on: { click: () => importFile(f) } }, "Import"),
        h("span", { class: "said", role: "status" }, said.get(f.file) ?? "")),
      refusalLine(h, refused.get(f.file), `import:${f.file}`));
  };

  const trust = (root: string): void => {
    const value = typed.get(root) ?? "";
    if (busy.has(`root:${root}`) || value !== root) return;
    busy.add(`root:${root}`); refused.delete(`root:${root}`); render();
    void ui.api.trustRoot(root, value).then((r) => {
      busy.delete(`root:${root}`);
      if (destroyed) return;
      if ("refused" in r) refused.set(`root:${root}`, r.refused.join("; "));
      else { typed.delete(root); ui.toast(`${root} is trusted: its loops are loaded`); read(); }
      render();
    });
  };
  const rootRow = (root: string): HTMLElement => {
    const label = `Type ${root} to trust it`;
    const button = h("button", { type: "button", data: { action: "trust" }, name: `Trust ${root}`, disabled: (typed.get(root) ?? "") !== root || busy.has(`root:${root}`), on: { click: () => trust(root) } }, "Trust this root") as HTMLButtonElement;
    const box = h("input", {
      type: "text", name: label, placeholder: root, value: typed.get(root) ?? "",
      on: {
        input: (e) => { typed.set(root, (e.target as HTMLInputElement).value); button.disabled = (typed.get(root) ?? "") !== root || busy.has(`root:${root}`); },
        keydown: (e) => { if ((e as KeyboardEvent).key === "Enter") { e.preventDefault(); trust(root); } },
      },
    });
    return h("article", { class: "untrusted-root", role: "listitem", data: { root } },
      h("p", null, h("span", { class: "file" }, root), " is not trusted. Trusting it lets its loops, stages and checks load, and its check scripts run. Type its folder name to confirm."),
      h("div", { class: "trust-row" }, box, button),
      refusalLine(h, refused.get(`root:${root}`), `trust:${root}`));
  };

  const render = (): void => {
    loadError.textContent = loopsFailed ? "The loops could not be loaded" : filesFailed ? "The loop store could not be read" : "";
    const focused = ui.doc.activeElement;
    const keep = focused !== null && el.contains(focused) && focused !== el ? (focused as HTMLElement).getAttribute("aria-label") : null;
    clear(grid);
    if (loops !== null) {
      for (const l of loops) grid.appendChild(loopTile(l));
      if (loops.length === 0) grid.appendChild(h("p", { class: "nomatch", role: "status" }, "There are no loops"));
    }
    clear(fileList);
    if (files !== null) {
      for (const f of files) fileList.appendChild(fileRow(f));
      if (files.length === 0) fileList.appendChild(h("p", { class: "muted", role: "status" }, "The loop store holds no loop files. Copy a received file into it, or export a loop."));
    }
    clear(rootList);
    const roots = [...new Set((loops ?? []).filter((l) => !l.trusted && !l.implicit && l.root !== "").map((l) => l.root))];
    for (const r of roots) rootList.appendChild(rootRow(r));
    if (keep !== null) {
      for (const b of Array.from(el.querySelectorAll("button, input")) as HTMLElement[]) if (b.getAttribute("aria-label") === keep) { b.focus(); break; }
    }
  };

  const el = h("main", { class: "top loops", data: { screen: "loops" }, tabindex: -1 },
    h("h1", null, "Loops"),
    h("p", { class: "muted" }, "What a case runs: its stages in order, their gates, and where each part comes from."),
    loadError, grid,
    h("section", { class: "loop-files" }, h("h2", null, "Loop files"), fileList, rootList));
  read();
  render();
  return { el, update() {}, focus() { el.focus(); }, destroy() { destroyed = true; } };
}
