import { canonical } from "../../core/canonical";
import { isObj } from "../../core/state/guards";
import type { Json } from "../../core/canonical";
import { GATES, SECTIONS, STAGE_RUNS } from "../../core/types";
import type { ModelChoice } from "../../core/types";
import type { ItemView, LoopStageView, LoopSummaryView, LoopView } from "../../core/wire";
import { clear } from "../dom";
import type { H } from "../dom";
import { refusalLine } from "../refusal";
import type { Screen, Shell } from "../app";
import { setEditButton } from "./loop";
import { hashChip, problemList, short, versionLine } from "./loops";

/**
 * Building a loop (slice 12): Copy on a loop's screen, and the edit screen, which is forms over the server's draft and nothing drawn as a graph.
 * Every title, about text, stage title and problem is the value of an input or a text node. Nothing is saved but by the person's Save, and every
 * save is the server's: it runs the check a save makes on a copy of the root, and the version the screen loaded must still be the current one.
 */

type Body = Record<string, Json>;
interface Draft { id: string; title: string; about: string; profile: string; entry: string; stages: Body[]; inputs: Json; outputs: Json; components: Record<string, Record<string, Json>>; uses: Json }

/** A copy's id: lower-case letters, digits and "-". */
const COPY_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A new stage's id. */
const STAGE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** What a sub-loop stage may hand its child, and the type of loop input each gives: the fixed list (slice 12's ruling). */
const SELECTORS: [string, string][] = [
  ["case.question", "question"], ["case.observables", "observables"], ["case.window", "window"], ["cards.kept", "cards"], ["findings.latest", "findings"], ["product.latest", "product"],
];
/** The kinds that are the profile's, for every stage: their source is set under "*". */
const SHARED_KINDS: readonly string[] = ["rules", "framework", "standard"];
const modelWords = (m: ModelChoice): string => `${m.provider} ${m.model} · effort ${m.effort ?? "default"}`;
const modelKey = (m: ModelChoice | null): string => (m === null ? "" : JSON.stringify([m.provider, m.model, m.effort ?? null]));
/** A JSON object of the draft. */
const isJsonObject = isObj as (x: unknown) => x is Record<string, Json>;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** The loop's draft from its view, or null when the view holds none that the forms can edit. */
function draftOf(view: LoopView): Draft | null {
  const d = view.draft;
  if (!isJsonObject(d) || !Array.isArray(d.stages) || !d.stages.every(isJsonObject)) return null;
  for (const k of ["id", "title", "about", "profile", "entry"]) if (typeof d[k] !== "string") return null;
  const out = clone(d) as unknown as Draft;
  if (!isJsonObject(out.components)) out.components = {};
  return out;
}

// ---------- Copy and Edit on a loop's screen ----------

/** Copy (an id and a title asked for, then the copy's edit screen) and, on a usable loop in a trusted root, Edit. */
function editButtons(shell: Shell, loop: LoopView): HTMLElement[] {
  const { ui, nav } = shell;
  const h = ui.h;
  if (!loop.usable) return [];
  const idBox = h("input", { type: "text", name: "Copy's id", placeholder: "lower-case letters, digits and -" }) as HTMLInputElement;
  const titleBox = h("input", { type: "text", name: "Copy's title", value: `${loop.title} (copy)` }) as HTMLInputElement;
  const problemAt = h("div", { class: "field-problem-at" });
  const refusalAt = h("div", { class: "refusal-at" });
  let busy = false;
  const make = h("button", { type: "button", class: "primary", data: { action: "make-copy" }, on: { click: () => void copy() } }, "Make the copy") as HTMLButtonElement;
  const say = (why: string | null): void => { clear(problemAt); if (why !== null) problemAt.appendChild(h("p", { class: "field-problem", role: "alert" }, why)); };
  const copy = async (): Promise<void> => {
    if (busy) return;
    const id = idBox.value.trim();
    const title = titleBox.value.trim();
    if (!COPY_ID.test(id)) { say("An id is lower-case letters, digits and -"); idBox.focus(); return; }
    if (title === "") { say("A copy needs a title"); titleBox.focus(); return; }
    say(null);
    busy = true; make.disabled = true; clear(refusalAt);
    const r = await ui.api.copyLoop(loop.id, { id, title });
    busy = false; make.disabled = false;
    if ("refused" in r) {
      const line = refusalLine(h, r.refused.join("; "), `copy:${loop.id}`);
      if (line !== null) refusalAt.appendChild(line);
      return;
    }
    ui.toast(`${loop.title} was copied as ${title}`);
    nav.go({ screen: "loop_edit", id: r.id });
  };
  const form = h("div", { class: "copy-form loop-form", hidden: true },
    h("div", { class: "row" }, h("label", null, "Id ", idBox), h("label", null, "Title ", titleBox), make,
      h("button", { type: "button", data: { action: "cancel-copy" }, on: { click: () => { form.hidden = true; say(null); } } }, "Cancel")),
    problemAt, refusalAt);
  const out: HTMLElement[] = [
    h("button", { type: "button", data: { action: "copy" }, title: "Copy this loop under a new id, every stage written into the copy", on: { click: () => { form.hidden = false; idBox.focus(); } } }, "Copy"),
  ];
  if (loop.trusted && loop.draft !== null) {
    out.push(h("button", { type: "button", data: { action: "edit" }, title: "Edit this loop in forms; a save makes its next version", on: { click: () => nav.go({ screen: "loop_edit", id: loop.id }) } }, "Edit"));
  }
  out.push(form);
  return out;
}
setEditButton(editButtons);

// ---------- the edit screen ----------

/** The forms over a loop's draft. Check and Save post it; Save carries the version the screen loaded. */
export function loopEditView(shell: Shell, id: string): Screen {
  const { ui } = shell;
  const h = ui.h;
  let view: LoopView | null = null;
  let draft: Draft | null = null;
  let failed = false;
  let destroyed = false;
  let version = 0;
  let baseline = "";
  let asked = false;
  let busy = false;
  let usable: LoopSummaryView[] = [];
  /** The loops a sub-loop stage may run, read once: their inputs and outputs. */
  const children = new Map<string, LoopView | "failed">();
  /** What the server last said of the draft: problems by stage, and the rest. */
  let byStage = new Map<string, string[]>();
  let general: string[] = [];
  /** What a removal did to another stage's edges, by stage. */
  const notes = new Map<string, string[]>();
  let saidText: (string | HTMLElement)[] = [];
  let saveWhy: string | undefined;

  const body = h("div", { class: "loop-edit-body" }, h("p", { class: "muted", role: "status" }, "Loading the loop…"));
  const stageList = h("ol", { class: "stage-list", role: "list" });
  /** The problems of the draft that name no stage of it. */
  const generalAt = h("ul", { class: "problems general", role: "list" });
  const said = h("span", { class: "said", role: "status" });
  const saveWhyAt = h("div", { class: "refusal-at" });
  const leaveAt = h("div", { class: "leave-at" });

  const dirty = (): boolean => draft !== null && canonical(draft as unknown as Json) !== baseline;
  const onBeforeUnload = (e: Event): void => { if (dirty()) e.preventDefault(); };
  ui.win.addEventListener("beforeunload", onBeforeUnload);
  const changed = (): void => { if (asked) { asked = false; clear(leaveAt); } };

  const stageView = (sid: string): LoopStageView | null => view?.stage_views.find((s) => s.id === sid) ?? null;
  const titleOf = (sid: string): string => {
    const st = draft?.stages.find((s) => s.id === sid);
    return typeof st?.title === "string" ? st.title : sid;
  };
  const stageAt = (sid: string): HTMLElement | null => (Array.from(stageList.children) as HTMLElement[]).find((el) => el.dataset.stage === sid) ?? null;
  const fixEntry = (): void => { if (draft !== null && draft.stages.length > 0) draft.entry = String(draft.stages[0]!.id); };

  // ---- one stage

  const select = (h: H, props: Parameters<H>[1], options: [string, string][], value: string): HTMLSelectElement => {
    const el = h("select", props, options.map(([v, label]) => h("option", { value: v }, label))) as HTMLSelectElement;
    el.value = value;
    return el;
  };
  const row = (label: string, control: HTMLElement): HTMLElement => h("label", { class: "row" }, h("span", { class: "label" }, label), control);

  const edgeOptions = (): [string, string][] => [["", "none"], ...(draft?.stages ?? []).map((s): [string, string] => [String(s.id), titleOf(String(s.id))])];

  const componentRows = (stageKey: string, items: ItemView[]): HTMLElement | null => {
    if (draft === null || items.length === 0) return null;
    const d = draft;
    const rows = items.map((i) => {
      const key = `${i.kind}:${i.id}`;
      const given = d.components[stageKey]?.[key];
      const pinned = isJsonObject(given) && typeof given.pinned === "string" ? given.pinned : null;
      const other = given !== undefined && given !== "root" && pinned === null;      // a loop output or a memory source: kept as it is
      const box = h("input", { type: "text", data: { field: "pinned" }, name: `Pinned hash of ${key}`, placeholder: "the 64 hex of the version to pin", value: pinned ?? "", hidden: pinned === null }) as HTMLInputElement;
      const problemAt = h("span", { class: "field-problem-at" });
      const set = (spec: Json | null): void => {
        const at = d.components[stageKey] ?? {};
        if (spec === null) delete at[key]; else at[key] = spec;
        if (Object.keys(at).length === 0) delete d.components[stageKey]; else d.components[stageKey] = at;
        changed();
      };
      const source = select(h, { data: { field: "source" }, name: `Source of ${key}` },
        [["root", "root"], ["pinned", "pinned"], ...(other ? [["as-is", "as the loop has it"] as [string, string]] : [])], pinned !== null ? "pinned" : other ? "as-is" : "root");
      const typed = (): void => {
        clear(problemAt);
        const v = box.value.trim();
        if (HEX64.test(v)) { set({ pinned: v }); return; }
        set(null);
        if (v !== "") problemAt.appendChild(h("span", { class: "field-problem", role: "alert" }, "A pinned hash is 64 lower-case hex characters"));
      };
      source.addEventListener("change", () => {
        clear(problemAt);
        if (source.value === "pinned") { box.hidden = false; typed(); box.focus(); return; }
        box.hidden = true;
        if (source.value === "root") set(null);
      });
      box.addEventListener("input", typed);
      return h("tr", { data: { component: key } },
        h("td", null, `${i.kind} ${i.title}`), h("td", null, source, " ", box, problemAt), h("td", { class: "now" }, "now ", hashChip(h, i.hash)));
    });
    return h("table", { class: "components" }, h("thead", null, h("tr", null, h("th", null, "Component"), h("th", null, "Source"), h("th", null, "Resolves to"))), h("tbody", null, rows));
  };
  const componentsOf = (sv: LoopStageView): ItemView[] => [...sv.context, ...sv.middleware].filter((i) => i.hash !== null && i.source !== "built-in" && i.kind !== "goal" && !SHARED_KINDS.includes(i.kind));

  const subloopFields = (st: Body, sid: string): HTMLElement[] => {
    const which = typeof st.loop === "string" ? st.loop : "";
    const loopSelect = select(h, { data: { field: "loop" }, name: `Loop ${sid} runs` },
      [["", "choose a loop"], ...usable.filter((l) => l.id !== id).map((l): [string, string] => [l.id, l.title])], which);
    loopSelect.addEventListener("change", () => {
      st.loop = loopSelect.value;
      st.inputs = {};
      st.returns = {};
      changed();
      const child = children.get(loopSelect.value);
      if (child === undefined || child === "failed") void readChild(loopSelect.value, true);
      else { defaults(st, child); paintStages(); }
    });
    const out: HTMLElement[] = [row("Runs the loop", loopSelect)];
    const child = which === "" ? undefined : children.get(which);
    if (which !== "" && child === undefined) { void readChild(which, false); out.push(h("p", { class: "muted" }, "Reading that loop's inputs and outputs…")); return out; }
    if (child === "failed") { out.push(h("p", { class: "muted" }, `The loop ${which} could not be read`)); return out; }
    if (child === undefined) return out;
    const inputs = isJsonObject(st.inputs) ? st.inputs : (st.inputs = {});
    const returns = isJsonObject(st.returns) ? st.returns : (st.returns = {});
    const inRows = Object.entries(child.inputs).map(([name, spec]) => {
      const options: [string, string][] = [...(spec.required ? [] : [["", "none"] as [string, string]]), ...SELECTORS.filter(([, t]) => t === spec.type).map(([sel]): [string, string] => [sel, sel])];
      const current = typeof inputs[name] === "string" ? (inputs[name] as string) : "";
      const el = select(h, { data: { input: name }, name: `Input ${name} of ${sid}` }, options, current);
      el.addEventListener("change", () => { if (el.value === "") delete inputs[name]; else inputs[name] = el.value; changed(); });
      return row(`input ${name} (${spec.type}${spec.required ? ", required" : ""}) ←`, el);
    });
    const outRows = Object.entries(child.outputs).map(([name, spec]) => {
      const sections = spec.from === "product" || spec.from === "findings" ? SECTIONS.map((sec): [string, string] => [`draft_section:${sec}`, `as the draft's ${sec.replace(/_/g, " ")} section`]) : [];
      const r = returns[name];
      const current = isJsonObject(r) ? (r.as === "cards" ? "cards" : r.as === "draft_section" ? `draft_section:${String(r.section)}` : "") : "";
      const el = select(h, { data: { output: name }, name: `How ${name} returns to ${sid}` }, [["", "not returned"], ["cards", "as note cards"], ...sections], current);
      el.addEventListener("change", () => {
        if (el.value === "") delete returns[name];
        else if (el.value === "cards") returns[name] = { as: "cards" };
        else returns[name] = { as: "draft_section", section: el.value.slice("draft_section:".length) };
        changed();
      });
      return row(`output ${name} (${spec.from}) →`, el);
    });
    out.push(h("fieldset", { class: "mapping" }, h("legend", null, "What the child is given"), inRows.length === 0 ? h("p", { class: "muted" }, "That loop takes no inputs") : inRows));
    out.push(h("fieldset", { class: "mapping" }, h("legend", null, "What comes back"), outRows.length === 0 ? h("p", { class: "muted" }, "That loop has no outputs") : outRows));
    return out;
  };
  /** A child's required inputs, each from the first selector of its type. */
  const defaults = (st: Body, child: LoopView): void => {
    const inputs: Body = {};
    for (const [name, spec] of Object.entries(child.inputs)) {
      if (!spec.required) continue;
      const sel = SELECTORS.find(([, t]) => t === spec.type);
      if (sel !== undefined) inputs[name] = sel[0];
    }
    st.inputs = inputs;
  };
  const readChild = async (loop: string, fill: boolean): Promise<void> => {
    if (children.has(loop)) return;
    try {
      const v = await ui.api.loop(loop);
      children.set(loop, v);
      if (fill && draft !== null) for (const st of draft.stages) if (st.runs === "loop" && st.loop === loop && isJsonObject(st.inputs) && Object.keys(st.inputs).length === 0) defaults(st, v);
    } catch {
      children.set(loop, "failed");
    }
    if (!destroyed) paintStages();
  };

  const stageEl = (st: Body, n: number, count: number): HTMLElement => {
    const sid = String(st.id);
    const name = h("span", { class: "stage-name" }, `${n}. ${typeof st.title === "string" ? st.title : sid}`);
    const move = (by: number): void => {
      if (draft === null) return;
      const at = draft.stages.indexOf(st);
      const to = at + by;
      if (at < 0 || to < 0 || to >= draft.stages.length) return;
      draft.stages.splice(at, 1);
      draft.stages.splice(to, 0, st);
      fixEntry(); changed(); paintStages();
      stageAt(sid)?.querySelector<HTMLElement>(`[data-action=${by < 0 ? "move-up" : "move-down"}]`)?.focus();
    };
    const remove = (): void => {
      if (draft === null || draft.stages.length <= 1) return;
      draft.stages = draft.stages.filter((x) => x !== st);
      const title = typeof st.title === "string" ? st.title : sid;
      for (const other of draft.stages) {
        for (const [edge, words] of [["on_pass", "on pass"], ["on_fail", "on fail"]] as const) {
          if (other[edge] !== sid) continue;
          other[edge] = null;
          const oid = String(other.id);
          notes.set(oid, [...(notes.get(oid) ?? []), `${words} named ${title}, which was removed: it is none now`]);
        }
      }
      delete draft.components[sid];
      notes.delete(sid); byStage.delete(sid);
      fixEntry(); changed(); paintStages();
    };
    const head = h("div", { class: "stage-head row" }, name,
      st.runs === "loop" ? h("span", { class: "chip" }, "sub-loop") : null,
      h("button", { type: "button", data: { action: "move-up" }, name: `Move ${sid} up`, disabled: n === 1, on: { click: () => move(-1) } }, "Move up"),
      h("button", { type: "button", data: { action: "move-down" }, name: `Move ${sid} down`, disabled: n === count, on: { click: () => move(1) } }, "Move down"),
      h("button", { type: "button", data: { action: "remove" }, name: `Remove ${sid}`, disabled: count === 1, on: { click: remove } }, "Remove"));

    const titleBox = h("input", { type: "text", data: { field: "title" }, name: `Title of ${sid}`, value: typeof st.title === "string" ? st.title : "" }) as HTMLInputElement;
    titleBox.addEventListener("input", () => { st.title = titleBox.value; name.textContent = `${n}. ${titleBox.value}`; changed(); });
    // the adopt gate is an adopt stage's alone (slice 14), so no other stage is offered it
    const gates = GATES.filter((g) => g !== "adopt" || st.role === "adopt");
    const gate = select(h, { data: { field: "gate" }, name: `Gate of ${sid}` }, [["", "none"], ...gates.map((g): [string, string] => [g, g])], typeof st.gate === "string" ? st.gate : "");
    gate.addEventListener("change", () => { st.gate = gate.value === "" ? null : gate.value; changed(); });
    const reviews = h("input", { type: "checkbox", data: { field: "reviews" }, name: `${sid} reviews`, checked: st.reviews === true }) as HTMLInputElement;
    reviews.addEventListener("change", () => { st.reviews = reviews.checked; changed(); });
    reviews.addEventListener("click", () => { if (st.reviews !== reviews.checked) { st.reviews = reviews.checked; changed(); } });
    const edge = (key: "on_pass" | "on_fail", words: string): HTMLElement => {
      const el = select(h, { data: { field: key }, name: `${words} of ${sid}` }, edgeOptions(), typeof st[key] === "string" ? (st[key] as string) : "");
      el.addEventListener("change", () => { st[key] = el.value === "" ? null : el.value; changed(); });
      return row(words, el);
    };
    const fields: (HTMLElement | null)[] = [row("Title", titleBox)];
    if (st.runs !== "loop") {
      const runs = select(h, { data: { field: "runs" }, name: `How ${sid} runs` }, STAGE_RUNS.filter((r) => r !== "loop").map((r): [string, string] => [r, r]), String(st.runs));
      runs.addEventListener("change", () => { st.runs = runs.value; changed(); });
      fields.push(row("Runs", runs));
    } else fields.push(h("p", { class: "row" }, "Runs a loop as a child case"));
    fields.push(row("Gate", gate), row("Reviews", reviews), edge("on_pass", "on pass"), edge("on_fail", "on fail"));

    if (st.runs === "loop") fields.push(...subloopFields(st, sid));
    else {
      const tools = Array.isArray(st.tools) ? (st.tools as Json[]).filter((t): t is string => typeof t === "string") : [];
      const boxes = ui.ref.stage_tools.map((t) => {
        const box = h("input", { type: "checkbox", data: { tool: t }, name: `${sid} may use ${t}`, checked: tools.includes(t) }) as HTMLInputElement;
        const toggle = (): void => {
          const now = Array.isArray(st.tools) ? (st.tools as Json[]).filter((x): x is string => typeof x === "string") : [];
          const listed = now.includes(t);
          if (box.checked === listed) return;
          st.tools = box.checked ? [...now, t] : now.filter((x) => x !== t);
          changed();
        };
        box.addEventListener("change", toggle);
        box.addEventListener("click", toggle);
        return h("label", { class: "tool" }, box, ` ${t}`);
      });
      fields.push(h("fieldset", { class: "tools" }, h("legend", null, "Tools"), boxes));
      const current = isJsonObject(st.model) ? { provider: String(st.model.provider), model: String(st.model.model), effort: typeof st.model.effort === "string" ? st.model.effort : null } : null;
      const choices: (ModelChoice | null)[] = [...ui.ref.stage_models];
      if (current !== null && !choices.some((m) => modelKey(m) === modelKey(current))) choices.unshift(current);
      if (current === null) choices.unshift(null);
      const model = select(h, { data: { field: "model" }, name: `Model of ${sid}` }, choices.map((m): [string, string] => [modelKey(m), m === null ? "none" : modelWords(m)]), modelKey(current));
      model.addEventListener("change", () => {
        const m = choices.find((c) => modelKey(c) === model.value) ?? null;
        st.model = m === null ? null : { provider: m.provider, model: m.model, effort: m.effort };
        changed();
      });
      fields.push(row("Model", model));
      const turnsProblem = h("span", { class: "field-problem-at" });
      const turns = h("input", { type: "number", data: { field: "max_turns" }, name: `Turn cap of ${sid}`, placeholder: "the loop's", value: typeof st.max_turns === "number" ? String(st.max_turns) : "" }) as HTMLInputElement;
      turns.addEventListener("input", () => {
        clear(turnsProblem);
        const v = turns.value.trim();
        if (v === "") { delete st.max_turns; changed(); return; }
        const n = Number(v);
        if (Number.isInteger(n) && n >= 1) { st.max_turns = n; changed(); return; }
        turnsProblem.appendChild(h("span", { class: "field-problem", role: "alert" }, "A turn cap is a whole number, 1 or more"));
      });
      fields.push(h("div", { class: "row" }, row("max_turns", turns), turnsProblem));
    }
    const sv = stageView(sid);
    const table = sv === null ? null : componentRows(sid, componentsOf(sv));
    return h("li", { class: "stage-edit", data: { stage: sid } },
      head,
      (notes.get(sid) ?? []).map((t) => h("p", { class: "edge-note", role: "status" }, t)),
      (byStage.get(sid) ?? []).length === 0 ? null : problemList(h, byStage.get(sid)!),
      fields,
      h("div", { class: "stage-components" }, h("h3", null, "Components"),
        sv === null ? h("p", { class: "muted" }, "Its components are listed once the loop is saved.")
          : table ?? h("p", { class: "muted" }, "It has no components of its own")));
  };

  const paintStages = (): void => {
    if (draft === null) return;
    const keep = ui.doc.activeElement;
    const label = keep !== null && stageList.contains(keep) ? keep.getAttribute("aria-label") : null;
    clear(stageList);
    const count = draft.stages.length;
    draft.stages.forEach((st, i) => stageList.appendChild(stageEl(st, i + 1, count)));
    if (label !== null) {
      for (const el of Array.from(stageList.querySelectorAll("[aria-label]")) as HTMLElement[]) if (el.getAttribute("aria-label") === label) { el.focus(); break; }
    }
  };
  const paintGeneral = (): void => {
    clear(generalAt);
    for (const p of general) generalAt.appendChild(h("li", null, p));
  };

  /** Each problem beside the stage it starts with (after a `loop "<id>": ` prefix), else in the general list. */
  const place = (problems: readonly string[]): void => {
    byStage = new Map();
    general = [];
    const ids = new Set((draft?.stages ?? []).map((s) => String(s.id)));
    for (const p of problems) {
      const t = p.replace(/^loop "[^"]*": /, "");
      const m = /^stage "([^"]+)"/.exec(t) ?? /^components\.([^:."\s]+)[:.]/.exec(t);
      const sid = m === null ? null : m[1]!;
      if (sid !== null && ids.has(sid)) byStage.set(sid, [...(byStage.get(sid) ?? []), p]);
      else general.push(p);
    }
    paintStages();
    paintGeneral();
  };
  const setSaid = (parts: (string | HTMLElement)[]): void => { saidText = parts; clear(said); said.append(...saidText); };
  const paintSaveWhy = (): void => {
    clear(saveWhyAt);
    const line = refusalLine(h, saveWhy, `save:${id}`);
    if (line !== null) saveWhyAt.appendChild(line);
  };

  const doCheck = async (): Promise<void> => {
    if (draft === null || busy) return;
    busy = true; setSaid(["Checking…"]); saveWhy = undefined; paintSaveWhy();
    const r = await ui.api.checkLoop(id, clone(draft));
    busy = false;
    if (destroyed) return;
    place(r.problems);
    setSaid([r.ok ? "No problems: this draft would save" : `${r.problems.length} ${r.problems.length === 1 ? "problem" : "problems"}: see beside each stage`]);
  };
  const doSave = async (): Promise<void> => {
    if (draft === null || busy) return;
    busy = true; setSaid(["Saving…"]); saveWhy = undefined; paintSaveWhy();
    const sent = clone(draft);
    const r = await ui.api.saveLoop(id, sent, version);
    busy = false;
    if (destroyed) return;
    if ("refused" in r) {
      setSaid([]);
      saveWhy = r.refused.join("; ");
      paintSaveWhy();
      place(r.refused);
      return;
    }
    version = r.version;
    baseline = canonical(sent as unknown as Json);
    asked = false; clear(leaveAt);
    notes.clear();
    place([]);
    setSaid([`Saved as version ${r.version} · `, h("span", { class: "hash", title: r.hash }, short(r.hash))]);
  };

  const render = (): void => {
    clear(body);
    if (failed || view === null) {
      if (failed) body.appendChild(h("p", { class: "load-error say", role: "alert" }, `The loop ${id} could not be loaded`));
      return;
    }
    const v = view;
    const head = h("div", { class: "loop-head" }, h("h1", null, `Edit ${v.title}`), h("p", { class: "facts" }, versionLine(h, v), " · ", h("span", { class: "root" }, v.implicit ? "implicit loop" : `from ${v.root}`)));
    if (!v.usable || draft === null) {
      body.append(head, h("p", { class: "say", role: "status" }, "This loop is not usable, so it cannot be edited here."), problemList(h, v.problems));
      return;
    }
    if (!v.trusted) {
      body.append(head, h("p", { class: "say", role: "status" }, "This loop is not in a trusted root, so it cannot be edited here; copy it to make one that can be."));
      return;
    }
    const d = draft;
    const title = h("input", { type: "text", name: "Loop title", value: d.title }) as HTMLInputElement;
    title.addEventListener("input", () => { d.title = title.value; changed(); });
    const about = h("textarea", { name: "About", value: d.about }) as HTMLTextAreaElement;
    about.value = d.about;
    about.addEventListener("input", () => { d.about = about.value; changed(); });

    // a new stage: a copy of one of this loop's under a new id, or a sub-loop stage
    const addKind = h("select", { data: { field: "add-kind" }, name: "Kind of stage to add" }) as HTMLSelectElement;
    const fillKinds = (): void => {
      clear(addKind);
      for (const st of d.stages) addKind.appendChild(h("option", { value: `copy:${String(st.id)}` }, `a copy of ${titleOf(String(st.id))}`));
      addKind.appendChild(h("option", { value: "subloop" }, "a sub-loop stage"));
    };
    fillKinds();
    addKind.addEventListener("focus", () => { const v2 = addKind.value; fillKinds(); addKind.value = v2; });
    const addId = h("input", { type: "text", data: { field: "add-id" }, name: "New stage's id", placeholder: "lower-case letters, digits, _ and -" }) as HTMLInputElement;
    const addProblem = h("div", { class: "field-problem-at" });
    const add = (): void => {
      clear(addProblem);
      const sid = addId.value.trim();
      if (!STAGE_ID.test(sid) || d.stages.some((s) => s.id === sid)) {
        addProblem.appendChild(h("p", { class: "field-problem", role: "alert" }, "A stage id is lower-case letters, digits, _ and -, and not one this loop has"));
        addId.focus();
        return;
      }
      const order = Math.max(0, ...d.stages.map((s) => (typeof s.order === "number" ? s.order : 0))) + 1;
      let made: Body;
      if (addKind.value === "subloop") {
        made = { id: sid, title: sid, order, phase: null, runs: "loop", role: "subloop", gate: null, reviews: false, tools: [], schema: null, model: null, on_pass: null, on_fail: null, loop: "", inputs: {}, returns: {} };
      } else {
        const from = d.stages.find((s) => `copy:${String(s.id)}` === addKind.value);
        if (from === undefined) return;
        made = { ...clone(from), id: sid, order };
      }
      d.stages.push(made);
      addId.value = "";
      fillKinds();
      changed(); paintStages();
      stageAt(sid)?.querySelector<HTMLElement>("[data-field]")?.focus();
    };
    const addRow = h("div", { class: "add-stage row" }, h("label", null, "Add ", addKind), h("label", null, "as ", addId),
      h("button", { type: "button", data: { action: "add-stage" }, on: { click: add } }, "Add stage"), addProblem);

    // the components that are the profile's, for every stage
    const shared = new Map<string, ItemView>();
    for (const sv of v.stage_views) for (const i of sv.context) if (SHARED_KINDS.includes(i.kind) && i.hash !== null) shared.set(`${i.kind}:${i.id}`, i);
    const sharedTable = componentRows("*", [...shared.values()]);

    paintStages();
    paintGeneral();
    body.append(head,
      h("div", { class: "loop-form" },
        h("div", { class: "row" }, h("label", null, "Title ", title)),
        h("div", { class: "row" }, h("label", null, "About ", about)),
        h("h2", null, "Stages"), stageList, addRow,
        sharedTable === null ? null : h("section", { class: "every-stage" }, h("h2", null, "Components of every stage"), sharedTable),
        generalAt,
        h("div", { class: "row save-row" },
          h("button", { type: "button", data: { action: "check" }, title: "Ask the server what a save of this draft would find; nothing is written", on: { click: () => void doCheck() } }, "Check"),
          h("button", { type: "button", class: "primary", data: { action: "save" }, title: "Save this draft as the loop's next version", on: { click: () => void doSave() } }, "Save"),
          said, saveWhyAt),
        leaveAt));
  };

  Promise.all([ui.api.loop(id), ui.api.loops().catch(() => [] as LoopSummaryView[])]).then(([v, list]) => {
    if (destroyed) return;
    view = v;
    usable = list.filter((l) => l.usable);
    draft = draftOf(v);
    version = v.version ?? 0;
    baseline = draft === null ? "" : canonical(draft as unknown as Json);
    render();
  }, () => { if (destroyed) return; failed = true; render(); });

  const el = h("main", { class: "top loop-edit", data: { screen: "loop_edit", loop: id }, tabindex: -1 }, body);
  return {
    el, update() {}, focus() { el.focus(); },
    leave() {
      if (!dirty() || asked) return true;
      asked = true;
      clear(leaveAt);
      leaveAt.appendChild(h("p", { class: "leave-ask say", role: "alert" }, "This loop has changes that are not saved. Go there again to leave them, or Save first."));
      return false;
    },
    destroy() { destroyed = true; ui.win.removeEventListener("beforeunload", onBeforeUnload); },
  };
}
