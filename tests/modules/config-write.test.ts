import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Refused } from "../../src/core/refused";
import { loadConfig } from "../../src/modules/config";
import { ConfigWriteError, saveOnComplete, saveTrustedRoot, withOnComplete, withTrustedRoot } from "../../src/modules/config-write";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "rw-config-write-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const refusal = (f: () => unknown): Error => {
  try { f(); } catch (e) { return e as Error; }
  throw new Error("not refused");
};

test("withOnComplete replaces the value in a block-style cases mapping and leaves every other byte", () => {
  expect(withOnComplete("user: a\ncases:\n  store: /mnt/s  # the share\n  on_complete: keep\nserver:\n  port: 1\n", "unload")).toBe("user: a\ncases:\n  store: /mnt/s  # the share\n  on_complete: unload\nserver:\n  port: 1\n");
  expect(withOnComplete("cases:\n    on_complete: \"unload\"   # off for now\n", "keep")).toBe("cases:\n    on_complete: keep   # off for now\n");
  expect(withOnComplete("cases:  # where cases go\n  on_complete: keep\n", "keep")).toBe("cases:  # where cases go\n  on_complete: keep\n");
});

test("withOnComplete adds the line, with the block's indent, to a cases mapping that has none", () => {
  expect(withOnComplete("cases:\n    store: /mnt/s\n    max_bytes: 10\n\n# the rest\nuser: a\n", "unload"))
    .toBe("cases:\n    store: /mnt/s\n    max_bytes: 10\n    on_complete: unload\n\n# the rest\nuser: a\n");
  expect(withOnComplete("user: a\ncases:\n", "unload")).toBe("user: a\ncases:\n  on_complete: unload\n");
  expect(withOnComplete("cases:\n  store: /mnt/s", "keep")).toBe("cases:\n  store: /mnt/s\n  on_complete: keep");
});

test("withOnComplete appends a cases mapping to a file that has none, and to an empty file", () => {
  expect(withOnComplete("user: a\n", "unload")).toBe("user: a\ncases:\n  on_complete: unload\n");
  expect(withOnComplete("user: a", "unload")).toBe("user: a\ncases:\n  on_complete: unload\n");
  expect(withOnComplete("", "keep")).toBe("cases:\n  on_complete: keep\n");
  expect(withOnComplete("# only a comment\n", "keep")).toBe("# only a comment\ncases:\n  on_complete: keep\n");
});

test("a flow-style cases mapping, or a result that does not parse to the old settings with only that value changed, is refused", () => {
  const flow = refusal(() => withOnComplete("cases: { store: /x }\n", "unload"));
  expect(flow).toBeInstanceOf(ConfigWriteError);
  expect(flow).toBeInstanceOf(Refused);
  expect(flow.message).toBe("set cases.on_complete in the configuration file by hand: it could not be edited safely");
  for (const text of [
    "cases: unload\n",                                  // not a mapping
    "\"cases\":\n  store: /x\n",                       // a quoted key the line edit does not see
    "cases:\n  on_complete: |\n    keep\n",            // a block scalar
    "- a\n- b\n",                                       // not a mapping of settings
    "a: [unclosed\n",                                   // not YAML
    "cases:\n  on_complete: keep\ncases:\n  store: /x\n", // the key twice
  ]) expect(refusal(() => withOnComplete(text, "unload"))).toBeInstanceOf(ConfigWriteError);
});

test("saveOnComplete writes the file, creates it and its folder when the defaults were in use, and sets the value on the config", () => {
  const dir = tmp();
  const home = join(dir, "home");
  const opts = { env: {}, home, repoRoot: "/repo" };
  const config = loadConfig(opts);
  expect(config.cases.on_complete).toBe("keep");
  saveOnComplete(config, "unload");
  expect(config.cases.on_complete).toBe("unload");
  expect(readFileSync(config.write_path, "utf8")).toBe("cases:\n  on_complete: unload\n");
  const again = loadConfig(opts);
  expect(again.path).toBe(config.write_path);
  expect({ ...again, path: null } as typeof config).toEqual(config);
  expect(readdirSync(join(home, ".config/research-workbench"))).toEqual(["config.yaml"]);

  const named = join(dir, "named.yaml");
  writeFileSync(named, "user: pat\n# keep this\ncases:\n  store: ./shelf\nserver:\n  port: 5000\n");
  const c = loadConfig({ ...opts, path: named });
  saveOnComplete(c, "unload");
  expect(readFileSync(named, "utf8")).toBe("user: pat\n# keep this\ncases:\n  store: ./shelf\n  on_complete: unload\nserver:\n  port: 5000\n");
  expect(loadConfig({ ...opts, path: named })).toEqual(c);
  saveOnComplete(c, "keep");
  expect(loadConfig({ ...opts, path: named }).cases.on_complete).toBe("keep");
  expect(readdirSync(dir).sort()).toEqual(["home", "named.yaml"]);
});

