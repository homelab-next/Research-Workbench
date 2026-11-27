import { activeOverrules, BASIS_TEXT, latestDraft, overruleSays, runQuestions } from "../../core/state";
import type { CaseState, QuestionState } from "../../core/state";
import { PERSON_BASES } from "../../core/types";
import type { PersonBasis } from "../../core/types";
import type { Open } from "../app";
import { cardChip, tag } from "../chips";
import { clear } from "../dom";
import { refusalLine } from "../refusal";
import { REPLAY_REFUSAL } from "../ui";
import type { Ui, View } from "../ui";

interface Fields { text: string; basis: PersonBasis; detail: string }
/** What the person has typed into an answer, per case store: kept when the form is drawn again in another place (the panel, the Narrative lens). */
const typed = new WeakMap<object, Map<string, Fields>>();

/** The questions of this run, and any earlier one still unanswered (it can still be answered), in the order asked. */
export function shownQuestions(s: CaseState): QuestionState[] {
  const now = new Set(runQuestions(s).map((q) => q.id));
  return Object.values(s.questions).filter((q) => now.has(q.id) || q.answer === null).sort((a, b) => a.seq - b.seq);
}

const runGoing = (s: CaseState): boolean => s.run.status !== "none" && s.run.status !== "finished";

/**
 * "Questions for you (N)": each question a stage put to the person, with why it matters, what it is about, the stage that asked, and an answer form that
 * sends `answer_question`. An answered question is one line with its card. The same component is drawn under the brief and at the top of the Narrative lens.
 * An answer passes no gate.
 */
export function makeQuestions(ui: Ui, open: Open, opts: { class?: string } = {}): View {
  const { h } = ui;
  const { store, nav } = open;
  const el = h("div", { class: `questions-box${opts.class === undefined ? "" : ` ${opts.class}`}` });
  const ro = (): boolean => store.at !== null;
  const owns = <T,>(o: Record<string, T>, k: string): boolean => Object.hasOwn(o, k);
  let fields = typed.get(store);
  if (fields === undefined) { fields = new Map(); typed.set(store, fields); }
  const values = fields;
  const fieldsOf = (id: string): Fields => {
    let v = values.get(id);
    if (v === undefined) { v = { text: "", basis: "unstated", detail: "" }; values.set(id, v); }
    return v;
  };
  /** Answers sent and not yet seen: the entry's seq once the server has answered, null while it is awaited. */
  const inflight = new Map<string, number | null>();
  let version = 0;
  /** The server's words when it refused an answer, beside that answer's form until it is sent again (slice 10). */
  const refusals = new Map<string, string>();
  const chipFor = (s: CaseState, id: string): Node =>
    (owns(s.cards, id) ? cardChip(ui, id, (c) => nav.focusCard(c), s.cards[id]!.place !== "lane") : ui.doc.createTextNode(id));

  const questionTag = (s: CaseState, q: QuestionState): HTMLElement =>
    q.answer !== null ? tag(ui, "done", "answered")
      : q.waived !== null ? tag(ui, "human", "went on without your answer", "The run went on without the answer; you can still give it")
        : q.blocking && q.run === s.run.id && runGoing(s) ? tag(ui, "attention", "the run waits on this", "The run does not go past this stage until you answer, or resume without the answer")
          : tag(ui, "human", "question");
  const form = (q: QuestionState): HTMLElement => {
    const v = fieldsOf(q.id);
    const busy = inflight.has(q.id);
    const off = (): boolean => ro() || busy || v.text.trim() === "";
    const send = h("button", {
      type: "button", class: "primary", data: { action: "answer-question" }, disabled: off(), title: ro() ? REPLAY_REFUSAL : `Answer ${q.id}; the answer is a card of yours`,
      on: { click: () => {
        if (off() || inflight.has(q.id)) return;
        inflight.set(q.id, null); refusals.delete(q.id); version++; render();
        void ui.send("answer_question", { question: q.id, answer: v.text.trim(), basis: v.basis, detail: v.detail.trim() }, undefined, undefined, (why) => { refusals.set(q.id, why); }).then((r) => {
          if (r === null) inflight.delete(q.id); else { inflight.set(q.id, r.seq); values.delete(q.id); }
          version++; render();
        });
      } },
      name: `Answer ${q.id}`,
    }, "Answer") as HTMLButtonElement;
    const basis = h("select", {
      name: `How you know the answer to ${q.id}`, disabled: ro(),
      on: { change: (e) => { v.basis = (e.target as HTMLSelectElement).value as PersonBasis; } },
    }, PERSON_BASES.map((b) => h("option", { value: b }, BASIS_TEXT[b]))) as HTMLSelectElement;
    basis.value = v.basis;
    return h("div", { class: "answer-form" },
      h("textarea", {
        name: `Answer to ${q.id}`, value: v.text, disabled: ro(), placeholder: "Your answer",
        on: { input: (e) => { v.text = (e.target as HTMLTextAreaElement).value; send.disabled = off(); } },
      }),
      h("label", null, "How you know ", basis),
      h("input", { type: "text", name: `How you know the answer to ${q.id}, in detail`, value: v.detail, disabled: ro(), placeholder: "How you know (optional)", on: { input: (e) => { v.detail = (e.target as HTMLInputElement).value; } } }),
      send, refusalLine(h, refusals.get(q.id), `q:${q.id}`));
  };
  const build = (s: CaseState): Node[] => {
    const qs = shownQuestions(s);
    if (qs.length === 0) return [];
    const title = (id: string | null): string => (id === null ? "an agent" : s.run.stages.find((x) => x.id === id)?.title ?? id);
    const waiting = qs.filter((q) => q.answer === null).length;
    return [h("h3", { class: "section-title" }, `Questions for you (${waiting})`), ...qs.map((q) => q.answer !== null
      // answered: one line, the question's text and the card that answers it
      ? h("div", { class: "question answered", data: { question: q.id } },
        questionTag(s, q), ` ${q.id} `, h("span", { class: "text", title: q.text }, q.text), " · Your answer: ", h("span", { class: "answer" }, chipFor(s, q.answer.card)))
      : h("div", { class: "question open", data: { question: q.id } },
        questionTag(s, q), ` ${q.id}`,
        h("p", { class: "text" }, q.text),
        h("p", { class: "why" }, `Why it matters: ${q.why}`),
        q.cards.length === 0 ? null : h("p", { class: "cards" }, h("span", { class: "label" }, "Cards "), q.cards.map((c) => [chipFor(s, c), " "])),
        q.about.length === 0 ? null : h("p", { class: "about" }, `About: ${q.about.map((o) => `${o.type} ${o.value}`).join(", ")}`),
        h("p", { class: "asked-by" }, `asked by ${title(q.stage)}`),
        form(q)))];
  };

  let sig: unknown[] | null = null;
  const render = (): void => {
    const s = store.shown;
    for (const [k, seq] of [...inflight]) if (seq !== null && store.live.seq >= seq) { inflight.delete(k); version++; }
    const now = [s.questions, s.run, s.cards, ro(), version];
    if (sig !== null && sig.every((x, i) => x === now[i])) return;
    sig = now;
    // the control that had focus has it again once the box is drawn anew
    const active = ui.doc.activeElement;
    const name = active !== null && el.contains(active) ? active.getAttribute("aria-label") : null;
    clear(el);
    for (const n of build(s)) el.appendChild(n);
    if (name !== null) {
      const again = [...el.querySelectorAll("input, button, textarea, select")].find((n) => n.getAttribute("aria-label") === name) as HTMLElement | undefined;
      again?.focus();
    }
  };
  render();
  return { el, update: render };
}

