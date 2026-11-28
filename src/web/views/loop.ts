import type { ItemView, LoopStageView, LoopView } from "../../core/wire";
import type { ModelChoice } from "../../core/types";
import { clear } from "../dom";
import { loopFileLink } from "../links";
import { refusalLine } from "../refusal";
import type { Screen, Shell } from "../app";
import { builderPanel } from "../panels/builder";
import { hashChip, problemList, versionLine } from "./loops";

/** Where Task 13 puts its Edit and Copy buttons: a function the loop view calls with the loaded LoopView and gets elements back; null until Task 13 sets it. */
export let editButton: ((shell: Shell, loop: LoopView) => HTMLElement[]) | null = null;
export function setEditButton(make: typeof editButton): void { editButton = make; }

const SOURCE_WORDS: Record<ItemView["source"], string> = { root: "root", pinned: "pinned", "loop-output": "loop output", inline: "inline", memory: "memory", "built-in": "built in" };
const modelWords = (m: ModelChoice): string => `${m.provider} ${m.model} · effort ${m.effort ?? "default"}`;

/**
 * A loop as a plain outline (slice 12): its heading (title, version, hash, the two caps), Export and New case from this loop, then its stages in order,
 * each a disclosure that opens to Context, Middleware and Orchestration, every item with its source and short hash. No graph is drawn.
 */
