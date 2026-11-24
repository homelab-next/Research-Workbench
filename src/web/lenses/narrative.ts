import { blockers, CARD_REF, latestDraft, publishable } from "../../core/state";
import type { CaseState } from "../../core/state";
import { CONFIDENCES } from "../../core/types";
import type { Actor, Draft, Finding, Product } from "../../core/types";
import type { Preview } from "../../core/wire";
import type { Open } from "../app";
import { cardChip, markingChip, tag } from "../chips";
import type { Child } from "../dom";
import { clear, fileLink } from "../dom";
import { narrativeMarkdown, SECTION_TITLES, TEXT_SECTIONS } from "../markdown";
import type { TextSection } from "../markdown";
import { REPLAY_REFUSAL } from "../ui";
import type { Ui, View } from "../ui";

export interface NarrativeView extends View {
  /** Opens the edit form and puts `[<card>]` at the caret of `section` (the one last focused, Summary at first). */
  cite(card: string, section?: string): void;
}

const TITLE = new Map<string, string>(SECTION_TITLES.map((s) => [s.id, s.title]));
const isText = (x: string): x is TextSection => (TEXT_SECTIONS as string[]).includes(x);
const byId = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });
const lines = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
const names = (a: Actor): string => a.id;

interface EditForm {
  base: string;
  el: HTMLElement;
  areas: Map<TextSection, HTMLTextAreaElement>;
  finding(id: string): { statement: HTMLTextAreaElement; likelihood: HTMLInputElement; confidence: HTMLSelectElement; basis: HTMLInputElement; cites: HTMLInputElement; assumptions: HTMLTextAreaElement; reasoning: HTMLTextAreaElement };
  reason: HTMLInputElement;
  save: HTMLButtonElement;
  sync(): void;
}

