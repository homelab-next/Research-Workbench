import { latestDraft } from "../../core/state";
import type { CaseState, StageState } from "../../core/state";
import type { Custody } from "../../core/wire";
import type { Child } from "../dom";
import { clear } from "../dom";
import type { LensId, Open } from "../app";
import { markingChip } from "../chips";
import { goals, nextThing, runButton, stageMark } from "../derive";
import type { StageMark } from "../derive";
import { shortLocal } from "../time";
import type { Ui, View } from "../ui";
import { AT_GATE } from "../ui";

const PLAN_WORDS = { none: "no plan", proposed: "plan proposed", accepted: "plan accepted", denied: "plan denied", replanning: "re-planning" } as const;
const SIGN: Record<StageMark, string> = {
  passed: "✓ passed", "passed earlier draft": "✓ earlier draft", running: "● running", failed: "✗ failed", waiting: "◌ waiting", declined: "declined", blocked: "blocked", idle: "idle",
};

/** Re-runs `build` into `el` only when `sig` differs from the last call by value identity. */
function slot(el: HTMLElement): (sig: unknown[], build: () => Child[]) => void {
  let last: unknown[] | null = null;
  return (sig, build) => {
    if (last !== null && sig.length === last.length && sig.every((x, i) => x === last![i])) return;
    last = sig;
    clear(el);
    for (const c of build()) if (c !== null && c !== undefined && c !== false && typeof c === "object" && !Array.isArray(c)) el.appendChild(c as Node);
  };
}

