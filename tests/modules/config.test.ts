import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../../src/modules/config";

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
    roots: [{ path: "/repo/sample", trusted_scripts: true }], server: { port: 4747 }, research: { parallel: 3 }, secrets_file: null });
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

test("roots given without trusted_scripts are not trusted", () => {
  const p = file(tmp(), "c.yaml", "roots:\n  - path: /a\n  - { path: /b, trusted_scripts: true }\n");
  const c = loadConfig({ path: p, env: {}, home: "/h", repoRoot: "/repo" });
  expect(c.roots).toEqual([{ path: "/a", trusted_scripts: false }, { path: "/b", trusted_scripts: true }]);
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
