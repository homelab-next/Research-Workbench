import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { serve } from "../../src/cli/serve";
import { verifyCase } from "../../src/core/verify";
import { findChrome, launch } from "../helpers/chrome";
import type { Browser } from "../helpers/chrome";
import { copySample } from "../helpers/sample-root";

const REPO = join(import.meta.dir, "..", "..");
const NONE = "browser run skipped: no Chromium found (set WORKBENCH_CHROME)";
const chrome = findChrome();

const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length > 0) await closers.pop()!(); });

function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = s.port!;
  void s.stop(true);
  return port;
}

async function theRun(path: string): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "browser-run-"));
  closers.push(() => { rmSync(dir, { recursive: true, force: true }); });
  const root = join(dir, "sample");
  copySample(root);
  const fixturePort = freePort();
  const rep = join(root, "sources", "reputation.yaml");
  writeFileSync(rep, readFileSync(rep, "utf8").replace("http://127.0.0.1:4801", `http://127.0.0.1:${fixturePort}`));
  const data = join(dir, "data");
  const config = join(dir, "config.yaml");
  writeFileSync(config, [`data_dir: ${data}`, "user: analyst", "roots:", `  - { path: ${root}, trusted: true }`, ""].join("\n"));
  const errors: string[] = [];
  const running = await serve(["--config", config, "--port", "0", "--sample-fixture", String(fixturePort)], { log: () => {}, error: (l) => errors.push(l) });
  let stopped = false;
  const stop = async (): Promise<void> => { if (!stopped) { stopped = true; await running.stop(); } };
  closers.push(stop);
  const browser: Browser = await launch(path);
  closers.push(() => browser.close());

  const tab = await browser.tab(`${running.origin}/`);
  const ready = (selector: string): Promise<void> => tab.waitFor(`document.querySelector(${JSON.stringify(selector)}) !== null`);
  const text = (selector: string): Promise<string> => tab.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`);
  const typeInto = async (selector: string, what: string): Promise<void> => {
    await tab.click(selector);
    await tab.evaluate(`document.querySelector(${JSON.stringify(selector)}).select?.()`);
    await tab.type(what);
  };
  const choose = (selector: string, value: string): Promise<unknown> =>
    tab.evaluate(`(() => { const s = document.querySelector(${JSON.stringify(selector)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  const inLane = (lane: string, card: string): string => `document.querySelector('[data-lane=${lane}] [data-card=${card}]') !== null`;

  // 1. Home -> Investigate -> + New investigation, the form, Create and frame the run
  await tab.waitFor(`document.querySelector("[data-mode=investigate]") !== null`);
  await tab.click("[data-mode=investigate]");
  await tab.click("[aria-label='New investigation']");
  await ready("[aria-label=Title]");
  await typeInto("[aria-label=Title]", "Traffic to 198.51.100.77");
  await typeInto("[aria-label='What was asked']", "Who is behind the traffic to 198.51.100.77?");
  await typeInto("[aria-label=Why]", "an unknown address was contacted overnight");
  await choose("[aria-label='Starting type 1']", SAMPLE_START.type);
  await typeInto("[aria-label='Starting value 1']", SAMPLE_START.value);
  await typeInto("[aria-label='Window from']", SAMPLE_WINDOW.from ?? "");
  await typeInto("[aria-label='Window to']", SAMPLE_WINDOW.to ?? "");
  await choose("[aria-label=Objective]", "sample-objective");
  await choose("[aria-label=Marking]", "TLP:GREEN");
  await tab.click(".primary");
  await tab.waitFor(`(document.querySelector(".stage-button[data-stage=plan]")?.textContent ?? "").includes("◌ waiting")`);

  // 2. Shift+Enter opens Steps; Estimate s3; a budget of 1; Accept
  await tab.press("Enter", { shift: true });
  await ready(".lens-steps .plan");
  await tab.click("[data-step=s3] [data-action=estimate]");
  await ready("[data-step=s3] .estimate");
  await tab.click("[aria-label='Budget for s3, in lookups']");
  await tab.type("1");
  await tab.waitFor(`!document.querySelector("[data-action=accept_plan]").disabled`);
  expect(await text("[data-action=accept_plan]")).toBe("Accept: run 3 steps");
  await tab.click("[data-action=accept_plan]");
  await tab.waitFor(`(document.querySelector(".stage-button[data-stage=publish]")?.textContent ?? "").includes("◌ waiting")`);

  // 4. a real drag of a card onto the second lane
  await tab.evaluate(`(() => { window.__animations = 0; const run = Element.prototype.animate; Element.prototype.animate = function (...a) { window.__animations++; return run.apply(this, a); }; window.__marker = "first page"; })()`);
  await ready("[data-area=incoming] [data-card=c1]");
  await tab.drag("[data-area=incoming] [data-card=c1] .title", "[data-lane=l2]");
  await tab.waitFor(inLane("l2", "c1"));
  expect(await tab.evaluate<number>("window.__animations")).toBeGreaterThan(0);          // with motion on, cards slide

  // with reduced motion: a card's transition is 0s, nothing slides, and a keep still lands in the lane
  await tab.reducedMotion(true);
  expect(await tab.evaluate<string>(`getComputedStyle(document.querySelector("[data-card=c3]")).transitionDuration`)).toBe("0s");
  const slid = await tab.evaluate<number>("window.__animations");
  await tab.click("[data-card=c3] .title");                    // a click opens it and focuses it
  await tab.press(" ");
  await tab.waitFor(inLane("l1", "c3"));
  expect(await tab.evaluate<number>("window.__animations")).toBe(slid);
  await tab.reducedMotion(false);

  // the focus ring after Tab
  await tab.evaluate(`document.activeElement.blur()`);
  await tab.press("Tab");
  expect(await tab.evaluate<string>(`getComputedStyle(document.activeElement).outlineStyle`)).not.toBe("none");

  // the stream is live: another tab, on the same case, pins a card; the first tab shows it without a reload
  const second = await browser.tab(`${running.origin}/#/case/CASE-1`);
  await second.waitFor(`document.querySelector("[data-area=incoming] [data-card=c4]") !== null`);
  await second.click("[data-card=c4] .title");
  await second.press("p");
  await tab.waitFor(`[...document.querySelectorAll("[data-card=c4] .tag")].some((t) => t.textContent === "pinned")`);
  expect(await tab.evaluate<string>("window.__marker")).toBe("first page");

  // 8. R opens Narrative; Shift+Enter reaches Approve, which publishes
  await tab.evaluate(`document.activeElement.blur()`);
  await tab.press("r");
  await ready(".review .check-row");
  expect(await tab.evaluate<number>(`document.querySelectorAll(".review .check-row").length`)).toBe(11);
  expect(await tab.evaluate<boolean>(`[...document.querySelectorAll(".review .check-row")].every((r) => r.textContent.startsWith("✓ "))`)).toBe(true);
  await tab.press("Enter", { shift: true });
  await tab.waitFor(`document.activeElement?.dataset?.action === "approve"`);
  expect(await tab.evaluate<string>("document.activeElement.textContent")).toMatch(/^Approve: publish draft \d+$/);
  await tab.click(".lens-dock [data-action=approve]");
  await tab.waitFor(`(document.querySelector(".lens .draft-head")?.textContent ?? "").includes("Published as product 1")`);

  // 12. custody reads intact
  await tab.waitFor(`/^chain intact · \\d+ entries$/.test(document.querySelector(".custody")?.textContent ?? "")`);

  // what the page is, in the browser that enforces it
  expect(await tab.evaluate<number>(`document.querySelectorAll("script:not([src]), style, [style], [onclick]").length`)).toBe(0);
  expect(tab.requests().filter((u) => !u.startsWith(running.origin))).toEqual([]);
  expect(second.requests().filter((u) => !u.startsWith(running.origin))).toEqual([]);
  expect(tab.problems()).toEqual([]);
  expect(second.problems()).toEqual([]);
  expect(errors).toEqual([]);
  // trusted types are enforced: this probe is the one violation the page is allowed to report, because it is the probe
  expect(await tab.evaluate<string>(`(() => { try { document.body.innerHTML = "<b>x</b>"; return "set"; } catch (e) { return e.name; } })()`)).toBe("TypeError");
  expect(tab.problems()).toEqual(["log: This document requires 'TrustedHTML' assignment. The action has been blocked."]);

  // the record verifies, published folder included
  await browser.close();
  closers.pop();
  await stop();
  const verified = verifyCase(join(data, "cases", "CASE-1"));
  expect(verified.ok).toBe(true);
  expect(verified.published.bundles.map((b) => b.state)).toEqual(["ok"]);
  const cli = Bun.spawnSync(["bun", "run", join(REPO, "src", "cli", "verify.ts"), join(data, "cases", "CASE-1")], { cwd: REPO, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  expect(cli.exitCode).toBe(0);
}

if (chrome === null) {
  if (process.env.WORKBENCH_REQUIRE_BROWSER === "1") {
    test("the whole sample investigation in a browser", () => { throw new Error(NONE); });
  } else {
    console.log(NONE);
    test.skip("the whole sample investigation in a browser", () => {});
  }
} else {
  test("the whole sample investigation in a browser", async () => { await theRun(chrome); }, 120_000);
}
