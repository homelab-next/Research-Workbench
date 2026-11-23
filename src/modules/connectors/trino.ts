import type { Json } from "../../core/canonical";
import type { Cost } from "../../core/types";
import type { SourceManifest } from "../manifests";
import { assertReadOnly, checkGuardrails, GuardError, stripForAnalysis } from "../sqlguard";
import type { TableGuard } from "../sqlguard";
import { effectiveBound } from "./placeholders";
import { ConnectorError } from "./types";
import type { Connector, ConnectorContext, QueryOutcome, QueryRequest } from "./types";

export const MAX_PAGE_BYTES = 16_777_216;
export const MAX_TOTAL_BYTES = 67_108_864;
const CANCEL_TIMEOUT_MS = 2000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const NAME = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;
const ISO_MS = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}\.\d{3})Z$/;
// Below 0x20, DEL, the C1 controls and the Unicode line and paragraph separators.
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

class TimedOut extends Error {}
/** The engine reported the query failed: it has already ended, so there is nothing to cancel. */
class EngineError extends ConnectorError {}
class TooBig extends Error {
  constructor(readonly limit: "page" | "total") { super(limit); }
}

/** One value as a SQL literal. The window ends become zoned timestamps; strings double their quotes. */
export function renderLiteral(name: string, value: string | number | null): string {
  if (value !== null && typeof value !== "string" && typeof value !== "number") {
    throw new ConnectorError(`the value for {${name}} is a ${Array.isArray(value) ? "array" : typeof value}; only strings, numbers and null can be bound`);
  }
  if (name === "window.from" || name === "window.to") {
    const m = typeof value === "string" ? ISO_MS.exec(value) : null;
    if (m === null) throw new ConnectorError(`the value for {${name}} is not a UTC timestamp like 2026-11-20T00:00:00.000Z`);
    return `TIMESTAMP '${m[1]} ${m[2]} UTC'`;
  }
  if (value === null) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ConnectorError(`the value for {${name}} is not a finite number`);
    return String(value);
  }
  if (CONTROL.test(value)) throw new ConnectorError(`the value for {${name}} contains a control character; refused`);
  return `'${value.replaceAll("'", "''")}'`;
}

interface Page { columns?: unknown; data?: unknown; nextUri?: unknown; error?: unknown }
interface Paged { columns: string[]; rows: Json[][]; pages: Uint8Array[]; coverage: QueryOutcome["coverage"] }
interface Auth { headers: Record<string, string>; redact: string[] }

export class TrinoConnector implements Connector {
  readonly kind = "trino" as const;

  constructor(private readonly source: SourceManifest, private readonly ctx: ConnectorContext) {}

  private guards(): TableGuard[] {
    return this.source.tables.filter(t => t.guarded).map(t => ({ table: t.name, time_column: t.time_column, large_columns: t.large_columns }));
  }

