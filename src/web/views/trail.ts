import type { CaseSummaryView } from "../../core/wire";
import { clear } from "../dom";
import type { Route, Shell } from "../app";
import { MODES, modeRoute } from "./home";
import type { Mode } from "./home";
import { newestFirst } from "./pick";

/** The mode a route is in, if any. */
function modeOf(route: Route): string | null {
  switch (route.screen) {
    case "home": return null;
    case "soon": return route.mode;
    case "loops": case "loop": case "loop_edit": return "loops";
    case "memory": return "memory";
    default: return "investigate";
  }
}

/** The trail: a home dot, then modes, items and lanes. The current choice at each level is a pill; its siblings are dots. */
export function trail(shell: Shell): { el: HTMLElement; update(): void } {
  const { ui, nav } = shell;
  const h = ui.h;
  const el = h("nav", { class: "trail", name: "Trail" });
  let signature = "";

  const dot = (label: string, onGo: () => void): HTMLElement => h("button", { type: "button", class: "dot", name: label, title: label, on: { click: onGo } });
  const pill = (text: string, full: string, onGo: () => void): HTMLElement => h("button", { type: "button", class: "pill", name: full, title: full, current: true, on: { click: onGo } }, text);
  const sep = (): HTMLElement => h("span", { class: "sep", aria: { hidden: "true" } }, "›");

  const modeButton = (m: Mode, current: boolean, cases: CaseSummaryView[]): HTMLElement => {
    const go = (): void => nav.go(modeRoute(m));
    const button = current ? pill(m.label, m.label, go) : dot(m.label, go);
    if (m.id !== "investigate") return button;
    return h("span", { class: "fly" }, button,
      h("span", { class: "flyout", role: "group", name: "Investigations" }, cases.map((c) => h("button", { type: "button", title: c.title, on: { click: () => nav.go({ screen: "case", id: c.id }) } }, `${c.id} · ${c.title}`))));
  };

  const build = (): void => {
    const route = shell.route();
    const cases = newestFirst(shell.cases());
    clear(el);
    el.appendChild(dot("Home", () => nav.go({ screen: "home" })));
    el.lastElementChild!.classList.add("home");
    const mode = modeOf(route);
    if (mode === null) return;
    el.append(sep(), h("span", { class: "level level-mode" }, MODES.filter((m) => m.roles.includes(ui.me.role) || m.id === mode).map((m) => modeButton(m, m.id === mode, cases))));
    if (route.screen === "case") {
      // only cases the server listed: an id typed into the address bar gets no pill
      el.append(sep(), h("span", { class: "level level-item" }, cases.map((c) => {
        const go = (): void => nav.go({ screen: "case", id: c.id });
        return c.id === route.id ? pill(c.id, `${c.id} · ${c.title}`, go) : dot(c.title, go);
      })));
      const state = shell.store()?.shown;
      if (state && state.lanes.length > 0) {
        el.append(sep(), h("span", { class: "level level-lane" }, state.lanes.map((lane) => {
          const go = (): void => shell.focusLane(lane.id);
          return lane.id === state.target ? pill(lane.title, lane.title, go) : dot(lane.title, go);
        })));
      }
    }
  };

  return {
    el,
    update() {
      const route = shell.route();
      const lanes = route.screen === "case" ? (shell.store()?.shown.lanes ?? []).map((l) => `${l.id}:${l.title}`).join(",") + `|${shell.store()?.shown.target ?? ""}` : "";
      const sig = [routeKey(route), shell.cases().map((c) => `${c.id}:${c.title}`).join(","), lanes].join("#");
      if (sig === signature) return;
      signature = sig;
      build();
    },
  };
}

const routeKey = (r: Route): string => JSON.stringify(r);
