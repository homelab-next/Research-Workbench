import { runUsage } from "../../core/state";
import type { CaseState, StageState } from "../../core/state";
import type { Marking, PackItem, Payloads, Where } from "../../core/types";
import type { ModelView } from "../../core/wire";
import type { Open } from "../app";
import { tag } from "../chips";
import { stageMark } from "../derive";
import type { Child } from "../dom";
import { clear, fileLink, syncList } from "../dom";
import { stageRecord } from "../stagerecord";
import type { StageRecord, TurnRecord } from "../stagerecord";
import { timeEl } from "../time";
import type { Ui, View } from "../ui";

const WHERE: Record<Where, string> = { machine: "this machine", network: "your network", hosted: "hosted" };
const MARK_WORDS: Record<string, string> = { idle: "not started" };
/** The most times one stage may be sent back to (src/pipeline/publish.ts); the figure the screen shows beside a count. */
const SENDBACK_LIMIT = 3;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const size = (chars: number): string => (chars >= 1000 ? `${Math.round(chars / 1000)}k chars` : `${chars} chars`);
const label = (item: PackItem): string => `${item.kind} ${item.title}`;

/** The text of a recorded blob, once fetched: loading, the text, or that it could not be read. */
type Fetched = { state: "loading" } | { state: "done"; text: string } | { state: "failed" };

/** A request body as text: each message as its role and text. A body that is not the usual shape is one message holding the bytes as recorded. */
export function messagesOf(text: string): { role: string; text: string }[] {
  try {
    const body: unknown = JSON.parse(text);
    const list = typeof body === "object" && body !== null ? (body as { messages?: unknown }).messages : undefined;
    if (Array.isArray(list)) {
      return list.map((m) => {
        const o = typeof m === "object" && m !== null ? (m as Record<string, unknown>) : {};
        const content = typeof o.content === "string" ? o.content : o.content === undefined || o.content === null ? "" : JSON.stringify(o.content);
        const calls = o.tool_calls === undefined ? "" : JSON.stringify(o.tool_calls);
        return { role: typeof o.role === "string" ? o.role : "message", text: content !== "" ? content : calls };
      });
    }
  } catch { /* not JSON */ }
  return [{ role: "request", text }];
}

/** A reply as text: its content when it has one, else the bytes as recorded (which show a tool call, say). */
export function replyOf(text: string): string {
  try {
    const body = JSON.parse(text) as { content?: unknown; choices?: { message?: { content?: unknown } }[] };
    if (typeof body.content === "string" && body.content !== "") return body.content;
    const c = body.choices?.[0]?.message?.content;
    if (typeof c === "string" && c !== "") return c;
  } catch { /* not JSON */ }
  return text;
}

