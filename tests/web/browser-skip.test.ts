import { expect, test } from "bun:test";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const SENTENCE = "browser run skipped: no Chromium found (set WORKBENCH_CHROME)";

/** The browser run, started as its own process, on a machine that is said to have no browser. */
function withoutBrowser(require: boolean): { code: number; out: string } {
  const env: Record<string, string | undefined> = { ...process.env, WORKBENCH_CHROME: "/nonexistent/chromium" };
  if (require) env.WORKBENCH_REQUIRE_BROWSER = "1"; else delete env.WORKBENCH_REQUIRE_BROWSER;
  const r = Bun.spawnSync(["bun", "test", join("tests", "web", "browser-run.test.ts")], { cwd: REPO, env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() };
}

test("with no browser the browser run is skipped, and says so in one printed line", () => {
  const r = withoutBrowser(false);
  expect(r.code).toBe(0);
  expect(r.out.split("\n").filter((l) => l === SENTENCE)).toHaveLength(1);
  expect(r.out).toMatch(/1 skip/);
});

test("with WORKBENCH_REQUIRE_BROWSER=1 and no browser the browser run fails with that sentence", () => {
  const r = withoutBrowser(true);
  expect(r.code).not.toBe(0);
  expect(r.out).toContain(SENTENCE);
  expect(r.out).toMatch(/1 fail/);
});