test("saveOnComplete leaves the file and the config as they were when it is refused or the write fails", () => {
  const dir = tmp();
  const opts = { env: {}, home: join(dir, "home"), repoRoot: "/repo" };
  const flow = join(dir, "flow.yaml");
  writeFileSync(flow, "cases: { store: /x }\n");
  const c = loadConfig({ ...opts, path: flow });
  const err = refusal(() => saveOnComplete(c, "unload"));
  expect(err).toBeInstanceOf(ConfigWriteError);
  expect(err.message).toBe(`set cases.on_complete in ${flow} by hand: it could not be edited safely`);
  expect(readFileSync(flow, "utf8")).toBe("cases: { store: /x }\n");
  expect(c.cases.on_complete).toBe("keep");
  expect(readdirSync(dir).sort()).toEqual(["flow.yaml"]);

  // the folder cannot be made: a file stands where it would go
  mkdirSync(join(dir, "home"));
  writeFileSync(join(dir, "home", ".config"), "a file\n");
  const d = loadConfig(opts);
  expect(refusal(() => saveOnComplete(d, "unload"))).toBeInstanceOf(ConfigWriteError);
  expect(d.cases.on_complete).toBe("keep");
  expect(readFileSync(join(dir, "home", ".config"), "utf8")).toBe("a file\n");

  // the file cannot be replaced: a folder stands at its name
  const blocked = join(dir, "blocked");
  mkdirSync(join(blocked, "config.yaml"), { recursive: true });
  const e = { ...loadConfig(opts), write_path: join(blocked, "config.yaml") };
  expect(refusal(() => saveOnComplete(e, "unload"))).toBeInstanceOf(ConfigWriteError);
  expect(e.cases.on_complete).toBe("keep");
  expect(readdirSync(blocked)).toEqual(["config.yaml"]);
  expect(existsSync(join(blocked, "config.yaml"))).toBe(true);
});

test("a quoted cases key, or a file that begins with a byte-order mark, never gets a second cases mapping", () => {
  // the quoted key is refused; a parser keeps the last of a key given twice, so the check after the edit would not see it
  expect(refusal(() => withOnComplete("\"cases\":\n  on_complete: keep\n", "unload"))).toBeInstanceOf(ConfigWriteError);
  expect(refusal(() => withOnComplete("'cases':\n  on_complete: keep\n", "unload"))).toBeInstanceOf(ConfigWriteError);
  // a byte-order mark reads as part of the first key: such a file is left to be edited by hand
  expect(refusal(() => withOnComplete("\uFEFFcases:\n  on_complete: keep\n", "unload"))).toBeInstanceOf(ConfigWriteError);
  expect(refusal(() => withOnComplete("\uFEFFuser: a\n", "unload"))).toBeInstanceOf(ConfigWriteError);
});

test("saveOnComplete writes through a link to the configuration file: the link stays a link", () => {
  const dir = tmp();
  const real = join(dir, "real.yaml");
  writeFileSync(real, "user: pat\n");
  const link = join(dir, "config.yaml");
  symlinkSync(real, link);
  const c = loadConfig({ env: {}, home: join(dir, "home"), repoRoot: "/repo", path: link });
  saveOnComplete(c, "unload");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(real, "utf8")).toBe("user: pat\ncases:\n  on_complete: unload\n");
  expect(readdirSync(dir).sort()).toEqual(["config.yaml", "real.yaml"]);
});

const IMPORTED = "/data/imported/triage-0123456789ab";
const ADD_BY_HAND = `add this root to the roots list of the configuration file by hand; it could not be edited safely:
roots:
  - path: "${IMPORTED}"
    trusted: true
    credentials: []`;