/** The Pipeline lens (spec §10.2): the run's status and budget, then a row for each stage with its model, context, transcript, send-backs and feedback. */
export function makePipeline(ui: Ui, open: Open, arg: string | null): View {
  const { h } = ui;
  const { store } = open;
  const el = h("div", { class: "lens lens-pipeline", name: "Pipeline" });
  const rows = h("div", { class: "stage-rows" });

  let models: ModelView[] | null = null;
  let modelsFailed = false;
  let modelsVersion = 0;
  let destroyed = false;
  let wanted = arg;
  const fetched = new Map<string, Fetched>();
  const shownTurns = new Set<string>();
  const texts = new Map<string, string>();
  const parts = new Map<HTMLElement, { sig: string; summary: HTMLElement; body: HTMLElement }>();

  const state = (): CaseState => store.shown;
  const ro = (): boolean => store.at !== null;
  const objective = (s: CaseState) => ui.ref.objectives.find((o) => o.id === s.meta?.objective) ?? null;

  void ui.api.models(store.id).then((list) => { models = list; modelsVersion++; if (!destroyed) update(); }, () => { modelsFailed = true; modelsVersion++; if (!destroyed) update(); });

  // ---------- the run line ----------
  const status = h("span", { class: "run-status" });
  const use = h("span", { class: "model-use" });
  const budgetNow = h("span", { class: "budget-now" });
  const budgetBox = h("input", {
    type: "text", name: "Run budget, in tokens", placeholder: "Tokens", value: "",
    on: { input: (e) => { texts.set("budget", (e.target as HTMLInputElement).value); syncBudget(); } },
  }) as HTMLInputElement;
  const budgetOf = (): number | null => { const t = (texts.get("budget") ?? "").trim(); const n = Number(t); return t !== "" && Number.isInteger(n) && n >= 1 ? n : null; };
  const setBudget = h("button", {
    type: "button", data: { action: "set-budget" }, title: "Stop the run when it has used this many model tokens",
    on: { click: () => { const n = budgetOf(); if (n !== null) void ui.act("set_budget", { tokens: n }).then((ok) => { if (ok) { texts.delete("budget"); budgetBox.value = ""; syncBudget(); } }); } },
  }, "Set") as HTMLButtonElement;
  const noBudget = h("button", { type: "button", data: { action: "no-budget" }, title: "Remove the token budget", on: { click: () => { void ui.act("set_budget", { tokens: null }); } } }, "No budget") as HTMLButtonElement;
  const syncBudget = (): void => {
    setBudget.disabled = ro() || budgetOf() === null;
    noBudget.disabled = ro() || state().run.budget_tokens === null;
    budgetBox.disabled = ro();
  };
  const runLine = h("div", { class: "run-line" }, status, " · ", use, " · ", budgetNow, " ", budgetBox, setBudget, noBudget);

  const statusWords = (s: CaseState): string => {
    const { run } = s;
    switch (run.status) {
      case "none": return "no run yet";
      case "waiting": return `waiting at the ${run.waiting ?? "a"} gate`;
      case "paused": return run.pause_reason === null ? "paused" : `paused: ${run.pause_reason}`;
      case "finished": return `finished: ${run.outcome ?? "ended"}`;
      default: return run.status;
    }
  };
  const paintRunLine = (s: CaseState): void => {
    const u = runUsage(s);
    status.textContent = statusWords(s);
    use.textContent = `model use: ${u.usage.input} in · ${u.usage.output} out · ${u.usage.reasoning} reasoning · ${u.model_calls} calls`;
    budgetNow.textContent = s.run.budget_tokens === null ? "No budget" : `Budget: ${s.run.budget_tokens} tokens`;
    syncBudget();
  };

  // ---------- model and effort ----------
  const viewOf = (stage: StageState): ModelView | null =>
    stage.model === null ? null : models?.find((m) => m.provider === stage.model!.provider && m.model === stage.model!.model) ?? null;
  const send = (stage: StageState, provider: string, model: string, effort: string | null): void => {
    void ui.act("set_model", { stage: stage.id, provider, model, effort });
  };
  const modelSelect = (stage: StageState): HTMLSelectElement => {
    const list = models ?? [];
    const current = viewOf(stage);
    const sel = h("select", {
      name: "Model", disabled: ro() || models === null,
      on: {
        change: (e) => {
          const picked = list[Number((e.target as HTMLSelectElement).value)];
          // the screen shows what is recorded: the pick goes back until the entry arrives
          (e.target as HTMLSelectElement).value = current === null ? "" : String(list.indexOf(current));
          if (picked === undefined || !picked.allowed) return;
          send(stage, picked.provider, picked.model, stage.model !== null && stage.model.effort !== null && picked.efforts.includes(stage.model.effort) ? stage.model.effort : null);
        },
      },
    // the placeholder is shown, never offered, and is there only while the recorded setting is not in the list
    }, current !== null ? null : h("option", { value: "", hidden: true }, models === null ? (modelsFailed ? "The model list could not be read" : "Loading models…") : "Choose a model"),
    list.map((m, i) => h("option", { value: String(i), disabled: !m.allowed }, `${m.model} · ${WHERE[m.where]}${m.allowed ? "" : ` (not allowed: ${m.reason ?? "not allowed for this case's marking"})`}`))) as HTMLSelectElement;
    sel.value = current === null ? "" : String(list.indexOf(current));
    return sel;
  };
  const effortSelect = (stage: StageState): HTMLSelectElement => {
    const current = viewOf(stage);
    const efforts = current?.efforts ?? [];
    if (current === null || efforts.length === 0) {
      return h("select", { name: "Effort", disabled: true }, h("option", { value: "" }, "no effort setting")) as HTMLSelectElement;
    }
    const chosen = stage.model!.effort ?? "";
    const sel = h("select", {
      name: "Effort", disabled: ro(),
      on: { change: (e) => { const v = (e.target as HTMLSelectElement).value; (e.target as HTMLSelectElement).value = chosen; send(stage, stage.model!.provider, stage.model!.model, v === "" ? null : v); } },
    }, h("option", { value: "" }, "Model default"), efforts.map((x) => h("option", { value: x }, x))) as HTMLSelectElement;
    sel.value = chosen;
    return sel;
  };
  const runsLine = (stage: StageState): string => {
    if (stage.runs === "script") return "runs a script";
    if (stage.runs === "human") return "waits for you";
    const m = stage.model;
    return m === null ? "runs an agent · no model chosen" : `runs an agent · ${m.provider} · ${m.model} · ${m.effort === null ? "model default effort" : `effort ${m.effort}`}`;
  };
  const resume = (): HTMLElement => h("button", { type: "button", class: "primary", data: { action: "resume" }, disabled: ro(), title: "Resume the run", on: { click: () => { void ui.act("resume"); } } }, "Resume");

  const modelSection = (stage: StageState, rec: StageRecord, s: CaseState): Child[] => {
    const out: Child[] = [h("p", { class: "runs" }, runsLine(stage))];
    if (stage.runs === "agent") out.push(h("div", { class: "model-controls" }, h("label", null, "Model ", modelSelect(stage)), " ", h("label", null, "Effort ", effortSelect(stage))));
    if (stage.status === "declined") {
      const reason = stage.last_reason ?? [...rec.turns].reverse().find((t) => t.outcome === "declined")?.reason ?? "no reason was given";
      out.push(h("div", { class: "declined attention" }, h("p", null, `The model declined: ${reason}`), h("p", null, "Choose another model above, then resume"), resume()));
    }
    if (stage.status === "blocked") {
      const last = rec.blocked.at(-1);
      const reason = s.run.pause_reason ?? (last === undefined ? "blocked" : `${last.marking} may not go to ${last.model} (${WHERE[last.where]})`);
      const limit = Object.hasOwn(s.pack_limits, stage.id) ? s.pack_limits[stage.id]! : "";
      const sel = h("select", {
        name: "Strictest marking this stage may be given", disabled: ro(),
        on: { change: (e) => {
          const v = (e.target as HTMLSelectElement).value;
          (e.target as HTMLSelectElement).value = limit;
          void ui.act("set_pack_limit", { stage: stage.id, max_marking: v === "" ? null : v });
        } },
      }, h("option", { value: "" }, "No limit"), ui.me.markings.map((m: Marking) => h("option", { value: m }, m))) as HTMLSelectElement;
      sel.value = limit;
      out.push(h("div", { class: "blocked attention" }, h("p", { class: "pause-reason" }, reason), h("label", null, "Strictest marking this stage may be given ", sel), " ", resume()));
    }
    return out;
  };

  // ---------- context ----------
  const contextSection = (rec: StageRecord): HTMLElement => {
    const t = rec.turns.at(-1);
    if (t === undefined) return h("div", { class: "context" }, h("h3", { class: "section-title" }, "Context"), h("p", { class: "empty" }, "no model turn yet"));
    const ordered = [...t.pack.filter((i) => i.fixed), ...t.pack.filter((i) => !i.fixed)];
    return h("div", { class: "context" }, h("h3", { class: "section-title" }, "Context"),
      h("div", { class: "chips" }, ordered.map((i) => h("span", { class: i.fixed ? "chip fixed" : "chip", title: `${i.chars} characters` }, label(i), i.fixed ? " fixed" : null)), " ", h("span", { class: "context-size" }, size(t.chars))),
      t.left_out.length > 0 ? h("p", { class: "left-out attention" }, `Left out: ${t.left_out.map((i) => `${i.kind} ${i.id}`).join(", ")}`) : null);
  };

  // ---------- transcript ----------
  const fetchBlob = (hash: string, again: () => void): Fetched => {
    const have = fetched.get(hash);
    if (have !== undefined) return have;
    fetched.set(hash, { state: "loading" });
    ui.api.blobText(store.id, hash).then(
      (text) => { fetched.set(hash, { state: "done", text }); if (!destroyed) again(); },
      () => { fetched.set(hash, { state: "failed" }); if (!destroyed) again(); },
    );
    return { state: "loading" };
  };
  const textBlock = (roleName: string, text: string, cls = "message"): HTMLElement => h("div", { class: cls }, h("span", { class: "role" }, roleName), h("pre", null, text));
  const outcomeWords = (t: TurnRecord): string => t.outcome;

  const turnView = (t: TurnRecord, repaint: () => void): HTMLElement => {
    const key = t.request;
    const shown = shownTurns.has(key);
    const head = h("div", { class: "turn-head" },
      h("span", { class: "actor" }, t.actor), " · ", h("span", { class: "model" }, `${t.model}${t.effort === null ? "" : ` (${t.effort})`}`), " · ", h("span", { class: "where" }, WHERE[t.where]), " · ",
      h("span", { class: "marking" }, t.marking), " · ", h("span", { class: "outcome" }, outcomeWords(t)),
      t.reason === null ? null : h("span", { class: "reason" }, ` ${t.reason}`), " ", timeEl(ui, t.ts, "local"), " ",
      h("button", { type: "button", data: { action: "show" }, title: shown ? "Hide the recorded text" : "Fetch and show the recorded text of this turn", on: { click: () => { if (shownTurns.has(key)) shownTurns.delete(key); else shownTurns.add(key); repaint(); } } }, shown ? "Hide" : "Show"));
    const partList = h("div", { class: "parts" },
      t.pack.map((i) => h("span", { class: "part" }, `${i.title} · ${t.marking}`), ), t.left_out.map((i) => h("span", { class: "part left-out" }, `${i.title} · left out`)));
    const kids: Child[] = [head, partList];
    if (shown) {
      const messages = fetchBlob(t.messages.blob, repaint);
      kids.push(h("div", { class: "recorded" },
        messages.state === "loading" ? h("p", { class: "empty" }, "Loading…") : messages.state === "failed" ? h("p", { class: "attention" }, "The request text could not be read") : messagesOf(messages.text).map((m) => textBlock(m.role, m.text)),
        fileLink(h, ui.api.blobPath(store.id, t.messages.blob), "raw bytes")));
      if (t.response !== null) {
        const reply = fetchBlob(t.response.blob, repaint);
        kids.push(h("div", { class: "recorded" },
          reply.state === "loading" ? h("p", { class: "empty" }, "Loading…") : reply.state === "failed" ? h("p", { class: "attention" }, "The reply could not be read") : textBlock("reply", replyOf(reply.text), "reply"),
          fileLink(h, ui.api.blobPath(store.id, t.response.blob), "raw bytes")));
      }
      if (t.reasoning !== null) {
        const why = fetchBlob(t.reasoning.blob, repaint);
        kids.push(h("div", { class: "reasoning" }, h("span", { class: "label" }, "reasoning as stated by the agent"),
          why.state === "loading" ? h("p", { class: "empty" }, "Loading…") : why.state === "failed" ? h("p", { class: "attention" }, "The reasoning could not be read") : h("pre", null, why.text)));
      }
    }
    for (const c of t.calls) {
      const end = c.ok === null ? c.open ?? "pending" : c.ok ? "ok" : "failed";
      kids.push(h("div", { class: "tool-call", data: { call: c.call } },
        h("span", { class: "tool" }, c.tool), " — ", h("span", { class: "why" }, `why (the agent's own account): ${c.why}`), " ", h("span", { class: `outcome${c.ok === false ? " attention" : ""}` }, end),
        c.summary === null ? null : h("span", { class: "summary" }, ` ${c.summary}`)));
    }
    return h("div", { class: "turn", data: { request: t.request } }, kids);
  };
  const transcriptSection = (rec: StageRecord, repaint: () => void): HTMLElement =>
    h("div", { class: "transcript" }, h("h3", { class: "section-title" }, "Transcript"), rec.turns.length === 0 ? h("p", { class: "empty" }, "no model turns yet") : rec.turns.map((t) => turnView(t, repaint)));

  const sendbackSection = (rec: StageRecord): HTMLElement | null =>
    rec.sendbacks.length === 0 ? null : h("div", { class: "sendbacks" }, h("h3", { class: "section-title" }, "Send-backs"),
      rec.sendbacks.map((b) => h("p", { class: "sendback" }, `${b.from} → ${b.to} (${b.count} of ${SENDBACK_LIMIT}): ${b.reason} `, timeEl(ui, b.ts, "local"))));

  // ---------- feedback ----------
  const feedbackSection = (s: CaseState): HTMLElement => {
    const obj = objective(s);
    const title = (id: string): string => obj?.measures.find((m) => m.id === id)?.title ?? id;
    let from = 0;
    store.entries.forEach((e, i) => { if (e.seq <= s.seq && e.type === "run.started") from = i; });
    const mops = store.entries.slice(from).filter((e) => e.seq <= s.seq && e.type === "feedback.recorded" && e.payload.kind === "mop") as { payload: Payloads["feedback.recorded"] }[];
    const line = (f: Payloads["feedback.recorded"]): string => `${title(f.measure)}: ${f.value}${f.note === "" ? "" : ` · ${f.note}`}`;
    const moes = s.feedback.filter((f) => f.kind === "moe");
    const forms = (obj?.measures ?? []).filter((m) => m.kind === "moe").map((m) => {
      const valueKey = `value:${m.id}`;
      const noteKey = `note:${m.id}`;
      const record = h("button", { type: "button", data: { action: "record" }, disabled: ro() || (texts.get(valueKey) ?? "").trim() === "", title: `Record ${m.title}`, on: { click: () => {
        const raw = (texts.get(valueKey) ?? "").trim();
        if (raw === "") return;
        const n = Number(raw);
        void ui.act("feedback", { measure: m.id, value: Number.isFinite(n) ? n : raw, note: (texts.get(noteKey) ?? "").trim() }).then((ok) => {
          if (!ok) return;
          texts.delete(valueKey); texts.delete(noteKey);
          for (const [, part] of parts) part.sig = "";
          update();
        });
      } } }, "Record") as HTMLButtonElement;
      return h("div", { class: "moe-form", data: { measure: m.id } }, h("span", { class: "measure" }, m.title), " ",
        h("input", { type: "text", name: `Value for ${m.title}`, placeholder: "Value", value: texts.get(valueKey) ?? "", disabled: ro(), on: { input: (e) => { texts.set(valueKey, (e.target as HTMLInputElement).value); record.disabled = ro() || (texts.get(valueKey) ?? "").trim() === ""; } } }), " ",
        h("input", { type: "text", name: `Note for ${m.title}`, placeholder: "Note", value: texts.get(noteKey) ?? "", disabled: ro(), on: { input: (e) => { texts.set(noteKey, (e.target as HTMLInputElement).value); } } }), " ", record);
    });
    return h("div", { class: "feedback" }, h("h3", { class: "section-title" }, "Feedback"),
      h("p", { class: "label" }, "Measures of performance, recorded by the system"),
      mops.length === 0 ? h("p", { class: "empty" }, "none recorded yet") : mops.map((e) => h("p", { class: "mop", data: { measure: e.payload.measure } }, line(e.payload))),
      h("p", { class: "label" }, "Measures of effectiveness, recorded by you"),
      moes.map((f) => h("p", { class: "moe", data: { measure: f.measure } }, line(f))),
      forms.length === 0 ? h("p", { class: "empty" }, "this case's objective has no measures of effectiveness") : forms);
  };

  // ---------- rows ----------
  const keyOf = (n: Element | null): string | null =>
    n === null ? null : [n.tagName, n.getAttribute("aria-label") ?? "", n.getAttribute("data-action") ?? "", n.closest("[data-measure]")?.getAttribute("data-measure") ?? "", n.closest("[data-request]")?.getAttribute("data-request") ?? ""].join("|");

  const paintRow = (row: HTMLElement, stage: StageState): void => {
    const part = parts.get(row)!;
    const s = state();
    const rec = stageRecord(store.entries, stage.id, s.seq);
    const mark = stageMark(s, stage);
    const sig = JSON.stringify([stage, mark, rec, ro(), modelsVersion, stage.status === "blocked" ? [s.run.pause_reason, s.pack_limits[stage.id] ?? null] : null,
      stage.runs === "human" ? [s.feedback, s.meta?.objective ?? null, store.entries.length] : null, [...shownTurns].filter((k) => rec.turns.some((t) => t.request === k)), [...fetched.keys()].length]);
    if (sig === part.sig) return;
    part.sig = sig;
    clear(part.summary);
    const markTag = tag(ui, mark === "passed" ? "done" : mark === "idle" || mark === "running" ? "system" : "attention", MARK_WORDS[mark] ?? mark);
    markTag.classList.add("mark");
    part.summary.append(h("span", { class: "summary-line" },
      h("span", { class: "title" }, stage.title), " ", markTag,
      " ", h("span", { class: "attempts" }, stage.attempts === 0 ? "no attempts" : plural(stage.attempts, "attempt", "attempts")),
      stage.last_reason === null ? null : [" ", h("span", { class: "last-reason" }, stage.last_reason)]));
    const active = keyOf(row.contains(ui.doc.activeElement) ? ui.doc.activeElement : null);
    clear(part.body);
    part.body.append(...modelSection(stage, rec, s).map((c) => c as Node));
    if (stage.runs === "agent") {
      part.body.append(contextSection(rec), transcriptSection(rec, () => repaint(row, stage.id)));
    }
    const back = sendbackSection(rec);
    if (back !== null) part.body.append(back);
    if (stage.runs === "human" && stage.gate === null) part.body.append(feedbackSection(s));
    if (active !== null) ([...part.body.querySelectorAll("input, button, select")].find((n) => keyOf(n) === active) as HTMLElement | undefined)?.focus();
  };

  /** Paints a row again whatever it last showed, from the stage as it is now. */
  const repaint = (row: HTMLElement, id: string): void => {
    const part = parts.get(row);
    const stage = state().run.stages.find((x) => x.id === id);
    if (part === undefined || stage === undefined) return;
    part.sig = "";
    paintRow(row, stage);
  };

  const makeRow = (stage: StageState): HTMLElement => {
    const summary = h("summary", null);
    const body = h("div", { class: "body" });
    const row = h("details", { class: "stage-row", data: { stage: stage.id } }, summary, body);
    parts.set(row, { sig: "", summary, body });
    if (stage.status === "declined" || stage.status === "blocked") (row as HTMLDetailsElement).open = true;
    return row;
  };

  function update(): void {
    const s = state();
    paintRunLine(s);
    empty.hidden = s.run.stages.length > 0;
    syncList(rows, s.run.stages, (x) => x.id, makeRow, () => {});
    for (const stage of s.run.stages) {
      const row = rows.querySelector(`[data-stage="${stage.id}"]`) as HTMLElement | null;
      if (row !== null) paintRow(row, stage);
    }
    for (const [row, part] of parts) if (!row.isConnected) parts.delete(row);
    if (wanted !== null) {
      const row = rows.querySelector(`[data-stage="${wanted}"]`) as HTMLDetailsElement | null;
      if (row !== null) {
        wanted = null;
        row.open = true;
        if (typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest", behavior: ui.reducedMotion() ? "auto" : "smooth" });
      }
    }
  }
  const empty = h("p", { class: "empty" }, "No run yet.");
  el.append(runLine, empty, rows);

  return { el, update, destroy() { destroyed = true; } };
}
