import { CARD_REF } from "../../core/state";
import type { CaseState } from "../../core/state";
import type { Entry, ModelChoice, Where } from "../../core/types";
import type { AgentView, ModelView, PartView } from "../../core/wire";
import type { Open } from "../app";
import { cardChip } from "../chips";
import type { Child } from "../dom";
import { clear, syncList } from "../dom";
import type { CaseStore } from "../store";
import { timeEl } from "../time";
import { REPLAY_REFUSAL } from "../ui";
import type { Ui, View } from "../ui";

export interface AgentLens extends View {
  /** Sends `text` to your agent as the next question. */
  ask(text: string): void;
}

/** The fixed questions of the quick asks. */
const QUICK: { key: string; label: string; question: string }[] = [
  { key: "synopsis", label: "Synopsis", question: "Give a synopsis of this case." },
  { key: "next", label: "What next?", question: "What should be done next, and why?" },
  { key: "draft", label: "Draft the response", question: "Draft the response to what was asked." },
  { key: "weak", label: "What's weak?", question: "What is weak in the evidence or the draft?" },
];
const WHERE: Record<Where, string> = { machine: "this machine", network: "your network", hosted: "hosted" };
const NO_MODEL = "Your agent has no model. Choose one in the Agent lens.";

/** What the person left out and added for the next turn: kept for the case until changed, even when the lens is closed and opened again. */
interface Picks { left_out: Set<string>; added: string[] }
const picks = new WeakMap<CaseStore, Picks>();

/** Where a turn stands, from the entries after its question. */
export type TurnStatus =
  | { kind: "answered" } | { kind: "thinking" } | { kind: "interrupted" }
  | { kind: "declined"; reason: string } | { kind: "blocked"; marking: string } | { kind: "failed"; reason: string };

const isAgent = (e: Entry): boolean => e.actor.kind === "agent" && e.actor.stage === "agent";

/**
 * Each question's status. A request or block is linked to its question by cause (the seq of the agent.asked entry the work answered), never by position,
 * and a decline or failed response by the request it names. A question the fold says was ended reads interrupted, or failed with the reason.
 */
export function turnStatuses(entries: readonly Entry[], state: CaseState): Map<string, TurnStatus> {
  const turnOfSeq = new Map(state.conversation.map((t) => [t.asked_seq, t.turn] as const));
  const byRequest = new Map<string, string>();
  const outcome = new Map<string, TurnStatus>();
  for (const e of entries) {
    if (e.seq > state.seq) break;
    switch (e.type) {
      case "model.request": {
        const turn = e.cause === null ? undefined : turnOfSeq.get(e.cause);
        if (isAgent(e) && turn !== undefined) byRequest.set(e.payload.request, turn);
        break;
      }
      case "model.blocked": {
        const turn = e.cause === null ? undefined : turnOfSeq.get(e.cause);
        if (isAgent(e) && turn !== undefined) outcome.set(turn, { kind: "blocked", marking: e.payload.marking });
        break;
      }
      case "model.declined": {
        const turn = byRequest.get(e.payload.request);
        if (turn !== undefined) outcome.set(turn, { kind: "declined", reason: e.payload.reason });
        break;
      }
      case "model.response": {
        const turn = byRequest.get(e.payload.request);
        if (turn !== undefined && e.payload.stop === "error") outcome.set(turn, { kind: "failed", reason: "the model call failed" });
        break;
      }
      default:
    }
  }
  const out = new Map<string, TurnStatus>();
  for (const t of state.conversation) {
    if (t.answer !== null) out.set(t.turn, { kind: "answered" });
    else if (outcome.has(t.turn)) out.set(t.turn, outcome.get(t.turn)!);
    else if (t.ended !== null) out.set(t.turn, t.ended === "interrupted" ? { kind: "interrupted" } : { kind: "failed", reason: t.ended });
    else out.set(t.turn, { kind: "thinking" });
  }
  return out;
}

