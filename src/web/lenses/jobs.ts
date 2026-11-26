import type { JobState } from "../../core/state";
import type { PlaybookRunState } from "../../core/state/types";
import type { Open } from "../app";
import { syncList } from "../dom";
import { playbookTrail } from "../panels/playbook";
import type { Ui, View } from "../ui";

/** "3.2 s" under ten seconds, "12 s" under a minute, then "1 min 5 s". */
export function lengthOf(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 10) return `${s.toFixed(1)} s`;
  if (s < 60) return `${Math.floor(s)} s`;
  return `${Math.floor(s / 60)} min ${Math.floor(s % 60)} s`;
}

const stamp = (ts: string | null): number => { const t = ts === null ? Number.NaN : Date.parse(ts); return Number.isNaN(t) ? 0 : t; };

/** Running jobs first, then newest first. */
export function orderJobs(jobs: Record<string, JobState>): JobState[] {
  const number = (j: JobState): number => Number(/\d+$/.exec(j.id)?.[0] ?? 0);
  return Object.values(jobs).sort((a, b) =>
    Number(b.status === "running") - Number(a.status === "running") || stamp(b.started_ts) - stamp(a.started_ts) || number(b) - number(a));
}

/** The Jobs lens: every job the case has started, with its status, source and how long it took. A playbook job opens to its run's trail. */
export function makeJobs(ui: Ui, open: Open): View {
  const { h } = ui;
  const { store } = open;
  const list = h("div", { class: "jobs" });
  const empty = h("p", { class: "empty" }, "No jobs yet.");
  const el = h("div", { class: "lens lens-jobs", name: "Jobs" }, list, empty);

  const source = (j: JobState): string => (j.source === null ? "no source" : ui.ref.sources.find((s) => s.id === j.source)?.title ?? j.source);
  const duration = (j: JobState): string => {
    if (j.status !== "running") return `took ${lengthOf(stamp(j.ended_ts) - stamp(j.started_ts))}`;
    // a replay is as of its entry, live is as of now
    const now = store.at === null ? Date.now() : stamp(store.shown.head_ts);
    return `running for ${Math.floor(Math.max(0, now - stamp(j.started_ts)) / 1000)} s`;
  };
  const runOf = (j: JobState): PlaybookRunState | null => (j.kind === "playbook" && Object.hasOwn(store.shown.playbooks, j.id) ? store.shown.playbooks[j.id]! : null);
  /** The run each playbook row's trail was drawn from: the trail is drawn again only when the fold gives a new run object. */
  const drawn = new WeakMap<HTMLElement, PlaybookRunState>();
  const paint = (n: HTMLElement, j: JobState): void => {
    n.querySelector(".status")!.textContent = j.status;
    n.querySelector(".duration")!.textContent = duration(j);
    const run = runOf(j);
    if (run === null || drawn.get(n) === run) return;
    drawn.set(n, run);
    n.querySelector(".playbook-trail")?.remove();
    n.append(playbookTrail(ui, run, store.shown.cards, (card) => open.nav.focusCard(card)));
  };
  const make = (j: JobState): HTMLElement => {
    const row = [h("span", { class: "title" }, j.title), " ", h("span", { class: "kind tag tag-human" }, j.kind), " ", h("span", { class: "status" }), " ",
      h("span", { class: "source" }, source(j)), " ", h("span", { class: "duration" })];
    // a playbook job whose run the case holds opens to that run; any other job is one line
    const n = runOf(j) === null ? h("div", { class: "job-row", data: { job: j.id } }, row) : h("details", { class: "job-row", data: { job: j.id } }, h("summary", null, row));
    paint(n, j);
    return n;
  };

  // a running job's length moves with the clock: while one runs and we are live, repaint once a second; the timer is cleared when none runs and on destroy
  let timer: number | null = null;
  const stopTimer = (): void => { if (timer !== null) { ui.win.clearInterval(timer); timer = null; } };
  const update = (): void => {
    const state = store.shown;
    const jobs = orderJobs(state.jobs);
    empty.hidden = jobs.length > 0;
    // a row is made again when its job gains its run (a plain line becomes one that opens)
    syncList(list, jobs, (j) => (runOf(j) === null ? j.id : `${j.id} run`), make, paint);
    const ticking = store.at === null && jobs.some((j) => j.status === "running");
    if (ticking && timer === null) timer = ui.win.setInterval(update, 1000);
    else if (!ticking) stopTimer();
  };
  return { el, update, destroy: stopTimer };
}
