import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig, rootsOf } from "../../src/modules/config";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "rw-config-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = (dir: string, name: string, text: string): string => {
  const p = join(dir, name);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
};

test("with no file, defaults point at the bundled sample root", () => {
  const c = loadConfig({ env: { USER: "pat" }, home: "/h", repoRoot: "/repo" });
  expect(c).toMatchObject({ path: null, user: "pat", role: "analyst", seeker: "cheapest", data_dir: "/h/.local/share/research-workbench",
    roots: [{ path: "/repo/sample", trusted: true, credentials: [] }], server: { port: 4747 }, research: { parallel: 3 }, secrets_file: null });
  expect(c.marking_policy["TLP:RED"]).toEqual(["machine"]);
  expect(c.marking_policy["TLP:CLEAR"]).toEqual(["machine", "network", "hosted"]);
});

test("user falls back to analyst when USER is unset", () => {
  expect(loadConfig({ env: {}, home: "/h", repoRoot: "/repo" }).user).toBe("analyst");
});

test("XDG_DATA_HOME moves the data directory", () => {
  const c = loadConfig({ env: { XDG_DATA_HOME: "/x" }, home: "/h", repoRoot: "/repo" });
  expect(c.data_dir).toBe("/x/research-workbench");
});

test("an explicit path wins over the environment, which wins over the home file", () => {
  const dir = tmp();
  const home = join(dir, "home");
  file(home, ".config/research-workbench/config.yaml", "user: from-home\n");
  const envFile = file(dir, "env.yaml", "user: from-env\n");
  const explicit = file(dir, "explicit.yaml", "user: from-explicit\n");
  const base = { home, repoRoot: "/repo" };
  expect(loadConfig({ ...base, env: {} }).user).toBe("from-home");
  expect(loadConfig({ ...base, env: { RESEARCH_WORKBENCH_CONFIG: envFile } }).user).toBe("from-env");
  const c = loadConfig({ ...base, env: { RESEARCH_WORKBENCH_CONFIG: envFile }, path: explicit });
  expect(c.user).toBe("from-explicit");
  expect(c.path).toBe(explicit);
});

test("a named file that does not exist is refused", () => {
  expect(() => loadConfig({ path: join(tmp(), "nope.yaml"), env: {}, home: "/h", repoRoot: "/repo" })).toThrow(ConfigError);
});

test("relative root paths resolve against the config file's folder, and ~ expands", () => {
  const dir = tmp();
  const p = file(dir, "conf/config.yaml", "data_dir: ~/data\nsecrets_file: ./s.yaml\nroots:\n  - path: ./mods\n  - path: ~/other\n");
  const c = loadConfig({ path: p, env: {}, home: "/h", repoRoot: "/repo" });
  expect(c.roots.map(r => r.path)).toEqual([join(dir, "conf/mods"), "/h/other"]);
  expect(c.data_dir).toBe("/h/data");
  expect(c.secrets_file).toBe(join(dir, "conf/s.yaml"));
});

test("roots given without a grant are not trusted and are given no credentials", () => {
  const p = file(tmp(), "c.yaml", "roots:\n  - path: /a\n  - { path: /b, trusted: true, credentials: [LAKE_PASSWORD] }\n");
  const c = loadConfig({ path: p, env: {}, home: "/h", repoRoot: "/repo" });
  expect(c.roots).toEqual([{ path: "/a", trusted: false, credentials: [] }, { path: "/b", trusted: true, credentials: ["LAKE_PASSWORD"] }]);
});

test("the old trusted_scripts setting and a malformed credentials list are configuration errors", () => {
  const dir = tmp();
  expect(() => loadConfig({ path: file(dir, "a.yaml", "roots:\n  - { path: /a, trusted_scripts: true }\n"), env: {}, home: "/h", repoRoot: "/repo" })).toThrow(ConfigError);
  expect(() => loadConfig({ path: file(dir, "b.yaml", "roots:\n  - { path: /a, credentials: LAKE }\n"), env: {}, home: "/h", repoRoot: "/repo" })).toThrow(ConfigError);
  expect(() => loadConfig({ path: file(dir, "c.yaml", "roots:\n  - { path: /a, credentials: [''] }\n"), env: {}, home: "/h", repoRoot: "/repo" })).toThrow(ConfigError);
});

test("secrets_file defaults to the home path only when it exists", () => {
  const home = tmp();
  expect(loadConfig({ env: {}, home, repoRoot: "/repo" }).secrets_file).toBeNull();
  const s = file(home, ".config/research-workbench/secrets.yaml", "a: b\n");
  expect(loadConfig({ env: {}, home, repoRoot: "/repo" }).secrets_file).toBe(s);
});

