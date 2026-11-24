import { eventSourceEntries, makeApi } from "./api";
import { startApp } from "./app";
import { makeH } from "./dom";
import { makePrefs } from "./prefs";
import type { Ui } from "./ui";

async function main(): Promise<void> {
  let storage: Storage | null = null;
  try { storage = localStorage; } catch { storage = null; }
  const api = makeApi((r) => fetch(r), location.origin, eventSourceEntries(window, location.origin));
  const [me, ref] = await Promise.all([api.me(), api.reference()]);
  const ui: Ui = {
    doc: document, win: window, h: makeH(document), api, prefs: makePrefs(storage), me, ref,
    toast: () => {},                              // Task 6 replaces this
    reducedMotion: () => matchMedia("(prefers-reduced-motion: reduce)").matches,
    act: async () => false,                       // Task 6 replaces this
  };
  const root = document.getElementById("app");
  if (root === null) throw new Error("the page has no #app");
  startApp(ui, root);
}

void main();
