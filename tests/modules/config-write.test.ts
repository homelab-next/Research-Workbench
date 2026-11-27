import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Refused } from "../../src/core/refused";
import { loadConfig } from "../../src/modules/config";
import { ConfigWriteError, saveOnComplete, withOnComplete } from "../../src/modules/config-write";

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