test("an unknown key is refused", () => {
  const p = file(tmp(), "c.yaml", "rooots: []\n");
  let err: unknown;
  try { loadConfig({ path: p, env: {}, home: "/h", repoRoot: "/repo" }); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ConfigError);
  expect((err as Error).message).toContain("rooots");
});

test("a bad role or a non-numeric port is refused", () => {
  const opts = { env: {}, home: "/h", repoRoot: "/repo" };
  expect(() => loadConfig({ ...opts, path: file(tmp(), "a.yaml", "role: boss\n") })).toThrow(ConfigError);
  expect(() => loadConfig({ ...opts, path: file(tmp(), "b.yaml", "server: { port: abc }\n") })).toThrow(ConfigError);
  expect(() => loadConfig({ ...opts, path: file(tmp(), "c.yaml", "marking_policy: { \"TLP:RED\": [moon] }\n") })).toThrow(ConfigError);
});

test("invalid YAML is a ConfigError, and an empty file or a bare key means defaults", () => {
  const opts = { env: {}, home: "/h", repoRoot: "/repo" };
  expect(() => loadConfig({ ...opts, path: file(tmp(), "a.yaml", "a: [unclosed\n") })).toThrow(ConfigError);
  expect(() => loadConfig({ ...opts, path: file(tmp(), "b.yaml", "- a\n- b\n") })).toThrow(ConfigError);
  expect(loadConfig({ ...opts, path: file(tmp(), "c.yaml", "") }).role).toBe("analyst");
  expect(loadConfig({ ...opts, path: file(tmp(), "d.yaml", "role:\n") }).role).toBe("analyst");
});

test("a partial marking_policy keeps the defaults for markings it omits", () => {
  const p = file(tmp(), "c.yaml", "marking_policy:\n  \"TLP:AMBER\": [machine]\n");
  const c = loadConfig({ path: p, env: {}, home: "/h", repoRoot: "/repo" });
  expect(c.marking_policy["TLP:AMBER"]).toEqual(["machine"]);
  expect(c.marking_policy["TLP:GREEN"]).toEqual(["machine", "network", "hosted"]);
  expect(c.marking_policy["TLP:RED"]).toEqual(["machine"]);
});

test("questions.max_open defaults to 3, is read from the file, and a negative or fractional one is refused", () => {
  const opts = { env: {}, home: "/h", repoRoot: "/repo" };
  expect(loadConfig(opts).questions).toEqual({ max_open: 3 });
  const dir = tmp();
  expect(loadConfig({ ...opts, path: file(dir, "a.yaml", "questions:\n  max_open: 5\n") }).questions).toEqual({ max_open: 5 });
  expect(loadConfig({ ...opts, path: file(dir, "b.yaml", "questions:\n  max_open: 0\n") }).questions).toEqual({ max_open: 0 });
  expect(loadConfig({ ...opts, path: file(dir, "c.yaml", "questions: {}\n") }).questions).toEqual({ max_open: 3 });
  expect(() => loadConfig({ ...opts, path: file(dir, "d.yaml", "questions:\n  max_open: -1\n") })).toThrow(ConfigError);
  expect(() => loadConfig({ ...opts, path: file(dir, "e.yaml", "questions:\n  max_open: 1.5\n") })).toThrow(ConfigError);
  expect(() => loadConfig({ ...opts, path: file(dir, "f.yaml", "questions:\n  most: 2\n") })).toThrow(ConfigError);
});

test("cases defaults: the store is <data_dir>/store, on_complete is keep, max_bytes is 2 GiB", () => {
  const c = loadConfig({ env: {}, home: "/h", repoRoot: "/repo" });
  expect(c.cases).toEqual({ store: "/h/.local/share/research-workbench/store", on_complete: "keep", max_bytes: 2147483648 });
  const p = file(tmp(), "c.yaml", "data_dir: /d\ncases:\n  on_complete: unload\n");
  expect(loadConfig({ path: p, env: {}, home: "/h", repoRoot: "/repo" }).cases).toEqual({ store: "/d/store", on_complete: "unload", max_bytes: 2147483648 });
  const q = file(tmp(), "d.yaml", "cases: {}\n");
  expect(loadConfig({ path: q, env: { XDG_DATA_HOME: "/x" }, home: "/h", repoRoot: "/repo" }).cases.store).toBe("/x/research-workbench/store");
});

