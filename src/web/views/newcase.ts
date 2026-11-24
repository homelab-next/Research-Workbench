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

export function newView(shell: Shell): Screen {
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
    try {
      const made = await ui.api.newCase({
        title: title.value.trim(), asked: asked.value.trim(), why: why.value.trim(),
        starting: current().map((r) => ({ type: r.type, value: r.value.trim() })),
        window: { from: from.value.trim(), to: to.value.trim() },
        objective: objective.value === "" ? null : objective.value,
        marking: marking.value as Marking,
      });
      if ("refused" in made) {
        for (const reason of made.refused) refusals.appendChild(h("li", null, reason));
        return;
      }
      // open the case first: ui.act sends for the case on screen, and says in a toast why a refusal happened
      nav.go({ screen: "case", id: made.id });
      await ui.act("start_run");
    } catch (err) {
      refusals.appendChild(h("li", null, `The case could not be created: ${err instanceof Error ? err.message : String(err)}`));
    } finally {
      busy = false;
      (submit as HTMLButtonElement).disabled = false;
    }
  };

  const el = h("main", { class: "top", data: { screen: "new" }, tabindex: -1 },
    h("h1", null, "New investigation"),
    h("div", { class: "form" },
      field("nc-title", "Title", title), field("nc-asked", "What was asked", asked), field("nc-why", "Why", why),
      h("fieldset", null, h("legend", null, "Starting values"), list, add),
      field("nc-from", "Window from", from), field("nc-to", "Window to", to),
      field("nc-objective", "Objective", objective), field("nc-marking", "Marking", marking),
      refusals, submit));
  return { el, update() {}, focus() { title.focus(); } };
}
