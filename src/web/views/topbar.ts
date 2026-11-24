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
        void perform(intent, { ui, nav, store }).then((r) => {
          if (r.cleared) box.value = "";
          say.textContent = r.say ?? "";
        });
      },
    },
  }) as HTMLInputElement;
  const connection = h("span", { class: "connection-slot" });
  const jobs = h("button", { type: "button", class: "jobs", name: "Jobs", title: "Open the Jobs lens", on: { click: () => nav.openLens("jobs") } }, "jobs (0)");
  const right = h("div", { class: "right" }, connection, jobs);
  const el = h("header", { class: "topbar" }, t.el, h("div", { class: "cmd" }, input, say), right);

  let lastConnection = "live";
  const update = (): void => {
    t.update();
    const store = shell.store();
    right.hidden = store === null;                       // jobs belong to a case
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
