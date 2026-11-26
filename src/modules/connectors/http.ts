import type { Json } from "../../core/canonical";
import type { Cost } from "../../core/types";
import type { EndpointManifest, SourceManifest } from "../manifests";
import { effectiveBound, PLACEHOLDER } from "./placeholders";
import { assertNoEcho, loadCredential, parseBase, readCapped, refuseOwnServer, scrub, TimedOut, TooBig } from "./shared";
import { ConnectorError } from "./types";
import { MAX_TS, MIN_TS } from "./types";
import type { Bound, Connector, ConnectorContext, QueryOutcome, QueryRequest } from "./types";

export const MAX_BODY_BYTES = 16_777_216;

export class HttpConnector implements Connector {
  readonly kind = "http" as const;

  constructor(private readonly source: SourceManifest, private readonly ctx: ConnectorContext) {
    this.refuseOwnServer();
  }

  /** A source that points at the workbench's own server would let a manifest talk to the server as if it were a source. */
  private refuseOwnServer(): void {
    refuseOwnServer(this.source.location, this.ctx.refuse_hosts?.() ?? []);
  }

  private endpoint(name: string): EndpointManifest {
    const e = this.source.endpoints.find(x => x.name === name);
    if (e === undefined) throw new ConnectorError(`unknown endpoint: ${name}`);
    if (e.method !== "GET" && !e.read) throw new ConnectorError(`endpoint ${name} is a ${e.method} not marked read; refused`);
    return e;
  }

  private url(e: EndpointManifest, bound: Bound): string {
    return endpointUrl(this.source, e, bound);
  }

  private body(e: EndpointManifest, bound: Bound): string | null {
    return requestBody(e, bound);
  }

  render(req: QueryRequest): string {
    const e = this.endpoint(req.text);
    const bound = effectiveBound(req);
    const body = this.body(e, bound);
    return `${e.method} ${this.url(e, bound)}${body === null ? "" : ` ${body}`}`;
  }

  async estimate(req: QueryRequest): Promise<Cost | null> {
    this.endpoint(req.text);
    return this.cost();
  }

  estimateRequest(_req: QueryRequest): null {
    return null;
  }

  readEstimate(_outcome: QueryOutcome): null {
    return null;
  }

  private cost(): Cost | null {
    return this.source.cost.weight > 0 ? { amount: 1, unit: this.source.cost.unit } : null;
  }

  async run(req: QueryRequest): Promise<QueryOutcome> {
    this.refuseOwnServer();
    const e = this.endpoint(req.text);
    const price = this.cost();
    if (req.budget !== null && price !== null && req.budget < price.amount) {
      throw new ConnectorError(`the budget of ${req.budget} ${price.unit} is below the cost of one request (${price.amount} ${price.unit}); not sent`);
    }
    const bound = effectiveBound(req);
    const url = this.url(e, bound);
    const body = this.body(e, bound);
    const headers: Record<string, string> = { accept: "application/json" };
    let secret: string | null = null;
    if (this.source.credential !== null) {
      secret = loadCredential(this.ctx.secrets, this.source.credential);
      headers.authorization = `Bearer ${secret}`;
    }
    if (body !== null) headers["content-type"] = "application/json";

    const ctl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, req.timeout_ms);
    let bytes: Uint8Array;
    let media: string;
    try {
      const res = await fetch(url, { method: e.method, headers, body, redirect: "manual", signal: ctl.signal, timeout: false });
      if (res.status >= 300) {
        await res.body?.cancel().catch(() => undefined);
        throw new ConnectorError(`HTTP ${res.status}${res.status < 400 ? " (redirects are not followed)" : ""} from endpoint ${e.name}`);
      }
      media = res.headers.get("content-type") ?? "";
      bytes = await readCapped(res, ctl.signal, MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      if (err instanceof TooBig) throw new ConnectorError(`the response body is larger than the limit of ${MAX_BODY_BYTES} bytes`);
      if (err instanceof TimedOut || timedOut) {
        return {
          columns: e.columns, rows: [], raw: new Uint8Array(), media: "", cost: this.cost(),
          coverage: { kind: "partial", reason: "timeout", detail: `no complete response within ${req.timeout_ms} ms` },
        };
      }
      throw new ConnectorError(scrub(`the request to endpoint ${e.name} failed: ${(err as Error).message}`, secret === null ? [] : [secret]));
    } finally {
      clearTimeout(timer);
    }

    let doc: unknown;
    let parsed = true;
    try {
      doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      parsed = false;
    }
    // A result that carries the credential is refused whole, before anything of it is kept.
    assertNoEcho(bytes, secret === null ? [] : [secret, `Bearer ${secret}`], parsed ? doc : undefined);
    if (!parsed) throw new ConnectorError(`the response from endpoint ${e.name} is not valid JSON`);
    const { rows, more } = rowsOfDoc(doc, e, req.max_rows);
    return {
      columns: [...e.columns], rows, raw: bytes, media, cost: this.cost(),
      coverage: more ? { kind: "partial", reason: "row_limit", detail: `stopped at ${req.max_rows} rows` } : { kind: "full" },
    };
  }

