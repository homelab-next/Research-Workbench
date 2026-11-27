import { parseCommand, perform } from "../commands";
import { tag } from "../chips";
import type { Shell } from "../app";
import type { View } from "../ui";
import { trail } from "./trail";

/** The top bar: the trail on the left, the command bar in the centre, the connection state and the jobs indicator on the right. */
export function topBar(shell: Shell): View {
  const { ui, nav } = shell;
  const h = ui.h;
  const t = trail(shell);
  let inFlight = false;
  const say = h("p", { class: "say", role: "status" });
  const input = h("input", {
    type: "text", name: "Command", placeholder: "open, run, verify c3, or ask",
    on: {
      keydown: (e) => {
        const k = e as KeyboardEvent;
        const box = k.target as HTMLInputElement;
        if (k.key === "Escape") { k.stopPropagation(); box.value = ""; say.textContent = ""; box.blur(); return; }
        if (k.key !== "Enter" || box.value.trim() === "") return;
        const store = shell.store();
        const intent = parseCommand(box.value, { cases: shell.cases(), in_case: store !== null, cards: store ? Object.keys(store.shown.cards) : [] });
        if (inFlight) return;
        inFlight = true;
        const ran = box.value;
        void perform(intent, { ui, nav, store }).then((r) => {
          if (r.cleared && box.value === ran) box.value = "";
          say.textContent = r.say ?? "";
        }).finally(() => { inFlight = false; });
      },
    },
  }) as HTMLInputElement;
  const connection = h("span", { class: "connection-slot" });
  const jobs = h("button", { type: "button", class: "jobs", name: "Jobs", title: "Open the Jobs lens", on: { click: () => nav.openLens("jobs") } }, "jobs (0)");
  const right = h("div", { class: "right" }, connection, jobs);
  /** A child case's parent, a way to open it (slice 12). A run paused on its child says so in the brief, with the way to the child beside the reason. */
  const links = h("div", { class: "case-links" });
  const el = h("header", { class: "topbar" }, t.el, links, h("div", { class: "cmd" }, input, say), right);

  let lastConnection = "live";
  let lastLinks = "";
  const paintLinks = (): void => {
    const state = shell.store()?.shown ?? null;
    const parent = state?.loop.parent?.case ?? null;
    const sig = JSON.stringify([parent]);
    if (sig === lastLinks) return;
    lastLinks = sig;
    while (links.firstChild) links.removeChild(links.firstChild);
    if (parent !== null) {
      links.appendChild(h("button", { type: "button", class: "link-button", data: { action: "open-parent" }, title: `Open ${parent}, the case that made this one`, on: { click: () => nav.go({ screen: "case", id: parent }) } }, `child of ${parent}`));
    }
  };
  const update = (): void => {
    t.update();
    const store = shell.store();
    right.hidden = store === null;                       // jobs belong to a case
    paintLinks();
    if (store === null) return;
    if (store.connection !== lastConnection) {
      lastConnection = store.connection;
      while (connection.firstChild) connection.removeChild(connection.firstChild);
      if (store.connection !== "live") connection.appendChild(h("span", { class: "connection" }, tag(ui, "attention", "reconnecting…", "The connection to the server was lost; trying again")));
    }
    const running = Object.values(store.shown.jobs).filter((j) => j.status === "running").length;
    const text = `jobs (${running})`;
    if (jobs.textContent !== text) jobs.textContent = text;
  };
  return { el, update };
}