  render(req: QueryRequest): string {
    const guards = this.guards();
    if (req.window.from === null) {
      const s = stripForAnalysis(req.text);
      const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const g of guards) {
        if (new RegExp(`(?<![\\w$])${g.table.toLowerCase().split(".").map(esc).join("\\s*\\.\\s*")}(?![\\w$])`).test(s)) {
          throw new GuardError(["a guarded table needs a bounded window"]);
        }
      }
    }
    const bound = effectiveBound(req);
    const sql = req.text.replace(NAME, (_m, n: string) => {
      if (!Object.hasOwn(bound, n)) throw new ConnectorError(`no value is bound for placeholder {${n}}`);
      return renderLiteral(n, bound[n] ?? null);
    });
    assertReadOnly(sql);
    const violations = checkGuardrails(sql, guards);
    if (violations.length > 0) throw new GuardError(violations);
    return sql;
  }

  async estimate(req: QueryRequest): Promise<Cost | null> {
    const sql = this.render(req);
    try {
      const out = await this.execute(`EXPLAIN (TYPE IO, FORMAT JSON) ${sql.replace(/[\s;]+$/, "")}`, 2, req.timeout_ms);
      if (out.coverage.kind !== "full" || out.rows.length !== 1) return null;
      const cell = out.rows[0]![0];
      if (typeof cell !== "string") return null;
      const plan: unknown = JSON.parse(cell);
      const est = typeof plan === "object" && plan !== null ? (plan as { estimate?: unknown }).estimate : undefined;
      const n = typeof est === "object" && est !== null ? (est as { outputRowCount?: unknown }).outputRowCount : undefined;
      return typeof n === "number" && Number.isFinite(n) && n >= 0 ? { amount: n, unit: "rows" } : null;
    } catch {
      return null;
    }
  }

  async run(req: QueryRequest): Promise<QueryOutcome> {
    const sql = this.render(req);
    const out = await this.execute(sql, req.max_rows, req.timeout_ms);
    return {
      columns: out.columns, rows: out.rows, raw: joinPages(out.pages),
      media: "application/json", coverage: out.coverage, cost: null,
    };
  }

  close(): void {}

  private base(): URL {
    let u: URL;
    try {
      u = new URL(this.source.location);
    } catch {
      throw new ConnectorError("the source location is not a valid URL");
    }
    if (u.username !== "" || u.password !== "") throw new ConnectorError("the source location must not contain credentials; use the credential setting");
    const ok = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
    if (!ok) throw new ConnectorError(`the source location must be https (http is allowed only on loopback): ${u.protocol}//${u.host}`);
    return u;
  }

  private auth(): Auth {
    const user = this.source.user;
    if (user === null || user === "") throw new ConnectorError("the source has no user; the engine needs one");
    if (CONTROL.test(user) || /[^\x20-\x7e]/.test(user)) throw new ConnectorError("the source user cannot be sent as a header value");
    const headers: Record<string, string> = {
      "x-trino-user": user, "x-trino-time-zone": "UTC", "x-trino-source": "research-workbench", "content-type": "text/plain", accept: "application/json",
    };
    const redact: string[] = [];
    if (this.source.credential !== null) {
      if (user.includes(":")) throw new ConnectorError("the source user cannot contain a colon when a credential is used");
      const secret = this.ctx.secrets.get(this.source.credential);
      if (secret === null) throw new ConnectorError(`credential ${this.source.credential} has no value in the environment or secrets file`);
      if (CONTROL.test(secret)) throw new ConnectorError(`credential ${this.source.credential} cannot be sent as a header value`);
      const token = Buffer.from(`${user}:${secret}`, "utf8").toString("base64");
      headers.authorization = `Basic ${token}`;
      redact.push(token, secret);
    }
    return { headers, redact };
  }

  private scrub(text: string, redact: string[]): string {
    let out = text;
    for (const r of redact) if (r !== "") out = out.split(r).join("[secret]");
    return out;
  }

  private init(method: string, headers: Record<string, string>, signal: AbortSignal, body?: string): RequestInit {
    const init: RequestInit & { tls?: { rejectUnauthorized: boolean } } = { method, headers, redirect: "manual", signal };
    if (body !== undefined) init.body = body;
    if (!this.source.tls_verify) init.tls = { rejectUnauthorized: false };
    return init;
  }

  /** Best effort DELETE of a running query. Only ever called with a URI already checked against the source's origin. */
  private async cancel(uri: string, headers: Record<string, string>): Promise<void> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), CANCEL_TIMEOUT_MS);
    try {
      const res = await fetch(uri, this.init("DELETE", headers, ctl.signal));
      await res.body?.cancel().catch(() => undefined);
    } catch {
      // the query will be reaped by the engine; nothing more can be done
    } finally {
      clearTimeout(timer);
    }
  }

  private async execute(sql: string, maxRows: number, timeoutMs: number): Promise<Paged> {
    const base = this.base();
    const { headers, redact } = this.auth();
    const echoes = redact.flatMap(r => (r === "" ? [] : [r, JSON.stringify(r).slice(1, -1)]));
    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
    const pages: Uint8Array[] = [];
    const rows: Json[][] = [];
    let columns: string[] = [];
    let pending: string | null = null;
    let total = 0;
    let capped = false;

    const step = async (method: string, url: string, body?: string): Promise<void> => {
      const res = await fetch(url, this.init(method, headers, ctl.signal, body));
      if (res.status >= 300) {
        await res.body?.cancel().catch(() => undefined);
        throw new ConnectorError(`HTTP ${res.status}${res.status < 400 ? " (redirects are not followed)" : ""} from the engine`);
      }
      const limit = Math.min(MAX_PAGE_BYTES, MAX_TOTAL_BYTES - total);
      const which = limit < MAX_PAGE_BYTES ? "total" : "page";
      if (Number(res.headers.get("content-length") ?? "0") > limit) {
        await res.body?.cancel().catch(() => undefined);
        throw new TooBig(which);
      }
      const bytes = await readCapped(res, ctl.signal, limit, which);
      total += bytes.length;
      if (echoes.length > 0) {
        const seen = new TextDecoder("utf-8").decode(bytes);
        if (echoes.some(e => seen.includes(e))) throw new ConnectorError("the source echoed the credential; result refused");
      }
      let page: Page;
      try {
        const doc: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("not an object");
        page = doc as Page;
      } catch {
        throw new ConnectorError("the engine sent a page that is not a JSON object");
      }
      pages.push(bytes);
      // Learn the query's nextUri before anything else can fail or time out, so it can be cancelled.
      // An unusable nextUri leaves the last good one in place; a page with none (an error page, the last page) leaves nothing to cancel.
      let next: string | null = null;
      if (page.nextUri !== undefined && page.nextUri !== null) {
        if (typeof page.nextUri !== "string") throw new ConnectorError("the engine sent a malformed nextUri");
        let u: URL;
        try {
          u = new URL(page.nextUri);
        } catch {
          throw new ConnectorError("the engine sent a nextUri that is not a URL");
        }
        if (u.origin !== base.origin) {
          throw new ConnectorError(`the engine's nextUri is on another origin (${u.origin}); it was not contacted and no credential was sent there`);
        }
        next = page.nextUri;
      }
      pending = next;
      if (page.error !== undefined && page.error !== null) {
        const msg = typeof page.error === "object" && typeof (page.error as { message?: unknown }).message === "string"
          ? (page.error as { message: string }).message : "unspecified error";
        throw new EngineError(this.scrub(`the engine reported an error: ${msg}`, redact));
      }
      if (page.columns !== undefined) {
        if (!Array.isArray(page.columns) || !page.columns.every(x => typeof x === "object" && x !== null && typeof (x as { name?: unknown }).name === "string")) {
          throw new ConnectorError("the engine sent malformed column metadata");
        }
        columns = page.columns.map(x => (x as { name: string }).name);
      }
      if (page.data !== undefined) {
        if (!Array.isArray(page.data) || !page.data.every(r => Array.isArray(r))) throw new ConnectorError("the engine sent malformed row data");
        for (const r of page.data as Json[][]) rows.push(r);
      }
    };

    try {
      await step("POST", `${this.source.location.replace(/\/+$/, "")}/v1/statement`, sql);
      while (pending !== null) {
        if (rows.length > maxRows) { capped = true; break; }
        if (ctl.signal.aborted) throw new TimedOut();
        await step("GET", pending);
      }
      if (rows.length > maxRows) capped = true;
      if (capped && pending !== null) await this.cancel(pending, headers);
      return {
        columns, rows: rows.slice(0, maxRows), pages,
        coverage: capped ? { kind: "partial", reason: "row_limit", detail: `stopped at ${maxRows} rows` } : { kind: "full" },
      };
    } catch (err) {
      if (err instanceof EngineError) throw err;
      // From here the query may still be running: cancel the last same-origin URI the engine gave us.
      if (err instanceof TimedOut || (timedOut && !(err instanceof ConnectorError))) {
        if (pending !== null) await this.cancel(pending, headers);
        return {
          columns, rows: rows.slice(0, maxRows), pages,
          coverage: { kind: "partial", reason: "timeout", detail: `no complete result within ${timeoutMs} ms` },
        };
      }
      if (pending !== null) await this.cancel(pending, headers);
      if (err instanceof ConnectorError) throw err;
      if (err instanceof TooBig) {
        const lim = err.limit === "page" ? `${MAX_PAGE_BYTES} bytes for one page` : `${MAX_TOTAL_BYTES} bytes for all pages`;
        throw new ConnectorError(`the engine's response is larger than the limit of ${lim}`);
      }
      throw new ConnectorError(this.scrub(`the request to the engine failed: ${(err as Error).message}`, redact));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readCapped(res: Response, signal: AbortSignal, limit: number, which: "page" | "total"): Promise<Uint8Array> {
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new TimedOut();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new TooBig(which);
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** `[` page1 `,` page2 ... `]`, each page's bytes exactly as received. */
function joinPages(pages: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pages.reduce((n, p) => n + p.length, 0) + pages.length + 1);
  let at = 0;
  out[at++] = 0x5b;
  pages.forEach((p, i) => {
    if (i > 0) out[at++] = 0x2c;
    out.set(p, at);
    at += p.length;
  });
  out[at] = 0x5d;
  return out;
}