/**
 * Under the brief, on every case screen: "Questions for you (N)", and at the publish gate each finding of the draft with an Overrule button that opens its
 * form in the Narrative lens. While the Narrative lens is open it holds both itself, so this panel is empty and no form is on screen twice.
 */
export function makeQuestionsPanel(ui: Ui, open: Open, lens: () => string | null): View {
  const { h } = ui;
  const { store, nav } = open;
  const questions = makeQuestions(ui, open);
  const findings = h("div", { class: "gate-findings" });
  const el = h("section", { class: "questions-panel", name: "Questions for you" });
  let sig: unknown[] | null = null;
  const paintFindings = (s: CaseState): void => {
    const d = latestDraft(s);
    const pub = d !== null && s.published.length > 0 && s.published[s.published.length - 1]!.draft_hash === d.hash;
    const now = [d, s.overrules, s.conflicts, s.run.waiting, pub, store.at];
    if (sig !== null && sig.every((x, i) => x === now[i])) return;
    sig = now;
    clear(findings);
    if (d === null || pub || s.run.waiting !== "publish") return;
    const active = new Map(activeOverrules(s).map((o) => [o.finding, o]));
    findings.append(
      h("h3", { class: "section-title" }, `Findings at the publish gate (draft ${d.n})`),
      ...d.product.key_findings.map((f) => {
        const o = active.get(f.id);
        return h("div", { class: "gate-finding", data: { finding: f.id } },
          h("span", { class: "finding-id" }, f.id), " ",
          h("span", { class: "statement", title: f.statement }, f.statement), " ",
          o === undefined ? null : h("span", { class: "overrule-now tag tag-human" }, `You overruled: ${overruleSays(o)}`), " ",
          h("button", {
            type: "button", class: "overrule-toggle", name: `Overrule ${f.id} in the Narrative lens`, data: { action: "open-overrule" }, disabled: store.at !== null,
            title: store.at !== null ? REPLAY_REFUSAL : `Open ${f.id}'s Overrule form in the Narrative lens; an overrule passes no gate`,
            on: { click: () => nav.openLens("narrative", `overrule:${f.id}`) },
          }, "Overrule"));
      }));
  };
  const render = (): void => {
    if (lens() === "narrative") {
      if (el.firstChild !== null) clear(el);
      el.hidden = true;
      return;
    }
    if (el.firstChild === null) el.append(questions.el, findings);
    questions.update();
    paintFindings(store.shown);
    el.hidden = questions.el.firstChild === null && findings.firstChild === null;
  };
  render();
  return { el, update: render };
}