/** The Narrative lens (guide §5.3, spec §9.5): the draft, how the review stands, and the publish gate. Everything shown comes from the fold, the preview the server computes, and the recorded text. */
export function makeNarrative(ui: Ui, open: Open): NarrativeView {
  const { h } = ui;
  const { store, nav } = open;
  const el = h("div", { class: "lens lens-narrative", name: "Narrative" });
  const state = (): CaseState => store.shown;
  const ro = (): boolean => store.at !== null;
  const draftOf = (): Draft | null => latestDraft(state());
  const owns = <T,>(o: Record<string, T>, k: string): boolean => Object.hasOwn(o, k);
  const kept = (id: string): boolean => owns(state().cards, id) && state().cards[id]!.place === "lane";
  /** A draft can be edited while a run is going on: before the gate too (spec §9.5). */
  const canEdit = (s: CaseState): boolean => latestDraft(s) !== null && s.run.status !== "none" && s.run.status !== "finished";

  let destroyed = false;
  let edit: EditForm | null = null;
  let lastSection: TextSection = "summary";
  const caret = new Map<TextSection, number>();
  let saving = false;
  let rejecting = false;
  let rejectReason = "";
  let rejectStop = false;
  const answers = new Map<string, string>();
  const kinds = new Map<string, string>();
  const proposalText = new Map<string, string>();
  const proposalEdit = new Set<string>();
  let fallback: string | null = null;
  let focusFallback = false;
  let tab: string | null = null;
  let preview: { seq: number; value: Preview | "failed" } | null = null;
  let asked = -1;
  let pickerAt: HTMLElement | null = null;
  let focusedAtGate = false;
  /** Commands sent and not yet seen: the answer's seq once it has come (the press stays off until that entry is here), null while the answer is awaited. */
  const inflight = new Map<string, number | null>();
  let inflightVersion = 0;
  /** The files each published bundle's recorded manifest lists, by product number. */
  const bundles = new Map<number, string[] | "loading" | "failed">();
  let bundlesVersion = 0;

  const draftBox = h("div", { class: "draft" });
  const headBox = h("div", { class: "head-box" });
  const bodyBox = h("div", { class: "body-box" });
  const toolsBox = h("div", { class: "tools-box" });
  const reviewBox = h("div", { class: "review-box" });
  const previewBox = h("div", { class: "preview-box" });
  const gateBox = h("div", { class: "gate-box" });
  const copyBox = h("div", { class: "copy-box" });
  const proposalsBox = h("div", { class: "proposals-box" });
  draftBox.append(headBox, bodyBox);
  el.append(draftBox, toolsBox, gateBox, reviewBox, previewBox, copyBox, proposalsBox);

  // ---------- repainting a part only when what it shows has changed ----------
  const sigs = new Map<HTMLElement, unknown[]>();
  const keyOf = (n: Element | null): string | null => n === null ? null : [
    n.tagName, n.getAttribute("aria-label") ?? "", n.getAttribute("data-action") ?? "",
    n.closest("[data-challenge]")?.getAttribute("data-challenge") ?? "", n.closest("[data-proposal]")?.getAttribute("data-proposal") ?? "", n.getAttribute("data-tab") ?? "", n.getAttribute("data-pick") ?? "",
  ].join("|");
  const paint = (box: HTMLElement, sig: unknown[], build: () => Node[]): void => {
    const was = sigs.get(box);
    if (was !== undefined && was.length === sig.length && was.every((x, i) => x === sig[i])) return;
    sigs.set(box, sig);
    const active = ui.doc.activeElement;
    const key = active !== null && box.contains(active) ? keyOf(active) : null;
    clear(box);
    for (const n of build()) box.appendChild(n);
    if (key !== null) {
      const again = [...box.querySelectorAll("input, button, textarea, select")].find((n) => keyOf(n) === key) as HTMLElement | undefined;
      if (again !== undefined) {
        again.focus();
        const t = again as HTMLInputElement;
        if (typeof t.setSelectionRange === "function" && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) { try { t.setSelectionRange(t.value.length, t.value.length); } catch { /* not a text field */ } }
      }
    }
  };

  /** Sends a command once: until the server has answered and its entries are here, the same press does nothing. */
  const guarded = (key: string, command: string, args: Record<string, unknown>, then?: () => void): void => {
    if (inflight.has(key)) return;
    inflight.set(key, null); inflightVersion++;
    render();
    void ui.send(command, args).then((r) => {
      if (r === null) inflight.delete(key); else { inflight.set(key, r.seq); then?.(); }
      inflightVersion++;
      render();
    });
  };
  const loadBundle = (n: number): void => {
    if (bundles.has(n)) return;
    bundles.set(n, "loading");
    const entry = [...store.entries].reverse().find((e) => e.type === "product.published" && e.payload.n === n);
    const done = (v: string[] | "failed"): void => { bundles.set(n, v); bundlesVersion++; render(); };
    if (entry === undefined || entry.type !== "product.published") { done("failed"); return; }
    ui.api.blobText(store.id, entry.payload.bundle.blob).then((text) => {
      const files = (JSON.parse(text) as { manifest?: { files?: { name?: unknown }[] } }).manifest?.files;
      if (!Array.isArray(files)) { done("failed"); return; }
      done([...files.flatMap((f) => (typeof f.name === "string" && /^[a-z0-9.]+$/.test(f.name) ? [f.name] : [])), "manifest.json"]);
    }).catch(() => done("failed"));
  };

  // ---------- text with citations as chips ----------
  const chipFor = (id: string): Node => (owns(state().cards, id) ? cardChip(ui, id, (c) => nav.focusCard(c), !kept(id)) : ui.doc.createTextNode(id));
  const withChips = (text: string): Child[] => {
    const out: Child[] = [];
    let at = 0;
    for (const m of text.matchAll(CARD_REF)) {
      out.push(text.slice(at, m.index));
      out.push(chipFor(m[0].toLowerCase()));
      at = m.index + m[0].length;
    }
    out.push(text.slice(at));
    return out;
  };
  const paragraphs = (text: string): HTMLElement[] =>
    text.trim() === "" ? [h("p", { class: "empty" }, "Nothing written.")] : text.split(/\n{2,}/).map((t) => h("p", null, withChips(t)));

  // ---------- the draft, read ----------
  const finding = (f: Finding): HTMLElement =>
    h("div", { class: "finding", data: { finding: f.id } },
      h("p", { class: "statement" }, f.statement),
      h("p", { class: "likelihood" }, `Likelihood: ${f.likelihood}`),
      h("p", { class: "confidence" }, `Confidence: ${f.confidence} — ${f.confidence_basis}`),
      h("div", { class: "evidence" }, h("span", { class: "label" }, "Evidence "), f.cites.length === 0 ? "No card cited." : f.cites.map((c) => [chipFor(c), " "])),
      h("div", { class: "assumptions" }, h("span", { class: "label" }, "Assumptions"), f.assumptions.length === 0 ? h("p", { class: "empty" }, "None stated.") : h("ul", null, f.assumptions.map((a) => h("li", null, a)))),
      h("div", { class: "reasoning" }, h("span", { class: "label" }, "Reasoning "), tag(ui, "agent", "judgment", "Reasoning is a judgment, not evidence"), " ", f.reasoning));

  const readBody = (d: Draft): Node[] =>
    SECTION_TITLES.map(({ id, title }) => {
      const kids: Child[] = [h("h3", { class: "section-title" }, title)];
      if (id === "key_findings") kids.push(d.product.key_findings.length === 0 ? h("p", { class: "empty" }, "No findings.") : d.product.key_findings.map(finding));
      else kids.push(paragraphs(d.product[id]));
      return h("section", { class: "narr-section", data: id === "key_findings" ? { section: id } : { section: id, drop: "cite" } }, kids);
    });

  // ---------- the edit form ----------
  const insertAt = (ta: HTMLTextAreaElement, section: TextSection, text: string, replaceHash: boolean): void => {
    const v = ta.value;
    let pos = Math.min(caret.get(section) ?? v.length, v.length);
    let before = v.slice(0, pos);
    if (replaceHash && before.endsWith("#")) before = before.slice(0, -1);
    else if (!replaceHash && before !== "" && !/\s$/.test(before)) before += " ";
    const rest = v.slice(pos);
    const gap = !replaceHash && rest !== "" && !/^\s/.test(rest) ? " " : "";
    ta.value = `${before}${text}${gap}${rest}`;
    const at = before.length + text.length;
    caret.set(section, at);
    ta.focus();
    try { ta.setSelectionRange(at, at); } catch { /* not supported */ }
  };
  const closePicker = (): void => { pickerAt?.remove(); pickerAt = null; };
  const openPicker = (ta: HTMLTextAreaElement, section: TextSection, host: HTMLElement): void => {
    closePicker();
    const cards = Object.values(state().cards).filter((c) => c.place === "lane").sort((a, b) => byId(a.id, b.id));
    const items: Child[] = cards.length === 0
      ? [h("p", { class: "empty" }, "No kept cards to cite. Keep a card first.")]
      : cards.map((c) => h("button", { type: "button", class: "pick", data: { pick: c.id }, title: `Cite ${c.id}`, on: { click: () => { closePicker(); insertAt(ta, section, `[${c.id}]`, true); } } }, `${c.title} (${c.id})`));
    pickerAt = h("div", { class: "picker", role: "listbox", name: "Kept cards", on: { keydown: (e) => { if ((e as KeyboardEvent).key === "Escape") { e.stopPropagation(); closePicker(); ta.focus(); } } } }, items);
    host.appendChild(pickerAt);
  };

  const buildEdit = (d: Draft): EditForm => {
    const areas = new Map<TextSection, HTMLTextAreaElement>();
    const fields = new Map<string, ReturnType<EditForm["finding"]>>();
    const sections: HTMLElement[] = [];
    for (const { id, title } of SECTION_TITLES) {
      if (id === "key_findings") {
        sections.push(h("section", { class: "edit-section", data: { section: id } }, h("h3", { class: "section-title" }, title), d.product.key_findings.map((f) => {
          const field = <E extends HTMLElement>(node: E): E => node;
          const statement = field(h("textarea", { name: `Statement of ${f.id}`, value: f.statement }) as HTMLTextAreaElement);
          const likelihood = field(h("input", { type: "text", name: `Likelihood of ${f.id}`, value: f.likelihood }) as HTMLInputElement);
          const confidence = field(h("select", { name: `Confidence of ${f.id}` }, CONFIDENCES.map((c) => h("option", { value: c }, c))) as HTMLSelectElement);
          confidence.value = f.confidence;
          const basis = field(h("input", { type: "text", name: `Basis of ${f.id}`, value: f.confidence_basis }) as HTMLInputElement);
          const cites = field(h("input", { type: "text", name: `Cites of ${f.id}`, value: f.cites.join(", "), placeholder: "c1, c2" }) as HTMLInputElement);
          const assumptions = field(h("textarea", { name: `Assumptions of ${f.id}`, value: f.assumptions.join("\n"), placeholder: "One per line" }) as HTMLTextAreaElement);
          const reasoning = field(h("textarea", { name: `Reasoning of ${f.id}`, value: f.reasoning }) as HTMLTextAreaElement);
          fields.set(f.id, { statement, likelihood, confidence, basis, cites, assumptions, reasoning });
          const row = (label: string, input: HTMLElement): HTMLElement => h("label", { class: "edit-row" }, h("span", { class: "label" }, label), input);
          return h("fieldset", { class: "edit-finding", data: { finding: f.id } }, h("legend", null, `Finding ${f.id}`),
            row("Statement", statement), row("Likelihood", likelihood), row("Confidence", confidence), row("Basis", basis), row("Cites", cites), row("Assumptions", assumptions), row("Reasoning (judgment)", reasoning));
        })));
        continue;
      }
      const host = h("section", { class: "edit-section", data: { section: id, drop: "cite" } });
      const ta = h("textarea", {
        name: title, value: d.product[id], placeholder: "Type # to cite a kept card",
        on: {
          focus: () => { lastSection = id; },
          input: () => {
            const t = areas.get(id)!;
            const at = t.selectionStart ?? t.value.length;
            caret.set(id, at);
            if (t.value.slice(0, at).endsWith("#")) openPicker(t, id, host); else closePicker();
          },
          keyup: () => { const t = areas.get(id)!; caret.set(id, t.selectionEnd ?? t.value.length); },
          click: () => { const t = areas.get(id)!; caret.set(id, t.selectionEnd ?? t.value.length); },
          blur: () => { const t = areas.get(id)!; caret.set(id, t.selectionEnd ?? t.value.length); },
        },
      }) as HTMLTextAreaElement;
      areas.set(id, ta);
      host.append(h("h3", { class: "section-title" }, title), ta);
      sections.push(host);
    }
    const reason = h("input", { type: "text", name: "Reason for the edit", placeholder: "Reason for the edit", on: { input: () => form.sync() } }) as HTMLInputElement;
    const save = h("button", { type: "button", class: "primary", data: { action: "save" }, on: { click: () => { void saveEdit(); } } }, `Save as draft ${d.n + 1}`) as HTMLButtonElement;
    const el2 = h("div", { class: "edit-form", name: "Edit the draft" }, sections,
      h("div", { class: "edit-foot" }, reason, save, h("button", { type: "button", data: { action: "cancel" }, on: { click: () => { edit = null; closePicker(); render(); } } }, "Cancel")),
      h("p", { class: "note" }, "An edit goes back through checks, evaluation and challenge before it can be published."));
    const form: EditForm = {
      base: d.hash, el: el2, areas, finding: (id) => fields.get(id)!, reason, save,
      sync() {
        const blank = reason.value.trim() === "";
        save.disabled = ro() || blank || saving;
        save.title = ro() ? REPLAY_REFUSAL : blank ? "An edit needs a reason" : `Save this as draft ${d.n + 1}; it goes back through review`;
      },
    };
    return form;
  };

  /** The whole product as the form now holds it: what the person did not touch is as it was. */
  const productOf = (d: Draft, f: EditForm): Product => ({
    ...d.product,
    ...Object.fromEntries(TEXT_SECTIONS.map((id) => [id, f.areas.get(id)!.value])),
    key_findings: d.product.key_findings.map((x) => {
      const v = f.finding(x.id);
      return {
        id: x.id, statement: v.statement.value, likelihood: v.likelihood.value, confidence: v.confidence.value as Finding["confidence"], confidence_basis: v.basis.value,
        cites: v.cites.value.split(",").map((c) => c.trim()).filter((c) => c !== ""), assumptions: lines(v.assumptions.value), reasoning: v.reasoning.value,
      };
    }),
  });
  const saveEdit = async (): Promise<void> => {
    const d = draftOf();
    if (edit === null || d === null || saving) return;
    const reason = edit.reason.value.trim();
    if (reason === "") { ui.toast("An edit needs a reason"); return; }
    saving = true; edit.sync();
    try { await ui.act("revise", { product: productOf(d, edit), reason }); } finally { saving = false; edit?.sync(); }
  };
  const startEdit = (): void => {
    const d = draftOf();
    if (edit !== null || d === null) return;
    caret.clear();
    edit = buildEdit(d);
    render();
  };

  // ---------- tools: Edit and Copy ----------
  const copy = async (): Promise<void> => {
    const md = narrativeMarkdown(state(), ui.ref);
    if (md === "") return;
    try {
      const clip = (ui.win.navigator as Navigator | undefined)?.clipboard;
      if (clip === undefined || clip === null || typeof clip.writeText !== "function") throw new Error("there is no clipboard");
      await clip.writeText(md);
      fallback = null; focusFallback = false;
      ui.toast("Copied as Markdown");
    } catch {
      fallback = md; focusFallback = true;
      ui.toast("The clipboard refused the text; it is shown below to copy by hand");
    }
    if (!destroyed) render();
  };
  const toolsView = (s: CaseState, d: Draft): Node[] => {
    const out: Node[] = [];
    if (edit === null) {
      const can = canEdit(s);
      out.push(h("button", {
        type: "button", data: { action: "edit" }, disabled: ro() || !can,
        title: ro() ? REPLAY_REFUSAL : can ? "Edit the draft; the new revision goes back through review" : "A draft can be edited while a run is in progress",
        on: { click: () => { startEdit(); edit?.areas.get("summary")?.focus(); } },
      }, "Edit"));
    }
    out.push(h("button", { type: "button", data: { action: "copy" }, title: `Copy draft ${d.n} as Markdown, with each citation's provenance`, on: { click: () => { void copy(); } } }, "Copy as Markdown"));
    return out;
  };

  // ---------- the head ----------
  const headView = (s: CaseState, d: Draft): Node[] => {
    const pub = s.published.length === 0 ? null : s.published[s.published.length - 1]!;
    const published = pub !== null && pub.draft_hash === d.hash ? pub : null;
    const kids: Child[] = [`Draft ${d.n} · ${d.hash.slice(0, 8)} · by ${names(d.author)}`, " ", markingChip(ui, d.product.marking)];
    if (published !== null) {
      loadBundle(published.n);
      const files = bundles.get(published.n);
      kids.push(h("span", { class: "published" }, ` Published as product ${published.n}`), " ",
        files === undefined || files === "loading" ? "(reading the file list…)" : files === "failed" ? "(the file list could not be read)"
          : files.map((f) => [fileLink(h, ui.api.bundlePath(store.id, published.n, f), f), " "]));
    }
    return [h("p", { class: "draft-head" }, kids)];
  };

  // ---------- the review ----------
  const findingsList = (fs: { where: string; message: string }[]): HTMLElement | null =>
    fs.length === 0 ? null : h("ul", { class: "findings" }, fs.map((f) => h("li", null, `${f.where}: ${f.message}`)));
  const answerForm = (s: CaseState, id: string): HTMLElement => {
    const box = h("textarea", {
      name: `Answer to ${id}`, value: answers.get(id) ?? "", disabled: ro(), placeholder: "Your answer",
      on: { input: (e) => { answers.set(id, (e.target as HTMLTextAreaElement).value); button.disabled = ro() || (answers.get(id) ?? "").trim() === ""; } },
    });
    const kind = h("select", {
      name: `Kind of answer to ${id}`, disabled: ro(),
      on: { change: (e) => { kinds.set(id, (e.target as HTMLSelectElement).value); } },
    }, h("option", { value: "revised" }, "Revised"), h("option", { value: "rebutted" }, "Rebutted")) as HTMLSelectElement;
    kind.value = kinds.get(id) ?? "revised";
    const button = h("button", {
      type: "button", class: "primary", data: { action: "answer" }, disabled: ro() || (answers.get(id) ?? "").trim() === "", title: ro() ? REPLAY_REFUSAL : `Answer challenge ${id}`,
      on: { click: () => {
        const text = (answers.get(id) ?? "").trim();
        if (text === "") return;
        void ui.act("answer_challenge", { challenge: id, answer: text, action: kind.value }).then((ok) => { if (ok) { answers.delete(id); kinds.delete(id); } });
      } },
    }, "Answer") as HTMLButtonElement;
    void s;
    return h("div", { class: "answer-form" }, box, kind, button);
  };
  const reviewView = (s: CaseState, d: Draft): Node[] => {
    const r = owns(s.reviews, d.hash) ? s.reviews[d.hash]! : null;
    const out: Child[] = [h("h3", { class: "section-title" }, "Review of this revision")];
    if (r === null) { out.push(h("p", { class: "empty" }, "This revision has not been reviewed yet.")); return [h("section", { class: "review" }, out)]; }
    if (r.rejected !== null) out.push(h("p", { class: "rejected" }, tag(ui, "attention", "rejected"), ` You rejected this revision: ${r.rejected.reason}${r.rejected.stop ? " (and stopped the run)" : ""}`));
    const mark = (pass: boolean): HTMLElement => h("span", { class: pass ? "pass" : "fail" }, pass ? "✓" : "✗");
    out.push(h("div", { class: "checks" }, r.checks.length === 0 ? h("p", { class: "empty" }, "No form checks yet.") : r.checks.map((c) =>
      h("div", { class: `check-row${c.pass ? "" : " failed"}` }, mark(c.pass), ` ${c.check}`, findingsList(c.findings)))));
    out.push(r.evaluation === null
      ? h("div", { class: "evaluation-row pending" }, "Evaluation: not yet")
      : h("div", { class: `evaluation-row${r.evaluation.pass ? "" : " failed"}` }, mark(r.evaluation.pass), " Evaluation", findingsList(r.evaluation.findings)));
    for (const id of r.challenges) {
      if (!owns(s.challenges, id)) continue;
      const c = s.challenges[id]!;
      const must = c.severity === "must_address";
      out.push(h("div", { class: `challenge${must ? " must" : ""}`, data: { challenge: id } },
        tag(ui, must ? "attention" : "human", must ? "must address" : "consider"), ` ${id} `, c.cites.map((x) => [chipFor(x), " "]),
        h("p", { class: "text" }, c.text),
        c.status === "answered"
          ? h("p", { class: "answer" }, tag(ui, "done", c.action ?? "answered"), ` ${c.answer ?? ""}`)
          : answerForm(s, id)));
    }
    const pub = s.published.length > 0 && s.published[s.published.length - 1]!.draft_hash === d.hash;
    if (!pub) {
      const why = blockers(s, d.hash);
      out.push(why.length === 0
        ? h("p", { class: "blockers-none tag tag-done" }, "Nothing blocks publishing")
        : h("div", { class: "blockers-box" }, h("p", { class: "blockers-title tag tag-attention" }, "Cannot be published yet"), h("ul", { class: "blockers" }, why.map((w) => h("li", null, w)))));
    }
    return [h("section", { class: "review" }, out)];
  };

  // ---------- the bundle preview ----------
  const wantsPreview = (s: CaseState): boolean => !ro() && s.run.waiting === "publish" && latestDraft(s) !== null;
  const ensurePreview = (s: CaseState): void => {
    if (!wantsPreview(s)) return;
    const seq = store.live.seq;
    if (asked === seq) return;
    asked = seq;
    const done = (value: Preview | "failed"): void => { if (!destroyed && asked === seq) { preview = { seq, value }; render(); } };
    ui.api.preview(store.id).then(done, () => done("failed"));
  };
  const currentPreview = (): Preview | "failed" | null => (preview !== null && preview.seq === store.live.seq ? preview.value : null);
  const previewView = (): Node[] => {
    const v = currentPreview();
    if (v === null) return [h("section", { class: "preview" }, h("h3", { class: "section-title" }, "Bundle preview"), h("p", { class: "empty" }, "Reading the preview…"))];
    const head = h("h3", { class: "section-title" }, "Bundle preview");
    if (v === "failed") return [h("section", { class: "preview" }, head, h("p", { class: "empty" }, "The preview could not be read."))];
    if ("reasons" in v) return [h("section", { class: "preview" }, head, h("div", { class: "reasons" }, h("p", null, "The bundle cannot be made yet:"), h("ul", null, v.reasons.map((r) => h("li", null, r)))))];
    const files: Record<string, string> = { ...v.files, "manifest.json": JSON.stringify(v.manifest, null, 2) };
    const all = Object.keys(files);
    const shown = tab !== null && all.includes(tab) ? tab : all[0]!;
    return [h("section", { class: "preview" }, head,
      h("div", { class: "tabs", role: "tablist", name: "Files" }, all.map((f) =>
        h("button", { type: "button", role: "tab", class: f === shown ? "active" : "", aria: { selected: String(f === shown) }, data: { tab: f }, on: { click: () => { tab = f; sigs.delete(previewBox); render(); } } }, f))),
      h("pre", { class: "preview-text" }, files[shown]!))];
  };

  // ---------- the gate ----------
  const gateView = (s: CaseState, d: Draft): Node[] => {
    if (s.run.waiting !== "publish") return [];
    const why = blockers(s, d.hash);
    const pv = currentPreview();
    const reasons = pv !== null && pv !== "failed" && "reasons" in pv ? pv.reasons : [];
    // fail closed: nothing is approved before the server's own check of this exact ledger has come back clean
    const checked = pv !== null && pv !== "failed";
    const can = why.length === 0 && checked && reasons.length === 0 && !inflight.has("approve");
    const why2 = why.length > 0 ? [...why, ...reasons.filter((r) => !why.includes(r))].join("; ")
      : pv === null ? "Checking…" : pv === "failed" ? "The draft could not be checked" : reasons.length > 0 ? reasons.join("; ") : inflight.has("approve") ? "Publishing…" : `Publish draft ${d.n} as it is`;
    const approve = h("button", {
      type: "button", class: "primary", data: { action: "approve" }, disabled: ro() || !can,
      title: ro() ? REPLAY_REFUSAL : why2,
      on: { click: () => { guarded("approve", "approve", { draft_hash: d.hash }); } },
    }, `Approve: publish draft ${d.n}`);
    const reject = h("button", {
      type: "button", data: { action: "reject" }, disabled: ro(), title: ro() ? REPLAY_REFUSAL : "Reject this draft and say why",
      on: { click: () => { rejecting = true; sigs.delete(gateBox); render(); (gateBox.querySelector("[aria-label='Reason for rejecting the draft']") as HTMLElement | null)?.focus(); } },
    }, "Reject");
    const out: Node[] = [h("div", { class: "gate-buttons" }, approve, reject)];
    if (rejecting) {
      const stop = h("input", { type: "checkbox", name: "and stop the run", disabled: ro(), checked: rejectStop, on: { change: (e) => { rejectStop = (e.target as HTMLInputElement).checked; } } }) as HTMLInputElement;
      const confirm = h("button", {
        type: "button", class: "primary", data: { action: "confirm-reject" }, disabled: ro() || rejectReason.trim() === "",
        on: { click: () => {
          const reason = rejectReason.trim();
          if (reason === "") return;
          void ui.act("reject", { reason, stop: stop.checked }).then((ok) => { if (ok) { rejecting = false; rejectReason = ""; rejectStop = false; render(); } });
        } },
      }, "Reject the draft") as HTMLButtonElement;
      const box = h("input", {
        type: "text", class: "ask-text", name: "Reason for rejecting the draft", value: rejectReason, disabled: ro(),
        on: {
          input: (e) => { rejectReason = (e.target as HTMLInputElement).value; confirm.disabled = ro() || rejectReason.trim() === ""; },
          keydown: (e) => { if ((e as KeyboardEvent).key === "Escape") { e.stopPropagation(); rejecting = false; render(); } },
        },
      });
      out.push(h("div", { class: "ask" }, box, h("label", null, stop, " and stop the run"), confirm, h("button", { type: "button", data: { action: "cancel-reject" }, on: { click: () => { rejecting = false; render(); } } }, "Cancel")));
    }
    return out;
  };

  // ---------- proposals ----------
  const proposalsView = (s: CaseState): Node[] => {
    const open = Object.values(s.proposals).filter((p) => p.kind === "narrative" && p.status === "open").sort((a, b) => byId(a.id, b.id));
    return open.map((p) => {
      if (p.kind !== "narrative") return h("div");
      const editing = proposalEdit.has(p.id);
      const kids: Child[] = [h("p", { class: "proposal-head" }, `Proposed ${TITLE.get(p.section) ?? p.section} · by ${p.by}`)];
      if (!editing) {
        kids.push(h("div", { class: "text" }, paragraphs(p.text)));
        kids.push(h("div", { class: "actions" },
          h("button", {
            type: "button", class: "primary", data: { action: "accept-proposal" }, disabled: ro() || !canEdit(s) || inflight.has(`accept:${p.id}`),
            title: ro() ? REPLAY_REFUSAL : latestDraft(s) === null ? "There is no draft yet to put this in" : !canEdit(s) ? "A draft can be edited while a run is in progress" : "Put this in the draft as a new revision; it goes back through review",
            on: { click: () => { guarded(`accept:${p.id}`, "accept_proposal", { proposal: p.id }); } },
          }, "Accept"),
          h("button", { type: "button", data: { action: "edit-proposal" }, disabled: ro(), on: { click: () => { proposalEdit.add(p.id); proposalText.set(p.id, p.text); sigs.delete(proposalsBox); render(); } } }, "Edit"),
          h("button", { type: "button", data: { action: "discard-proposal" }, disabled: ro(), on: { click: () => { void ui.act("reject_proposal", { proposal: p.id, reason: "discarded" }); } } }, "Discard")));
      } else {
        const accept = h("button", {
          type: "button", class: "primary", data: { action: "accept-edited" }, disabled: ro() || !canEdit(s) || inflight.has(`accept:${p.id}`) || (proposalText.get(p.id) ?? "").trim() === "",
          title: latestDraft(s) === null ? "There is no draft yet to put this in" : undefined,
          on: { click: () => { const t = proposalText.get(p.id) ?? ""; if (t.trim() !== "") guarded(`accept:${p.id}`, "accept_proposal", { proposal: p.id, text: t }); } },
        }, "Accept as edited") as HTMLButtonElement;
        kids.push(h("textarea", {
          name: `Text proposed in ${p.id}`, value: proposalText.get(p.id) ?? p.text, disabled: ro(),
          on: { input: (e) => { proposalText.set(p.id, (e.target as HTMLTextAreaElement).value); accept.disabled = ro() || (proposalText.get(p.id) ?? "").trim() === ""; } },
        }), h("div", { class: "actions" }, accept,
          h("button", { type: "button", data: { action: "cancel-proposal-edit" }, on: { click: () => { proposalEdit.delete(p.id); proposalText.delete(p.id); sigs.delete(proposalsBox); render(); } } }, "Cancel")));
      }
      return h("div", { class: "proposal proposed", data: { proposal: p.id } }, kids);
    });
  };

  // ---------- painting ----------
  const render = (): void => {
    if (destroyed) return;
    const s = state();
    const d = draftOf();
    if (edit !== null && (d === null || d.hash !== edit.base)) {
      // the revision the form was made from is no longer the latest: this person's own save, or somebody else's
      if (d !== null && d.author.kind !== "human") ui.toast("A new draft arrived; what you typed was not saved");
      edit = null; closePicker();
    }
    for (const [k, seq] of [...inflight]) if (seq !== null && store.live.seq >= seq) { inflight.delete(k); inflightVersion++; }
    ensurePreview(s);
    const published = d !== null && s.published.length > 0 && s.published[s.published.length - 1]!.draft_hash === d.hash;
    draftBox.classList.toggle("proposed", !published);
    draftBox.hidden = d === null;
    paint(headBox, [d, s.published, store.id, bundlesVersion], () => (d === null ? [] : headView(s, d)));
    paint(bodyBox, edit !== null ? [edit] : [d, s.cards], () => (d === null ? [h("p", { class: "empty" }, "No draft yet.")] : edit !== null ? [edit.el] : readBody(d)));
    if (d === null) {
      paint(toolsBox, [null], () => []); paint(gateBox, [null], () => []); paint(reviewBox, [null], () => []); paint(previewBox, [null], () => []);
      if (el.querySelector(".no-draft") === null) el.insertBefore(h("p", { class: "empty no-draft" }, "No draft yet."), el.firstChild);
    } else {
      el.querySelector(".no-draft")?.remove();
      paint(toolsBox, [d.hash, edit, ro(), s.run.status, s.cards === s.cards], () => toolsView(s, d));
      paint(gateBox, [d.hash, s.run, s.reviews, s.challenges, s.published, preview, store.live.seq, rejecting, ro(), inflightVersion], () => gateView(s, d));
      paint(reviewBox, [d.hash, s.reviews, s.challenges, s.run, s.published, s.cards, ro()], () => reviewView(s, d));
      paint(previewBox, [wantsPreview(s), preview, store.live.seq, tab], () => (wantsPreview(s) ? previewView() : []));
    }
    // the first time Approve can be pressed, a person who came here for the gate is on it (Approve waits for the server's check, so this cannot be done on opening)
    if (!focusedAtGate && el.isConnected) {
      const ap = gateBox.querySelector("[data-action=approve]:not([disabled])") as HTMLElement | null;
      const at = ui.doc.activeElement;
      if (ap !== null) { focusedAtGate = true; if (at === null || at === ui.doc.body || el.contains(at) || at.closest("[data-area=lens]") !== null) ap.focus(); }
    }
    paint(copyBox, [fallback], () => (fallback === null ? [] : [h("div", { class: "copy-fallback" },
      h("p", null, "Select all and copy:"),
      h("textarea", { name: "Markdown to copy", value: fallback, readonly: true }),
      h("button", { type: "button", data: { action: "close-copy" }, on: { click: () => { fallback = null; render(); } } }, "Close"))]));
    if (focusFallback) {
      focusFallback = false;
      const ta = copyBox.querySelector("textarea") as HTMLTextAreaElement | null;
      if (ta !== null) { ta.focus(); ta.select(); }
    }
    paint(proposalsBox, [s.proposals, proposalEdit.size, ro(), s.cards, s.run.status, s.drafts.length, inflightVersion], () => proposalsView(s));
    edit?.sync();
  };

  // a preview that could not be read is asked for again when the person comes back to the lens
  el.addEventListener("focusin", () => { if (preview !== null && preview.value === "failed" && preview.seq === store.live.seq) { asked = -1; preview = null; render(); } });
  return {
    el,
    update: render,
    destroy() { destroyed = true; closePicker(); },
    cite(card, section) {
      const s = state();
      if (ro()) { ui.toast(REPLAY_REFUSAL); return; }
      if (draftOf() === null) { ui.toast("There is no draft yet to cite in"); return; }
      if (!canEdit(s)) { ui.toast("A draft can be edited while a run is in progress"); return; }
      startEdit();
      const id: TextSection = section !== undefined && isText(section) ? section : lastSection;
      const ta = edit?.areas.get(id);
      if (ta === undefined) return;
      lastSection = id;
      closePicker();
      insertAt(ta, id, `[${card}]`, false);
    },
  };
}
