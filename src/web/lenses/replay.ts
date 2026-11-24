import { BLOB_FIELDS } from "../../core/types";
import type { Entry } from "../../core/types";
import type { Open } from "../app";
import { describe } from "../describe";
import { clear, fileLink, syncList } from "../dom";
import type { Child } from "../dom";
import { isBoundary, matches, seek, step } from "../replay";
import type { ReplayFilter } from "../replay";
import { utc } from "../time";
import type { Ui, View } from "../ui";

const PLAY_MS = 600;
const AROUND = 30;

/** The Replay view, and the one thing the work area asks of it: step one entry (J and K). */
export interface ReplayView extends View { focus(): void; step(dir: 1 | -1): void }

const asObject = (x: unknown): Record<string, unknown> => (typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
const asText = (x: unknown): string => (typeof x === "string" ? x : typeof x === "number" || typeof x === "boolean" ? String(x) : "");

/** The blobs an entry references at a typed position, as [field, hash]. */
function blobsOf(entry: Entry): [string, string][] {
  if (!Object.hasOwn(BLOB_FIELDS, entry.type)) return [];
  const fields = (BLOB_FIELDS as Record<string, readonly string[]>)[entry.type]!;
  const p = asObject(entry.payload);
  const out: [string, string][] = [];
  for (const f of fields) { const hash = asText(asObject(p[f]).blob); if (hash !== "") out.push([f, hash]); }
  return out;
}

/** The Replay lens (spec §10.2): step through the ledger with the work area as it was, and read each entry's who, what, why and hashes. */
export function makeReplay(ui: Ui, open: Open, arg: string | null): ReplayView {
  const { h, win } = ui;
  const { store } = open;
  const filter: ReplayFilter = { actor: null, type: null, stage: null };
  let timer: number | null = null;
  let sig = "";
  let optionsFor = -1;
  let detailFor: number | null = -2;

  const head = h("p", { class: "replay-head", role: "status" });
  const what = h("p", { class: "replay-what" });
  const play = h("button", { type: "button", class: "play", name: "Play", data: { action: "play" }, on: { click: () => start() } }, "Play");
  const halt = h("button", { type: "button", class: "play", name: "Stop", data: { action: "stop" }, hidden: true, on: { click: () => { stop(); el.update(); } } }, "Stop");
  const prev = h("button", { type: "button", name: "Previous entry", title: "Previous entry (K)", on: { click: () => stepBy(-1) } }, "◂");
  const next = h("button", { type: "button", name: "Next entry", title: "Next entry (J)", on: { click: () => stepBy(1) } }, "▸");
  const prevGate = h("button", { type: "button", name: "Previous stage or gate", title: "Previous stage boundary or gate", on: { click: () => boundary(-1) } }, "⇤");
  const nextGate = h("button", { type: "button", name: "Next stage or gate", title: "Next stage boundary or gate", on: { click: () => boundary(1) } }, "⇥");
  const live = h("button", { type: "button", class: "live", name: "Live", title: "Return to the present (Esc)", on: { click: () => goLive() } }, "Live");
  const jump = h("input", {
    type: "text", name: "Go to entry", placeholder: "entry #", class: "replay-jump",
    on: { keydown: (e) => {
      const k = e as KeyboardEvent;
      if (k.key !== "Enter") return;
      k.stopPropagation();
      const typed = (k.target as HTMLInputElement).value.trim();
      if (!/^[0-9]{1,9}$/.test(typed)) { ui.toast("Type an entry number"); return; }
      stop(); store.goTo(Number(typed));
    } },
  }) as HTMLInputElement;
  const select = (name: string, key: keyof ReplayFilter): HTMLSelectElement => h("select", {
    name, on: { change: (e) => { filter[key] = (e.target as HTMLSelectElement).value === "" ? null : (e.target as HTMLSelectElement).value; sig = ""; el.update(); } },
  }) as HTMLSelectElement;
  const actors = select("Actor", "actor");
  const types = select("Type", "type");
  const stages = select("Stage", "stage");
  const list = h("div", { class: "replay-list", role: "list", name: "Entries" });
  const detail = h("dl", { class: "replay-detail" });
  const root = h("div", { class: "lens lens-replay", name: "Replay", tabindex: -1, data: { area: "replay" } },
    head, what,
    h("div", { class: "replay-controls", role: "group", name: "Position" }, prevGate, prev, play, halt, next, nextGate, live, jump),
    h("div", { class: "replay-filters", role: "group", name: "Filter entries" },
      h("label", null, "Actor ", actors), h("label", null, "Type ", types), h("label", null, "Stage ", stages)),
    list, detail);

  const total = (): number => store.live.seq;
  const at = (): number | null => store.at;
  const entryAt = (seq: number | null): Entry | null => (seq === null || seq < 1 ? null : store.entries[seq - 1] ?? null);

  const stop = (): void => { if (timer !== null) { win.clearInterval(timer); timer = null; } };
  const start = (): void => {
    const here = at();
    if (here === null || step(store.entries, here, 1, filter) === null) return;
    timer = win.setInterval(() => {
      const now = at();
      const to = now === null ? null : step(store.entries, now, 1, filter);
      if (to === null) { stop(); el.update(); return; }
      store.goTo(to);
    }, PLAY_MS);
    el.update();
  };
  const goLive = (): void => { stop(); store.goTo(null); };
  const move = (to: number | null): void => { if (to !== null) store.goTo(to); };
  const stepBy = (dir: 1 | -1): void => {
    stop();                                                // a person's own step ends Play
    const here = at();
    if (here === null) { if (dir < 0) move(step(store.entries, total() + 1, -1, filter)); }
    else move(step(store.entries, here, dir, filter));
    el.update();
  };
  const boundary = (dir: 1 | -1): void => {
    stop();
    const here = at() ?? total() + 1;
    move(seek(store.entries, here, dir, isBoundary));
  };

  // ---------- the pieces ----------
  const fill = (box: HTMLSelectElement, values: string[], now: string | null): void => {
    clear(box);
    box.appendChild(h("option", { value: "" }, "All"));
    for (const v of values) box.appendChild(h("option", { value: v }, v));
    box.value = now ?? "";
  };
  const refreshOptions = (): void => {
    if (optionsFor === total()) return;
    optionsFor = total();
    const a = new Set<string>(); const t = new Set<string>(); const s = new Set<string>();
    for (const e of store.entries) { a.add(e.actor.id); t.add(e.type); if (e.stage !== null) s.add(e.stage); }
    fill(actors, [...a], filter.actor); fill(types, [...t], filter.type); fill(stages, [...s], filter.stage);
  };

  const rows = (here: number | null): Entry[] => {
    const all = store.entries;
    const pivot = here ?? total() + 1;
    const before: Entry[] = []; const after: Entry[] = [];
    for (let i = Math.min(pivot - 2, all.length - 1); i >= 0 && before.length < AROUND; i--) if (matches(all[i]!, filter)) before.push(all[i]!);
    if (here !== null) for (let i = pivot; i < all.length && after.length < AROUND; i++) if (matches(all[i]!, filter)) after.push(all[i]!);
    const cur = here !== null && here >= 1 ? entryAt(here) : null;
    return [...before.reverse(), ...(cur === null ? [] : [cur]), ...after];
  };
  const makeRow = (e: Entry): HTMLElement => {
    const d = describe(e, ui.ref);
    const go = (): void => { stop(); store.goTo(e.seq); };
    return h("div", {
      class: e.seq === at() ? "replay-row current" : "replay-row", current: e.seq === at(), role: "listitem", tabindex: 0, data: { seq: String(e.seq) }, title: d.detail,
      on: { click: go, keydown: (ev) => { const k = ev as KeyboardEvent; if (k.key === "Enter" || k.key === " ") { k.preventDefault(); go(); } } },
    },
    h("span", { class: "mark" }, e.seq === at() ? "▸" : ""), h("span", { class: "seq" }, String(e.seq)), " ", h("time", { title: utc(e.ts) }, `${e.ts.slice(11, 19)} UTC`), " ",
    h("span", { class: "actor-id" }, e.actor.id), " ", h("span", { class: "what" }, d.what), d.detail === "" ? null : h("span", { class: "detail" }, ` ${d.detail}`));
  };
  const paintRow = (n: HTMLElement, e: Entry, here: number | null): void => {
    const mark = n.querySelector(".mark");
    if (mark !== null) mark.textContent = e.seq === here ? "▸" : "";
  };

  const row = (label: string, ...value: Child[]): HTMLElement[] => [h("dt", null, label), h("dd", null, value)];
  const paintDetail = (e: Entry | null): void => {
    clear(detail);
    if (e === null) return;
    const p = asObject(e.payload);
    const d = describe(e, ui.ref);
    const a = e.actor;
    const out: HTMLElement[] = [];
    out.push(...row("Who", h("span", { class: "replay-who" }, a.kind === "agent"
      ? `${a.kind}: ${a.id} · stage ${a.stage} · profile ${a.profile} · model ${a.model} · effort ${a.effort ?? "none"} · ran ${a.where}`
      : `${a.kind}: ${a.id}`)));
    out.push(...row("What", `${e.type} · ${d.what}`));
    const why = asText(p.why);
    if (why !== "") out.push(...row("Why", a.kind === "agent" ? `reasoning as stated by the agent: ${why}` : why));
    if (e.type === "query.issued") {
      out.push(...row("Query", h("pre", { class: "query" }, asText(p.text))));
      out.push(...row("Bound values", h("code", null, JSON.stringify(p.bound ?? {}))));
      const w = asObject(p.window);
      out.push(...row("Window", `${asText(w.from) || "open"} to ${asText(w.to) || "open"}`));
    }
    const sourceId = asText(p.source);
    if (sourceId !== "") out.push(...row("Source", ui.ref.sources.find((s) => s.id === sourceId)?.title ?? sourceId));
    const blobs = blobsOf(e);
    const hashes = [`entry ${e.hash}`, `previous ${e.prev_hash}`, ...blobs.map(([f, hash]) => `${f} ${hash}`)];
    out.push(...row("Hashes", ...hashes.map((t) => h("span", { class: "hash" }, t))));
    if (e.cause !== null) {
      const cause = e.cause;
      out.push(...row("Caused by", h("button", { type: "button", class: "replay-cause", name: `Go to entry ${cause}`, on: { click: () => { stop(); store.goTo(cause); } } }, `entry ${cause}`)));
    }
    out.push(...row("Run, stage, job", `${e.run ?? "none"} · ${e.stage ?? "none"} · ${e.job ?? "none"}`));
    if (blobs.length > 0) out.push(...row("Files", blobs.map(([, hash]) => [fileLink(h, ui.api.blobPath(store.id, hash), "raw bytes"), " "]).flat()));
    for (const n of out) detail.appendChild(n);
  };

  const el: ReplayView = {
    el: root,
    focus() { root.focus(); },
    step: stepBy,
    update() {
      const here = at();
      const entry = entryAt(here);
      const key = `${here}|${total()}|${timer !== null}|${filter.actor}|${filter.type}|${filter.stage}`;
      if (key === sig) return;
      sig = key;
      refreshOptions();
      head.textContent = here === null
        ? `Replay · live · ${total()} entries`
        : entry === null ? `Replay · entry ${here} of ${total()} · before the first entry`
          : `Replay · entry ${here} of ${total()} · ${utc(entry.ts)} · ${entry.actor.kind}: ${entry.actor.id}`;
      what.textContent = entry === null ? "" : (() => { const d = describe(entry, ui.ref); return d.detail === "" ? d.what : `${d.what} — ${d.detail}`; })();
      play.hidden = timer !== null; halt.hidden = timer === null;
      (prev as HTMLButtonElement).disabled = here !== null && step(store.entries, here, -1, filter) === null;
      (next as HTMLButtonElement).disabled = here === null || step(store.entries, here, 1, filter) === null;
      (prevGate as HTMLButtonElement).disabled = seek(store.entries, here ?? total() + 1, -1, isBoundary) === null;
      (nextGate as HTMLButtonElement).disabled = here === null || seek(store.entries, here, 1, isBoundary) === null;
      const hadFocus = root.contains(ui.doc.activeElement);
      // The row at the position is a node of its own (aria-current can only be set when a node is made), so the key says which it is.
      syncList(list, rows(here), (e) => (e.seq === here ? `${e.seq}*` : String(e.seq)), makeRow, (n, e) => paintRow(n, e, here));
      if (detailFor !== here) { detailFor = here; paintDetail(entry); }
      if (hadFocus && !root.contains(ui.doc.activeElement)) root.focus();
    },
    destroy() {
      stop();                                              // the position stays: another lens may be looked at as of this entry
    },
  };

  const n = arg === null || !/^[0-9]+$/.test(arg) ? null : Number(arg);
  store.goTo(n === null ? store.at ?? total() : n);
  return el;
}
