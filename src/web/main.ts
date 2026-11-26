import type { Reference } from "../core/wire";
import { eventSourceEntries, makeApi } from "./api";
import { startApp } from "./app";
import { makeH } from "./dom";
import { makePrefs } from "./prefs";
import type { Ui } from "./ui";

/** A requester or a leader may not read the reference; they have nothing to choose from. */
const NO_REFERENCE: Reference = { types: [], sources: [], pivots: [], objectives: [], phases: [], profile: { id: "none", title: "none" }, send_back_cap: 0, playbooks: [] };

async function main(): Promise<void> {
  let storage: Storage | null = null;
  try { storage = localStorage; } catch { storage = null; }
  const api = makeApi((r) => fetch(r), location.origin, eventSourceEntries(window, location.origin));
  const [me, ref] = await Promise.all([api.me(), api.reference().catch((): Reference => NO_REFERENCE)]);
  const ui: Ui = {
    doc: document, win: window, h: makeH(document), api, prefs: makePrefs(storage), me, ref,
    toast: () => {},                              // startApp puts the real toasts in
    reducedMotion: () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    act: async () => false, send: async () => null,   // startApp puts the real sending in
  };
  const root = document.getElementById("app");
  if (root === null) throw new Error("the page has no #app");
  startApp(ui, root);
}

void main();
