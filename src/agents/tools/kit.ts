import type { Json } from "../../core/canonical";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { Schema } from "../../core/schema";
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
/** `//` (not after a colon) and `/./` collapsed, so a path spelled oddly is matched as the plain one. */
const tidy = (t: string): string => t.replace(/(?<!:)\/{2,}/g, "/").replace(/\/\.(?=\/)/g, "");

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

const URL_RE = /[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const POSIX_PATH_RE = /(?<![\w.\-/~:])\/[^\s'"<>)\]/]*\/[^\s'"<>)\]]*/g;
const WINDOWS_PATH_RE = /(?<![\w])[A-Za-z]:\\[^\s'"<>]*/g;

/**
 * Text from a runner result or a caught error, with every source's location, folders, user, credential name and host taken
 * out: each matched in any case, percent-encoded, and with `\` separators, after the text's own paths are tidied. Unless
 * `backstop` is false, any URL and any absolute path is hidden too, whatever it names. The ledger keeps the full text.
 */
export function scrub(registry: Registry, text: string, opts: { backstop?: boolean } = {}): string {
  let out = tidy(text);
  for (const secret of secretsOf(registry)) {
    const forms = new Set([tidy(secret), encodeURIComponent(secret), encodeURI(secret), secret.replaceAll("/", "\\"), tidy(secret).replaceAll("/", "\\")]);
    const re = new RegExp([...forms].sort((a, b) => b.length - a.length).map(escapeRe).join("|"), "gi");
    out = out.replace(re, HIDDEN);
  }
  if (opts.backstop === false) return out;
  return out.replace(URL_RE, HIDDEN).replace(POSIX_PATH_RE, HIDDEN).replace(WINDOWS_PATH_RE, HIDDEN);
}