  close(): void {}
}

/** The URL an endpoint is called at with these bound values; ConnectorError when it cannot be formed or leaves the source's origin. */
export function endpointUrl(source: SourceManifest, e: EndpointManifest, bound: Bound): string {
  const base = parseBase(source.location);
  if (!e.path.startsWith("/")) throw new ConnectorError(`endpoint ${e.name} path must start with /`);
  const path = e.path.replace(PLACEHOLDER, (_m, n: string) => {
    if (!Object.hasOwn(bound, n)) throw new ConnectorError(`no value is bound for placeholder {${n}}`);
    const v = bound[n];
    if (v === null || v === undefined) throw new ConnectorError(`the value for placeholder {${n}} is null`);
    const text = String(v);
    if (text === "." || text === "..") throw new ConnectorError(`the value for placeholder {${n}} is a dot segment; refused`);
    return encodeURIComponent(text);
  });
  const full = source.location.replace(/\/+$/, "") + path;
  let parsed: URL;
  try {
    parsed = new URL(full);
  } catch {
    throw new ConnectorError(`endpoint ${e.name} does not form a valid URL`);
  }
  if (parsed.origin !== base.origin) throw new ConnectorError(`endpoint ${e.name} leaves the source's origin`);
  return full;
}

const requestBody = (e: EndpointManifest, bound: Bound): string | null => (e.method === "GET" ? null : JSON.stringify(bound));

/** The request text the runner records for an endpoint: `METHOD url [body]`. */
function requestText(source: SourceManifest, e: EndpointManifest, bound: Bound): string {
  const body = requestBody(e, bound);
  return `${e.method} ${endpointUrl(source, e, bound)}${body === null ? "" : ` ${body}`}`;
}

/** The rows of a parsed response for an endpoint, cut at `max`; `more` says rows were left out. Throws ConnectorError when the body does not have them. */
function rowsOfDoc(doc: unknown, e: EndpointManifest, max: number): { rows: Json[][]; more: boolean } {
  const list = rowsAt(doc, e);
  return { more: list.length > max, rows: list.slice(0, max).map(item => e.columns.map(c => (Object.hasOwn(item, c) ? (item[c] as Json) ?? null : null))) };
}

/**
 * The columns and rows an http result's recorded response holds. The endpoint is the one whose request renders to the recorded text
 * with the recorded bound values and window. Null when none does, or the bytes are not a response that endpoint would have accepted.
 * Empty bytes are what a timed-out request kept: no rows. Pure: it reads the source manifest and the bytes only.
 */
export function rowsOfHttp(source: SourceManifest, issued: { text: string; bound: Record<string, unknown>; window: { from: string | null; to: string | null } }, bytes: Uint8Array, maxRows: number): { columns: string[]; rows: Json[][] } | null {
  const bound = { ...issued.bound, "window.from": issued.window.from ?? MIN_TS, "window.to": issued.window.to ?? MAX_TS } as Bound;
  const e = source.endpoints.find((x) => { try { return requestText(source, x, bound) === issued.text; } catch { return false; } });
  if (e === undefined) return null;
  if (bytes.length === 0) return { columns: [...e.columns], rows: [] };
  try {
    const doc: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return { columns: [...e.columns], rows: rowsOfDoc(doc, e, maxRows).rows };
  } catch {
    return null;
  }
}

function rowsAt(doc: unknown, e: EndpointManifest): Record<string, unknown>[] {
  let cur: unknown = doc;
  if (e.rows !== "") {
    for (const key of e.rows.split(".")) {
      if (typeof cur !== "object" || cur === null || Array.isArray(cur) || !Object.hasOwn(cur, key)) {
        throw new ConnectorError(`the response from endpoint ${e.name} has nothing at "${e.rows}"`);
      }
      cur = (cur as Record<string, unknown>)[key];
    }
  }
  if (!Array.isArray(cur)) throw new ConnectorError(`the response from endpoint ${e.name} has no array at "${e.rows}"`);
  for (const item of cur) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) throw new ConnectorError(`the rows in the response from endpoint ${e.name} are not all objects`);
  }
  return cur as Record<string, unknown>[];
}