/** The brief (spec §10.2): the case and its marking, what was asked, the status buttons, the phase strip, and the custody chip. */
export function makeBrief(ui: Ui, open: Open): View {
  const { h } = ui;
  const { store, nav } = open;
  const lens = (id: LensId, arg?: string): void => nav.openLens(id, arg);

  // ---------- custody ----------
  let custody: { report: Custody; at: string } | "failed" | null = null;
  let asked = 0;
  const checkCustody = (): void => {
    if (store.at !== null) return;                       // a past screen never fetches today's check
    const mine = ++asked;
    ui.api.custody(store.id).then((report) => {
      if (mine !== asked) return;
      custody = { report, at: new Date().toISOString() };
      render();
    }).catch(() => {
      if (mine !== asked) return;
      custody = "failed";
      render();
    });
  };
  const chip = (): HTMLElement => {
    if (store.at !== null) return h("span", { class: "tag tag-human custody muted", title: "The custody check is of the live record, not of this entry" }, "custody: checked on the live record");
    const onClick = { click: checkCustody };
    if (custody === null) return h("button", { type: "button", class: "tag tag-human custody", name: "Custody check", title: "Checking the record", on: onClick }, "checking custody…");
    if (custody === "failed") return h("button", { type: "button", class: "tag tag-attention custody", name: "Custody check", title: "The check could not be made; activate to try again", on: onClick }, "custody not checked");
    const { report, at } = custody;
    return h("button", {
      type: "button", class: `tag ${report.ok ? "tag-done" : "tag-attention"} custody`, name: `Custody check: ${report.line}`,
      title: `head ${report.head} · checked ${shortLocal(at, new Date())}`, on: onClick,
    }, report.line);
  };

  // ---------- the pieces ----------
  const line1 = h("div", { class: "brief-line brief-title" });
  const line2 = h("div", { class: "brief-line brief-status" });
  const strip = h("div", { class: "phase-strip" });
  const notes = h("div", { class: "brief-line brief-notes" });
  const el = h("section", { class: "brief", name: "Brief" }, line1, line2, notes, strip);
  const into1 = slot(line1);
  const into2 = slot(line2);
  const intoStrip = slot(strip);
  const intoNotes = slot(notes);

  let stopping = false;
  const stopInput = h("input", {
    type: "text", class: "stop-reason", name: "Reason for stopping", placeholder: "Why stop?",
    on: { keydown: (e) => {
      const k = e as KeyboardEvent;
      const box = k.target as HTMLInputElement;
      if (k.key === "Escape") { k.stopPropagation(); stopping = false; box.value = ""; render(); }
      else if (k.key === "Enter" && box.value.trim() !== "") { const reason = box.value.trim(); void ui.act("stop", { reason }).then((ok) => { if (ok) { stopping = false; box.value = ""; render(); } }); }
    } },
  }) as HTMLInputElement;

  let hiding = ui.prefs.get<boolean>("brief", false) === true;
  const hideButton = h("button", { type: "button", class: "hide-toggle", on: { click: () => { hiding = !hiding; ui.prefs.set("brief", hiding); render(); } } });

  const render = (): void => {
    const state: CaseState = store.shown;
    const ro = store.at !== null;
    const meta = state.meta;
    el.classList.toggle("collapsed", hiding);
    hideButton.textContent = hiding ? "Show" : "Hide";
    hideButton.title = hiding ? "Show the brief" : "Hide the brief";
    line2.hidden = hiding; strip.hidden = hiding || state.run.stages.length === 0; notes.hidden = hiding;
    const custodyKey = store.at !== null ? "replay" : custody === null ? "none" : custody === "failed" ? "failed" : custody.report;
    into1([meta, store.id, custodyKey, hiding], () => [
      h("span", { class: "heading" }, `Brief: ${store.id} · `, meta === null ? null : markingChip(ui, meta.marking), ` · ${meta?.title ?? ""}`),
      h("span", { class: "right" }, chip(), hideButton),
    ]);
    if (hiding) return;

    const g = goals(state);
    const draft = latestDraft(state);
    const run = state.run;
    const next = nextThing(state);
    const rb = runButton(state);
    const status = (name: string, text: string, id: LensId): HTMLElement => h("button", { type: "button", class: "status", data: { status: name }, on: { click: () => lens(id) } }, text);
    into2([meta?.asked, g.done, g.of, state.plan.status, draft?.n, run.status, run.waiting, next?.label, ro, stopping], () => [
      h("span", { class: "asked" }, `Asked for: ${meta?.asked ?? ""}`),
      status("goals", `✔ ${g.done}/${g.of} goals`, "steps"),
      status("plan", PLAN_WORDS[state.plan.status], "steps"),
      draft === undefined || draft === null ? null : status("draft", `draft ${draft.n}`, "narrative"),
      h("span", { class: "right" },
        h("button", {
          type: "button", class: "run-button", disabled: ro || rb.disabled,
          on: { click: () => { if (rb.command !== null) void ui.act(rb.command); else if (rb.lens !== null) lens(rb.lens, AT_GATE); } },
        }, rb.label),
        h("button", { type: "button", class: "pause", disabled: ro || !(run.status === "running" || run.status === "waiting"), on: { click: () => void ui.act("pause") } }, "Pause"),
        stopping
          ? stopInput
          : h("button", {
            type: "button", class: "stop", disabled: ro || run.status === "none" || run.status === "finished",
            on: { click: () => { stopping = true; render(); stopInput.focus(); } },
          }, "Stop"),
        next === null ? null : h("button", {
          type: "button", class: "next-thing", disabled: ro && "command" in next,
          on: { click: () => { if ("command" in next) { if (next.command === "resume") void ui.act("resume"); else nav.nextThing(); } else lens(next.lens, AT_GATE); } },
        }, next.label)),
    ]);

    const strike = state.skipped;
    intoNotes([run.status, run.pause_reason, strike, ro], () => [
      run.status === "paused" ? h("span", { class: "paused tag tag-attention" }, `Paused: ${run.pause_reason ?? ""}`) : null,
      run.status === "interrupted"
        ? h("span", { class: "interrupted tag tag-attention" }, "Interrupted: the server stopped during this run. ",
          h("button", { type: "button", disabled: ro, on: { click: () => void ui.act("resume") } }, "Resume"))
        : null,
      strike.length === 0 ? null : h("span", { class: "skipped tag tag-attention", title: strike.map((s) => `${s.seq} ${s.type}: ${s.reason}`).join("\n") }, `${strike.length} entries not applied`),
    ]);

    const runningJobs = Object.values(state.jobs).filter((j) => j.kind === "research" && j.status === "running").length;
    intoStrip([run.stages, state.reviews, draft, run.current, runningJobs, ref()], () => phaseStrip(state, runningJobs));
  };
  const ref = (): unknown => ui.ref.phases;

  const phaseStrip = (state: CaseState, runningJobs: number): Child[] => {
    const groups: { phase: string | null; stages: StageState[] }[] = [];
    for (const s of state.run.stages) {
      const g = groups.find((x) => x.phase === s.phase);
      if (g === undefined) groups.push({ phase: s.phase, stages: [s] }); else g.stages.push(s);
    }
    const out: Child[] = [];
    groups.forEach((g, gi) => {
      const title = g.phase === null ? "" : ui.ref.phases.find((p) => p.id === g.phase)?.title ?? g.phase;
      const kids: Child[] = [];
      g.stages.forEach((s, si) => {
        if (si > 0) kids.push(h("span", { class: "sep" }, "▸"));
        const mark = stageMark(state, s);
        const sign = mark === "running" && s.id === state.run.current && runningJobs > 1 ? `● ${runningJobs} running` : SIGN[mark];
        kids.push(h("button", {
          type: "button", class: `stage-button mark-${mark.replace(/ /g, "-")}`, data: { stage: s.id, mark }, title: s.last_reason ?? `${s.title}: ${mark}`,
          on: { click: () => lens("pipeline", s.id) },
        }, `${s.title} ${sign}`));
      });
      if (gi > 0) out.push(h("span", { class: "sep" }, "▸"));
      out.push(h("div", { class: "phase" }, h("span", { class: "phase-title" }, title), h("div", { class: "stages" }, kids)));
    });
    return out;
  };

  checkCustody();
  let published = store.live.published.length;
  let replaying = store.at !== null;
  return {
    el,
    update() {
      const n = store.live.published.length;
      const back = replaying && store.at === null;      // back at the present: the check is asked again
      replaying = store.at !== null;
      if (n !== published) { published = n; checkCustody(); } else if (back) checkCustody();
      render();
    },
    destroy() { asked++; },
  };
}
