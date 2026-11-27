// Build with help (slice 12, part B): the loop builder's chat beside the Loops screen and a loop's screen. The sessions about that loop, newest
// first, and New conversation; the open session's turns as the Agent lens draws them; under the composer, what waits for the person: each proposed
// change file by file, as a diff to Accept or Reject, and each probe, to Approve or Reject. Every word from the model or a manifest is a text node;
// nothing is accepted or approved but by the person's own button (Enter in the composer only sends the question).
import { MARKINGS } from "../../core/types";
import type { CaseState } from "../../core/state";
import type { Entry, Marking, ModelChoice } from "../../core/types";
import type { BuilderFileView, BuilderSummaryView, BuilderView, CommandResult, DiffLine } from "../../core/wire";
import type { Shell } from "../app";
import { markingChip } from "../chips";
import { clear } from "../dom";
import { refusalLine } from "../refusal";
import { CaseStore, follow } from "../store";

type Change = BuilderView["changes"][number];
type Probe = BuilderView["probes"][number];

const NO_ANSWER = "The server did not answer.";
const STALE = "This file changed on disk since it was proposed, so it cannot be accepted.";
/** The first rows of a probe's card that are shown. */
const FIRST_ROWS = 5;
const OP_CLASS: Record<DiffLine["op"], string> = { "+": "diff-added", "-": "diff-removed", " ": "diff-context" };
const modelWords = (m: ModelChoice): string => `${m.provider} ${m.model}${m.effort === null ? "" : ` · effort ${m.effort}`}`;
/** The entries after which what the view says may have changed: a proposal, a decision, a probe's card, the model. */
const VIEW_TYPES = new Set<Entry["type"]>(["builder.proposed", "builder.decided", "builder.probe_asked", "builder.probe_decided", "card.created", "stage.model_set"]);

/** Where a question stands, read from the entries: answered, still thinking, or why it will not be answered. */
function turnStatus(entries: readonly Entry[], t: CaseState["conversation"][number]): string | null {
  if (t.answer !== null) return null;
  const requests = new Set<string>();
  let why: string | null = null;
  for (const e of entries) {
    if (e.actor.kind !== "agent") continue;
    if (e.type === "model.request" && e.cause === t.asked_seq) requests.add(e.payload.request);
    else if (e.type === "model.blocked" && e.cause === t.asked_seq) why = `blocked: the model may not receive ${e.payload.marking}`;
    else if (e.type === "model.declined" && requests.has(e.payload.request)) why = `declined: ${e.payload.reason}`;
  }
  if (why !== null) return why;
  if (t.ended !== null) return t.ended === "interrupted" ? "interrupted" : `failed: ${t.ended}`;
  return "thinking…";
}

