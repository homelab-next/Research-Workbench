import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** WORKBENCH_CHROME; else the newest chrome-headless-shell or chrome under ~/.cache/ms-playwright; else chromium, chromium-browser or google-chrome on the path. */
export function findChrome(): string | null {
  const given = process.env.WORKBENCH_CHROME;
  if (given !== undefined && given !== "") return existsSync(given) ? given : null;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache)) {
    const newest = (prefix: string, inside: string, binary: string): string | null => {
      const found = readdirSync(cache)
        .flatMap((name) => { const m = new RegExp(`^${prefix}-(\\d+)$`).exec(name); return m === null ? [] : [{ n: Number(m[1]), path: join(cache, name, inside, binary) }]; })
        .filter((c) => existsSync(c.path))
        .sort((a, b) => b.n - a.n);
      return found[0]?.path ?? null;
    };
    const shell = newest("chromium_headless_shell", "chrome-headless-shell-linux64", "chrome-headless-shell");
    if (shell !== null) return shell;
    const full = newest("chromium", "chrome-linux64", "chrome");
    if (full !== null) return full;
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    const path = Bun.which(name);
    if (path !== null) return path;
  }
  return null;
}

export interface Tab {
  /** Runtime.evaluate, awaiting a promise, by value. */
  evaluate<T>(expression: string): Promise<T>;
  /** Polls until the expression is truthy; throws with the expression after `ms` (default 10,000). */
  waitFor(expression: string, ms?: number): Promise<void>;
  /** Real mouse events at the element's centre. */
  click(selector: string): Promise<void>;
  /** Mouse down, three moves, up. `at` is where on the target the pointer lands. */
  drag(from: string, to: string, at?: "upper" | "lower" | "centre"): Promise<void>;
  /** Real key events. */
  press(key: string, mods?: { shift?: boolean }): Promise<void>;
  /** Input.insertText into the focused element. */
  type(text: string): Promise<void>;
  reducedMotion(on: boolean): Promise<void>;
  /** Uncaught exceptions, console errors and security-policy violations so far. */
  problems(): string[];
  /** Every URL the page asked for. */
  requests(): string[];
}
export interface Browser { tab(url: string): Promise<Tab>; close(): Promise<void> }

interface Pending { resolve(v: unknown): void; reject(e: Error): void }

/** One debugging-protocol connection over a WebSocket. */
class Wire {
  private next = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, ((params: Record<string, unknown>) => void)[]>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (m) => {
      const msg = JSON.parse(String(m.data)) as { id?: number; result?: unknown; error?: { message: string }; method?: string; params?: Record<string, unknown> };
      if (msg.id !== undefined) {
        const waiting = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error !== undefined) waiting?.reject(new Error(msg.error.message)); else waiting?.resolve(msg.result);
      } else if (msg.method !== undefined) for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params ?? {});
    });
    socket.addEventListener("close", () => { for (const w of this.pending.values()) w.reject(new Error("the browser closed the connection")); this.pending.clear(); });
  }
  static async open(url: string): Promise<Wire> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error(`could not open ${url}`))); });
    return new Wire(socket);
  }
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method: string, fn: (params: Record<string, unknown>) => void): void { (this.listeners.get(method) ?? this.listeners.set(method, []).get(method)!).push(fn); }
  close(): void { try { this.socket.close(); } catch { /* already closed */ } }
}

const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" }, Tab: { code: "Tab", vk: 9 }, Escape: { code: "Escape", vk: 27 }, " ": { code: "Space", vk: 32, text: " " }, Space: { code: "Space", vk: 32, text: " " },
  Backspace: { code: "Backspace", vk: 8 }, ArrowDown: { code: "ArrowDown", vk: 40 }, ArrowUp: { code: "ArrowUp", vk: 38 }, ArrowLeft: { code: "ArrowLeft", vk: 37 }, ArrowRight: { code: "ArrowRight", vk: 39 },
  F2: { code: "F2", vk: 113 },
};
function keyEvent(key: string, shift: boolean): Record<string, unknown> {
  const known = KEYS[key === "Space" ? " " : key];
  const base = { modifiers: shift ? 8 : 0 };
  if (known !== undefined) return { ...base, key: key === "Space" ? " " : key, code: known.code, windowsVirtualKeyCode: known.vk, ...(known.text === undefined || shift ? {} : { text: known.text }) };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const letter = /^[a-z]$/i.test(key);
    const digit = /^[0-9]$/.test(key);
    return { ...base, key, code: letter ? `Key${upper}` : digit ? `Digit${key}` : "", windowsVirtualKeyCode: letter ? upper.charCodeAt(0) : key.charCodeAt(0), text: key };
  }
  throw new Error(`no key table entry for ${key}`);
}

