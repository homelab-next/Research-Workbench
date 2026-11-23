import type { Json } from "../../core/canonical";
import type { Cost } from "../../core/types";
import type { EndpointManifest, SourceManifest } from "../manifests";
import { effectiveBound } from "./placeholders";
import { ConnectorError } from "./types";
import type { Bound, Connector, ConnectorContext, QueryOutcome, QueryRequest } from "./types";

export const MAX_BODY_BYTES = 16_777_216;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const NAME = /\{([A-Za-z_][A-Za-z0-9_.]*)\}/g;

class Timeout extends Error {}
class TooBig extends Error {}

export class HttpConnector implements Connector {
  readonly kind = "http" as const;

  constructor(private readonly source: SourceManifest, private readonly ctx: ConnectorContext) {}

  private endpoint(name: string): EndpointManifest {
    const e = this.source.endpoints.find(x => x.name === name);
    if (e === undefined) throw new ConnectorError(`unknown endpoint: ${name}`);
    if (e.method !== "GET" && !e.read) throw new ConnectorError(`endpoint ${name} is a ${e.method} not marked read; refused`);
    return e;
  }

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

  private url(e: EndpointManifest, bound: Bound): string {
    const base = this.base();
    if (!e.path.startsWith("/")) throw new ConnectorError(`endpoint ${e.name} path must start with /`);
    const path = e.path.replace(NAME, (_m, n: string) => {
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

  private cost(): Cost | null {
    return this.source.cost.weight > 0 ? { amount: 1, unit: this.source.cost.unit } : null;
  }

  private scrub(text: string, secret: string | null): string {
    return secret === null || secret === "" ? text : text.split(secret).join("[secret]");
  }

  async run(req: QueryRequest): Promise<QueryOutcome> {
    const e = this.endpoint(req.text);
    const bound = effectiveBound(req);
    const url = this.url(e, bound);
    const body = this.body(e, bound);
    const headers: Record<string, string> = { accept: "application/json" };
    let secret: string | null = null;
    if (this.source.credential !== null) {
      secret = this.ctx.secrets.get(this.source.credential);
      if (secret === null) throw new ConnectorError(`credential ${this.source.credential} has no value in the environment or secrets file`);
      if (/[\x00-\x1f\x7f]/.test(secret)) throw new ConnectorError(`credential ${this.source.credential} cannot be sent as a header value`);
      headers.authorization = `Bearer ${secret}`;
    }
    if (body !== null) headers["content-type"] = "application/json";

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(new Timeout()), req.timeout_ms);
    let bytes: Uint8Array;
    let media: string;
    try {
      const res = await fetch(url, { method: e.method, headers, body, redirect: "manual", signal: ctl.signal });
      if (res.status >= 300) {
        await res.body?.cancel().catch(() => undefined);
        throw new ConnectorError(`HTTP ${res.status}${res.status < 400 ? " (redirects are not followed)" : ""} from endpoint ${e.name}`);
      }
      media = res.headers.get("content-type") ?? "";
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_BODY_BYTES) {
        await res.body?.cancel().catch(() => undefined);
        throw new TooBig();
      }
      bytes = await readCapped(res, ctl.signal);
    } catch (err) {
      if (err instanceof ConnectorError) throw err;
      if (err instanceof TooBig) throw new ConnectorError(`the response body is larger than the limit of ${MAX_BODY_BYTES} bytes`);
      if (err instanceof Timeout || ctl.signal.aborted) {
        return {
          columns: e.columns, rows: [], raw: new Uint8Array(), media: "", cost: this.cost(),
          coverage: { kind: "partial", reason: "timeout", detail: `no complete response within ${req.timeout_ms} ms` },
        };
      }
      throw new ConnectorError(this.scrub(`the request to endpoint ${e.name} failed: ${(err as Error).message}`, secret));
    } finally {
      clearTimeout(timer);
    }

    let doc: unknown;
    try {
      doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new ConnectorError(`the response from endpoint ${e.name} is not valid JSON`);
    }
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

async function readCapped(res: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new Timeout();
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY_BYTES) throw new TooBig();
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