const STATUS_WORDS = (s: TurnStatus): string => {
  switch (s.kind) {
    case "thinking": return "thinking…";
    case "interrupted": return "interrupted";
    case "declined": return `declined: ${s.reason}`;
    case "blocked": return `blocked: the model may not receive ${s.marking}`;
    case "failed": return `failed: ${s.reason}`;
    case "answered": return "";
  }
};

const size = (chars: number): string => `${(chars / 1000).toFixed(1)}k chars`;

/** The Agent lens (guide §6): what your agent is given, the conversation, and the buttons that turn an answer into a proposal or a note. Everything about the conversation is read from the entries. */
export function makeAgent(ui: Ui, open: Open): AgentLens {
  const { h } = ui;
  const { store, nav } = open;
  const mine = ((): Picks => {
    const have = picks.get(store);
    if (have !== undefined) return have;
    const made: Picks = { left_out: new Set(), added: [] };
    picks.set(store, made);
    return made;
  })();
  const ro = (): boolean => store.at !== null;

  let view: AgentView | null = null;
  let viewFailed = false;
  let models: ModelView[] | null = null;
  let destroyed = false;
  let selected: string | null = null;
  let viewSig = "";
  let version = 0;
  let paintedControls = "";
  let paintedChips = "";
  const kept = (s: CaseState, id: string): boolean => Object.hasOwn(s.cards, id) && s.cards[id]!.place === "lane";

  // ---------- the head ----------
  const head = h("p", { class: "agent-head" });
  const controls = h("div", { class: "model-controls" });
  const noModel = h("p", { class: "models-note attention" }, NO_MODEL);
  const use = h("p", { class: "agent-use" });
  const loaded = h("p", { class: "loaded" });
  const chips = h("div", { class: "chips" });
  const addBox = h("div", { class: "add-box" });
  const excerpt = h("div", { class: "excerpt-box" });
  const note = h("p", { class: "empty" }, "The context is shown for the live case.");

  const modelSelect = (current: ModelChoice | null): HTMLSelectElement => {
    const list = models ?? [];
    const at = current === null ? -1 : list.findIndex((m) => m.provider === current.provider && m.model === current.model);
    const sel = h("select", {
      name: "Model", disabled: ro() || models === null || list.length === 0,
      on: { change: (e) => {
        const picked = list[Number((e.target as HTMLSelectElement).value)];
        (e.target as HTMLSelectElement).value = at < 0 ? "" : String(at);
        if (picked === undefined || !picked.allowed) return;
        const effort = current !== null && current.effort !== null && picked.efforts.includes(current.effort) ? current.effort : null;
        void ui.act("set_model", { stage: "agent", provider: picked.provider, model: picked.model, effort });
      } },
    }, at >= 0 ? null : h("option", { value: "", hidden: true }, models === null ? "Loading models…" : list.length === 0 ? "No models could be listed" : "Choose a model"),
    list.map((m, i) => h("option", { value: String(i), disabled: !m.allowed }, `${m.model} · ${WHERE[m.where]}${m.allowed ? "" : ` (not allowed: ${m.reason ?? "not allowed for this case's marking"})`}`))) as HTMLSelectElement;
    sel.value = at < 0 ? "" : String(at);
    return sel;
  };
  const effortSelect = (current: ModelChoice | null): HTMLSelectElement => {
    const info = current === null ? undefined : models?.find((m) => m.provider === current.provider && m.model === current.model);
    const efforts = info?.efforts ?? [];
    if (current === null || info === undefined || efforts.length === 0) {
      return h("select", { name: "Effort", disabled: true }, h("option", { value: "" }, "no effort setting")) as HTMLSelectElement;
    }
    const sel = h("select", {
      name: "Effort", disabled: ro(),
      on: { change: (e) => {
        const v = (e.target as HTMLSelectElement).value;
        (e.target as HTMLSelectElement).value = current.effort ?? "";
        void ui.act("set_model", { stage: "agent", provider: current.provider, model: current.model, effort: v === "" ? null : v });
      } },
    }, h("option", { value: "" }, "Model default"), efforts.map((x) => h("option", { value: x }, x))) as HTMLSelectElement;
    sel.value = current.effort ?? "";
    return sel;
  };

  // ---------- the context ----------
  const partOf = (key: string): PartView | undefined => view?.parts.find((p) => p.key === key);
  const titleOf = (key: string): string => partOf(key)?.title ?? view?.addable.find((a) => a.key === key)?.title ?? key;
  const leftOut = (): string[] => [...mine.left_out].filter((k) => partOf(k) !== undefined);
  const addedNow = (): string[] => mine.added.filter((k) => view === null || view.addable.some((a) => a.key === k));
  const chip = (key: string, fixed: boolean, onRemove: (() => void) | null): HTMLElement => {
    const title = titleOf(key);
    return h("span", { class: `chip part${fixed ? " fixed" : ""}${selected === key ? " selected" : ""}`, data: { part: key }, title: `${partOf(key)?.chars ?? 0} characters` },
      h("button", { type: "button", class: "chip-pick", title: `Show what ${title} says`, on: { click: () => { selected = selected === key ? null : key; paintContext(true); } } }, title),
      fixed ? h("span", { class: "fixed-note" }, " fixed") : null,
      onRemove === null ? null : h("button", { type: "button", class: "chip-remove", name: `Leave out ${title}`, title: `Leave ${title} out of the next question`, disabled: ro(), on: { click: onRemove } }, "×"));
  };
  const paintContext = (force = false): void => {
    const v = view;
    const sig = JSON.stringify([v, [...mine.left_out], mine.added, selected, ro(), viewFailed]);
    if (!force && sig === paintedChips) return;
    paintedChips = sig;
    clear(chips); clear(addBox); clear(excerpt);
    if (v === null) { loaded.textContent = viewFailed ? "The context could not be read." : "Loading the context…"; return; }
    const out = new Set(leftOut());
    const going = v.parts.filter((p) => !out.has(p.key));
    const add = addedNow();
    loaded.textContent = `Loaded for this turn (${size(going.reduce((n, p) => n + p.chars, 0))}):`;
    for (const p of going) {
      chips.appendChild(chip(p.key, p.fixed, p.fixed ? null : () => { mine.left_out.add(p.key); paintContext(); }));
      chips.appendChild(space());
    }
    for (const key of add) {
      chips.appendChild(chip(key, false, () => { mine.added = mine.added.filter((k) => k !== key); paintContext(); }));
      chips.appendChild(space());
    }
    if (out.size > 0) {
      addBox.appendChild(h("button", { type: "button", data: { action: "restore" }, disabled: ro(), title: "Put back what you left out", on: { click: () => { mine.left_out.clear(); paintContext(); } } }, `Restore ${out.size} left out`));
      addBox.appendChild(space());
    }
    const options = v.addable.filter((a) => !add.includes(a.key));
    const sel = h("select", {
      name: "Add a skill, SOP or lesson", disabled: ro() || options.length === 0,
      on: { change: (e) => {
        const key = (e.target as HTMLSelectElement).value;
        (e.target as HTMLSelectElement).value = "";
        if (key === "" || mine.added.includes(key)) return;
        mine.added = [...mine.added, key];
        paintContext();
      } },
    }, h("option", { value: "" }, "+ Add a skill, SOP or lesson…"), options.map((a) => h("option", { value: a.key }, a.title))) as HTMLSelectElement;
    sel.value = "";
    addBox.appendChild(sel);
    if (selected !== null) {
      const p = partOf(selected);
      excerpt.appendChild(h("div", { class: "excerpt" }, h("span", { class: "label" }, titleOf(selected)), " ",
        p === undefined ? h("p", null, "Added for the next question: its text goes with it.") : h("pre", null, p.excerpt + (p.chars > p.excerpt.length ? "…" : ""))));
    }
  };
  const space = (): Text => ui.doc.createTextNode(" ");

  const paintHead = (s: CaseState): void => {
    const v = view;
    const obj = v === null ? (ui.ref.objectives.find((o) => o.id === s.meta?.objective)?.title ?? null) : v.objective;
    head.textContent = `agent: ${v?.agent ?? "assistant"} · Profile: ${v?.profile ?? ui.ref.profile.title} · serves ${obj ?? "no objective"} · tools: none`;
    const sig = JSON.stringify([v?.model ?? null, models, ro(), v === null]);
    if (sig !== paintedControls) {
      paintedControls = sig;
      clear(controls);
      controls.append(h("label", null, "Model ", modelSelect(v?.model ?? null)), " ", h("label", null, "Effort ", effortSelect(v?.model ?? null)));
    }
    noModel.hidden = v === null || v.model !== null;
    const u = s.agent_usage;
    use.textContent = `conversation use: ${u.usage.input} in · ${u.usage.output} out · ${u.usage.reasoning} reasoning · ${u.calls} calls`;
  };

  // ---------- loading ----------
  const loadView = (): void => {
    const mineVersion = ++version;
    ui.api.agent(store.id).then(
      (v) => { if (destroyed || mineVersion !== version) return; view = v; viewFailed = false; update(); },
      () => { if (destroyed || mineVersion !== version) return; viewFailed = true; update(); },
    );
  };
  ui.api.models(store.id).then((list) => { models = list; if (!destroyed) update(); }, () => { models = []; if (!destroyed) update(); });
  /** What the context depends on: the kept cards, the draft, the answers so far, the case and the model picked. */
  const signature = (s: CaseState): string =>
    JSON.stringify([s.drafts.length, Object.values(s.cards).filter((c) => c.place === "lane").map((c) => c.id), s.conversation.filter((t) => t.answer !== null).length, s.stage_models.agent ?? null, s.pack_limits.agent ?? null]);

  // ---------- asking ----------
  const send = (text: string): Promise<boolean> => ui.act("ask", { text, left_out: leftOut(), added: addedNow() });
  const box = h("textarea", {
    name: "Ask your agent", placeholder: "ask your agent …", value: "",
    on: { keydown: (e) => {
      const k = e as KeyboardEvent;
      if (k.key !== "Enter" || k.shiftKey || k.isComposing) return;
      k.preventDefault();
      const text = (k.target as HTMLTextAreaElement).value.trim();
      if (text === "" || ro()) return;
      const sent = (k.target as HTMLTextAreaElement).value;
      void send(text).then((ok) => { if (ok && box.value === sent) box.value = ""; });
    } },
  }) as HTMLTextAreaElement;
  const quick = h("div", { class: "quick" }, "Quick asks: ", QUICK.map((q) => h("button", {
    type: "button", data: { quick: q.key }, title: q.question, disabled: ro(), on: { click: () => { void send(q.question); } },
  }, q.label)));
  const quickButtons = (): HTMLButtonElement[] => [...quick.querySelectorAll("button")] as HTMLButtonElement[];

  // ---------- the conversation ----------
  const conversation = h("div", { class: "conversation" });
  const empty = h("p", { class: "empty" }, "Nothing asked yet. Ask about the case, or use a quick ask.");
  const requestOf = (entries: readonly Entry[], id: string | null): Extract<Entry, { type: "model.request" }> | null =>
    id === null ? null : (entries.find((e) => e.type === "model.request" && e.payload.request === id) as Extract<Entry, { type: "model.request" }> | undefined) ?? null;
  const answeredTs = (entries: readonly Entry[], turn: string): string | null => {
    const e = entries.find((x) => x.type === "agent.answered" && x.payload.turn === turn);
    return e === undefined ? null : e.ts;
  };
  const answerBody = (text: string, cites: readonly string[], s: CaseState): HTMLElement =>
    h("div", { class: "answer" }, h("p", { class: "answer-text" }, text),
      cites.length === 0 ? null : h("p", { class: "cites" }, "cites: ", cites.map((c) => [h("span", { data: { "card-chip": c } }, cardChip(ui, c, (id) => nav.focusCard(id), !kept(s, c))), " "])));
  const proposeButton = (turn: string, section: "summary" | "assessment", label: string): HTMLElement =>
    h("button", {
      type: "button", data: { action: `propose-${section}` }, disabled: ro(), title: ro() ? REPLAY_REFUSAL : `Make this answer a proposal for the ${label.replace("Propose as ", "")} section; nothing changes until you accept it in the Narrative lens`,
      on: { click: () => { void ui.act("propose_answer", { turn, section }).then((ok) => { if (ok) ui.toast(`Proposed for ${section === "summary" ? "Summary" : "Assessment"}: accept it in the Narrative lens`); }); } },
    }, label);
  const turnSig = new WeakMap<HTMLElement, string>();
  const paintTurn = (el: HTMLElement, t: CaseState["conversation"][number], status: TurnStatus, s: CaseState): void => {
    const entries = store.entries;
    const req = requestOf(entries, t.request);
    const ts = answeredTs(entries, t.turn);
    const sig = JSON.stringify([t, status, ts, ro(), t.cites.map((c) => kept(s, c)), req?.payload.pack ?? null]);
    if (turnSig.get(el) === sig) return;
    turnSig.set(el, sig);
    clear(el);
    const kids: Child[] = [h("p", { class: "question" }, t.asked)];
    if (t.answer === null) {
      kids.push(h("p", { class: `status status-${status.kind}${status.kind === "thinking" ? "" : " attention"}`, role: "status" }, STATUS_WORDS(status)));
    } else {
      kids.push(answerBody(t.answer, t.cites, s));
      kids.push(h("p", { class: "byline" }, `your agent · ${ui.ref.profile.title} profile · `, ts === null ? null : timeEl(ui, ts, "local")));
      if (req === null) kids.push(h("p", { class: "incomplete attention" }, "this turn's record is incomplete"));
      else {
        kids.push(h("details", { class: "turn-context" }, h("summary", null, "context"),
          h("ul", null, req.payload.pack.map((i) => h("li", null, `${i.kind} ${i.title} · ${i.chars} chars${i.fixed ? " · fixed" : ""}`)),
            req.payload.left_out.map((i) => h("li", { class: "left-out" }, `left out: ${i.kind} ${i.id}`)))));
      }
      kids.push(h("div", { class: "turn-actions" },
        proposeButton(t.turn, "summary", "Propose as Summary"), " ", proposeButton(t.turn, "assessment", "Propose as Assessment"), " ",
        h("button", {
          type: "button", data: { action: "keep-note" }, disabled: ro(), title: ro() ? REPLAY_REFUSAL : "Keep this answer as a note card in Incoming",
          on: { click: () => { void ui.act("keep_answer", { turn: t.turn }).then((ok) => { if (ok) ui.toast("Kept as a note in Incoming"); }); } },
        }, "Keep as note")));
    }
    for (const k of kids) el.appendChild(k as Node);
  };

  function update(): void {
    if (destroyed) return;
    const s = store.shown;
    if (store.at === null) {
      const sig = signature(store.live);
      if (sig !== viewSig) { viewSig = sig; loadView(); }
    }
    paintHead(s);
    note.hidden = store.at === null;
    if (store.at === null) paintContext(); else { clear(chips); clear(addBox); clear(excerpt); loaded.textContent = ""; paintedChips = ""; }
    const statuses = turnStatuses(store.entries, s);
    empty.hidden = s.conversation.length > 0;
    syncList(conversation, s.conversation, (t) => t.turn,
      (t) => { const n = h("div", { class: "turn", data: { turn: t.turn } }); paintTurn(n, t, statuses.get(t.turn) ?? { kind: "thinking" }, s); return n; },
      (n, t) => paintTurn(n, t, statuses.get(t.turn) ?? { kind: "thinking" }, s));
    box.disabled = ro();
    for (const b of quickButtons()) b.disabled = ro();
  }

  const el = h("div", { class: "lens lens-agent", name: "Agent" },
    head, controls, noModel, use, note, loaded, chips, addBox, excerpt, quick, conversation, empty,
    h("div", { class: "ask-row" }, box));
  viewSig = store.at === null ? signature(store.live) : "";
  if (store.at === null) loadView();
  update();
  return {
    el, update,
    ask(text) { void send(text); },
    destroy() { destroyed = true; version++; },
  };
}
