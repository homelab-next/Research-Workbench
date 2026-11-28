// The Improve lens (slice 14): an improve case's request and its tasks, the candidates Propose made (a dropped one with why, each file's diff
// drawn as the builder panel draws one), the probes as a table of candidate by task (each cell opens the child at the head Probe read), Compose's
// choice and its reason, the scores once the Judge has run, the lessons Reflect proposed, and, while the run waits at the adopt gate, the gate.
// Ruling: Adopt is all or nothing, so the gate has one Accept and one Reject for the whole chosen candidate, and the scores beside it are said
// to be the whole candidate's. Only its own buttons pass it; no key does. No known answer is shown here: the Judge alone reads one.
//
// What is drawn is `store.shown` (the fold at the entry Replay shows, or the live one): a section exists only when its entry is folded in, so at
// an entry before judge.scored there are no scores and before compose.chosen no choice. The server's view adds what the ledger does not hold as
// text a person may see: the diffs, whether a file changed on disk since, the score sheet's detail, the lessons, and every reason scrubbed.
import { adoptOffer, BASE, plannedProbes } from "../../core/state";
import type { CaseState, OutputScore, ScoreSheet } from "../../core/state";
import type { DiffLine, ImproveView } from "../../core/wire";
import type { Open } from "../app";
import { markingChip, tag } from "../chips";
import { clear } from "../dom";
import type { Child } from "../dom";
import { refusalLine } from "../refusal";
import { AT_GATE, REPLAY_REFUSAL } from "../ui";
import type { Ui, View } from "../ui";

type CandidateView = ImproveView["candidates"][number];
type FileView = CandidateView["files"][number];

const OP_CLASS: Record<DiffLine["op"], string> = { "+": "diff-added", "-": "diff-removed", " ": "diff-context" };
const STALE = "This file changed on disk since it was proposed, so the candidate cannot be accepted.";
const LEFT_OUT: Record<string, string> = { marking: "stricter than this case", cap: "over the number of tasks asked" };
/** The entries after which what the server's view says may have changed. */
const VIEW_TYPES = new Set<string>([
  "improve.selected", "improve.task", "improve.candidate", "builder.proposed", "builder.decided", "probe.started", "probe.finished", "compose.chosen", "judge.scored",
  "stage.finished", "gate.waiting", "gate.passed", "run.finished",
]);

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
/** The children given, without the ones left out. */
const present = (...kids: Child[]): Child[] => kids.filter((k) => k !== null && k !== undefined && k !== false);

/** The stage that runs just before the adopt gate's (Reflect, in an improve loop's fixed order); null when there is none. */
function reflectStage(s: Readonly<CaseState>): CaseState["run"]["stages"][number] | null {
  const at = s.run.stages.findIndex((x) => x.gate === "adopt");
  return at > 0 ? s.run.stages[at - 1]! : null;
}

