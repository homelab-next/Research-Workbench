import { SecretError } from "../secrets";
import type { Secrets } from "../secrets";
import { ConnectorError } from "./types";

/** Hosts where plain http is allowed: this machine only. */
export const LOOPBACK: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

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