/** Starts the browser with --headless --no-sandbox --disable-gpu --remote-debugging-port=0, a fresh --user-data-dir, and a host rule that resolves nothing but 127.0.0.1; reads the debugging address from its stderr; talks over WebSocket. */
export async function launch(path: string): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "chrome-profile-"));
  const proc = Bun.spawn([path, "--headless", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--no-first-run", "about:blank"], {
    stdout: "ignore", stderr: "pipe", stdin: "ignore",
  });
  const tabs: Wire[] = [];
  const gone = (): void => { for (const w of tabs) w.close(); proc.kill(); };
  // the debugging address is the one line the browser writes that we need
  let address: string;
  try {
    address = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the browser did not say where it listens")), 20_000);
      let seen = "";
      void (async () => {
        const reader = proc.stderr.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { clearTimeout(timer); reject(new Error(`the browser exited before it listened: ${seen.slice(0, 300)}`)); return; }
          seen += new TextDecoder().decode(value);
          const m = /DevTools listening on ws:\/\/(127\.0\.0\.1:\d+)\//.exec(seen);
          if (m !== null) { clearTimeout(timer); resolve(m[1]!); }
        }
      })();
    });
  } catch (err) {
    gone();
    rmSync(profile, { recursive: true, force: true });
    throw err;
  }

  const open = async (url: string): Promise<Tab> => {
    const made = await fetch(`http://${address}/json/new?about:blank`, { method: "PUT" });
    const target = (await made.json()) as { webSocketDebuggerUrl: string };
    const wire = await Wire.open(target.webSocketDebuggerUrl);
    tabs.push(wire);
    const problems: string[] = [];
    const requests: string[] = [];
    wire.on("Runtime.exceptionThrown", (p) => { const d = p.exceptionDetails as { text?: string; exception?: { description?: string } }; problems.push(`exception: ${d.exception?.description ?? d.text ?? "?"}`); });
    wire.on("Runtime.consoleAPICalled", (p) => {
      if (p.type !== "error") return;
      problems.push(`console.error: ${((p.args as { value?: unknown; description?: string }[]) ?? []).map((a) => String(a.value ?? a.description ?? "")).join(" ")}`);
    });
    wire.on("Log.entryAdded", (p) => { const e = p.entry as { level: string; text: string; url?: string }; if (e.level === "error") problems.push(`log: ${e.text}${e.url === undefined ? "" : ` ${e.url}`}`); });
    wire.on("Network.requestWillBeSent", (p) => { requests.push((p.request as { url: string }).url); });
    for (const domain of ["Runtime", "Log", "Network", "Page"]) await wire.send(`${domain}.enable`);
    // a screen tall enough that the lanes and the lens are both in view: a drag can only land on what is on screen
    await wire.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    // a policy violation is reported by the page as an event; it is made loud here so that problems() holds it
    await wire.send("Page.addScriptToEvaluateOnNewDocument", { source: "document.addEventListener('securitypolicyviolation', (e) => console.error('csp: ' + e.violatedDirective + ' ' + e.blockedURI));" });

    const evaluate = async <T>(expression: string): Promise<T> => {
      const r = await wire.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails !== undefined) throw new Error(`evaluating ${expression.slice(0, 120)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value as T;
    };
    const centre = async (selector: string, at: "upper" | "lower" | "centre" = "centre"): Promise<{ x: number; y: number }> => {
      const where = await evaluate<{ x: number; y: number } | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: "center", inline: "center" }); const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * ${at === "upper" ? 0.25 : at === "lower" ? 0.75 : 0.5} }; })()`);
      if (where === null) throw new Error(`nothing matches ${selector}`);
      return where;
    };
    const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<unknown> =>
      wire.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", ...extra });
    const waitFor = async (expression: string, ms = 10_000): Promise<void> => {
      const end = Date.now() + ms;
      for (;;) {
        let value: unknown = false;
        try { value = await evaluate<unknown>(expression); } catch { /* the page may be between documents */ }
        if (value) return;
        if (Date.now() > end) throw new Error(`did not become true within ${ms} ms: ${expression}`);
        await Bun.sleep(40);
      }
    };
    const loaded = new Promise<void>((resolve) => wire.on("Page.loadEventFired", () => resolve()));
    await wire.send("Page.navigate", { url });
    await loaded;
    return {
      evaluate, waitFor,
      async click(selector) {
        const { x, y } = await centre(selector);
        await mouse("mouseMoved", x, y);
        await mouse("mousePressed", x, y, { buttons: 1, clickCount: 1 });
        await mouse("mouseReleased", x, y, { buttons: 0, clickCount: 1 });
      },
      async drag(from, to, at = "centre") {
        const a = await centre(from);
        await mouse("mouseMoved", a.x, a.y);
        await mouse("mousePressed", a.x, a.y, { buttons: 1, clickCount: 1 });
        await mouse("mouseMoved", a.x + 8, a.y + 8, { buttons: 1 });
        // the target is found after the drag has begun: the page may have moved things to show where a card can go
        const b = await evaluate<{ x: number; y: number } | null>(`(() => { const el = document.querySelector(${JSON.stringify(to)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height * ${at === "upper" ? 0.25 : at === "lower" ? 0.75 : 0.5} }; })()`);
        if (b === null) throw new Error(`nothing matches ${to}`);
        await mouse("mouseMoved", (a.x + b.x) / 2, (a.y + b.y) / 2, { buttons: 1 });
        await mouse("mouseMoved", b.x, b.y, { buttons: 1 });
        await mouse("mouseReleased", b.x, b.y, { buttons: 0, clickCount: 1 });
      },
      async press(key, mods = {}) {
        const shift = mods.shift === true;
        const base = keyEvent(key, shift);
        await wire.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
        await wire.send("Input.dispatchKeyEvent", { type: "keyUp", ...base, text: undefined });
      },
      async type(text) { await wire.send("Input.insertText", { text }); },
      async reducedMotion(on) { await wire.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: on ? "reduce" : "no-preference" }] }); },
      problems: () => [...problems],
      requests: () => [...requests],
    };
  };

  return {
    tab: open,
    async close() {
      gone();
      await proc.exited.catch(() => undefined);
      rmSync(profile, { recursive: true, force: true });
    },
  };
}
