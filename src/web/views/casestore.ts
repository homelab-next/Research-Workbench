import type { StoredCaseView, StoreView } from "../../core/wire";
import { clear } from "../dom";
import { markingChip } from "../chips";
import { refusalLine } from "../refusal";
import { timeEl } from "../time";
import type { Screen, Shell } from "../app";

export const SETTING_NAME = "Unload a case to the store when it is published";

/**
 * The Case store (slice 11): the files in the store as each one's case.json describes them (nothing is unpacked to list them), a search the server
 * answers, Load and Delete on each row, and the on-complete setting. A title, a question or a file name from a case file is only ever text here.
 */
export function caseStoreView(shell: Shell): Screen {
  const { ui, nav } = shell;
  const h = ui.h;
  let listing: StoreView | null = null;
  let failed = false;
  let asked = 0;                 // the latest search sent: an answer to any earlier one is dropped
  let destroyed = false;
  let deleting: string | null = null;
  const refused = new Map<string, string>();     // a file's last refusal (load or delete), shown on its row
  const busy = new Set<string>();
  let settingWhy: string | undefined;

  const search = h("input", { type: "search", name: "Search the case store", placeholder: "Search by id, title, question or observable value" }) as HTMLInputElement;
  const folder = h("p", { class: "store-folder" }, `Files in ${ui.me.cases.store}`);
  const list = h("div", { class: "store-list", role: "list" });
  const leftovers = h("p", { class: "store-leftovers muted" });
  const loadError = h("p", { class: "load-error say", role: "alert" });

  const ask = (text: string): void => {
    const mine = ++asked;
    ui.api.store(text).then((view) => {
      if (destroyed || mine !== asked) return;
      listing = view; failed = false;
      list.dataset.ready = text;
      render();
    }, () => {
      if (destroyed || mine !== asked) return;
      failed = true;
      render();
    });
  };

  const load = (c: StoredCaseView): void => {
    if (busy.has(c.file)) return;
    busy.add(c.file); refused.delete(c.file); render();
    void ui.api.load(c.file).then((r) => {
      busy.delete(c.file);
      if (destroyed) return;
      if (r.ok) { shell.refreshCases(); nav.go({ screen: "case", id: r.id }); return; }
      refused.set(c.file, r.refused.join("; "));
      render();
    });
  };

  const remove = (c: StoredCaseView, typed: string): void => {
    if (busy.has(c.file) || typed !== c.id) return;
    busy.add(c.file); refused.delete(c.file); render();
    void ui.api.deleteStored(c.file, typed).then((r) => {
      busy.delete(c.file);
      if (destroyed) return;
      if (r.ok) { deleting = null; ui.toast(`The file of ${c.id} was deleted from the case store`); ask(search.value); return; }
      refused.set(c.file, r.refused.join("; "));
      render();
    });
  };

  /** The box Delete opens: the file goes only once its case's id is typed exactly. */
  const deleteBox = (c: StoredCaseView): HTMLElement => {
    const confirm = h("button", { type: "button", class: "danger", data: { action: "confirm-delete" }, disabled: true, name: `Delete the file of ${c.id}` }, "Delete the file") as HTMLButtonElement;
    const typed = h("input", {
      type: "text", name: `Type ${c.id} to delete`, placeholder: c.id,
      on: {
        input: () => { confirm.disabled = typed.value !== c.id || busy.has(c.file); },
        keydown: (e) => {
          const k = e as KeyboardEvent;
          if (k.key === "Enter" && typed.value === c.id) { k.preventDefault(); remove(c, typed.value); }
          else if (k.key === "Escape") { k.stopPropagation(); deleting = null; render(); }
        },
      },
    }) as HTMLInputElement;
    confirm.addEventListener("click", () => remove(c, typed.value));
    return h("div", { class: "delete-box", role: "group", name: `Delete the file of ${c.id}` },
      h("p", null, `Type ${c.id} to delete its file from the case store. This cannot be undone.`),
      h("div", { class: "delete-row" }, typed, confirm,
        h("button", { type: "button", data: { action: "cancel-delete" }, on: { click: () => { deleting = null; render(); } } }, "Cancel")));
  };

  const rowOf = (c: StoredCaseView): HTMLElement => {
    const actions = h("div", { class: "stored-actions" },
      c.loaded
        ? h("span", { class: "loaded tag tag-done", title: `${c.id} is in the working set` }, "Loaded")
        : h("button", { type: "button", class: "primary", data: { action: "load" }, name: `Load ${c.id}`, disabled: busy.has(c.file), on: { click: () => load(c) } }, "Load"),
      h("button", { type: "button", data: { action: "delete" }, name: `Delete ${c.id}`, disabled: busy.has(c.file), aria: { expanded: deleting === c.file ? "true" : "false" },
        on: { click: () => { deleting = deleting === c.file ? null : c.file; render(); } } }, "Delete"));
    const el = h("article", { class: c.loaded ? "stored-case is-loaded" : "stored-case", role: "listitem", data: { file: c.file, id: c.id } },
      h("div", { class: "stored-head" }, h("span", { class: "id" }, c.id), h("span", { class: "title" }, c.title), markingChip(ui, c.marking)),
      h("p", { class: "asked" }, c.asked),
      h("div", { class: "stored-facts" },
        h("span", { class: "status chip" }, c.status),
        c.outcome === null ? null : h("span", { class: "outcome chip" }, c.outcome),
        h("span", { class: "entries chip" }, `${c.entries} entries`),
        h("span", { class: "when" }, "unloaded ", timeEl(ui, c.unloaded_ts, "local"))),
      actions,
      refusalLine(h, refused.get(c.file), `store:${c.file}`),
      deleting === c.file ? deleteBox(c) : null);
    return el;
  };

  const render = (): void => {
    loadError.textContent = failed ? "The case store could not be read" : "";
    if (listing === null) return;
    folder.textContent = `Files in ${listing.store}`;
    const focused = ui.doc.activeElement;
    const keepFocus = focused !== null && list.contains(focused) ? (focused as HTMLElement).getAttribute("aria-label") : null;
    clear(list);
    for (const c of listing.cases) list.appendChild(rowOf(c));
    for (const u of listing.unreadable) {
      list.appendChild(h("div", { class: "stored-unreadable", role: "listitem", data: { file: u.file } },
        h("span", { class: "file" }, u.file), h("span", { class: "reason muted" }, u.reason)));
    }
    if (listing.cases.length === 0 && listing.unreadable.length === 0) {
      list.appendChild(h("p", { class: "store-none", role: "status" }, list.dataset.ready === "" ? "The case store is empty" : "Nothing in the case store matches"));
    }
    leftovers.textContent = listing.leftovers > 0 ? `${listing.leftovers} temporary file(s) left by an unload that stopped` : "";
    // the delete box takes focus when it opens; a button that was focused keeps it across a repaint
    const box = deleting === null ? null : list.querySelector(".delete-box input") as HTMLInputElement | null;
    if (box !== null && keepFocus !== box.getAttribute("aria-label")) box.focus();
    else if (keepFocus !== null) {
      for (const b of Array.from(list.querySelectorAll("button, input")) as HTMLElement[]) if (b.getAttribute("aria-label") === keepFocus) { b.focus(); break; }
    }
  };

  // the setting: the default of "Unload after publishing" at the publish gate; it unloads nothing by itself
  const settingWhyAt = h("div", { class: "setting-why" });
  const setting = h("input", { type: "checkbox", name: SETTING_NAME, checked: ui.me.cases.on_complete === "unload" }) as HTMLInputElement;
  const paintSetting = (): void => { clear(settingWhyAt); const line = refusalLine(h, settingWhy, "setting:cases.on_complete"); if (line !== null) settingWhyAt.appendChild(line); };
  setting.addEventListener("change", () => {
    const want = setting.checked ? "unload" : "keep";
    setting.disabled = true;
    void ui.api.setSetting("cases.on_complete", want).then((r) => {
      if (destroyed) return;
      setting.disabled = false;
      if (r.ok) { ui.me.cases.on_complete = want; settingWhy = undefined; }
      else { settingWhy = r.refused.join("; "); }
      setting.checked = ui.me.cases.on_complete === "unload";     // refused: the box is put back
      paintSetting();
    });
  });
  const settingBox = h("div", { class: "store-setting" },
    h("label", null, setting, ` ${SETTING_NAME}`),
    h("p", { class: "muted" }, "This is where \"Unload after publishing\" starts at the publish gate. It unloads nothing by itself."),
    settingWhyAt);

  search.addEventListener("input", () => ask(search.value));
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (search.value !== "") { search.value = ""; ask(""); } else nav.up();
  });

  const el = h("main", { class: "top", data: { screen: "store" }, tabindex: -1 },
    h("h1", null, "Case store"), folder, settingBox, h("div", { class: "filter" }, search), loadError, list, leftovers);
  ask("");
  return {
    el, update() {},
    focus() { search.focus(); },
    destroy() { destroyed = true; },
  };
}
