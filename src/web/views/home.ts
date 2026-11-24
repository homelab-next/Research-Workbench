import type { Me } from "../../core/wire";
import { parseCommand, perform } from "../commands";
import type { Shell, Screen } from "../app";

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
  { id: "strategy", column: "resources", label: "Strategy", roles: AL, live: false },
  { id: "requirements", column: "resources", label: "Requirements", roles: AL, live: false },
  { id: "gaps", column: "resources", label: "Gaps", roles: AL, live: false },
  { id: "priorities", column: "resources", label: "Priorities", roles: ["leader"], live: false },
  { id: "learn", column: "resources", label: "Learn", roles: A, live: false },
  { id: "inventory", column: "resources", label: "Agent inventory", roles: A, live: false },
];

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
  /** Investigate's count is the server's answer: "…" until it comes, nothing when the read failed. */
  const count = (m: Mode): string => {
    if (!m.live) return "soon";
    const status = shell.casesStatus();
    return status === "loading" ? "…" : status === "failed" && shell.cases().length === 0 ? "" : `${open()} open`;
  };

  const makeTile = (m: Mode): HTMLElement => h("button", {
    type: "button", class: m.live ? "mode" : "mode soon", data: { mode: m.id }, name: count(m) === "" ? m.label : `${m.label}: ${count(m)}`, title: count(m) === "" ? m.label : `${m.label}: ${count(m)}`,
    on: { click: () => nav.go(m.live ? { screen: "pick" } : { screen: "soon", mode: m.id }) },
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

  return {
    el,
    update() {
      // The only live count is Investigate's: replace that tile, keeping focus where it was.
      loadError.textContent = shell.casesStatus() === "failed" ? "The cases could not be loaded" : "";
      const old = el.querySelector("[data-mode=investigate]");
      if (old === null) return;
      const had = ui.doc.activeElement === old;
      const fresh = makeTile(MODES.find((m) => m.id === "investigate")!);
      if (fresh.textContent === old.textContent) return;
      old.replaceWith(fresh);
      if (had) fresh.focus();
    },
    focus() { (command ?? el).focus(); },
  };
}
