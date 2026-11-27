import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Json } from "../../src/core/canonical";
import { findChrome, launch } from "../helpers/chrome";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

// Task 18 in a real browser: Build with help on a loop's screen. A question sent with Enter; the builder's proposal drawn as a diff whose markup is
// text under the page's own policy; Accept writes that one file; a probe shows its query and runs only on Approve, its card's rows shown after.
const chrome = findChrome();
const NONE = "browser run skipped: no Chromium found (set WORKBENCH_CHROME)";
const closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (closers.length > 0) await closers.pop()!(); });

const SCRIPT = "builder-browser";
const MARKUP = "<img src=x onerror=\"document.title='owned'\">";
const QUERY = "SELECT name FROM sqlite_master WHERE type = 'table'";
const SKILL = `---\nkind: skill\nid: field-notes\ntitle: Field notes\n---\nRead the field notes first. ${MARKUP}\n`;
type Reply = { content?: string; tool_calls?: { tool: string; args: Record<string, Json> }[] };
const TURNS: Reply[] = [
  { tool_calls: [{ tool: "propose_change", args: { why: "the person asked for field notes", title: MARKUP, files: [{ path: "skills/field-notes.md", text: SKILL }] } }] },
  { content: "I have proposed a skill for you to accept." },
  { tool_calls: [{ tool: "request_probe", args: { why: "to see what tables it holds", kind: "query", source: "flows", text: QUERY } }] },
  { content: "I have asked for a probe; it waits for your approval." },
];

async function buildWithHelp(path: string): Promise<void> {
  const s: Served = await served({
    listen: true,
    before: (root) => writeFileSync(join(root, "scripts", `${SCRIPT}.yaml`), JSON.stringify({ kind: "script", id: SCRIPT, title: "Builder browser test", turns: TURNS.map((reply) => ({ actor: "builder", reply })) })),
  });
  closers.push(() => s.close());
  const browser = await launch(path);
  closers.push(() => browser.close());
  const tab = await browser.tab(`${s.origin}/#/loops/investigation`);
  const text = (selector: string): Promise<string> => tab.evaluate<string>(`(document.querySelector(${JSON.stringify(selector)})?.textContent ?? "")`);

  // New conversation makes a session about this loop at the least restrictive marking; the builder's model is the scripted one
  await tab.waitFor(`document.querySelector("[data-screen=loop] .builder-panel [data-action=new-builder]") !== null`);
  expect(await text("[data-screen=loop] .builder-panel h2")).toBe("Build with help");
  await tab.evaluate(`(() => { const m = document.querySelector(".builder-new [aria-label=Marking]"); m.value = "TLP:GREEN"; })()`);
  await tab.click("[data-action=new-builder]");
  await tab.waitFor(`document.querySelector(".builder-sessions [data-builder=BUILD-1]") !== null && !document.querySelector(".builder-open").hidden`);
  expect((await s.post("/api/builders/BUILD-1/model", { choice: { provider: "scripted", model: SCRIPT, effort: null } })).status).toBe(200);
  expect(s.wb.builder("BUILD-1").state.meta?.marking).toBe("TLP:GREEN");
  await tab.waitFor(`(document.querySelector(".builder-head .marking")?.textContent ?? "") === "TLP:GREEN"`);

  // a question goes on Enter; the proposal comes back as a diff, its markup drawn as text
  await tab.evaluate(`document.querySelector("[aria-label='Ask the builder']").focus()`);
  await tab.type("Add a skill for field notes");
  await tab.press("Enter");
  await tab.waitFor(`(document.querySelector(".builder-turns .answer-text")?.textContent ?? "") === "I have proposed a skill for you to accept."`, 20_000);
  await tab.waitFor(`document.querySelector(".builder-change .builder-file[data-file='0']") !== null`);
  expect(await text(".builder-turns .question")).toBe("Add a skill for field notes");
  expect(await text(".builder-change .change-title")).toBe(MARKUP);
  expect(await text(".builder-file .file-state")).toBe("new file");
  const lines = await tab.evaluate<string[]>(`[...document.querySelectorAll(".builder-file .diff-line")].map((l) => l.textContent)`);
  expect(lines).toContain(`+Read the field notes first. ${MARKUP}`);
  expect(lines.every((l) => l.startsWith("+"))).toBe(true);
  expect(await tab.evaluate<number>(`document.querySelectorAll(".builder-panel img").length`)).toBe(0);
  expect(await tab.evaluate<string>(`document.title`)).not.toBe("owned");
  const target = join(s.config.roots[0]!.path, "skills", "field-notes.md");
  expect(existsSync(target)).toBe(false);

  // Accept writes that one file, by the person
  await tab.click(".builder-file[data-file='0'] [data-action=accept]");
  await tab.waitFor(`(document.querySelector(".builder-file[data-file='0'] .file-decided")?.textContent ?? "") === "Accepted"`);
  expect(readFileSync(target, "utf8")).toBe(SKILL);
  expect(await tab.evaluate<number>(`document.querySelectorAll(".builder-file[data-file='0'] [data-action=accept]").length`)).toBe(0);

  // a probe: what would run and where; nothing runs until Approve
  await tab.evaluate(`document.querySelector("[aria-label='Ask the builder']").focus()`);
  await tab.type("What tables does flows hold?");
  await tab.press("Enter");
  await tab.waitFor(`document.querySelector(".builder-probe[data-probe=probe-1] [data-action=approve]") !== null`, 20_000);
  expect(await text(".builder-probe[data-probe=probe-1] .probe-query")).toBe(QUERY);
  expect(await text(".builder-probe[data-probe=probe-1] .probe-source")).toBe("on the source flows");
  expect(s.wb.builder("BUILD-1").entries().some((e) => e.type === "query.issued")).toBe(false);
  await tab.click(".builder-probe[data-probe=probe-1] [data-action=approve]");
  await tab.waitFor(`(document.querySelector(".builder-probe[data-probe=probe-1] .probe-outcome")?.textContent ?? "").startsWith("Approved: ran")`, 20_000);
  await tab.waitFor(`document.querySelectorAll(".builder-probe[data-probe=probe-1] .probe-card td").length > 0`);
  expect(s.wb.builder("BUILD-1").entries().filter((e) => e.type === "query.issued").map((e) => e.actor.kind)).toEqual(["human"]);

  // leaving the screen closes the stream: the page goes on without problems
  await tab.evaluate(`location.hash = "#/loops"`);
  await tab.waitFor(`location.hash === "#/loops" && document.querySelector("[data-screen=loops] .builder-panel") !== null`);
  expect(s.wb.builder("BUILD-1").state.skipped).toEqual([]);
  expect(tab.requests().filter((u) => !u.startsWith(s.origin))).toEqual([]);
  expect(tab.problems()).toEqual([]);
}

const NAME = "Build with help on a loop's screen: ask on Enter, a diff drawn as text, Accept writes one file, a probe runs on Approve and shows its rows";
if (chrome === null) {
  if (process.env.WORKBENCH_REQUIRE_BROWSER === "1") test(NAME, () => { throw new Error(NONE); });
  else test.skip(NAME, () => {});
} else {
  test(NAME, async () => { await buildWithHelp(chrome); }, 120_000);
}
