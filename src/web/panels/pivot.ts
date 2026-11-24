import type { Observable, TimeWindow } from "../../core/types";
import type { RouteView } from "../../core/wire";
import { cardChip, tag } from "../chips";
import { clear } from "../dom";
import type { CaseStore } from "../store";
import { routeTrail } from "../trail";
import type { Nav } from "../app";
import type { Ui, View } from "../ui";

export interface PivotPanel extends View { setValues(values: Observable[]): void }

const DAY_MS = 86_400_000;
const WINDOWS: [string, string][] = [["case", "The case's window"], ["1d", "Last 1 day"], ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["custom", "Custom"], ["all", "All time"]];
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const utcMs = (x: string): boolean => UTC_MS.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The Pivot panel, inside one open card (guide §5.4): the values to start from, what is wanted, the routes the finder offers (read from the
 * registry, nothing asked of any source), the window, limits and reason, and the trail of the newest route started here, read from the entries.
 * A route is run by the `run_route` command; a costly lookup the route could not afford waits here for a budget the person sets.
 */
export function makePivotPanel(ui: Ui, store: CaseStore, nav: Pick<Nav, "focusCard">, card: string): PivotPanel {
  const { h } = ui;
  let values: Observable[] = [];
  let want = "";
  let routes: RouteView[] | "loading" | "failed" = [];
  let loads = 0;
  let windowKind = "case";
  let from = "", to = "";
  let maxCost = "";
  let unconfirmed = false;
  let why = "";
  let whyEdited = false;
  let job: string | null = null;
  let after: number | null = null;
  let trailSig = "";
  let wasReadonly = false;
  const budgets = new Map<string, { value: string; budget: string }>();
  const ran = new Set<string>();

  const ro = (): boolean => store.at !== null;
  const typeTitle = (id: string): string => ui.ref.types.find((t) => t.id === id)?.title ?? id;
  const pivotTitle = (id: string | null): string => (id === null ? "Query" : ui.ref.pivots.find((x) => x.id === id)?.title ?? id);
  const suggested = (): string => `Pivot from ${card} to ${typeTitle(want)}`;

  // ---------- the window ----------
  const caseWindow = (): TimeWindow => store.live.meta?.window ?? { from: null, to: null };
  /** The window the choice names, or null while a custom one is not two UTC times in order. */
  const windowValue = (): TimeWindow | null => {
    switch (windowKind) {
      case "case": return caseWindow();
      case "all": return { from: null, to: null };
      case "custom": return utcMs(from) && utcMs(to) && Date.parse(from) <= Date.parse(to) ? { from, to } : null;
      default: {
        const days = windowKind === "1d" ? 1 : windowKind === "7d" ? 7 : 30;
        const end = caseWindow().to ?? new Date().toISOString();
        return { from: new Date(Date.parse(end) - days * DAY_MS).toISOString(), to: end };
      }
    }
  };
  const limit = (): number | null | "bad" => {
    const t = maxCost.trim();
    if (t === "") return null;
    return /^\d+(?:\.\d+)?$/.test(t) ? Number(t) : "bad";
  };

  // ---------- controls that live as long as the panel ----------
  const chips = h("span", { class: "chips" });
  const wantSelect = h("select", { name: "What do you want?", on: { change: (e) => { want = (e.target as HTMLSelectElement).value; if (!whyEdited) syncWhy(); reload(); } } },
    h("option", { value: "" }, "Choose…"), ui.ref.types.map((t) => h("option", { value: t.id }, t.title))) as HTMLSelectElement;
  const windowSelect = h("select", { name: "Window", on: { change: (e) => { windowKind = (e.target as HTMLSelectElement).value; paintWindow(); paintRoutes(); } } },
    WINDOWS.map(([id, label]) => h("option", { value: id }, label))) as HTMLSelectElement;
  const customBox = h("span", { class: "custom-window", hidden: true },
    h("input", { type: "text", name: "From (UTC)", placeholder: "2026-11-20T00:00:00.000Z", on: { input: (e) => { from = (e.target as HTMLInputElement).value.trim(); paintRoutes(); } } }),
    " ", h("input", { type: "text", name: "To (UTC)", placeholder: "2026-11-21T00:00:00.000Z", on: { input: (e) => { to = (e.target as HTMLInputElement).value.trim(); paintRoutes(); } } }));
  const costInput = h("input", { type: "text", name: "Max cost", placeholder: "none", on: { input: (e) => { maxCost = (e.target as HTMLInputElement).value; reload(); } } }) as HTMLInputElement;
  const allow = h("input", { type: "checkbox", name: "Allow unconfirmed sources", on: { change: (e) => { const on = (e.target as HTMLInputElement).checked; if (on !== unconfirmed) { unconfirmed = on; reload(); } } } }) as HTMLInputElement;
  const whyInput = h("input", { type: "text", name: "Why", on: { input: (e) => { why = (e.target as HTMLInputElement).value; whyEdited = true; paintRoutes(); } } }) as HTMLInputElement;
  const routeBox = h("div", { class: "routes" });
  const trailBox = h("div", { class: "trail route-trail", role: "status" });
  const el = h("section", { class: "pivot-panel", name: "Pivot" },
    h("div", { class: "row starting" }, h("span", { class: "label" }, "Starting from:"), " ", chips),
    h("div", { class: "row" }, h("label", { class: "wanted-label" }, "What do you want?"), " ", wantSelect),
    h("div", { class: "row" }, h("label", { class: "label" }, "Window:"), " ", windowSelect, " ", customBox),
    h("div", { class: "row" }, h("span", { class: "label" }, "Limits:"), " ", h("label", null, "Max cost "), costInput, " ", h("label", null, allow, " Allow unconfirmed sources")),
    h("div", { class: "row" }, h("label", { class: "label" }, "Why "), whyInput),
    routeBox, trailBox);

  function syncWhy(): void { why = suggested(); whyInput.value = why; }
  function paintWindow(): void { customBox.hidden = windowKind !== "custom"; }

  // ---------- the starting values ----------
  function paintStarting(): void {
    clear(chips);
    if (values.length === 0) { chips.append(h("span", { class: "muted" }, "no values")); return; }
    for (const o of values) {
      chips.append(h("button", {
        type: "button", class: "chip value", name: values.length > 1 ? `${o.type} ${o.value}: take out` : `${o.type} ${o.value}`, title: values.length > 1 ? `Take ${o.value} out of this pivot` : `${o.type} ${o.value}`,
        on: { click: () => { if (values.length > 1) { values = values.filter((x) => x !== o); paintStarting(); reload(); } } },
      }, o.value), " ");
    }
  }

  // ---------- the routes ----------
  function reload(): void {
    const mine = ++loads;
    const cost = limit();
    if (want === "" || values.length === 0 || cost === "bad") { routes = []; paintRoutes(); return; }
    routes = "loading";
    paintRoutes();
    ui.api.routes({ have: [...new Set(values.map((v) => v.type))], want, max_weight: cost, unconfirmed }).then((list) => {
      if (mine !== loads) return;
      routes = list;
      paintRoutes();
    }).catch(() => {
      if (mine !== loads) return;
      routes = "failed";
      paintRoutes();
    });
  }

  const unconfirmedTag = (): HTMLElement => {
    const t = tag(ui, "attention", "unconfirmed source", "The source's manifest is not marked confirmed");
    t.classList.add("unconfirmed");
    return t;
  };
  const hopLine = (hop: RouteView["hops"][number]): HTMLElement => h("div", { class: "hop" },
    h("span", { class: "source" }, hop.source_title), " · ", h("span", { class: "pivot" }, hop.title), " · ",
    h("span", { class: hop.free ? "cost free" : "cost costly" }, hop.free ? "free" : `costly (${hop.weight} per ${hop.unit})`),
    hop.needs_window ? " · " : null, hop.needs_window ? h("span", { class: "needs-window" }, "needs a window") : null,
    " · ", h("span", { class: "empty-means" }, `if empty: ${hop.empty_means === "proven-negative" ? "proven negative" : "not seen"}`),
    hop.confirmed ? null : " ", hop.confirmed ? null : unconfirmedTag());

  function paintRoutes(): void {
    clear(routeBox);
    if (want === "") return;
    if (routes === "loading") { routeBox.append(h("p", { class: "muted" }, "Looking for routes…")); return; }
    if (routes === "failed") { routeBox.append(h("p", { class: "attention" }, "Could not load the routes.")); return; }
    if (limit() === "bad") { routeBox.append(h("p", { class: "attention" }, "Max cost must be a number, or blank for none.")); return; }
    if (routes.length === 0) { routeBox.append(h("p", { class: "empty" }, `No route from these values to ${typeTitle(want)}.`)); return; }
    routes.forEach((route, n) => {
      const window = windowValue();
      const noWindow = windowKind === "all" && route.hops.some((x) => x.needs_window);
      const reason = ro() ? "Return to live to run a route" : why.trim() === "" ? "Say why first" : window === null ? "The custom window needs two UTC times, the first not after the second" : noWindow ? "A hop here needs a window; choose one" : null;
      const run = h("button", {
        type: "button", class: "action", data: { action: "run" }, disabled: reason !== null, title: reason ?? `Run this route: ${plural(route.hops.length, "hop", "hops")} to ${typeTitle(want)}`,
        on: { click: () => { void runRoute(route); } },
      }, `Run: ${plural(route.hops.length, "hop", "hops")} to ${typeTitle(want)}`);
      routeBox.append(h("div", { class: "route", data: { route: String(n) } },
        h("div", { class: "route-head" }, `${plural(route.hops.length, "hop", "hops")} · weight ${route.weight}`),
        route.hops.map(hopLine), run, noWindow ? h("span", { class: "why-disabled attention" }, " needs a window: choose one") : null));
    });
  }

  async function runRoute(route: RouteView): Promise<void> {
    const window = windowValue();
    if (window === null || ro() || why.trim() === "") return;
    const before = store.live.seq;
    const cost = limit();
    const sent = await ui.send("run_route", { have: values, want, window, why: why.trim(), max_weight: cost === "bad" ? null : cost, allow_unconfirmed: unconfirmed });
    void route;
    if (sent === null) return;
    after = before; job = null; trailSig = "";
    paintTrail();
  }

  // ---------- the trail of the newest route started here ----------
  function findJob(): void {
    if (after === null) return;
    for (let i = after; i < store.entries.length; i++) {
      const e = store.entries[i]!;
      if (e.type === "job.started" && e.payload.kind === "query" && e.payload.title.startsWith("Route to ")) { job = e.payload.job; after = null; return; }
    }
  }
  const unit = (pivot: string): string => {
    const source = ui.ref.pivots.find((x) => x.id === pivot)?.source;
    return ui.ref.sources.find((x) => x.id === source)?.cost.unit ?? "units";
  };
  const budgetBlock = (pivot: string): HTMLElement => {
    const info = ui.ref.pivots.find((x) => x.id === pivot);
    const mem = budgets.get(pivot) ?? { value: values.find((v) => v.type === info?.from)?.value ?? "", budget: "" };
    budgets.set(pivot, mem);
    const amount = (): number => (/^\d+(?:\.\d+)?$/.test(mem.budget.trim()) ? Number(mem.budget) : 0);
    const go = h("button", { type: "button", class: "action", data: { action: "run-lookup" }, on: { click: () => { void lookup(pivot, mem, go); } } }) as HTMLButtonElement;
    const label = (): void => {
      go.textContent = `Run this lookup: spend up to ${mem.budget.trim() === "" ? "…" : mem.budget.trim()} ${unit(pivot)}`;
      go.disabled = ro() || !(amount() > 0) || mem.value.trim() === "";
    };
    label();
    return h("div", { class: "needs-budget", data: { pivot } },
      h("p", null, `${pivotTitle(pivot)} needs a budget: costly (${info?.weight ?? 0} per ${unit(pivot)}). Nothing costly runs until you set one.`),
      h("label", null, "Value "), h("input", { type: "text", name: "Value", value: mem.value, on: { input: (e) => { mem.value = (e.target as HTMLInputElement).value; label(); } } }), " ",
      h("label", null, "Budget "), h("input", { type: "text", name: "Budget", placeholder: unit(pivot), value: mem.budget, on: { input: (e) => { mem.budget = (e.target as HTMLInputElement).value; label(); } } }), " ", go);
  };
  async function lookup(pivot: string, mem: { value: string; budget: string }, go: HTMLButtonElement): Promise<void> {
    const window = windowValue();
    if (window === null || ro()) return;
    go.disabled = true;
    const sent = await ui.send("run_pivot", { pivot, value: mem.value.trim(), window, why: why.trim() === "" ? suggested() : why.trim(), budget: Number(mem.budget) });
    if (sent === null) { go.disabled = false; return; }
    ran.add(pivot); trailSig = "";
    ui.toast(`Lookup run: ${pivotTitle(pivot)}`);
    paintTrail();
  }

  function paintTrail(): void {
    findJob();
    const shown = store.shown.seq;
    const t = job === null ? null : routeTrail(shown >= store.entries.length ? store.entries : store.entries.slice(0, shown), job);
    const sig = JSON.stringify([job, t, [...ran], ro()]);
    if (sig === trailSig) return;
    trailSig = sig;
    clear(trailBox);
    if (t === null) return;
    for (const l of t.lookups) {
      const words = l.status === "running" ? "running" : l.status === "answered" ? `answered: ${l.rows} rows` : l.status === "failed" ? `failed: ${l.detail}` : `${l.status}: ${l.detail}`;
      trailBox.append(h("div", { class: `lookup ${l.status}`, data: { query: l.query } },
        h("span", { class: "what" }, `${pivotTitle(l.pivot)} · ${l.value}`), " ", h("span", { class: "status" }, words),
        l.card === null ? null : " ", l.card === null ? null : cardChip(ui, l.card, (c) => nav.focusCard(c))));
    }
    const f = t.finished;
    if (f === null) return;
    const answered = f.outcome === "answered";
    trailBox.append(h("div", { class: `finished ${f.outcome}` },
      h("span", { class: answered ? "verdict tag tag-done" : "verdict tag tag-attention" }, answered ? `answered: ${f.reached.map((o) => o.value).join(", ")}` : "blocked"),
      f.blocked.length > 0 ? h("p", { class: "dry" }, `Ran dry: ${f.blocked.map(pivotTitle).join(", ")}`) : null,
      f.caveats.map((c) => h("p", { class: "caveat" }, c))));
    for (const c of f.caveats) {
      const m = /^([A-Za-z0-9_.-]+): needs a budget/.exec(c);
      if (m !== null && !ran.has(m[1]!)) trailBox.append(budgetBlock(m[1]!));
    }
  }

  return {
    el,
    setValues(next) {
      values = next.map((o) => ({ type: o.type, value: o.value }));
      paintStarting();
      if (!whyEdited && want !== "") syncWhy();
      reload();
    },
    update() {
      if (ro() !== wasReadonly) { wasReadonly = ro(); paintRoutes(); }
      paintTrail();
    },
  };
}
