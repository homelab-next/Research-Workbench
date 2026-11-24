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
  const { providers, problems } = loadProviders(load(["t", true]), secrets);
  expect(providers.all().map((p) => p.id)).toEqual(["dup"]);
  const reg = load(["t", true]);
  const all = [...reg.problems, ...problems].map((p) => p.error).join("\n");
  expect(all).toMatch(/unknown provider "mystery"/);
  expect(all).toMatch(/duplicate model id "dup"/);
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

const local = (over: Record<string, string>): string => {
  const f = { kind: "model", id: "lm", title: "L", provider: "local", where: "machine", base_url: "http://127.0.0.1:1234/v1", credential: "null", context: "null", efforts: "[]", timeout_ms: "1000", ...over };
  return Object.entries(f).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n";
};
const loadLocal = (text: string, credentials: string[] = [], env: Record<string, string> = {}) => {
  put("t", "lm.yaml", text);
  const registry = Registry.load([{ path: join(dir, "t"), trusted: true, credentials }]);
  const out = loadProviders(registry, new Secrets(env, null));
  return { ...out, problems: [...registry.problems, ...out.problems] };
};

test("a local model loads with the manifest's settings", () => {
  const { providers, problems } = loadLocal(local({}));
  expect(problems).toEqual([]);
  expect(providers.get("lm")!.kind).toBe("local");
  expect(providers.get("lm")!.where).toBe("machine");
});

test("a local model on another host may not say it is on this machine", () => {
  const { providers, problems } = loadLocal(local({ base_url: "https://models.example.net/v1" }));
  expect(providers.get("lm")).toBeNull();
  expect(problems.map((p) => p.error).join()).toMatch(/machine/);
  expect(loadLocal(local({ base_url: "https://models.example.net/v1", where: "network" })).problems).toEqual([]);
});

test("where: machine needs a numeric loopback address", () => {
  expect(loadLocal(local({ base_url: "http://localhost:1234/v1" })).problems[0]!.error).toContain("write 127.0.0.1 in place of localhost");
  expect(loadLocal(local({ base_url: "http://127.0.0.1:1234/v1" })).problems).toEqual([]);
  expect(loadLocal(local({ base_url: "http://[::1]:1234/v1" })).problems).toEqual([]);
});

test("plain http is accepted for loopback only", () => {
  expect(loadLocal(local({ base_url: "http://127.0.0.1:1234/v1" })).problems).toEqual([]);
  const bad = loadLocal(local({ base_url: "http://models.example.net/v1", where: "network" }));
  expect(bad.providers.get("lm")).toBeNull();
  expect(bad.problems.map((p) => p.error).join()).toMatch(/https/);
});

test("a credential the root was not granted is a problem", () => {
  const bad = loadLocal(local({ credential: "LM_KEY" }), [], { LM_KEY: "some-long-secret" });
  expect(bad.providers.get("lm")).toBeNull();
  expect(bad.problems.map((p) => p.error).join()).toMatch(/credential/);
  const good = loadLocal(local({ credential: "LM_KEY" }), ["LM_KEY"], { LM_KEY: "some-long-secret" });
  expect(good.problems).toEqual([]);
  expect(good.providers.get("lm")).not.toBeNull();
});

test("bad settings are problems", () => {
  expect(loadLocal(local({ timeout_ms: "0" })).providers.get("lm")).toBeNull();
  expect(loadLocal(local({ base_url: "null" })).providers.get("lm")).toBeNull();
  expect(loadLocal(local({ efforts: "[1]" })).providers.get("lm")).toBeNull();
});

/** A registry stand-in that holds manifests the real one would not pass on (it refuses duplicates and untrusted roots itself). */
const fake = (models: Record<string, unknown>[]): Registry => ({
  all: (kind: string) => (kind === "model" ? models.map((body, i) => ({ kind: "model", id: String(body.id ?? `m${i}`), title: "t", hash: "h", root: "/r", path: `/r/m${i}.yaml`, dir: "/r", body, text: null })) : []),
  rootOf: () => ({ path: "/r", trusted: true, credentials: [] }),
}) as unknown as Registry;

test("loadProviders itself refuses a scripted model that is not on this machine, and a body that fails the schema", () => {
  const { providers, problems } = loadProviders(fake([
    { kind: "model", id: "far", provider: "scripted", where: "hosted" },
    { kind: "model", id: "nameless", where: "machine" },
  ]), secrets);
  expect(providers.all()).toEqual([]);
  expect(problems.map((p) => p.error)).toEqual([expect.stringMatching(/where must be machine/), expect.stringMatching(/provider/)]);
});

test("a timeout above ten minutes is a problem", () => {
  expect(loadLocal(local({ timeout_ms: "600000" })).problems).toEqual([]);
  expect(loadLocal(local({ timeout_ms: "600001" })).providers.get("lm")).toBeNull();
  expect(loadLocal(local({ timeout_ms: "3000000000" })).providers.get("lm")).toBeNull();
});

test("lookalike hosts may not say they are on this machine", () => {
  for (const host of ["127.0.0.1.example.org", "localhost.", "localhost.example.org"]) {
    const { providers, problems } = loadLocal(local({ base_url: `https://${host}/v1` }));
    expect(providers.get("lm")).toBeNull();
    expect(problems.map((p) => p.error).join()).toMatch(/machine/);
  }
});

test("max_output_tokens is a positive integer, 8192 when the manifest gives none", () => {
  const limit = (text: string): unknown => {
    const p = loadLocal(text).providers.get("lm");
    return p === null ? null : (JSON.parse(new TextDecoder().decode(p.body({ model: "m", effort: null, messages: [], tools: [], key: "a", ordinal: 0 }))) as { max_tokens: unknown }).max_tokens;
  };
  expect(limit(local({}))).toBe(8192);
  expect(limit(local({ max_output_tokens: "2048" }))).toBe(2048);
  expect(limit(local({ max_output_tokens: "null" }))).toBe(8192);
  for (const bad of ["0", "-1", "1.5", "\"many\""]) {
    const out = loadLocal(local({ max_output_tokens: bad }));
    expect(out.providers.get("lm")).toBeNull();
    expect(out.problems.map((p) => p.error).join()).toContain("max_output_tokens");
  }
});

test("structured_output is true or false, true when the manifest gives none", () => {
  const flag = (text: string): unknown => (loadLocal(text).providers.get("lm") as { structured_output?: boolean } | null)?.structured_output ?? null;
  expect(flag(local({}))).toBe(true);
  expect(flag(local({ structured_output: "false" }))).toBe(false);
  expect(flag(local({ structured_output: "true" }))).toBe(true);
  const out = loadLocal(local({ structured_output: "\"yes\"" }));
  expect(out.providers.get("lm")).toBeNull();
  expect(out.problems.map((p) => p.error).join()).toContain("structured_output");
});
