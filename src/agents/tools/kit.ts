import type { Json } from "../../core/canonical";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { Schema } from "../../core/schema";
import type { Coverage } from "../../core/types";
import type { Registry } from "../../modules/registry";

/** A tool's own failure. It becomes a result with ok false; it is never thrown past execTool. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** The one place every tool's parameter schema is built, so each has `why` and refuses unknown arguments. */
export function params(properties: Record<string, Schema> = {}, required: string[] = []): Schema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["why", ...required],
    properties: { why: { type: "string", minLength: 1, maxLength: MAX_WHY, description: "why you are doing this, in a sentence" }, ...properties },
  };
}

export const json = (x: unknown): Json => x as Json;
export const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");

export const TOOL_VIEW_CHARS = 6000;
export const VIEW_ROWS = 20;

export const MAX_WHY = 500;
export const MAX_TEXT = 4000;
export const MAX_ID = 200;
export const MAX_HAVE = 10;
export const MAX_BOUND_KEYS = 20;
export const MAX_BOUND_VALUE = 1000;
/** A short string argument: a name, id or value. */
export const idArg: Schema = { type: "string", minLength: 1, maxLength: MAX_ID };

const HIDDEN = "[hidden]";

const escapeRe = (t: string): string => t.replace(/[^\w\s]/g, "\\$&");

/**
 * The copy of a text that secrets and paths are matched in, with where each of its characters came from in the text: percent-encoding
 * undone (up to three times, so a double encoding is undone too), `\` read as `/`, runs of `/` (not after a colon) read as one and `/./` as
 * `/`. Nothing is changed in the text itself: what is shown is the text with only the matched parts hidden.
 */
interface Matchable { text: string; from: number[]; to: number[] }
const HEX2 = /^[0-9a-f]{2}$/i;
const utf8 = new TextDecoder();
function matchable(t: string): Matchable {
  let text = t;
  let from = Array.from({ length: t.length }, (_, i) => i);
  let to = from.map((i) => i + 1);
  const push = (o: Matchable, ch: string, a: number, b: number): void => { o.text += ch; o.from.push(a); o.to.push(b); };
  for (let pass = 0; pass < 3; pass++) {
    const o: Matchable = { text: "", from: [], to: [] };
    let changed = false;
    for (let i = 0; i < text.length;) {
      if (text[i] === "%" && HEX2.test(text.slice(i + 1, i + 3))) {
        // a run of encoded bytes is decoded together, so a character of several bytes comes out whole
        const bytes: number[] = [];
        let j = i;
        while (text[j] === "%" && HEX2.test(text.slice(j + 1, j + 3))) { bytes.push(parseInt(text.slice(j + 1, j + 3), 16)); j += 3; }
        for (const ch of utf8.decode(new Uint8Array(bytes))) push(o, ch, from[i]!, to[j - 1]!);
        changed = true;
        i = j;
        continue;
      }
      push(o, text[i]!, from[i]!, to[i]!);
      i++;
    }
    ({ text, from, to } = o);
    if (!changed) break;
  }
  const o: Matchable = { text: "", from: [], to: [] };
  const slash = (i: number): boolean => text[i] === "/" || text[i] === "\\";
  for (let i = 0; i < text.length;) {
    if (slash(i)) {
      let j = i;
      while (slash(j)) j++;
      // a run of separators after a colon is a URL's `//` and stays
      if (o.text.endsWith(":")) for (let k = i; k < j; k++) push(o, "/", from[k]!, to[k]!);
      else push(o, "/", from[i]!, to[j - 1]!);
      i = j;
      // `/./` is `/`: the dot and the separator after it belong to the separator before
      while (text[i] === "." && slash(i + 1)) {
        let k = i + 1;
        while (slash(k)) k++;
        o.to[o.to.length - 1] = to[k - 1]!;
        i = k;
      }
      continue;
    }
    push(o, text[i]!, from[i]!, to[i]!);
    i++;
  }
  return o;
}

