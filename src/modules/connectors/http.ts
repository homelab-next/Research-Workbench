import type { Json } from "../../core/canonical";
import type { Cost } from "../../core/types";
import type { EndpointManifest, SourceManifest } from "../manifests";
import { effectiveBound, PLACEHOLDER } from "./placeholders";
import { assertNoEcho, loadCredential, parseBase, readCapped, scrub, TimedOut, TooBig } from "./shared";
import { ConnectorError } from "./types";
import type { Bound, Connector, ConnectorContext, QueryOutcome, QueryRequest } from "./types";

export const MAX_BODY_BYTES = 16_777_216;

export class HttpConnector implements Connector {
  readonly kind = "http" as const;

  constructor(private readonly source: SourceManifest, private readonly ctx: ConnectorContext) {}

  private endpoint(name: string): EndpointManifest {
    const e = this.source.endpoints.find(x => x.name === name);
    if (e === undefined) throw new ConnectorError(`unknown endpoint: ${name}`);
    if (e.method !== "GET" && !e.read) throw new ConnectorError(`endpoint ${name} is a ${e.method} not marked read; refused`);
    return e;
  }

  private url(e: EndpointManifest, bound: Bound): string {
    const base = parseBase(this.source.location);
    if (!e.path.startsWith("/")) throw new ConnectorError(`endpoint ${e.name} path must start with /`);
    const path = e.path.replace(PLACEHOLDER, (_m, n: string) => {
      if (!Object.hasOwn(bound, n)) throw new ConnectorError(`no value is bound for placeholder {${n}}`);
      const v = bound[n];
      if (v === null || v === undefined) throw new ConnectorError(`the value for placeholder {${n}} is null`);
      const text = String(v);
      if (text === "." || text === "..") throw new ConnectorError(`the value for placeholder {${n}} is a dot segment; refused`);
      return encodeURIComponent(text);
    });
    const full = this.source.location.replace(/\/+$/, "") + path;
    let parsed: URL;
    try {
      parsed = new URL(full);
    } catch {
      throw new ConnectorError(`endpoint ${e.name} does not form a valid URL`);
    }
    if (parsed.origin !== base.origin) throw new ConnectorError(`endpoint ${e.name} leaves the source's origin`);
    return full;
  }

  private body(e: EndpointManifest, bound: Bound): string | null {
    return e.method === "GET" ? null : JSON.stringify(bound);
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
      const res = await fetch(url, { method: e.method, headers, body, redirect: "manual", signal: ctl.signal });
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
    const list = rowsAt(doc, e);
    const more = list.length > req.max_rows;
    const rows: Json[][] = list.slice(0, req.max_rows).map(item => e.columns.map(c => (Object.hasOwn(item, c) ? (item[c] as Json) ?? null : null)));
    return {
      columns: [...e.columns], rows, raw: bytes, media, cost: this.cost(),
      coverage: more ? { kind: "partial", reason: "row_limit", detail: `stopped at ${req.max_rows} rows` } : { kind: "full" },
    };
  }

  close(): void {}
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