test("cases.store is placed like data_dir: relative to the file, with ~ expanded", () => {
  const dir = tmp();
  const opts = { env: {}, home: "/h", repoRoot: "/repo" };
  expect(loadConfig({ ...opts, path: file(dir, "conf/a.yaml", "cases:\n  store: ./shelf\n  max_bytes: 10\n") }).cases)
    .toEqual({ store: join(dir, "conf/shelf"), on_complete: "keep", max_bytes: 10 });
  expect(loadConfig({ ...opts, path: file(dir, "conf/b.yaml", "cases:\n  store: ~/shelf\n") }).cases.store).toBe("/h/shelf");
  expect(loadConfig({ ...opts, path: file(dir, "conf/c.yaml", "cases:\n  store: /mnt/share\n") }).cases.store).toBe("/mnt/share");
});

test("cases.on_complete other than keep or unload, max_bytes below 1 and an unknown key under cases are refused", () => {
  const dir = tmp();
  const opts = { env: {}, home: "/h", repoRoot: "/repo" };
  for (const [name, text] of [
    ["a.yaml", "cases:\n  on_complete: archive\n"],
    ["b.yaml", "cases:\n  max_bytes: 0\n"],
    ["c.yaml", "cases:\n  max_bytes: 1.5\n"],
    ["d.yaml", "cases:\n  shelf: /x\n"],
    ["e.yaml", "cases:\n  store: ''\n"],
    ["f.yaml", "cases: unload\n"],
  ] as const) {
    let err: unknown;
    try { loadConfig({ ...opts, path: file(dir, name, text) }); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ConfigError);
  }
  let err: unknown;
  try { loadConfig({ ...opts, path: file(dir, "g.yaml", "cases:\n  shelf: /x\n") }); } catch (e) { err = e; }
  expect((err as Error).message).toContain("shelf");
});

test("write_path is the file the settings came from, or the home file when there was none", () => {
  const dir = tmp();
  const home = join(dir, "home");
  const opts = { home, repoRoot: "/repo" };
  expect(loadConfig({ ...opts, env: {} }).write_path).toBe(join(home, ".config/research-workbench/config.yaml"));
  const named = file(dir, "named.yaml", "user: a\n");
  expect(loadConfig({ ...opts, env: {}, path: named }).write_path).toBe(named);
  expect(loadConfig({ ...opts, env: { RESEARCH_WORKBENCH_CONFIG: named } }).write_path).toBe(named);
  const homeFile = file(home, ".config/research-workbench/config.yaml", "user: b\n");
  const c = loadConfig({ ...opts, env: {} });
  expect([c.path, c.write_path]).toEqual([homeFile, homeFile]);
});

// ---------- slice 12: the loops block and imported roots ----------

test("loops defaults: default investigation, max_depth 2, max_children 8, store <data_dir>/loops, imports <data_dir>/imported", () => {
  const c = loadConfig({ env: {}, home: "/h", repoRoot: "/repo" });
  expect(c.loops).toEqual({ default: "investigation", max_depth: 2, max_children: 8, store: "/h/.local/share/research-workbench/loops", imports: "/h/.local/share/research-workbench/imported" });
  const dir = tmp();
  const p = file(dir, "conf/c.yaml", "data_dir: /d\nloops:\n  default: triage\n  max_children: 3\n  imports: ./in\n  store: ~/shelf\n");
  expect(loadConfig({ path: p, env: {}, home: "/h", repoRoot: "/repo" }).loops)
    .toEqual({ default: "triage", max_depth: 2, max_children: 3, store: "/h/shelf", imports: join(dir, "conf/in") });
  const q = file(dir, "d.yaml", "data_dir: /d\nloops: {}\n");
  expect(loadConfig({ path: q, env: {}, home: "/h", repoRoot: "/repo" }).loops).toEqual({ default: "investigation", max_depth: 2, max_children: 8, store: "/d/loops", imports: "/d/imported" });
});

test("loops.max_depth 0 is allowed (no sub-loops); a negative depth, max_children 0 and an unknown key under loops are refused", () => {
  const dir = tmp();
  const opts = { env: {}, home: "/h", repoRoot: "/repo" };
  expect(loadConfig({ ...opts, path: file(dir, "z.yaml", "loops:\n  max_depth: 0\n") }).loops.max_depth).toBe(0);
  for (const [name, text] of [
    ["a.yaml", "loops:\n  max_depth: -1\n"],
    ["b.yaml", "loops:\n  max_children: 0\n"],
    ["c.yaml", "loops:\n  max_depth: 1.5\n"],
    ["d.yaml", "loops:\n  depth: 2\n"],
    ["e.yaml", "loops:\n  default: ''\n"],
    ["f.yaml", "loops: investigation\n"],
    ["g.yaml", "loops:\n  imports: ''\n"],
  ] as const) {
    let err: unknown;
    try { loadConfig({ ...opts, path: file(dir, name, text) }); } catch (e) { err = e; }
    expect({ name, refused: err instanceof ConfigError }).toEqual({ name, refused: true });
  }
  let err: unknown;
  try { loadConfig({ ...opts, path: file(dir, "h.yaml", "loops:\n  depth: 2\n") }); } catch (e) { err = e; }
  expect((err as Error).message).toContain("depth");
});