export function loopView(shell: Shell, id: string): Screen {
  const { ui, nav } = shell;
  const h = ui.h;
  let loop: LoopView | null = null;
  let failed = false;
  let destroyed = false;
  let exporting = false;
  let exportWhy: string | undefined;
  let exportSaid = "";
  /** The file the last export wrote, for its download link. */
  let exportFile: string | null = null;

  const body = h("div", { class: "loop-outline" }, h("p", { class: "muted", role: "status" }, "Loading the loop…"));

  const titleOf = (l: LoopView, stage: string): string => l.stage_views.find((s) => s.id === stage)?.title ?? stage;
  /** "6. Evaluate · runs agent · on pass → Challenge · on fail → Assemble": the stage, how it runs, its gate and its edges. */
  const stageLine = (l: LoopView, s: LoopStageView, n: number): string => [
    `${n}. ${s.title}`, `runs ${s.runs}`,
    s.gate === null ? null : `${s.gate} gate`,
    s.on_pass === null ? null : `on pass → ${titleOf(l, s.on_pass)}`,
    s.on_fail === null ? null : `on fail → ${titleOf(l, s.on_fail)}`,
  ].filter((x): x is string => x !== null).join(" · ");

  /** A memory item reads by its selector and shows no hash: what it holds is the store's, read when a run binds, not part of the loop. */
  const itemRow = (i: ItemView): HTMLElement => i.source === "memory"
    ? h("li", { class: "item", data: { kind: i.kind, source: "memory" } },
      h("span", { class: "item-name" }, `${i.kind} ${i.title}`), " ",
      h("span", { class: "chip source source-memory memory-selector", title: "Read from memory when a run starts" }, `memory: ${i.memory ?? i.id}`))
    : h("li", { class: "item", data: { kind: i.kind } },
      h("span", { class: "item-name" }, `${i.kind} ${i.title}`), " ",
      h("span", { class: `chip source source-${i.source}` }, SOURCE_WORDS[i.source] ?? i.source), " ",
      hashChip(h, i.hash));
  const group = (name: string, title: string, rows: HTMLElement[]): HTMLElement => h("section", { class: "stage-group", data: { group: name } },
    h("h3", null, title), rows.length === 0 ? h("p", { class: "muted" }, "nothing") : h("ul", { role: "list" }, rows));

  const orchestration = (s: LoopStageView): HTMLElement[] => {
    const o = s.orchestration;
    const rows: (HTMLElement | null)[] = [
      s.runs === "loop" && o.tools.length === 0 ? null : h("li", null, `tools ${o.tools.length === 0 ? "none" : o.tools.join(", ")}`),
      o.model === null ? null : h("li", null, `model ${modelWords(o.model)}`),
      o.fast_model === null ? null : h("li", null, `fast model ${modelWords(o.fast_model)}`),
      o.max_turns === null ? null : h("li", null, `turn cap ${o.max_turns}`),
      h("li", null, `send-back cap ${o.send_back_cap}`),
    ];
    if (o.subloop !== null) {
      const sub = o.subloop;
      rows.push(h("li", { class: "subloop" }, "sub-loop ",
        h("button", { type: "button", class: "link-button", data: { action: "open-subloop" }, name: `Open the loop ${sub.loop}`, title: `Open the loop ${sub.loop}`, on: { click: () => nav.go({ screen: "loop", id: sub.loop }) } }, sub.loop),
        " ", hashChip(h, sub.hash),
        h("ul", { class: "mapping", role: "list" },
          Object.entries(sub.inputs).map(([k, v]) => h("li", null, `input ${k} ← ${v}`)),
          Object.entries(sub.returns).map(([k, v]) => h("li", null, `returns ${k} as ${v}`)))));
    }
    return rows.filter((r): r is HTMLElement => r !== null);
  };

  const stageRow = (l: LoopView, s: LoopStageView, n: number): HTMLElement => h("li", { data: { stage: s.id } },
    h("details", { class: "stage", data: { stage: s.id } },
      h("summary", null, h("span", { class: "stage-line" }, stageLine(l, s, n)), " ",
        s.inline ? h("span", { class: "chip source source-inline" }, "inline") : null, " ", hashChip(h, s.hash)),
      h("div", { class: "stage-body" },
        group("context", "Context", s.context.map(itemRow)),
        group("middleware", "Middleware", s.middleware.map(itemRow)),
        group("orchestration", "Orchestration", orchestration(s)))));

  const exportRow = h("div", { class: "export-row" });
  const paintExport = (): void => {
    if (loop === null) return;
    clear(exportRow);
    exportRow.append(
      h("button", { type: "button", data: { action: "export" }, disabled: exporting || !loop.usable, title: "Write this loop's file into the loop store", on: { click: () => void doExport() } }, "Export"),
      h("span", { class: "said", role: "status" }, exportSaid));
    if (exportFile !== null) exportRow.append(" ", loopFileLink(h, ui.api.loopFilePath(exportFile), "Download"));
    const line = refusalLine(h, exportWhy, `export:${id}`);
    if (line !== null) exportRow.appendChild(line);
  };
  const doExport = async (): Promise<void> => {
    if (exporting) return;
    exporting = true; exportWhy = undefined; exportSaid = ""; exportFile = null; paintExport();
    const r = await ui.api.exportLoop(id);
    exporting = false;
    if (destroyed) return;
    if ("refused" in r) exportWhy = r.refused.join("; ");
    else { exportSaid = `Exported to ${r.file} in the loop store`; exportFile = r.file; }
    paintExport();
    (exportRow.querySelector("[data-action=export]") as HTMLElement | null)?.focus();
  };

  const render = (): void => {
    clear(body);
    if (failed) { body.appendChild(h("p", { class: "load-error say", role: "alert" }, `The loop ${id} could not be loaded`)); return; }
    if (loop === null) return;
    const l = loop;
    const actions = h("div", { class: "loop-actions" }, exportRow,
      l.usable ? h("button", { type: "button", class: "primary", data: { action: "new-from-loop" }, on: { click: () => nav.go({ screen: "new", loop: l.id }) } }, "New case from this loop") : null,
      editButton?.(shell, l) ?? []);
    paintExport();
    body.appendChild(h("div", null,
      h("div", { class: "loop-head" },
        h("h1", null, l.title),
        h("p", { class: "facts" }, versionLine(h, l), " · ", h("span", { class: "caps" }, `depth cap ${l.caps.max_depth} · children cap ${l.caps.max_children}`),
          " · ", h("span", { class: "root" }, l.implicit ? "implicit loop" : `from ${l.root}${l.trusted ? "" : " (not trusted)"}`)),
        l.case_type === null ? null : h("p", { class: "case-type-line" }, `Case type: ${(ui.ref.case_types ?? []).find((t) => t.id === l.case_type)?.title ?? l.case_type}`),
        h("p", { class: "about" }, l.about)),
      actions,
      l.usable ? null : problemList(h, l.problems),
      l.stage_views.length === 0 ? null : h("ol", { class: "loop-stages", role: "list" }, l.stage_views.map((s, i) => stageRow(l, s, i + 1)))));
  };

  ui.api.loop(id).then((v) => { if (destroyed) return; loop = v; render(); }, () => { if (destroyed) return; failed = true; render(); });

  /** Build with help, about this loop. */
  const builder = builderPanel(shell, { loop: id });
  const el = h("main", { class: "top loop", data: { screen: "loop", loop: id }, tabindex: -1 }, body, builder.el);
  return { el, update() {}, focus() { el.focus(); }, destroy() { destroyed = true; builder.destroy(); } };
}
