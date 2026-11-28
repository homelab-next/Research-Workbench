// The known answer on a published product (slice 14): what the person knows the right answer was, and the findings they expect, which a later
// improve run scores its probes against. It is shown under the product it is about, as text, with who set it and when; the form is a person's
// who may write (off while replaying), and never in a probe child or an improve case (neither holds a known answer). The marking offered is
// never below the case's or the product's. Save sends set_known_answer and Withdraw withdraw_known_answer; what is saved arrives on the stream.
import type { CaseState } from "../../core/state";
import { CONFIDENCES, MARKINGS } from "../../core/types";
import type { ExpectedFinding, Marking } from "../../core/types";
import { markingChip } from "../chips";
import { clear } from "../dom";
import { refusalLine } from "../refusal";
import type { CaseStore } from "../store";
import { timeEl } from "../time";
import type { Ui, View } from "../ui";

/** As the server holds them: a text of 1 to 600 characters, at most 12 expected findings, a claim of 1 to 300. */
const TEXT_MAX = 600;
const FINDINGS_MAX = 12;
const CLAIM_MAX = 300;

export interface AnswerContext { ui: Ui; store: Pick<CaseStore, "id" | "shown" | "at"> }

interface Row { el: HTMLElement; claim: HTMLInputElement; likelihood: HTMLSelectElement | HTMLInputElement; confidence: HTMLSelectElement }

const strictest = (a: Marking, b: Marking): Marking => (MARKINGS.indexOf(a) >= MARKINGS.indexOf(b) ? a : b);

/** The marking of published product `n`'s draft; null when the case holds no such product. */
function productMarking(s: CaseState, n: number): Marking | null {
  const pub = s.published.find((x) => x.n === n);
  if (pub === undefined) return null;
  return s.drafts.find((d) => d.hash === pub.draft_hash)?.product.marking ?? null;
}

/** Whether this case may hold a known answer at all: a probe child and an improve case hold none. */
const holdsAnswers = (s: CaseState): boolean => s.improve.probe_of === null && s.improve.request === null;