test("withTrustedRoot adds one root to a block-style roots list and changes no other line; the result parses to the old configuration plus that root", () => {
  const entry = { path: IMPORTED, trusted: true, credentials: [] };
  const texts = [
    "user: a\nroots:\n  - path: ./sample   # the sample\n    trusted: true\n    credentials: [lake]\n# after\nserver:\n  port: 1\n",
    "roots:\n- path: /r/one\n- path: /r/two\n  credentials:\n    - a\n",
    "roots:   # where manifests come from\n    -   path: /r\n        trusted: false\n\nseeker: cheapest\n",
    "roots:\r\n  - path: /r\r\n",
    "roots:\n  - { path: /r, trusted: true }\n",
  ];
  for (const text of texts) {
    const next = withTrustedRoot(text, IMPORTED);
    const before = Bun.YAML.parse(text) as { roots: unknown[] };
    expect(Bun.YAML.parse(next)).toEqual({ ...before, roots: [...before.roots, entry] });
    // every old line is there, in order, and only the new root's three lines are added
    const nl = text.includes("\r\n") ? "\r\n" : "\n";
    const old = text.split(nl);
    const now = next.split(nl);
    expect(now.length).toBe(old.length + 3);
    const at = now.findIndex((l) => l.trim() === `- path: "${IMPORTED}"`);
    expect(now.slice(at, at + 3).map((l) => l.trim())).toEqual([`- path: "${IMPORTED}"`, "trusted: true", "credentials: []"]);
    expect([...now.slice(0, at), ...now.slice(at + 3)]).toEqual(old);
  }
  expect(withTrustedRoot("user: a\nroots:\n  - path: /r\nserver:\n  port: 1\n", IMPORTED))
    .toBe(`user: a\nroots:\n  - path: /r\n  - path: "${IMPORTED}"\n    trusted: true\n    credentials: []\nserver:\n  port: 1\n`);
});

test("a configuration with no roots key, with roots in flow style, or that already lists the path is refused with the lines to add by hand", () => {
  for (const text of [
    "user: a\n",                                       // no roots key
    "",                                                 // an empty file
    `roots: [{ path: /r }]\n`,                         // flow style
    "roots: []\n",                                     // flow style, empty
    "roots:\n",                                        // no list at all
    `roots:\n  - path: "${IMPORTED}"\n`,              // already listed
    `roots:\n  - path: ${IMPORTED}\n    trusted: false\n`, // already listed, not trusted
    "\"roots\":\n  - path: /r\n",                   // a quoted key the line edit does not see
    "roots:\n  - path: /r\nroots:\n  - path: /s\n",  // the key twice
    "roots:\n  path: /r\n",                           // not a list
    "\uFEFFroots:\n  - path: /r\n",                  // a byte-order mark
  ]) {
    const err = refusal(() => withTrustedRoot(text, IMPORTED));
    expect(err).toBeInstanceOf(ConfigWriteError);
    expect(err.message).toBe(ADD_BY_HAND);
  }
});

test("saveTrustedRoot writes the root into the file and onto the config; refused, it changes neither", () => {
  const dir = tmp();
  const opts = { env: {}, home: join(dir, "home"), repoRoot: "/repo" };
  const named = join(dir, "config.yaml");
  const root = join(dir, "imported", "triage-0123456789ab");
  mkdirSync(root, { recursive: true });
  writeFileSync(named, "roots:\n  - path: ./sample\n    trusted: true\n");
  const c = loadConfig({ ...opts, path: named });
  saveTrustedRoot(c, root);
  expect(c.roots.at(-1)).toEqual({ path: root, trusted: true, credentials: [] });
  expect(loadConfig({ ...opts, path: named })).toEqual(c);
  expect(readdirSync(dir).sort()).toEqual(["config.yaml", "imported"]);

  const text = readFileSync(named, "utf8");
  const err = refusal(() => saveTrustedRoot(c, root));
  expect(err).toBeInstanceOf(ConfigWriteError);
  expect(err.message).toStartWith(`add this root to the roots list of ${named} by hand; it could not be edited safely:\nroots:\n  - path: "${root}"`);
  expect(readFileSync(named, "utf8")).toBe(text);
  expect(c.roots.length).toBe(2);
});
