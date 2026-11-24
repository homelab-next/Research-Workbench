import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretError, Secrets } from "../../src/modules/secrets";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "secrets-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("reads from the environment first, then the file", () => {
  const f = join(dir, "s.yaml");
  writeFileSync(f, "A: from-file-2\nB: 30000003\n", { mode: 0o600 });
  const s = new Secrets({ A: "from-env-1" }, f);
  expect(s.get("A")).toBe("from-env-1");
  expect(s.get("B")).toBe("30000003");
  expect(s.get("C")).toBeNull();
  expect(s.get("toString")).toBeNull();
});

test("a secrets file readable by others is refused", () => {
  const f = join(dir, "s.yaml");
  writeFileSync(f, "A: 2\n");
  chmodSync(f, 0o644);
  expect(() => new Secrets({}, f)).toThrow(/s\.yaml.*0600/);
});

test("a missing file is the same as no file", () => {
  expect(new Secrets({ A: "from-env-1" }, join(dir, "nope.yaml")).get("A")).toBe("from-env-1");
  expect(new Secrets({}, null).get("A")).toBeNull();
});

test("an empty credential, or one shorter than 8 characters, is refused when loaded", () => {
  const f = join(dir, "s.yaml");
  writeFileSync(f, "SHORT_FILE: abc\n", { mode: 0o600 });
  const s = new Secrets({ EMPTY: "", SHORT: "1234567", OK: "12345678" }, f);
  expect(() => s.get("EMPTY")).toThrow(SecretError);
  expect(() => s.get("EMPTY")).toThrow(/EMPTY is empty/);
  expect(() => s.get("SHORT")).toThrow(/SHORT is shorter than 8 characters/);
  expect(() => s.get("SHORT_FILE")).toThrow(SecretError);
  expect(s.get("OK")).toBe("12345678");
});

test("the values cannot be read by enumerating or serialising the object", () => {
  const f = join(dir, "s.yaml");
  writeFileSync(f, "FILE_SECRET: file-value-xyz\n", { mode: 0o600 });
  const s = new Secrets({ ENV_SECRET: "env-value-xyz", HOME: "/home/someone" }, f);
  const deps = { secrets: s, nested: [s] };
  const text = JSON.stringify(deps) + Object.keys(s).join() + Object.getOwnPropertyNames(s).join() + Bun.inspect(s) + String(s);
  for (const leak of ["env-value-xyz", "file-value-xyz", "ENV_SECRET", "FILE_SECRET", "/home/someone"]) expect(text).not.toContain(leak);
  expect(JSON.stringify(s)).toBe("{}");
});
