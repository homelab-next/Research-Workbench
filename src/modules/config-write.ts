// Writing the one setting a person may change from the interface, cases.on_complete, into the configuration file by a line edit.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Json } from "../core/canonical";
import { canonical, isPlainObject } from "../core/canonical";
import { Refused } from "../core/refused";
import type { Config } from "./config";

/** The setting could not be written: the file could not be edited safely, or the write failed. Nothing was changed. */
export class ConfigWriteError extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "ConfigWriteError";
  }
}

const byHand = (file: string): ConfigWriteError => new ConfigWriteError(`set cases.on_complete in ${file} by hand: it could not be edited safely`);
const UNSAFE = byHand("the configuration file");

/** A top-level `cases:` with nothing after it but a comment: the start of a block-style mapping. */
const BLOCK_START = /^cases:[ \t]*(#.*)?$/;
/** Any other top-level line that names cases (a flow mapping, a scalar). */
const OTHER_START = /^cases[ \t]*:/;
/** A child `on_complete:` with a plain one-line value and perhaps a comment. */
const CHILD = /^([ ]+)on_complete[ \t]*:([ \t]*)([^#]*?)([ \t]+#.*)?$/;
const indentOf = (line: string): number => line.length - line.trimStart().length;
/** A clean-up after a failure, which must not hide the failure. */
const quietly = (f: () => void): void => {
  try { f(); } catch { /* the failure being reported is the one that matters */ }
};
const isContent = (line: string): boolean => line.trim() !== "" && !line.trimStart().startsWith("#");

function parse(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch {
    throw UNSAFE;
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) throw UNSAFE;
  return parsed;
}

/** The line edit, before it is checked. */
function edit(text: string, value: "keep" | "unload"): string {
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const endsWithNewline = text === "" || text.endsWith("\n");
  if (endsWithNewline) lines.pop(); // the empty string after the final newline

  const start = lines.findIndex((l) => BLOCK_START.test(l));
  if (start === -1) {
    if (lines.some((l) => OTHER_START.test(l))) throw UNSAFE;
    const out = [...lines, "cases:", `  on_complete: ${value}`];
    return out.join(nl) + nl;
  }
  // the block runs to the next line that is content at the left margin
  let end = start + 1;
  while (end < lines.length && !(isContent(lines[end]!) && indentOf(lines[end]!) === 0)) end++;
  const children = [];
  for (let i = start + 1; i < end; i++) if (isContent(lines[i]!)) children.push(i);
  const indent = children.length === 0 ? 2 : indentOf(lines[children[0]!]!);
  const pad = " ".repeat(indent);
  const own = children.filter((i) => indentOf(lines[i]!) === indent && CHILD.test(lines[i]!));
  const out = [...lines];
  if (own.length > 0) {
    for (const i of own) {
      const m = CHILD.exec(lines[i]!)!;
      out[i] = `${m[1]}on_complete:${m[2] === "" ? " " : m[2]}${value}${m[4] ?? ""}`;
    }
  } else {
    const after = children.length === 0 ? start : children.at(-1)!;
    out.splice(after + 1, 0, `${pad}on_complete: ${value}`);
  }
  return out.join(nl) + (endsWithNewline ? nl : "");
}

/** The text of a configuration file with cases.on_complete set, every other line as it was. Pure. Throws ConfigWriteError when it cannot be done by a line edit. */
export function withOnComplete(text: string, value: "keep" | "unload"): string {
  const before = parse(text);
  const cases = before.cases ?? null;
  if (cases !== null && !isPlainObject(cases)) throw UNSAFE;
  const next = edit(text, value);
  const after = parse(next);
  const expected = { ...before, cases: { ...(cases ?? {}), on_complete: value } };
  let same: boolean;
  try {
    same = canonical(after as unknown as Json) === canonical(expected as unknown as Json);
  } catch {
    same = false;
  }
  if (!same) throw UNSAFE;
  return next;
}

/** Writes cases.on_complete to config.write_path (temporary file, fsync, rename; the folder is made when missing) and sets it on `config`. Throws ConfigWriteError and changes nothing. */
export function saveOnComplete(config: Config, value: "keep" | "unload"): void {
  const file = config.write_path;
  const dir = dirname(file);
  let text: string;
  try {
    text = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch (err) {
    throw new ConfigWriteError(`${file} could not be read: ${(err as Error).message}`);
  }
  let next: string;
  try {
    next = withOnComplete(text, value);
  } catch (err) {
    if (err instanceof ConfigWriteError) throw byHand(file);
    throw err;
  }
  let made: string | undefined;
  const tmp = join(dir, `.${basename(file)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    made = mkdirSync(dir, { recursive: true });
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, next);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    const created = made;
    quietly(() => rmSync(tmp, { force: true }));
    if (created !== undefined) quietly(() => rmSync(created, { recursive: true, force: true }));
    throw new ConfigWriteError(`${file} could not be written: ${(err as Error).message}`);
  }
  try {
    const d = openSync(dir, "r");
    try { fsyncSync(d); } finally { closeSync(d); }
  } catch {
    // the rename is done; a folder that cannot be synced does not undo it
  }
  config.cases.on_complete = value;
}