/** Every string in the registry that says where a source is or how to sign in to it. */
function secretsOf(registry: Registry): string[] {
  const out = new Set<string>();
  const add = (v: string | null | undefined, min = 2): void => {
    if (typeof v === "string" && v.length >= min) out.add(v);
  };
  for (const s of registry.sources()) {
    for (const v of [s.location, s.dir, s.root, s.user, s.credential]) add(v);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s.location)) {
      const full = resolve(s.dir, s.location);
      add(full);
      try { add(realpathSync(full)); } catch { /* a missing file has no real path */ }
      const name = basename(s.location);
      if (name.includes(".") || s.connector === "sql") add(name, 3);
    } else {
      try {
        const u = new URL(s.location);
        add(u.host);
        add(u.hostname, 3);
      } catch { /* not a URL */ }
    }
    for (const d of [s.dir, s.root]) {
      if (isAbsolute(d)) try { add(realpathSync(d)); } catch { /* gone */ }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const PATH_END = `[^\\s'"<>)\\]]`;
/** A folder name in a path: no separator, and spaces only between other characters, so `/srv/my lake/x.db` is one path. */
const SEGMENT = `[^\\s'"<>)\\]/]+(?: [^\\s'"<>)\\]/]+)*`;
const URL_RE = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
/** An absolute path of two parts or more, also after a colon (`path:/srv/x`); a UNC path reads as one once its separators are. */
const POSIX_PATH_RE = new RegExp(`(?<![\\w.\\-/~])\\/(?:${SEGMENT}\\/)+${PATH_END}*`, "g");
const WINDOWS_PATH_RE = /(?<![\w])[A-Za-z]:\/[^\s'"<>]*/g;
const HOME_PATH_RE = new RegExp(`(?<![\\w.\\-/~])~[\\w.\\-]*\\/${PATH_END}*`, "g");
const UP_PATH_RE = new RegExp(`(?<![\\w.\\-/~])(?:\\.\\.\\/)+${PATH_END}*`, "g");
const BACKSTOP = [URL_RE, POSIX_PATH_RE, WINDOWS_PATH_RE, HOME_PATH_RE, UP_PATH_RE];

/**
 * Text from a runner result or a caught error, with every source's location, folders, user, credential name and host taken out: each matched in
 * any case, percent-encoded once or twice, with `\` separators or spelled oddly (`//`, `/./`). Unless `backstop` is false, any URL and any path
 * that is absolute, under a home (`~/`), above the current folder (`../`) or a UNC share is hidden too, whatever it names. Only the matched parts
 * change: with `backstop` false a query's text is shown exactly as it was run, less the secrets. The ledger keeps the full text.
 */
export function scrub(registry: Registry, text: string, opts: { backstop?: boolean } = {}): string {
  const m = matchable(text);
  const spans: [number, number][] = [];
  const collect = (re: RegExp): void => {
    for (const hit of m.text.matchAll(re)) {
      if (hit[0].length === 0) continue;
      spans.push([m.from[hit.index]!, m.to[hit.index + hit[0].length - 1]!]);
    }
  };
  const forms = new Set(secretsOf(registry).map((x) => matchable(x).text).filter((x) => x.length > 0));
  if (forms.size > 0) collect(new RegExp([...forms].sort((a, b) => b.length - a.length).map(escapeRe).join("|"), "gi"));
  if (opts.backstop !== false) for (const re of BACKSTOP) collect(re);
  if (spans.length === 0) return text;
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "";
  let at = 0;
  for (const [a, b] of spans) {
    if (b <= at) continue;
    if (a >= at) out += text.slice(at, a) + HIDDEN;
    at = b;
  }
  return out + text.slice(at);
}

/** A coverage with its free text (an engine's error, which may name a host, a user or a path) scrubbed. */
export function scrubCoverage(registry: Registry, c: Coverage | null): Coverage | null {
  return c === null || c.kind === "full" || c.detail === undefined ? c : { ...c, detail: scrub(registry, c.detail) };
}
