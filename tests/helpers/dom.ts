import { Window } from "happy-dom";
import type { Config } from "../../src/modules/config";
import type { Entry } from "../../src/core/types";
import type { Reference } from "../../src/core/wire";
import { makeH } from "../../src/web/dom";
import { makeApi } from "../../src/web/api";
import type { EntrySource, Fetcher } from "../../src/web/api";
import { startApp } from "../../src/web/app";
import type { CaseScreen, Open } from "../../src/web/app";
import { caseScreenFor } from "../../src/web/views/workarea";
import type { CaseStore } from "../../src/web/store";
import { makePrefs } from "../../src/web/prefs";
import type { Ui } from "../../src/web/ui";
import { served } from "./served";
import type { Served } from "./served";

type Role = Config["role"];


export interface Page {
  s: Served; win: Window; doc: Document; ui: Ui; root: HTMLElement;
  press(key: string, mods?: { shift?: boolean; alt?: boolean }): void;      // a keydown on the focused element, bubbling
  /** Every key action the screen in front answers to. */
  actions(): Record<string, () => void>;
  click(target: string | Element): void; fill(target: string | Element, text: string): void;
  q(selector: string): HTMLElement; all(selector: string): HTMLElement[]; text(): string;
  /** Waits until the server is idle and every entry it wrote has been rendered. */
  settle(): Promise<void>;
  toasts(): string[];
  /** The case store the open case screen follows, and every nav call the screen made (name first). */
  store(): CaseStore | null; navCalls: unknown[][];
  close(): Promise<void>;
}

/** What a role that may not read the reference sees: nothing to choose from. */
const noReference: Reference = { types: [], sources: [], pivots: [], objectives: [], phases: [], profile: { id: "none", title: "none" }, send_back_cap: 3, playbooks: [] };

/** A Ui over a happy-dom window with no server behind it: for tests of the helpers alone. */
export function testUi(win: Window, over: Partial<Ui> = {}): Ui {
  const doc = win.document as unknown as Document;
  const none = (): never => { throw new Error("no server in this test"); };
  const entries: EntrySource = { open: () => () => {} };
  return {
    doc, win: win as unknown as globalThis.Window, h: makeH(doc), api: makeApi(none as unknown as Fetcher, "http://127.0.0.1:1", entries), prefs: makePrefs(null),
    me: { user: "analyst", role: "analyst", origin: "http://127.0.0.1:1", markings: [], policy: {} as never, problems: [] },
    ref: { types: [], sources: [], pivots: [], objectives: [], phases: [], profile: { id: "p", title: "p" }, send_back_cap: 3, playbooks: [] },
    toast: () => {}, reducedMotion: () => false, act: async () => false, send: async () => null, ...over,
  } as Ui;
}

/** served(), a happy-dom Window at the server's origin, makeApi over app.handle, an EntrySource over hub.read(id).subscribe, and startApp. `reducedMotion` sets what ui.reducedMotion() answers. */
export async function page(opts: { role?: Role; reducedMotion?: boolean; hash?: string; before?: (root: string) => void } = {}): Promise<Page> {
  const s = await served({ role: opts.role, ...(opts.before === undefined ? {} : { before: opts.before }) });
  const win = new Window({ url: `${s.origin}/${opts.hash ?? ""}` });
  const doc = win.document as unknown as Document;
  const toasts: string[] = [];
  const host = new URL(s.origin).host;
  const fetcher: Fetcher = (req) => s.app.handle(new Request(req, { headers: new Headers([...req.headers, ["host", host]]) }));
  const source: EntrySource = {
    open(caseId, after, onEntry) {
      const session = s.app.hub.read(caseId);
      for (const e of session.entries(after)) onEntry(JSON.parse(JSON.stringify(e)) as Entry);
      let last = Math.max(after, session.state.seq);
      return session.subscribe((e) => { if (e.seq > last) { last = e.seq; onEntry(JSON.parse(JSON.stringify(e)) as Entry); } });
    },
  };
  const api = makeApi(fetcher, s.origin, source);
  const ui = testUi(win, { api, me: await api.me(), ref: await api.reference().catch(() => noReference), reducedMotion: () => opts.reducedMotion === true, toast: (m) => { toasts.push(m); } });
  const root = doc.createElement("div");
  doc.body.append(root);
  const navCalls: unknown[][] = [];
  let opened: Open | null = null;
  const screen = caseScreenFor(ui);
  const caseScreen: CaseScreen = (o, register) => {
    opened = o;
    const nav = { ...o.nav, openLens: (...a: Parameters<Open["nav"]["openLens"]>) => { navCalls.push(["openLens", ...a]); o.nav.openLens(...a); }, pivot: (...a: Parameters<Open["nav"]["pivot"]>) => { navCalls.push(["pivot", ...a]); o.nav.pivot(...a); } };
    return screen({ store: o.store, nav }, register);
  };
  const app = startApp(ui, root, { caseScreen });
  const el = (t: string | Element): HTMLElement => (typeof t === "string" ? q(t) : (t as HTMLElement));
  const q = (selector: string): HTMLElement => {
    const found = root.querySelector(selector);
    if (found === null) throw new Error(`nothing matches ${selector}`);
    return found as HTMLElement;
  };
  const page: Page = {
    s, win, doc, ui, root,
    press(key, mods = {}) {
      const target = doc.activeElement ?? doc.body;
      target.dispatchEvent(new win.KeyboardEvent("keydown", { key, shiftKey: mods.shift === true, altKey: mods.alt === true, bubbles: true }) as unknown as Event);
    },
    actions: () => app.actions(),
    click(target) { el(target).dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event); },
    fill(target, text) {
      const input = el(target) as HTMLInputElement;
      input.value = text;
      input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    },
    q, all: (selector) => [...root.querySelectorAll(selector)] as HTMLElement[], text: () => root.textContent ?? "",
    async settle() {
      await s.app.hub.idle();
      await new Promise((r) => setTimeout(r, 0));
      await win.happyDOM.waitUntilComplete();
    },
    toasts: () => [...toasts],
    store: () => (opened as Open | null)?.store ?? null, navCalls,
    async close() {
      app.destroy();
      await win.happyDOM.close();
      await s.close();
    },
  };
  return page;
}
