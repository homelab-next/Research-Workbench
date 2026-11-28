import type { LoopSummaryView, Me, MemoryView } from "../../core/wire";
import { parseCommand, perform } from "../commands";
import type { Route, Shell, Screen } from "../app";

export interface Mode { id: string; column: "help" | "work" | "resources"; label: string; roles: readonly Me["role"][]; live: boolean }

const A = ["analyst"] as const;
const AL = ["analyst", "leader"] as const;
const R = ["requester"] as const;
export const MODES: readonly Mode[] = [
  { id: "ask", column: "help", label: "Ask for help", roles: R, live: false },
  { id: "requests", column: "help", label: "My requests", roles: R, live: false },
  { id: "feedback", column: "help", label: "Give feedback", roles: R, live: false },
  { id: "tickets", column: "work", label: "Work tickets", roles: A, live: false },
  { id: "investigate", column: "work", label: "Investigate", roles: A, live: true },
  { id: "hunt", column: "work", label: "Hunt", roles: A, live: false },
  { id: "actors", column: "work", label: "Actors", roles: A, live: false },
  { id: "folders", column: "work", label: "My folders", roles: A, live: false },
  { id: "loops", column: "resources", label: "Loops", roles: A, live: true },
  { id: "memory", column: "resources", label: "Memory", roles: ["analyst"], live: true },
  { id: "strategy", column: "resources", label: "Strategy", roles: AL, live: false },
  { id: "requirements", column: "resources", label: "Requirements", roles: AL, live: false },
  { id: "gaps", column: "resources", label: "Gaps", roles: AL, live: false },
  { id: "priorities", column: "resources", label: "Priorities", roles: ["leader"], live: false },
  { id: "learn", column: "resources", label: "Learn", roles: A, live: false },
  { id: "inventory", column: "resources", label: "Agent inventory", roles: A, live: false },
];

/** Where a mode's tile goes: a live mode to its own screen, the rest to the honest "not built yet". */
export function modeRoute(m: Mode): Route {
  if (!m.live) return { screen: "soon", mode: m.id };
  return m.id === "loops" ? { screen: "loops" } : m.id === "memory" ? { screen: "memory" } : { screen: "pick" };
}

const COLUMNS: { id: Mode["column"]; title: string; subtitle: string }[] = [
  { id: "help", title: "Get help", subtitle: "Ask the team" },
  { id: "work", title: "Do the work", subtitle: "Pick up a case" },
  { id: "resources", title: "Resources", subtitle: "What steers the work" },
];

export function homeView(shell: Shell): Screen {
  const { ui, nav } = shell;
  const h = ui.h;
  const role = ui.me.role;
  const open = (): number => shell.cases().filter((c) => c.run_status !== "finished").length;
  /** The loops the server listed (an analyst's read only): null until it answers, "failed" when it did not. */
  let loops: LoopSummaryView[] | null | "failed" = null;
  /** The proposals the Memory page has to review: null until the store's read answers, "failed" when it did not. */
  let toReview: number | null | "failed" = null;
  let destroyed = false;
  /** Investigate's, Loops' and Memory's counts are the server's answers: "…" until they come, nothing when the read failed. */
  const count = (m: Mode): string => {
    if (!m.live) return "soon";
    if (m.id === "memory") return toReview === null ? "…" : toReview === "failed" ? "" : `${toReview} to review`;
    if (m.id === "loops") return loops === null ? "…" : loops === "failed" ? "" : `${loops.filter((l) => l.usable).length} usable`;
    const status = shell.casesStatus();
    return status === "loading" ? "…" : status === "failed" && shell.cases().length === 0 ? "" : `${open()} open`;
  };

  const makeTile = (m: Mode): HTMLElement => h("button", {
    type: "button", class: m.live ? "mode" : "mode soon", data: { mode: m.id }, name: count(m) === "" ? m.label : `${m.label}: ${count(m)}`, title: count(m) === "" ? m.label : `${m.label}: ${count(m)}`,
    on: { click: () => nav.go(modeRoute(m)) },
  }, h("span", { class: "label" }, m.label), h("span", { class: "count" }, count(m)));
  const columns = COLUMNS.map((col) => {
    const modes = MODES.filter((m) => m.column === col.id && m.roles.includes(role));
    if (modes.length === 0) return null;
    return h("section", { data: { column: col.id } },
      h("h2", null, col.title), h("p", { class: "muted" }, col.subtitle),
      h("div", { class: "modes" }, modes.map(makeTile)));
  });

  const say = h("p", { class: "say", role: "status" });
  const loadError = h("p", { class: "load-error say", role: "alert" });
  const command = role === "analyst"
    ? h("input", {
      type: "text", name: "Command", placeholder: "investigate CASE-1",
      on: {
        keydown: (e) => {
          if ((e as KeyboardEvent).key !== "Enter") return;
          const input = e.target as HTMLInputElement;
          if (input.value.trim() === "") return;
          const intent = parseCommand(input.value, { cases: shell.cases(), in_case: false, cards: [] });
          void perform(intent, { ui, nav, store: null }).then((r) => {
            if (r.cleared) input.value = "";
            say.textContent = r.say ?? "";
          });
        },
      },
    }) as HTMLInputElement
    : null;

  const el = h("main", { class: "home", data: { screen: "home" }, tabindex: -1 },
    h("h1", null, "How can I help you today?"),
    loadError,
    h("div", { class: "columns" }, columns),
    command === null ? null : h("div", { class: "home-command" }, command, say),
    h("p", { class: "hint" }, "Press ? for keys"));

  /** The live counts are Investigate's, Loops' and Memory's: replace those tiles, keeping focus where it was. */
  const repaint = (id: string): void => {
    const old = el.querySelector(`[data-mode=${id}]`);
    if (old === null) return;
    const had = ui.doc.activeElement === old;
    const fresh = makeTile(MODES.find((m) => m.id === id)!);
    if (fresh.textContent === old.textContent) return;
    old.replaceWith(fresh);
    if (had) fresh.focus();
  };
  if (MODES.some((m) => m.id === "loops" && m.roles.includes(role))) {
    ui.api.loops().then((list) => { if (destroyed) return; loops = list; repaint("loops"); }, () => { if (destroyed) return; loops = "failed"; repaint("loops"); });
  }
  if (MODES.some((m) => m.id === "memory" && m.roles.includes(role))) {
    const proposals = (v: MemoryView): number => v.groups.reduce((n, g) => n + g.lessons.filter((l) => l.status === "proposed").length, 0);
    Promise.resolve().then(() => ui.api.memory()).then((v) => { if (destroyed) return; toReview = proposals(v); repaint("memory"); }, () => { if (destroyed) return; toReview = "failed"; repaint("memory"); });
  }
  return {
    el,
    update() {
      loadError.textContent = shell.casesStatus() === "failed" ? "The cases could not be loaded" : "";
      repaint("investigate");
    },
    focus() { (command ?? el).focus(); },
    destroy() { destroyed = true; },
  };
}
