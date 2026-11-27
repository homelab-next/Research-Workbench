// Writing what a person may change from the interface into the configuration file by a line edit: cases.on_complete, and one more trusted root.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
/** Any other top-level line that names cases (a flow mapping, a scalar, a quoted key). */
const OTHER_START = /^(["']?)cases\1[ \t]*:/;
const BOM = "\uFEFF";
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
  // a byte-order mark reads as part of the first key (the loader would not see cases there either): such a file is edited by hand
  if (text.startsWith(BOM)) throw UNSAFE;
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
  // a YAML parser keeps the last of a key given twice, so the comparison below would not see a second cases mapping
  const starts = next.split("\n").filter((l) => OTHER_START.test(l)).length;
  if (starts > 1) throw UNSAFE;
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
  writeConfig(config, (text) => withOnComplete(text, value), byHand);
  config.cases.on_complete = value;
}

/** The edited configuration file written in place of the old (temporary file, fsync, rename; the folder is made when missing). Throws ConfigWriteError and changes nothing. */
function writeConfig(config: Config, edit: (text: string) => string, refused: (file: string) => ConfigWriteError): void {
  const named = config.write_path;
  // a link to the configuration file is written through, to the file it names: the link stays a link
  let file = named;
  try {
    file = realpathSync(named);
  } catch {
    // not there yet: it is made where it is named
  }
  const dir = dirname(file);
  let text: string;
  try {
    text = existsSync(file) ? readFileSync(file, "utf8") : "";
  } catch (err) {
    throw new ConfigWriteError(`${named} could not be read: ${(err as Error).message}`);
  }
  let next: string;
  try {
    next = edit(text);
  } catch (err) {
    if (err instanceof ConfigWriteError) throw refused(named);
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
    throw new ConfigWriteError(`${named} could not be written: ${(err as Error).message}`);
  }
  try {
    const d = openSync(dir, "r");
    try { fsyncSync(d); } finally { closeSync(d); }
  } catch {
    // the rename is done; a folder that cannot be synced does not undo it
  }
}

/** A top-level `roots:` with nothing after it but a comment: the start of a block-style list. */
const ROOTS_START = /^roots:[ \t]*(#.*)?$/;
/** Any top-level line that names roots (a flow list, a quoted key). */
const ROOTS_OTHER = /^(["']?)roots\1[ \t]*:/;
/** The lines of a trusted root with no credentials, as a person would add them to the roots list. */
const rootLines = (path: string, indent = 2): string[] => {
  const pad = " ".repeat(indent);
  return [`${pad}- path: ${JSON.stringify(path)}`, `${pad}  trusted: true`, `${pad}  credentials: []`];
};
const rootByHand = (file: string, path: string): ConfigWriteError =>
  new ConfigWriteError(`add this root to the roots list of ${file} by hand; it could not be edited safely:\nroots:\n${rootLines(path).join("\n")}`);

/** The configuration's text with one more root, trusted, no credentials. Refused when the edit cannot be shown to add exactly that root (ConfigWriteError names the lines to add by hand). */
export function withTrustedRoot(text: string, path: string): string {
  const unsafe = rootByHand("the configuration file", path);
  if (text.startsWith(BOM)) throw unsafe;
  let before: Record<string, unknown>;
  try {
    before = parse(text);
  } catch {
    throw unsafe;
  }
  const roots = before.roots;
  if (!Array.isArray(roots)) throw unsafe;
  if (roots.some((r) => isPlainObject(r) && r.path === path)) throw unsafe;
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const endsWithNewline = text.endsWith("\n");
  if (endsWithNewline) lines.pop();
  if (lines.filter((l) => ROOTS_OTHER.test(l)).length !== 1) throw unsafe;
  const start = lines.findIndex((l) => ROOTS_START.test(l));
  if (start === -1) throw unsafe;
  // the list runs to the next line at the left margin that is content and not one of its items
  let end = start + 1;
  while (end < lines.length && !(isContent(lines[end]!) && indentOf(lines[end]!) === 0 && !lines[end]!.startsWith("-"))) end++;
  const children: number[] = [];
  for (let i = start + 1; i < end; i++) if (isContent(lines[i]!)) children.push(i);
  if (children.length === 0 || !lines[children[0]!]!.trimStart().startsWith("-")) throw unsafe;
  const out = [...lines];
  out.splice(children.at(-1)! + 1, 0, ...rootLines(path, indentOf(lines[children[0]!]!)));
  const next = out.join(nl) + (endsWithNewline ? nl : "");
  let same: boolean;
  try {
    const after = parse(next);
    const expected = { ...before, roots: [...roots, { path, trusted: true, credentials: [] }] };
    same = canonical(after as unknown as Json) === canonical(expected as unknown as Json);
  } catch {
    same = false;
  }
  if (!same) throw unsafe;
  return next;
}

/** Writes one more trusted root, with no credentials, into config.write_path and onto `config.roots`. Throws ConfigWriteError and changes nothing. */
export function saveTrustedRoot(config: Config, path: string): void {
  const at = resolve(path);
  if (!isAbsolute(path) || config.roots.some((r) => resolve(r.path) === at)) throw rootByHand(config.write_path, at);
  writeConfig(config, (text) => withTrustedRoot(text, at), (file) => rootByHand(file, at));
  config.roots.push({ path: at, trusted: true, credentials: [] });
}
