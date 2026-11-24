import type { Json } from "../../core/canonical";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
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

/** Every string in the registry that says where a source is or how to sign in to it. */
function secretsOf(registry: Registry): string[] {
  const out = new Set<string>();
  const add = (v: string | null | undefined): void => {
    if (typeof v === "string" && v.length >= 2) out.add(v);
  };
  for (const s of registry.sources()) {
    for (const v of [s.location, s.dir, s.root, s.user, s.credential]) add(v);
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s.location)) {
      const full = resolve(s.dir, s.location);
      add(full);
      try { add(realpathSync(full)); } catch { /* a missing file has no real path */ }
    } else {
      try { add(new URL(s.location).host); } catch { /* not a URL */ }
    }
    for (const d of [s.dir, s.root]) {
      if (isAbsolute(d)) try { add(realpathSync(d)); } catch { /* gone */ }
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Text from a runner result or a caught error, with every source's location, folders, user and credential name taken out. The ledger keeps the full text. */
export function scrub(registry: Registry, text: string): string {
  let out = text;
  for (const secret of secretsOf(registry)) out = out.split(secret).join(HIDDEN);
  return out;
}
