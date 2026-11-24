import { SecretError } from "../secrets";
import type { Secrets } from "../secrets";
import { ConnectorError } from "./types";

/** A UTC timestamp with milliseconds, the one format a window end may take: 2026-11-20T00:00:00.000Z. */
export const UTC_MS = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}\.\d{3})Z$/;

/** True for a string in UTC_MS form that names a real instant (no 31 February, no hour 25). */
export function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_MS.test(value)) return false;
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString() === value;
}

/** Hosts where plain http is allowed: this machine only. */
export const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Throws ConnectorError when `location` points at one of the workbench's own addresses (`host:port`, asked of the server each time):
 * the same port under any loopback name is the server. A location that is not a URL is left for parseBase to refuse.
 */
export function refuseOwnServer(location: string, own: readonly string[]): void {
  if (own.length === 0) return;
  // the URL parser already reads 127.1, 0x7f000001 and the IPv6 long form as 127.0.0.1 and [::1]; a trailing dot and the IPv4-mapped form it leaves
  const loopback = (hostname: string): boolean => LOOPBACK.has(hostname.replace(/\.$/, "")) || hostname === "[::ffff:7f00:1]";
  let target: URL;
  try {
    target = new URL(location);
  } catch {
    return;
  }
  const loopbackPort = (host: string): string | null => {
    try {
      const u = new URL(`http://${host}`);
      return loopback(u.hostname) ? (u.port || "80") : null;
    } catch {
      return null;
    }
  };
  const port = loopback(target.hostname) ? (target.port || (target.protocol === "https:" ? "443" : "80")) : null;
  for (const host of own) {
    if (target.host === host.toLowerCase() || (port !== null && port === loopbackPort(host))) {
      throw new ConnectorError("this source points at the workbench's own server");
    }
  }
}

/**
 * A network source's location as a URL. It must be https (http only on loopback) and carry no credentials,
 * no query and no fragment: anything there would be copied into every query text the ledger records.
 */
export function parseBase(location: string): URL {
  let u: URL;
  try {
    u = new URL(location);
  } catch {
    throw new ConnectorError("the source location is not a valid URL");
  }
  if (u.username !== "" || u.password !== "") throw new ConnectorError("the source location must not contain credentials; use the credential setting");
  const ok = u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.has(u.hostname));
  if (!ok) throw new ConnectorError(`the source location must be https (http is allowed only on loopback): ${u.protocol}//${u.host}`);
  if (u.search !== "" || location.includes("?")) throw new ConnectorError("the source location must not contain a query string");
  if (u.hash !== "" || location.includes("#")) throw new ConnectorError("the source location must not contain a fragment");
  return u;
}

/** The source took longer than its time limit. */
export class TimedOut extends Error {}
/** A body or page was larger than the limit it was read under. */
export class TooBig extends Error {
  constructor(readonly limit: number) { super(`larger than ${limit} bytes`); }
}

/** Reads a response body, refusing more than `limit` bytes (TooBig) and stopping when `signal` aborts (TimedOut). */
export async function readCapped(res: Response, signal: AbortSignal, limit: number): Promise<Uint8Array> {
  if (Number(res.headers.get("content-length") ?? "0") > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new TooBig(limit);
  }
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
      if (total > limit) throw new TooBig(limit);
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

/** The text with every non-empty value in `redact` replaced by [secret]. */
export function scrub(text: string, redact: readonly string[]): string {
  let out = text;
  for (const r of redact) if (r !== "") out = out.split(r).join("[secret]");
  return out;
}

// Below 0x20, DEL, the C1 controls and the Unicode line and paragraph separators.
export const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

/** The value of a credential the registry allowed for this source, ready to send in a header. Anything unusable is a ConnectorError. */
export function loadCredential(secrets: Secrets, name: string): string {
  let value: string | null;
  try {
    value = secrets.get(name);
  } catch (err) {
    if (err instanceof SecretError) throw new ConnectorError(err.message);
    throw err;
  }
  if (value === null) throw new ConnectorError(`credential ${name} has no value in the environment or secrets file`);
  if (CONTROL.test(value)) throw new ConnectorError(`credential ${name} cannot be sent as a header value`);
  return value;
}

const ECHO_REFUSED = "the source echoed the credential; result refused";

/** The ways a secret can appear in a body: as is, JSON-escaped, \u-escaped (either case), base64 (padded or not, standard or URL alphabet) and URL-encoded. */
function encodedForms(secret: string): string[] {
  const bytes = Buffer.from(secret, "utf8");
  const u = (upper: boolean): string => [...secret].map((ch) => {
    const units = ch.length === 2 ? [ch.charCodeAt(0), ch.charCodeAt(1)] : [ch.charCodeAt(0)];
    return units.map((n) => { const h = n.toString(16).padStart(4, "0"); return `\\u${upper ? h.toUpperCase() : h}`; }).join("");
  }).join("");
  const b64 = bytes.toString("base64");
  const b64url = bytes.toString("base64url");
  return [...new Set([secret, JSON.stringify(secret).slice(1, -1), u(false), u(true), b64, b64.replace(/=+$/, ""), b64url, encodeURIComponent(secret), ...base64Alignments(bytes)])];
}

/**
 * What the secret's bytes look like inside base64 text whose first group did not start on the secret: encode it after
 * 0, 1 and 2 filler bytes and keep only the groups the secret fills (the leading group, which holds filler, and the
 * trailing one, which may hold what follows, are dropped), in both alphabets. A secret too short to fill a group yields none.
 */
function base64Alignments(secret: Buffer): string[] {
  const out: string[] = [];
  for (const pad of [0, 1, 2]) {
    const enc = Buffer.concat([Buffer.alloc(pad, 0x78), secret]).toString("base64").replace(/=+$/, "");
    const from = pad === 0 ? 0 : 4;
    const filled = Math.floor((pad + secret.length) / 3) * 4; // complete groups
    const cut = enc.slice(from, filled);
    if (cut.length >= 4) out.push(cut, cut.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return out;
}

/** Every string in a parsed JSON value, keys included. */
function* stringsIn(value: unknown, depth = 0): Generator<string> {
  if (typeof value === "string") { yield value; return; }
  if (depth > 256 || typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) { for (const v of value) yield* stringsIn(v, depth + 1); return; }
  for (const [k, v] of Object.entries(value)) { yield k; yield* stringsIn(v, depth + 1); }
}

/**
 * Throws ConnectorError when a response carries a secret: in its raw bytes (as is or in an encoded form), or in any
 * string of its parsed body once JSON escapes are decoded. `parsed` is the parsed body, or undefined if it did not parse.
 * The one check both network connectors use; the caller cancels anything still running.
 */
export function assertNoEcho(raw: Uint8Array, secrets: readonly string[], parsed?: unknown): void {
  const live = secrets.filter((x) => x !== "");
  if (live.length === 0) return;
  const forms = live.flatMap(encodedForms);
  const text = new TextDecoder("utf-8").decode(raw);
  if (forms.some((f) => text.includes(f))) throw new ConnectorError(ECHO_REFUSED);
  if (parsed === undefined) return;
  for (const str of stringsIn(parsed)) if (forms.some((f) => str.includes(f))) throw new ConnectorError(ECHO_REFUSED);
}