/** `onWritten` is called after an accepted file is written, so the screen that holds the panel can read the loops again. */
export function builderPanel(shell: Shell, opts: { loop: string | null; onWritten?: () => void }): { el: HTMLElement; destroy(): void } {
  const { ui } = shell;
  const h = ui.h;
  let destroyed = false;
  let sessions: BuilderSummaryView[] | null = null;
  let listFailed = false;
  let openId: string | null = null;
  let store: CaseStore | null = null;
  let stopFollow: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  let view: BuilderView | null = null;
  let viewFailed = false;
  let viewAsked = 0;
  /** The seq up to which the entries have been looked at for a reason to read the view again. */
  let seen = 0;
  /** What the server refused, beside the control that sent it, by key; and the acts in flight. */
  const refused = new Map<string, string>();
  const busy = new Set<string>();
  /** What was typed into each costly probe's budget box, and which file disclosures the person opened or closed. */
  const budgets = new Map<string, string>();
  const shut = new Map<string, boolean>();

  const markings = (): Marking[] => {
    const allowed = ui.me.markings.length === 0 ? [...MARKINGS] : ui.me.markings;
    return MARKINGS.filter((m) => allowed.includes(m));
  };
  const models = (): ModelChoice[] => ui.ref.stage_models;

  // ---------- the head, the sessions and New conversation ----------
  const chip = h("span", { class: "builder-marking" });
  const head = h("header", { class: "builder-head" }, h("h2", null, "Build with help"), " ", chip);
  const listEl = h("ul", { class: "builder-sessions", role: "list" });
  const newMarking = h("select", { name: "Marking" }, markings().map((m) => h("option", { value: m }, m))) as HTMLSelectElement;
  newMarking.value = markings()[0] ?? "";
  const newModel = h("select", { name: "Model" }, h("option", { value: "" }, "the default model"),
    models().map((m, i) => h("option", { value: String(i) }, modelWords(m)))) as HTMLSelectElement;
  newModel.value = "";
  const newButton = h("button", { type: "button", data: { action: "new-builder" }, on: { click: () => void startNew() } }, "New conversation") as HTMLButtonElement;
  const newRefusal = h("div", { class: "builder-new-refusal" });
  const newRow = h("div", { class: "builder-new" }, h("label", null, "Marking ", newMarking), " ", h("label", null, "Model ", newModel), " ", newButton, newRefusal);

  const readList = (): void => {
    // a read that throws, as one that fails, leaves the screen standing and says so
    Promise.resolve().then(() => ui.api.builders()).then((list) => {
      if (destroyed) return;
      sessions = list.filter((b) => b.loop === opts.loop);
      listFailed = false;
      paintList();
    }, () => { if (destroyed) return; listFailed = true; paintList(); });
  };
  const paintList = (): void => {
    clear(listEl);
    if (listFailed) { listEl.appendChild(h("li", { class: "load-error say", role: "alert" }, "The builder sessions could not be read")); return; }
    if (sessions === null) return;
    if (sessions.length === 0) listEl.appendChild(h("li", { class: "muted" }, "No conversation yet."));
    for (const b of sessions) {
      const waiting = [b.open_changes > 0 ? `${b.open_changes} change${b.open_changes === 1 ? "" : "s"} waiting` : null, b.open_probes > 0 ? `${b.open_probes} probe${b.open_probes === 1 ? "" : "s"} waiting` : null]
        .filter((x): x is string => x !== null);
      listEl.appendChild(h("li", { data: { builder: b.id } },
        h("button", { type: "button", class: "link-button", data: { action: "open-builder" }, current: b.id === openId, on: { click: () => openSession(b.id) } }, `${b.id} · ${b.title}`),
        " ", h("span", { class: "muted" }, [`${b.turns} turn${b.turns === 1 ? "" : "s"}`, ...waiting].join(" · ")), " ", markingChip(ui, b.marking)));
    }
  };
  const startNew = async (): Promise<void> => {
    if (busy.has("new")) return;
    busy.add("new"); refused.delete("new"); paintNew();
    const marking = newMarking.value as Marking;
    const pick = newModel.value === "" ? null : models()[Number(newModel.value)] ?? null;
    let r: { id: string } | { refused: string[] };
    try { r = await ui.api.newBuilder(opts.loop, marking); } catch { r = { refused: [NO_ANSWER] }; }
    if (destroyed) return;
    if ("refused" in r) { busy.delete("new"); refused.set("new", r.refused.join("; ")); paintNew(); return; }
    if (pick !== null) {
      const m = await answer(ui.api.builderModel(r.id, pick));
      if (destroyed) return;
      if (!m.ok) refused.set("model", m.refused.join("; "));
    }
    busy.delete("new"); paintNew();
    openSession(r.id);
    readList();
  };
  const paintNew = (): void => {
    newButton.disabled = busy.has("new");
    clear(newRefusal);
    const line = refusalLine(h, refused.get("new"), `builder-new:${opts.loop ?? ""}`);
    if (line !== null) newRefusal.appendChild(line);
  };
  const answer = async (p: Promise<CommandResult>): Promise<CommandResult> => {
    try { return await p; } catch { return { ok: false, refused: [NO_ANSWER] }; }
  };

  // ---------- the open session ----------
  const openEl = h("section", { class: "builder-open", hidden: true });
  const openHead = h("div", { class: "builder-open-head" });
  const turns = h("div", { class: "builder-turns conversation" });
  const pending = h("p", { class: "builder-pending muted", role: "status" });
  const askRefusal = h("div", { class: "builder-ask-refusal" });
  const box = h("textarea", {
    name: "Ask the builder", placeholder: "ask the builder to make or change a loop …", value: "",
    on: { keydown: (e) => {
      const k = e as KeyboardEvent;
      if (k.key !== "Enter" || k.shiftKey || k.isComposing) return;
      k.preventDefault();
      void ask();
    } },
  }) as HTMLTextAreaElement;
  const waits = h("div", { class: "builder-waits" });
  openEl.append(openHead, turns, h("div", { class: "ask-row" }, box), pending, askRefusal, waits);

  const ask = async (): Promise<void> => {
    const id = openId;
    const text = box.value.trim();
    if (id === null || text === "" || busy.has("ask")) return;
    const sent = box.value;
    busy.add("ask"); refused.delete("ask"); pending.textContent = "Sending…"; paintAskRefusal();
    const r = await answer(ui.api.builderAsk(id, text));
    busy.delete("ask");
    if (destroyed || openId !== id) return;
    pending.textContent = "";
    if (r.ok) { if (box.value === sent) box.value = ""; } else refused.set("ask", r.refused.join("; "));
    paintAskRefusal();
  };
  const paintAskRefusal = (): void => {
    clear(askRefusal);
    const line = refusalLine(h, refused.get("ask"), `builder-ask:${openId ?? ""}`);
    if (line !== null) askRefusal.appendChild(line);
  };

  const closeSession = (): void => {
    unsubscribe?.(); stopFollow?.();
    unsubscribe = null; stopFollow = null; store = null; view = null; viewFailed = false; seen = 0; viewAsked++;
    refused.clear(); budgets.clear(); shut.clear();
  };
  const openSession = (id: string): void => {
    if (openId === id && store !== null) return;
    closeSession();
    openId = id;
    const s = new CaseStore(id);
    store = s;
    unsubscribe = s.subscribe(() => onEntries());
    stopFollow = follow(s, ui.api.entries, ui.win, "builders");
    box.value = ""; pending.textContent = "";
    readView();
    paintList();
    paintOpen();
  };
  const readView = (): void => {
    const id = openId;
    if (id === null) return;
    const mine = ++viewAsked;
    ui.api.builderView(id).then((v) => {
      if (destroyed || mine !== viewAsked) return;
      view = v; viewFailed = false; paintOpen();
    }, () => { if (destroyed || mine !== viewAsked) return; viewFailed = true; paintOpen(); });
  };
  const onEntries = (): void => {
    if (destroyed || store === null) return;
    const fresh = store.entries.filter((e) => e.seq > seen);
    seen = store.live.seq;
    if (fresh.some((e) => VIEW_TYPES.has(e.type))) readView();
    paintOpen();
  };

  // ---------- painting the open session ----------
  const paintOpen = (): void => {
    openEl.hidden = openId === null;
    clear(chip);
    if (openId === null) return;
    const marking = view?.marking ?? sessions?.find((b) => b.id === openId)?.marking ?? null;
    if (marking !== null) chip.appendChild(markingChip(ui, marking));
    // keep the focus where it was across a repaint: the control is found again by its key
    const focused = ui.doc.activeElement as HTMLElement | null;
    const keep = focused !== null && waits.contains(focused) ? (focused.dataset.key ?? null) : null;
    paintOpenHead();
    paintTurns();
    paintWaits();
    if (keep !== null) (waits.querySelector(`[data-key="${keep.replace(/["\\]/g, "")}"]`) as HTMLElement | null)?.focus();
  };

  const paintOpenHead = (): void => {
    clear(openHead);
    const current = view?.model ?? null;
    const list = models();
    const at = current === null ? -1 : list.findIndex((m) => m.provider === current.provider && m.model === current.model && m.effort === current.effort);
    const sel = h("select", {
      name: "Model of this conversation", disabled: view === null || busy.has("model"),
      on: { change: (e) => {
        const picked = list[Number((e.target as HTMLSelectElement).value)];
        if (picked === undefined || openId === null) return;
        const id = openId;
        busy.add("model"); refused.delete("model");
        void answer(ui.api.builderModel(id, picked)).then((r) => {
          busy.delete("model");
          if (destroyed || openId !== id) return;
          if (!r.ok) refused.set("model", r.refused.join("; "));
          readView();
        });
      } },
    }, at >= 0 ? null : h("option", { value: "", hidden: true }, current === null ? "the default model" : modelWords(current)),
    list.map((m, i) => h("option", { value: String(i) }, modelWords(m)))) as HTMLSelectElement;
    sel.value = at < 0 ? "" : String(at);
    openHead.append(h("p", { class: "builder-id" }, openId ?? ""), h("label", null, "Model ", sel));
    if (viewFailed) openHead.appendChild(h("p", { class: "load-error say", role: "alert" }, "What this conversation proposed could not be read"));
    const line = refusalLine(h, refused.get("model"), `builder-model:${openId ?? ""}`);
    if (line !== null) openHead.appendChild(line);
  };

  const paintTurns = (): void => {
    clear(turns);
    if (store === null) return;
    const s = store.live;
    if (s.conversation.length === 0) { turns.appendChild(h("p", { class: "empty" }, "Nothing asked yet. Say what the loop should do, or what to change.")); return; }
    for (const t of s.conversation) {
      const status = turnStatus(store.entries, t);
      turns.appendChild(h("div", { class: "turn", data: { turn: t.turn } },
        h("p", { class: "question" }, t.asked),
        status === null
          ? h("div", { class: "answer" }, h("p", { class: "answer-text" }, t.answer ?? ""))
          : h("p", { class: `status${status === "thinking…" ? "" : " attention"}`, role: "status" }, status)));
    }
  };

  const paintWaits = (): void => {
    clear(waits);
    if (view === null) return;
    for (const c of view.changes) waits.appendChild(changeBlock(c));
    for (const p of view.probes) waits.appendChild(probeBlock(p));
  };

  // ---------- a proposed change ----------
  const decide = async (change: string, file: number, accept: boolean): Promise<void> => {
    const id = openId;
    const key = `file:${change}/${file}`;
    if (id === null || busy.has(key)) return;
    busy.add(key); refused.delete(key); paintOpen();
    const r = await answer(ui.api.builderDecide(id, change, file, accept));
    busy.delete(key);
    if (destroyed || openId !== id) return;
    if (!r.ok) refused.set(key, r.refused.join("; "));
    else if (accept) opts.onWritten?.();
    readView();
    paintOpen();
  };
  const diffLines = (lines: readonly DiffLine[]): HTMLElement =>
    h("div", { class: "diff", role: "list" }, lines.map((l) => h("div", { class: `diff-line ${OP_CLASS[l.op] ?? "diff-context"}`, role: "listitem" }, `${l.op}${l.text}`)));
  const fileBlock = (c: Change, f: BuilderFileView): HTMLElement => {
    const key = `file:${c.id}/${f.index}`;
    const decided = f.decided;
    const block = h("details", { class: `builder-file${f.stale && decided === null ? " stale" : ""}`, data: { file: String(f.index) },
      on: { toggle: (e) => { shut.set(key, !(e.target as HTMLDetailsElement).open); } } },
      h("summary", null, h("span", { class: "file-path" }, f.path), " ", h("span", { class: `chip file-state${f.new_file ? " new" : ""}` }, f.new_file ? "new file" : "changed"),
        " ", h("span", { class: "muted file-kind" }, `${f.kind} ${f.id}`)),
      decided === null ? null : h("p", { class: `file-decided tag ${decided.accepted ? "tag-done" : "tag-human"}` }, decided.accepted ? "Accepted" : "Rejected"),
      decided === null && f.stale ? h("p", { class: "file-stale tag tag-attention" }, STALE) : null,
      diffLines(f.lines),
      decided !== null ? null : h("div", { class: "file-actions" },
        f.stale ? null : h("button", { type: "button", class: "primary", data: { action: "accept", key: `${key}:accept` }, disabled: busy.has(key),
          title: `Write ${f.path} into the loop's root`, on: { click: () => void decide(c.id, f.index, true) } }, "Accept"),
        " ",
        h("button", { type: "button", data: { action: "reject", key: `${key}:reject` }, disabled: busy.has(key), title: `Leave ${f.path} as it is`,
          on: { click: () => void decide(c.id, f.index, false) } }, "Reject")),
      refusalLine(h, refused.get(key), `builder:${openId ?? ""}:${key}`)) as HTMLDetailsElement;
    block.open = !(shut.get(key) ?? decided !== null);
    return block;
  };
  const changeBlock = (c: Change): HTMLElement => h("article", { class: "builder-change", data: { change: c.id } },
    h("h3", { class: "change-title" }, c.title),
    h("p", { class: "change-why" }, c.why),
    c.files.map((f) => fileBlock(c, f)));

  // ---------- a probe ----------
  const decideProbe = async (p: Probe, approve: boolean): Promise<void> => {
    const id = openId;
    const key = `probe:${p.id}`;
    if (id === null || busy.has(key)) return;
    let budget: number | null = null;
    const typed = (budgets.get(p.id) ?? "").trim();
    if (approve && p.costly && typed !== "") {
      budget = Number(typed);
      if (!Number.isFinite(budget) || budget <= 0) { refused.set(key, "a budget is a number above zero"); paintOpen(); return; }
    }
    busy.add(key); refused.delete(key); paintOpen();
    const r = await answer(ui.api.builderProbe(id, p.id, approve, budget));
    busy.delete(key);
    if (destroyed || openId !== id) return;
    if (!r.ok) refused.set(key, r.refused.join("; "));
    readView();
    paintOpen();
  };
  const cardOf = (p: Probe): HTMLElement | null => {
    const id = p.decided?.card ?? null;
    if (id === null || store === null) return null;
    const c = store.live.cards[id];
    if (c === undefined) return h("div", { class: "probe-card" }, h("p", { class: "card-title" }, id));
    const rows = c.rows.slice(0, FIRST_ROWS);
    return h("div", { class: "probe-card" },
      h("p", null, h("span", { class: "card-title" }, `${c.id} · ${c.title}`), " ", markingChip(ui, c.marking)),
      c.columns.length === 0 ? null : h("table", null,
        h("thead", null, h("tr", null, c.columns.map((n) => h("th", null, n)))),
        h("tbody", null, rows.map((row) => h("tr", null, c.columns.map((_n, i) => h("td", null, row[i] === null || row[i] === undefined ? "" : String(row[i]))))))),
      c.row_count > rows.length ? h("p", { class: "muted" }, `first ${rows.length} of ${c.row_count} rows`) : null);
  };
  const probeBlock = (p: Probe): HTMLElement => {
    const key = `probe:${p.id}`;
    const d = p.decided;
    const what = p.kind === "pivot"
      ? h("p", { class: "probe-what" }, `the pivot ${p.pivot ?? "?"} on ${p.value === null ? "no value" : `${p.value.type} ${p.value.value}`}`)
      : h("div", { class: "probe-what" }, h("p", null, "the query"), h("pre", { class: "probe-query query" }, p.text ?? ""));
    const outcome = d === null ? null
      : [d.approved ? "Approved" : "Rejected", d.outcome === "rejected" ? "" : `: ${d.outcome}`, d.detail === "" ? "" : ` · ${d.detail}`].join("");
    return h("article", { class: "builder-probe", data: { probe: p.id } },
      h("h3", null, "A probe to approve"),
      what,
      h("p", { class: "probe-source" }, `on the source ${p.source}`),
      h("p", { class: "probe-why" }, p.why),
      p.costly ? h("p", null, h("span", { class: "probe-costly tag tag-attention" }, "costly")) : null,
      d === null ? h("div", { class: "probe-actions" },
        p.costly ? h("label", null, "Budget ", h("input", {
          type: "number", name: "Budget", value: budgets.get(p.id) ?? "", data: { key: `${key}:budget` },
          on: { input: (e) => { budgets.set(p.id, (e.target as HTMLInputElement).value); } },
        })) : null,
        " ",
        h("button", { type: "button", class: "primary", data: { action: "approve", key: `${key}:approve` }, disabled: busy.has(key), title: "Run this probe, in your name",
          on: { click: () => void decideProbe(p, true) } }, "Approve"),
        " ",
        h("button", { type: "button", data: { action: "reject", key: `${key}:reject` }, disabled: busy.has(key), title: "Do not run this probe",
          on: { click: () => void decideProbe(p, false) } }, "Reject"))
        : h("p", { class: `probe-outcome tag ${d.approved && d.outcome === "ran" ? "tag-done" : "tag-human"}` }, outcome),
      d === null ? null : cardOf(p),
      refusalLine(h, refused.get(key), `builder:${openId ?? ""}:${key}`));
  };

  const el = h("section", { class: "builder-panel", data: { panel: "builder" } }, head,
    h("p", { class: "muted" }, opts.loop === null
      ? "Ask the builder to make a loop. It proposes files; you accept each one. It may ask to look at a source; you approve each look."
      : "Ask the builder to change this loop. It proposes files; you accept each one. It may ask to look at a source; you approve each look."),
    listEl, newRow, openEl);
  readList();
  paintList();
  paintNew();
  return { el, destroy() { destroyed = true; closeSession(); openId = null; } };
}
