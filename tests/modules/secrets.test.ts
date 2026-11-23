import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Secrets } from "../../src/modules/secrets";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "secrets-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test("reads from the environment first, then the file", () => {
  const f = join(dir, "s.yaml");
  writeFileSync(f, "A: 2\nB: 3\n", { mode: 0o600 });
  const s = new Secrets({ A: "1" }, f);
  expect(s.get("A")).toBe("1");
  expect(s.get("B")).toBe("3");
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
  expect(new Secrets({ A: "1" }, join(dir, "nope.yaml")).get("A")).toBe("1");
  expect(new Secrets({}, null).get("A")).toBeNull();
});
