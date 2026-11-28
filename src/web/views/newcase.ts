import type { Marking } from "../../core/types";
import { clear } from "../dom";
import type { Screen, Shell } from "../app";

const DAY = 86_400_000;

/** Seven days ago at midnight UTC, and the coming midnight UTC. */
export function defaultWindow(now: Date): { from: string; to: string } {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return { from: new Date(midnight - 7 * DAY).toISOString(), to: new Date(midnight + DAY).toISOString() };
}

interface Row { sel: HTMLSelectElement; inp: HTMLInputElement }

/** The new-case form; `loop` (from "New case from this loop") is posted with the case, and the server makes the case for that loop. */
export function newView(shell: Shell, loop?: string): Screen {
  const { ui, nav } = shell;
  const h = ui.h;
  const field = (id: string, label: string, control: HTMLElement): HTMLElement => h("div", { class: "field" }, h("label", { for: id }, label), control);
  const win = defaultWindow(new Date());

  const title = h("input", { type: "text", id: "nc-title", name: "Title" }) as HTMLInputElement;
  const asked = h("textarea", { id: "nc-asked", name: "What was asked" }) as HTMLTextAreaElement;
  const why = h("textarea", { id: "nc-why", name: "Why" }) as HTMLTextAreaElement;
  const from = h("input", { type: "text", id: "nc-from", name: "Window from", value: win.from }) as HTMLInputElement;
  const to = h("input", { type: "text", id: "nc-to", name: "Window to", value: win.to }) as HTMLInputElement;
  const objective = h("select", { id: "nc-objective", name: "Objective" }, h("option", { value: "" }, "None"), ui.ref.objectives.map((o) => h("option", { value: o.id }, o.title))) as HTMLSelectElement;
  const marking = h("select", { id: "nc-marking", name: "Marking" }, ui.me.markings.map((m) => h("option", { value: m }, m))) as HTMLSelectElement;
  marking.value = ui.me.markings.includes("TLP:AMBER") ? "TLP:AMBER" : (ui.me.markings[0] ?? "");
  // the case's type (slice 13): None, or a loaded case type; preset to the loop's own once the server says it, unless the person chose first
  const caseType = h("select", { id: "nc-type", name: "Case type" }, h("option", { value: "" }, "None"), (ui.ref.case_types ?? []).map((t) => h("option", { value: t.id }, t.title))) as HTMLSelectElement;
  let typeChosen = false;
  caseType.addEventListener("change", () => { typeChosen = true; paintTypeNote(); });
  /** Said under the select when the loop has a case type of its own and None is chosen: the server gives such a case the loop's. */
  const typeNote = h("p", { class: "muted type-note" });
  let loopType: string | null = null;
  const paintTypeNote = (): void => {
    const title = loopType === null ? null : ((ui.ref.case_types ?? []).find((t) => t.id === loopType)?.title ?? loopType);
    typeNote.textContent = title !== null && caseType.value === "" ? `A case of this loop that names no type takes the loop's: ${title}.` : "";
  };

  let rows: Row[] = [];
  const list = h("div", { class: "rows" });
  const makeRow = (n: number, type: string, value: string): Row => {
    const sel = h("select", { name: `Starting type ${n}` }, ui.ref.types.map((t) => h("option", { value: t.id }, t.title))) as HTMLSelectElement;
    if (type !== "") sel.value = type;
    const inp = h("input", { type: "text", name: `Starting value ${n}`, value }) as HTMLInputElement;
    return { sel, inp };
  };
  const drawRows = (keep: { type: string; value: string }[], focusLast: boolean): void => {
    rows = keep.map((k, i) => makeRow(i + 1, k.type, k.value));
    clear(list);
    rows.forEach((r, i) => {
      const remove = h("button", { type: "button", name: `Remove value ${i + 1}`, title: `Remove value ${i + 1}`, disabled: rows.length === 1, on: { click: () => {
        const rest = current().filter((_, j) => j !== i);
        drawRows(rest, false);
      } } }, "Remove");
      list.appendChild(h("div", { class: "row" }, r.sel, r.inp, remove));
    });
    if (focusLast) rows[rows.length - 1]?.inp.focus();
  };
  const current = (): { type: string; value: string }[] => rows.map((r) => ({ type: r.sel.value, value: r.inp.value }));
  drawRows([{ type: "", value: "" }], false);
  const add = h("button", { type: "button", name: "Add a value", on: { click: () => drawRows([...current(), { type: "", value: "" }], true) } }, "+ Add a value");

  const refusals = h("ul", { class: "refusals", role: "alert" });
  let busy = false;
  const submit = h("button", { type: "button", class: "primary", on: { click: () => void create() } }, "Create and frame the run");
  const create = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    (submit as HTMLButtonElement).disabled = true;
    clear(refusals);
    let created = false;
    try {
      const made = await ui.api.newCase({
        title: title.value.trim(), asked: asked.value.trim(), why: why.value.trim(),
        starting: current().map((r) => ({ type: r.type, value: r.value.trim() })),
        window: { from: from.value.trim(), to: to.value.trim() },
        objective: objective.value === "" ? null : objective.value,
        marking: marking.value as Marking,
        ...(loop === undefined ? {} : { loop }),
        ...(caseType.value === "" ? {} : { type: caseType.value }),
      });
      if ("refused" in made) {
        for (const reason of made.refused) refusals.appendChild(h("li", null, reason));
        return;
      }
      // From here the case exists: whatever goes wrong next, the person goes to the case and is told, never back to a form that would make a second one.
      created = true;
      nav.go({ screen: "case", id: made.id });
      let reason = "";
      try { if (!(await ui.act("start_run"))) reason = "see the message shown"; } catch (err) { reason = err instanceof Error ? err.message : String(err); }
      if (reason !== "") ui.toast(`The case was created; the run did not start: ${reason}`);
    } catch (err) {
      if (created) return;
      refusals.appendChild(h("li", null, `The case could not be created: ${err instanceof Error ? err.message : String(err)}`));
    } finally {
      busy = false;
      (submit as HTMLButtonElement).disabled = false;
    }
  };

  // the loop's title once the server says it; its id until then
  const loopLine = loop === undefined ? null : h("p", { class: "loop-line" }, `Loop: ${loop}`);
  let destroyed = false;
  if (loop !== undefined && loopLine !== null) {
    ui.api.loops().then((list) => {
      const found = list.find((l) => l.id === loop);
      if (destroyed || found === undefined) return;
      loopLine.textContent = `Loop: ${found.title}`;
      loopType = found.case_type;
      if (!typeChosen && loopType !== null && [...caseType.options].some((o) => o.value === loopType)) caseType.value = loopType;
      paintTypeNote();
    }, () => {});
  }
  const el = h("main", { class: "top", data: { screen: "new" }, tabindex: -1 },
    h("h1", null, loop === undefined ? "New investigation" : "New case from a loop"),
    loopLine,
    h("div", { class: "form" },
      field("nc-title", "Title", title), field("nc-asked", "What was asked", asked), field("nc-why", "Why", why),
      h("fieldset", null, h("legend", null, "Starting values"), list, add),
      field("nc-from", "Window from", from), field("nc-to", "Window to", to),
      field("nc-objective", "Objective", objective), field("nc-marking", "Marking", marking),
      field("nc-type", "Case type", caseType), typeNote,
      refusals, submit));
  // Escape from a button keeps a form that holds anything; it only steps up when the form is empty.
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const filled = [title, asked, why].some((f) => f.value.trim() !== "") || current().some((r) => r.value.trim() !== "");
    if (filled) e.stopPropagation();
  });
  return { el, update() {}, focus() { title.focus(); }, destroy() { destroyed = true; } };
}