export function makeImprove(ui: Ui, open: Open, arg: string | null): View {
  const { h } = ui;
  const { store, nav } = open;
  let view: ImproveView | null = null;
  let failed = false;
  let destroyed = false;
  let asked = 0;
  let version = 0;
  /** The live seq up to which the entries have been looked at for a reason to read the view again. */
  let seen = store.live.seq;
  let busy = false;
  let refused: string | undefined;
  let painted = "";
  let toGate = arg === AT_GATE;
  /** Which file disclosures the person closed or opened, by "<candidate>/<file>". */
  const shut = new Map<string, boolean>();

  const el = h("div", { class: "lens lens-improve", name: "Improve" });

  const read = (): void => {
    const mine = ++asked;
    // a read that throws, as one that fails, leaves the lens drawn from the ledger and says so
    Promise.resolve().then(() => ui.api.improve(store.id)).then((v) => {
      if (destroyed || mine !== asked) return;
      view = v; failed = false; version++; paint();
    }, () => { if (destroyed || mine !== asked) return; failed = true; version++; paint(); });
  };

  const replaying = (): boolean => store.at !== null;
  const analyst = (): boolean => ui.me.role === "analyst";
  /** The view's candidate for the one the ledger shows, when it is the same proposal. */
  const candidateView = (candidate: string, change: string): CandidateView | null => view?.candidates.find((c) => c.candidate === candidate && c.change === change) ?? null;
  const caseLink = (id: string, label: string, at?: number): HTMLElement => h("button", {
    type: "button", class: "link-button", data: { case: id }, title: at === undefined ? `Open ${id}` : `Open ${id} at entry ${at}`,
    on: { click: () => nav.go(at === undefined ? { screen: "case", id } : { screen: "case", id, at }) },
  }, label);

  // ---------- the request and the tasks ----------
  const requestPart = (s: Readonly<CaseState>): HTMLElement => {
    const i = s.improve;
    const r = i.request!;
    const sel = i.selected;
    return h("section", { class: "improve-part", data: { part: "request" } },
      h("h3", null, `Improve ${r.target} for ${r.case_type}`),
      h("p", { class: "request-counts muted" }, `${plural(r.tasks, "task", "tasks")} and ${plural(r.candidates, "candidate", "candidates")} asked`),
      h("p", { class: "no-answer muted" }, "No known answer is shown here: only the Judge reads one, after Compose has chosen."),
      sel === null ? h("p", { class: "empty" }, "Select has not run yet.") : present(
        h("p", { class: "selected" }, `Version ${sel.version} of ${sel.target} · ${sel.loop_hash.slice(0, 12)}`),
        h("ul", { class: "improve-tasks", role: "list" }, i.task_order.filter((t) => Object.hasOwn(i.tasks, t)).map((t) => {
          const task = i.tasks[t]!;
          return h("li", { data: { task: t } }, caseLink(task.case, `${t} · ${task.case}`), " ", markingChip(ui, task.marking));
        })),
        sel.left_out.length === 0 ? null : h("p", { class: "left-out muted" }, `Left out: ${sel.left_out.map((l) => `${l.case}: ${LEFT_OUT[l.why] ?? l.why}`).join("; ")}`),
      ));
  };

  // ---------- the candidates ----------
  const diffLines = (lines: readonly DiffLine[]): HTMLElement =>
    h("div", { class: "diff", role: "list" }, lines.map((l) => h("div", { class: `diff-line ${OP_CLASS[l.op] ?? "diff-context"}`, role: "listitem" }, `${l.op}${l.text}`)));
  const fileBlock = (candidate: string, f: CaseState["builder"]["changes"][string]["files"][number], index: number, vf: FileView | null): HTMLElement => {
    const key = `${candidate}/${index}`;
    const decided = f.decided;
    const block = h("details", {
      class: `builder-file${vf?.stale === true && decided === null ? " stale" : ""}`, data: { file: String(index) },
      on: { toggle: (e) => { shut.set(key, !(e.target as HTMLDetailsElement).open); } },
    },
    h("summary", null, h("span", { class: "file-path" }, f.path), " ", h("span", { class: `chip file-state${vf?.new_file === true ? " new" : ""}` }, vf?.new_file === true ? "new file" : "changed"),
      " ", h("span", { class: "muted file-kind" }, `${f.kind} ${f.id}`)),
    decided === null ? null : h("p", { class: `file-decided tag ${decided.accepted ? "tag-done" : "tag-human"}` }, decided.accepted ? "Accepted" : "Rejected"),
    vf !== null ? diffLines(vf.lines) : h("p", { class: failed ? "load-error say" : "muted" }, failed ? "The diff could not be read" : "Loading the diff…")) as HTMLDetailsElement;
    block.open = !(shut.get(key) ?? decided !== null);
    return block;
  };
  const candidatesPart = (s: Readonly<CaseState>): HTMLElement | null => {
    const i = s.improve;
    if (i.selected === null) return null;
    const list = i.candidate_order.filter((k) => Object.hasOwn(i.candidates, k)).map((k) => i.candidates[k]!);
    return h("section", { class: "improve-part", data: { part: "candidates" } },
      h("h3", null, "Candidates"),
      list.length === 0 ? h("p", { class: "empty" }, "Propose has made no candidate yet.") : list.map((c) => {
        const change = Object.hasOwn(s.builder.changes, c.change) ? s.builder.changes[c.change]! : null;
        const vc = candidateView(c.candidate, c.change);
        const staged = c.status === "staged";
        const status = tag(ui, staged ? "system" : "attention", c.status);
        status.classList.add("candidate-status");
        return h("article", { class: "improve-candidate", data: { candidate: c.candidate, change: c.change } },
          h("p", { class: "candidate-head" }, h("span", { class: "candidate-title" }, `${c.candidate} · ${vc?.title ?? change?.title ?? ""}`), " ", status),
          h("p", { class: "candidate-why" }, vc?.why ?? change?.why ?? ""),
          staged ? null : h("p", { class: "candidate-reason attention" }, `Dropped: ${vc?.reason ?? c.reason}`),
          (change?.files ?? []).map((f, n) => fileBlock(c.candidate, f, n, vc?.files.find((x) => x.index === n) ?? null)));
      }));
  };

  // ---------- the probes ----------
  const probesPart = (s: Readonly<CaseState>): HTMLElement | null => {
    const i = s.improve;
    if (i.selected === null || i.candidate_order.length === 0 && i.probe_order.length === 0) return null;
    const planned = plannedProbes(s);
    if (planned.length === 0) return null;
    const rows = [...new Set(planned.map((x) => x.candidate))];
    const tasks = i.task_order;
    const cell = (probe: string): HTMLElement => {
      const x = Object.hasOwn(i.probes, probe) ? i.probes[probe]! : null;
      if (x === null) return h("td", { data: { probe } }, h("span", { class: "muted" }, "not run"));
      const f = x.finished;
      if (f === null) return h("td", { data: { probe } }, caseLink(x.child, `running · ${x.child}`));
      const reason = view?.probes.find((v) => v.probe === probe && v.child === x.child)?.reason ?? f.reason;
      return h("td", { data: { probe }, class: f.outcome === "drafted" ? "probe-drafted" : "probe-incomplete" },
        caseLink(x.child, `${f.outcome} · ${plural(f.lookups, "lookup", "lookups")} · ${plural(f.tokens, "token", "tokens")}`, f.head.seq),
        f.outcome === "incomplete" && reason !== "" ? h("p", { class: "probe-reason attention" }, reason) : null);
    };
    return h("section", { class: "improve-part", data: { part: "probes" } },
      h("h3", null, "Probes"),
      h("table", { class: "probe-table" },
        h("thead", null, h("tr", null, h("th", null, ""), tasks.map((t) => h("th", null, t)))),
        h("tbody", null, rows.map((candidate) => h("tr", { data: { candidate } },
          h("th", { title: candidate === BASE ? "the unchanged loop" : `candidate ${candidate}` }, candidate),
          tasks.map((t) => cell(`${candidate}/${t}`)))))),
      h("p", { class: "muted" }, "Each cell opens the probe's child case at the entry Probe read its output from."));
  };

  // ---------- Compose's choice ----------
  const choicePart = (s: Readonly<CaseState>): HTMLElement | null => {
    const chosen = s.improve.chosen;
    if (chosen === null) return null;
    const same = view?.chosen !== null && view?.chosen !== undefined && view.chosen.candidate === chosen.candidate && store.live.improve.chosen?.seq === chosen.seq;
    return h("section", { class: "improve-part", data: { part: "choice" } },
      h("h3", null, "Compose's choice"),
      h("p", { class: "chosen" }, chosen.candidate === null ? "Compose chose no candidate: the loop stays as it is" : `Compose chose ${chosen.candidate}`),
      h("p", { class: "chosen-why" }, same ? view!.chosen!.why : chosen.why));
  };

  // ---------- the scores ----------
  const findingLine = (f: OutputScore["findings"][number]): string => {
    const n = `expected finding ${f.expected + 1}`;
    if (f.produced === null) return `${n}: not matched · score ${f.score}`;
    const parts = [
      f.similarity === null ? null : `similarity ${f.similarity}`,
      f.likelihood_distance === null ? null : `likelihood distance ${f.likelihood_distance}`,
      f.confidence_distance === null ? null : `confidence distance ${f.confidence_distance}`,
      `score ${f.score}`,
    ].filter((x): x is string => x !== null);
    return `${n}: matched by ${f.by ?? "code"} to “${f.produced}” · ${parts.join(" · ")}`;
  };
  const outputBlock = (o: OutputScore): HTMLElement => h("div", { class: "improve-output", data: { output: o.probe } },
    h("p", { class: "output-score" }, `${o.probe} · ${o.outcome} · ${o.score === null ? "unscored" : o.score}`),
    o.text === null ? null : h("p", { class: "output-text" }, `The product ${o.text} with the answer's text`),
    o.findings.length === 0 ? null : h("ul", { class: "output-findings", role: "list" }, o.findings.map((f) => h("li", { data: { expected: String(f.expected + 1) } }, findingLine(f)))),
    o.left_over.length === 0 ? null : h("p", { class: "left-over muted" }, `Also stated, matching no expected finding: ${o.left_over.join("; ")}`));
  const scoresPart = (s: Readonly<CaseState>): HTMLElement | null => {
    const scored = s.improve.scored;
    if (scored === null) return null;
    // the sheet's detail is the server's, read for the live run: it is shown when the entry on screen scored that same sheet
    const sheet: ScoreSheet | null = view !== null && store.live.improve.scored?.scores.blob === scored.scores.blob ? view.scores : null;
    return h("section", { class: "improve-part", data: { part: "scores" } },
      h("h3", null, "Scores"),
      h("p", { class: "muted" }, `Each score is from 0 to 1000, computed in code (${scored.matcher === "code" ? "claims matched by code" : "claims matched by code, then a model for the ones code left"}).`),
      h("table", { class: "score-summary" },
        h("thead", null, h("tr", null, h("th", null, "Candidate"), h("th", null, "Score"), h("th", null, "Drafted"))),
        h("tbody", null, scored.summary.map((r) => h("tr", { data: { candidate: r.candidate } }, h("td", null, r.candidate), h("td", null, String(r.score)), h("td", null, `${r.drafted} of ${r.tasks}`))))),
      sheet === null
        ? h("p", { class: failed ? "load-error say" : "muted" }, failed ? "The score sheet could not be read" : view === null ? "Loading the score sheet…" : "The score sheet of this run is not the one the case holds now")
        : sheet.outputs.map(outputBlock));
  };

  // ---------- the lessons ----------
  const lessonsPart = (s: Readonly<CaseState>): HTMLElement | null => {
    const reflect = reflectStage(s);
    if (reflect === null || reflect.status !== "passed" || s.improve.selected === null || store.live.improve.selected?.seq !== s.improve.selected.seq) return null;
    const lessons = view?.lessons ?? [];
    return h("section", { class: "improve-part", data: { part: "lessons" } },
      h("h3", null, "Lessons proposed"),
      lessons.length === 0 ? h("p", { class: "empty" }, view === null ? "Loading…" : "Reflect proposed no lesson.") : [
        h("p", { class: "muted" }, "Reflect proposed these to the shared memory; each waits for a person on the Memory page."),
        h("ul", { class: "improve-lessons", role: "list" }, lessons.map((l) => h("li", { data: { lesson: l.lesson } },
          h("button", { type: "button", class: "link-button", title: "Open the Memory page", on: { click: () => nav.go({ screen: "memory" }) } }, `${l.lesson} · ${l.title}`)))),
      ]);
  };

  // ---------- the adopt gate ----------
  const decide = (command: "adopt_decide" | "adopt_finish", args: Record<string, unknown>): void => {
    if (busy || replaying()) return;
    busy = true; refused = undefined; paint();
    void ui.send(command, args, undefined, undefined, (why) => { refused = why; }).then(() => {
      busy = false;
      if (destroyed) return;
      read();
      paint();
    });
  };
  const adoptPart = (s: Readonly<CaseState>): HTMLElement | null => {
    if (s.run.status !== "waiting" || s.run.waiting !== "adopt") return null;
    const offer = adoptOffer(s);
    if (offer === null) return null;
    const change = s.builder.changes[offer.change]!;
    const vc = candidateView(offer.candidate, offer.change);
    const files = change.files;
    const stale = files.filter((f, n) => f.decided === null && vc?.files.find((x) => x.index === n)?.stale === true).length;
    const scored = s.improve.scored;
    const mine = scored?.summary.find((r) => r.candidate === offer.candidate) ?? null;
    const base = scored?.summary.find((r) => r.candidate === BASE) ?? null;
    const together = `Its ${plural(files.length, "file", "files")} ${files.length === 1 ? "is" : "are"} accepted or rejected together.`;
    const whole = mine === null
      ? `The whole candidate is decided at once. ${together}`
      : `The score shown is the whole candidate's: ${offer.candidate} scored ${mine.score} of 1000${base === null ? "" : `, the unchanged loop ${base.score}`}. ${together}`;
    const partly = offer.undecided < files.length;
    const off = replaying();
    const why = off ? REPLAY_REFUSAL : undefined;
    const controls = !analyst() ? null : h("div", { class: "adopt-actions" },
      partly
        ? h("button", { type: "button", data: { action: "adopt-finish" }, disabled: off || busy, title: why ?? "Reject every file still undecided and pass the gate", on: { click: () => decide("adopt_finish", {}) } }, "Finish: reject the rest")
        : [
          h("button", {
            type: "button", class: "primary", data: { action: "adopt-accept" }, disabled: off || busy || stale > 0 || view === null,
            title: why ?? `Write every file of ${offer.candidate} into the loop's root, in your name`, on: { click: () => decide("adopt_decide", { change: offer.change, accept: true }) },
          }, "Accept"),
          " ",
          h("button", { type: "button", data: { action: "adopt-reject" }, disabled: off || busy, title: why ?? "Leave the loop as it is", on: { click: () => decide("adopt_decide", { change: offer.change, accept: false }) } }, "Reject"),
        ]);
    return h("section", { class: "improve-part improve-adopt", data: { part: "adopt" } },
      h("h3", null, `Adopt ${offer.candidate} · ${vc?.title ?? change.title}`),
      h("p", { class: "adopt-whole" }, whole),
      h("ul", { class: "adopt-files", role: "list" }, files.map((f, n) => {
        const vf = vc?.files.find((x) => x.index === n) ?? null;
        return h("li", { class: "adopt-file", data: { file: String(n) } },
          h("span", { class: "file-path" }, f.path),
          f.decided === null ? null : [" ", h("span", { class: `file-decided tag ${f.decided.accepted ? "tag-done" : "tag-human"}` }, f.decided.accepted ? "Accepted" : "Rejected")],
          f.decided === null && vf?.stale === true ? h("p", { class: "file-stale tag tag-attention" }, STALE) : null);
      })),
      controls,
      analyst() && stale > 0 && !partly ? h("p", { class: "adopt-stale attention" }, `Accept is off: ${plural(stale, "file", "files")} changed on disk since the candidate was proposed. Run the improve loop again.`) : null,
      refusalLine(h, refused, `improve:${store.id}:adopt`));
  };

  // ---------- painting ----------
  const paint = (): void => {
    if (destroyed) return;
    const s = store.shown;
    const sig = JSON.stringify([s.seq, store.at, version, busy, refused ?? null, ui.me.role]);
    if (sig === painted) return;
    painted = sig;
    const focused = ui.doc.activeElement as HTMLElement | null;
    const keep = focused !== null && el.contains(focused) ? (focused.dataset.action ?? focused.dataset.case ?? null) : null;
    clear(el);
    if (s.improve.request === null) { el.appendChild(h("p", { class: "empty" }, "This case is not an improve case.")); return; }
    el.append(...present(
      failed ? h("p", { class: "load-error say", role: "alert" }, "What this improve run recorded could not be read; the ledger's record is shown") : null,
      requestPart(s), candidatesPart(s), probesPart(s), choicePart(s), scoresPart(s), lessonsPart(s), adoptPart(s),
    ) as Node[]);
    if (keep !== null) ([...el.querySelectorAll("button")].find((b) => (b as HTMLElement).dataset.action === keep || (b as HTMLElement).dataset.case === keep) as HTMLElement | undefined)?.focus();
    if (toGate) {
      const g = el.querySelector("[data-part=adopt]") as HTMLElement | null;
      if (g !== null) { toGate = false; if (typeof g.scrollIntoView === "function") g.scrollIntoView({ block: "nearest", behavior: ui.reducedMotion() ? "auto" : "smooth" }); }
    }
  };

  const update = (): void => {
    if (destroyed) return;
    const fresh = store.entries.filter((e) => e.seq > seen);
    seen = store.live.seq;
    if (fresh.some((e) => VIEW_TYPES.has(e.type))) read();
    paint();
  };

  read();
  paint();
  return { el, update, destroy() { destroyed = true; } };
}
