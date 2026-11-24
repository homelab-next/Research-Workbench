import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProviders } from "../../src/agents/providers";
import { Registry } from "../../src/modules/registry";
import { Secrets } from "../../src/modules/secrets";

const SAMPLE = join(import.meta.dir, "..", "..", "sample");
const secrets = new Secrets({}, null);
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "prov-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const put = (root: string, name: string, text: string): void => {
  mkdirSync(join(dir, root), { recursive: true });
  writeFileSync(join(dir, root, name), text);
};
const model = (id: string, provider = "scripted"): string => `kind: model\nid: ${id}\ntitle: T\nprovider: ${provider}\nwhere: machine\n`;
const load = (...roots: [string, boolean][]) => Registry.load(roots.map(([r, trusted]) => ({ path: join(dir, r), trusted, credentials: [] })));

test("the sample root yields the scripted provider on this machine", () => {
  const registry = Registry.load([{ path: SAMPLE, trusted: true, credentials: [] }]);
  const { providers, problems } = loadProviders(registry, secrets);
  expect(problems).toEqual([]);
  expect(providers.get("scripted")!.where).toBe("machine");
  expect(providers.all().map((p) => p.id)).toEqual(["scripted"]);
});

test("a model manifest from an untrusted root is a problem, not a provider", () => {
  put("u", "m.yaml", model("scripted"));
  const registry = load(["u", false]);
  const { providers, problems } = loadProviders(registry, secrets);
  expect(providers.get("scripted")).toBeNull();
  expect([...registry.problems, ...problems].some((p) => /trusted root/.test(p.error))).toBe(true);
});

test("an untrusted root cannot displace a trusted model by taking its id", () => {
  put("t", "m.yaml", model("scripted"));
  put("u", "m.yaml", model("scripted"));
  const registry = load(["t", true], ["u", false]);
  expect(registry.problems.map((p) => p.path)).toEqual([join(dir, "u", "m.yaml")]);
  expect(registry.problems[0]!.error).toMatch(/trusted root/);
  const { providers } = loadProviders(registry, secrets);
  expect(providers.get("scripted")).not.toBeNull();
});

test("an unknown provider kind and a duplicate id are problems", () => {
  put("t", "a.yaml", model("odd", "mystery"));
  put("t", "b.yaml", model("dup"));
  put("t", "c.yaml", model("dup"));
  put("t", "d.yaml", model("loc", "local"));
  const { providers, problems } = loadProviders(load(["t", true]), secrets);
  expect(providers.all().map((p) => p.id)).toEqual(["dup"]);
  const reg = load(["t", true]);
  const all = [...reg.problems, ...problems].map((p) => p.error).join("\n");
  expect(all).toMatch(/unknown provider "mystery"/);
  expect(all).toMatch(/duplicate model id "dup"/);
  expect(all).toMatch(/local provider is not built yet/);
});

test("a script with a turn that has no actor is left out with a problem", async () => {
  put("t", "m.yaml", model("scripted"));
  put("t", "good.yaml", "kind: script\nid: good\ntitle: G\nturns:\n  - actor: planner\n    reply: { content: hi }\n");
  put("t", "bad.yaml", "kind: script\nid: bad\ntitle: B\nturns:\n  - reply: { content: hi }\n");
  const { providers, problems } = loadProviders(load(["t", true]), secrets);
  expect(problems).toHaveLength(1);
  expect(problems[0]!.error).toMatch(/missing actor/);
  expect((await providers.get("scripted")!.models()).map((m) => m.id)).toEqual(["good"]);
});