/** The known answer of published product `product`: shown as text, and, for a person who may write, the form that sets or withdraws it. */
export function answerPanel(ctx: AnswerContext, product: number): View {
  const { ui, store } = ctx;
  const { h } = ui;
  // the case's own standard's terms, as the server checks them; the profile's until they have come in
  let scale: readonly string[] | null = null;
  const terms = (): readonly string[] => scale ?? ui.ref.likelihood;
  /** The person may set an answer here; while replaying the controls are drawn as they would be live, and every one is off. */
  const writable = (s: CaseState): boolean => ui.me.role === "analyst" && holdsAnswers(s) && productMarking(s, product) !== null;
  const replaying = (): boolean => store.at !== null;

  const savedBox = h("div", { class: "known-answer-saved-box" });
  const text = h("textarea", { name: "Known answer text", placeholder: "What the right answer was, in your words", on: { input: () => { dirty = true; paintButtons(); } } }) as HTMLTextAreaElement;
  text.maxLength = TEXT_MAX;
  const rowsBox = h("div", { class: "answer-rows" });
  const rows: Row[] = [];
  const addRow = h("button", { type: "button", class: "action", data: { action: "add-finding" }, on: { click: () => { dirty = true; newRow(null); paintButtons(); rows[rows.length - 1]?.claim.focus(); } } }, "Add an expected finding") as HTMLButtonElement;
  const marking = h("select", { name: "Answer marking", on: { change: () => { dirty = true; } } }) as HTMLSelectElement;
  const save = h("button", { type: "button", class: "primary", data: { action: "save-answer" }, on: { click: () => { void doSave(); } } }, "Save") as HTMLButtonElement;
  const saveRefused = h("div", { class: "refused-box" });
  const summary = h("summary", null, "Set the known answer");
  const form = h("details", { class: "known-answer-form", on: { toggle: () => { if (form.open) askScale(); } } }, summary,
    h("div", { class: "form-body" },
      h("label", null, "The answer ", text),
      h("p", { class: "muted" }, "The findings you expect, each with its likelihood and confidence"),
      rowsBox, addRow,
      h("label", null, "Marking ", marking),
      h("div", { class: "save-row" }, save, saveRefused))) as HTMLDetailsElement;
  const reason = h("input", { type: "text", name: "Reason to withdraw", placeholder: "Why this answer no longer holds", on: { input: () => paintButtons() } }) as HTMLInputElement;
  const withdraw = h("button", { type: "button", data: { action: "withdraw-answer" }, on: { click: () => { void doWithdraw(); } } }, "Withdraw") as HTMLButtonElement;
  const withdrawRefused = h("div", { class: "refused-box" });
  const withdrawRow = h("div", { class: "known-answer-withdraw" }, h("label", null, "Withdraw the answer ", reason), withdraw, withdrawRefused);
  const controlsBox = h("div", { class: "known-answer-controls" });
  const el = h("section", { class: "known-answer", data: { product: String(product) }, name: `Known answer for product ${product}` }, h("h3", null, "Known answer"), savedBox, controlsBox);

  let dirty = false;
  let busy = false;
  // asked for once, when the person opens the form: a case being unloaded or a reader's view asks nothing
  let askedScale = false;
  const askScale = (): void => {
    if (askedScale || !writable(store.shown) || replaying()) return;
    askedScale = true;
    ui.api.answerScale?.(store.id).then((got) => {
      if (!Array.isArray(got?.likelihood) || got.likelihood.join("\n") === terms().join("\n")) return;
      scale = got.likelihood.filter((t) => typeof t === "string");
      // the rows drawn so far are drawn again with the case's terms, keeping what was typed
      const kept = rows.map(valueOf);
      clear(rowsBox); rows.length = 0;
      for (const f of kept) newRow(f);
      if (rows.length === 0) newRow(null);
      paintButtons();
    }, () => { /* the profile's terms stay; the server refuses a term its standard does not have */ });
  };
  /** The seq of the saved answer the form was last filled from (0: none), and the floor its marking list was made for. */
  let filledFrom = -1;
  let floorShown: Marking | null = null;
  let shownSig: unknown[] = [];

  function newRow(f: ExpectedFinding | null): void {
    const n = rows.length + 1;
    const claim = h("input", { type: "text", name: `Claim ${n}`, placeholder: "a finding you expect the product to state", value: f?.claim ?? "", on: { input: () => { dirty = true; } } }) as HTMLInputElement;
    claim.maxLength = CLAIM_MAX;
    const t = terms();
    const likelihood = t.length === 0
      ? h("input", { type: "text", name: `Likelihood ${n}`, placeholder: "likelihood", value: f?.likelihood ?? "", on: { input: () => { dirty = true; } } }) as HTMLInputElement
      : h("select", { name: `Likelihood ${n}`, on: { change: () => { dirty = true; } } }, t.map((term) => h("option", { value: term }, term))) as HTMLSelectElement;
    if (t.length > 0) likelihood.value = f !== null && t.includes(f.likelihood) ? f.likelihood : t[Math.floor(t.length / 2)] ?? "";
    const confidence = h("select", { name: `Confidence ${n}`, on: { change: () => { dirty = true; } } }, CONFIDENCES.map((c) => h("option", { value: c }, c))) as HTMLSelectElement;
    confidence.value = f?.confidence ?? "moderate";
    const row: Row = {
      claim, likelihood, confidence,
      el: h("div", { class: "answer-row" }, claim, likelihood, confidence,
        h("button", { type: "button", class: "link-button", data: { action: "remove-finding" }, name: `Remove finding ${n}`, on: { click: () => { dirty = true; removeRow(row); } } }, "Remove")),
    };
    rows.push(row);
    rowsBox.append(row.el);
  }
  function removeRow(row: Row): void {
    const kept = rows.filter((r) => r !== row).map(valueOf);
    clear(rowsBox); rows.length = 0;
    for (const f of kept) newRow(f);
    if (rows.length === 0) newRow(null);
    paintButtons();
  }
  const valueOf = (r: Row): ExpectedFinding => ({ claim: r.claim.value, likelihood: r.likelihood.value, confidence: r.confidence.value as ExpectedFinding["confidence"] });

  /** Fills the form from the saved answer (or empties it), unless the person has typed in it since. */
  function fill(s: CaseState, floor: Marking): void {
    const known = Object.hasOwn(s.answers, String(product)) ? s.answers[String(product)]! : null;
    const from = known?.seq ?? 0;
    if (floor !== floorShown) {
      floorShown = floor;
      const chosen = marking.value;
      clear(marking);
      for (const m of MARKINGS.slice(MARKINGS.indexOf(floor))) marking.append(h("option", { value: m }, m));
      marking.value = [...marking.options].some((o) => o.value === chosen) ? chosen : floor;
    }
    if (from === filledFrom || dirty) return;
    filledFrom = from;
    text.value = known?.text ?? "";
    clear(rowsBox); rows.length = 0;
    for (const f of known?.findings ?? []) newRow(f);
    if (rows.length === 0) newRow(null);
    marking.value = known !== null && MARKINGS.indexOf(known.marking) >= MARKINGS.indexOf(floor) ? known.marking : floor;
    summary.textContent = known === null ? "Set the known answer" : "Change the known answer";
  }

  function paintButtons(): void {
    const t = text.value.trim();
    const ro = replaying();
    save.disabled = ro || busy || t === "" || t.length > TEXT_MAX;
    addRow.disabled = ro || busy || rows.length >= FINDINGS_MAX;
    withdraw.disabled = ro || busy || reason.value.trim() === "";
    for (const c of [text, marking, reason, ...rows.flatMap((r) => [r.claim, r.likelihood, r.confidence])]) c.disabled = ro;
    for (const b of rowsBox.querySelectorAll("[data-action=remove-finding]")) (b as HTMLButtonElement).disabled = ro;
  }

  const savedView = (s: CaseState): Node[] => {
    const known = Object.hasOwn(s.answers, String(product)) ? s.answers[String(product)]! : null;
    if (known === null) return [];
    return [h("div", { class: "known-answer-saved" },
      h("p", { class: "known-answer-by" }, `Set by ${known.by} at `, timeEl(ui, known.ts, "utc")),
      h("p", null, markingChip(ui, known.marking)),
      h("p", { class: "known-answer-text" }, known.text),
      known.findings.length === 0 ? h("p", { class: "muted" }, "No expected findings: the answer is judged from its text.")
        : h("ul", { class: "known-answer-findings" }, known.findings.map((f) => h("li", null, `${f.claim} · ${f.likelihood} · ${f.confidence} confidence`))))];
  };

  function update(): void {
    const s = store.shown;
    const known = Object.hasOwn(s.answers, String(product)) ? s.answers[String(product)]! : null;
    const show = holdsAnswers(s) && productMarking(s, product) !== null;
    el.hidden = !show || (known === null && !writable(s));
    const sig = [show, known, store.at, ui.me.role];
    if (sig.some((x, i) => x !== shownSig[i])) {
      shownSig = sig;
      clear(savedBox);
      if (show) for (const n of savedView(s)) savedBox.appendChild(n);
    }
    if (!show || !writable(s)) { if (controlsBox.firstChild !== null) clear(controlsBox); return; }
    const floor = strictest(s.meta?.marking ?? MARKINGS[0]!, productMarking(s, product)!);
    fill(s, floor);
    if (controlsBox.firstChild === null) controlsBox.append(form);
    if (known === null) withdrawRow.remove(); else if (withdrawRow.parentElement === null) controlsBox.append(withdrawRow);
    paintButtons();
  }

  async function doSave(): Promise<void> {
    if (busy || replaying() || !writable(store.shown)) return;
    const findings = rows.map(valueOf).map((f) => ({ ...f, claim: f.claim.trim() })).filter((f) => f.claim !== "");
    busy = true; paintButtons();
    clear(saveRefused); refusalLine(h, undefined, `answer:${product}`);
    const sent = await ui.send("set_known_answer", { product, text: text.value.trim(), findings, marking: marking.value as Marking }, undefined, undefined,
      (why) => { clear(saveRefused); saveRefused.append(refusalLine(h, why, `answer:${product}`)!); });
    busy = false;
    // a refusal leaves the form as typed; a save is filled again from what the stream brings
    if (sent !== null) { dirty = false; filledFrom = -1; form.open = false; }
    update();
  }

  async function doWithdraw(): Promise<void> {
    const why = reason.value.trim();
    if (busy || why === "" || replaying() || !writable(store.shown)) return;
    busy = true; paintButtons();
    clear(withdrawRefused); refusalLine(h, undefined, `withdraw:${product}`);
    const sent = await ui.send("withdraw_known_answer", { product, reason: why }, undefined, undefined,
      (w) => { clear(withdrawRefused); withdrawRefused.append(refusalLine(h, w, `withdraw:${product}`)!); });
    busy = false;
    if (sent !== null) { reason.value = ""; dirty = false; filledFrom = -1; }
    update();
  }

  return { el, update };
}