test("rootsOf adds each folder of loops.imports as an untrusted root with no credentials, sorted; a file there and a dot-folder are not roots", () => {
  const dir = tmp();
  const own = join(dir, "own");
  mkdirSync(own);
  const p = file(dir, "c.yaml", `data_dir: ${join(dir, "data")}\nroots:\n  - { path: ./own, trusted: true, credentials: [lake] }\n`);
  const c = loadConfig({ path: p, env: {}, home: "/h", repoRoot: "/repo" });
  // no imports folder yet: the configuration's roots alone
  expect(rootsOf(c)).toEqual([{ path: own, trusted: true, credentials: ["lake"] }]);
  const imports = join(dir, "data", "imported");
  for (const name of ["triage-bbbbbbbbbbbb", "Zeta-cccccccccccc", "alpha-aaaaaaaaaaaa", ".hidden"]) mkdirSync(join(imports, name), { recursive: true });
  writeFileSync(join(imports, "stray.yaml"), "kind: loop\n");
  expect(rootsOf(c)).toEqual([
    { path: own, trusted: true, credentials: ["lake"] },
    { path: join(imports, "Zeta-cccccccccccc"), trusted: false, credentials: [], staged: true },
    { path: join(imports, "alpha-aaaaaaaaaaaa"), trusted: false, credentials: [], staged: true },
    { path: join(imports, "triage-bbbbbbbbbbbb"), trusted: false, credentials: [], staged: true },
  ]);
  // the configuration itself is not changed
  expect(c.roots).toEqual([{ path: own, trusted: true, credentials: ["lake"] }]);
});

test("a folder of loops.imports that config.roots lists is taken once, with the trust the configuration gives it", () => {
  const dir = tmp();
  const imports = join(dir, "in");
  for (const name of ["a-111111111111", "b-222222222222"]) mkdirSync(join(imports, name), { recursive: true });
  const p = file(dir, "c.yaml", "loops:\n  imports: ./in\nroots:\n  - { path: ./in/b-222222222222/, trusted: true }\n");
  const c = loadConfig({ path: p, env: {}, home: "/h", repoRoot: "/repo" });
  expect(rootsOf(c)).toEqual([
    { path: join(imports, "b-222222222222"), trusted: true, credentials: [] },
    { path: join(imports, "a-111111111111"), trusted: false, credentials: [], staged: true },
  ]);
});

// ---------- slice 13: the memory block ----------

test("the memory block defaults to the data folder's memory and memory-files, 12 lessons and 40 notes", () => {
  const c = loadConfig({ env: {}, home: "/h", repoRoot: "/repo" });
  expect(c.memory).toEqual({ store: "/h/.local/share/research-workbench/memory", files: "/h/.local/share/research-workbench/memory-files", max_lessons: 12, max_notes: 40 });
  const dir = tmp();
  const q = file(dir, "d.yaml", "data_dir: /d\nmemory: {}\n");
  expect(loadConfig({ path: q, env: {}, home: "/h", repoRoot: "/repo" }).memory).toEqual({ store: "/d/memory", files: "/d/memory-files", max_lessons: 12, max_notes: 40 });
});

test("a memory block in the file is read, its folders placed against the file's folder; max_lessons 0 is refused", () => {
  const dir = tmp();
  const p = file(dir, "conf/c.yaml", "data_dir: /d\nmemory:\n  store: ./shared\n  files: ~/shelf\n  max_lessons: 5\n  max_notes: 7\n");
  expect(loadConfig({ path: p, env: {}, home: "/h", repoRoot: "/repo" }).memory).toEqual({ store: join(dir, "conf/shared"), files: "/h/shelf", max_lessons: 5, max_notes: 7 });
  for (const [n, text] of [["a.yaml", "memory:\n  max_lessons: 0\n"], ["b.yaml", "memory:\n  max_notes: 0\n"], ["c.yaml", "memory:\n  max_lessons: 1.5\n"], ["d.yaml", "memory:\n  extra: 1\n"]] as const) {
    expect(() => loadConfig({ path: file(dir, n, text), env: {}, home: "/h", repoRoot: "/repo" })).toThrow(ConfigError);
  }
});
