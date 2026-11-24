import { afterEach, beforeEach, expect, test } from "bun:test";
import { execTool, parseCall, TOOL_NAMES, TOOLS, TOOL_VIEW_CHARS, ToolError, viewText } from "../../src/agents/tools";
import type { ToolResult } from "../../src/agents/tools";
import { fixture } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
beforeEach(() => { f = fixture(false); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});

test("every tool requires why and refuses unknown arguments", () => {
  for (const name of TOOL_NAMES) {
    expect(TOOLS[name].parameters.required).toContain("why");
    expect(TOOLS[name].parameters.additionalProperties).toBe(false);
  }
});

test("arguments that are not JSON are a parsed error that keeps the text", () => {
  const p = parseCall(["run_pivot"], "run_pivot", '{"pivot": "a", "value": "x');
  expect(p.error).toBe("the arguments were not valid JSON");
  expect(p.args).toEqual({ _raw: '{"pivot": "a", "value": "x' });
  expect(parseCall(["run_pivot"], "run_pivot", "x".repeat(5000)).args).toEqual({ _raw: "x".repeat(2000) });
});

test("an unknown tool, a tool the stage lacks, a missing why and a budget argument are each an error", () => {
  expect(parseCall(["list_cards"], "nope", "{}").error).toBe("unknown tool: nope");
  expect(parseCall(["list_cards"], "list_sources", '{"why":"x"}').error).toBe("this stage may not use list_sources");
  const noWhy = parseCall(["list_sources"], "list_sources", "{}");
  expect(noWhy.error).toStartWith("invalid arguments: ");
  expect(noWhy.error).toContain("why");
  expect(noWhy.why).toBe("");
  const budget = parseCall(["run_pivot"], "run_pivot", '{"why":"w","pivot":"p","value":"v","budget":9}');
  expect(budget.error).toContain("invalid arguments: budget unexpected property");
  expect(budget.why).toBe("w");
  expect(parseCall(["list_sources"], "list_sources", '{"why":"w"}').error).toBeNull();
  expect(parseCall(["list_sources"], "list_sources", "[]").error).toStartWith("invalid arguments: ");
});

test("a parsed error runs nothing and is a result the model can read", async () => {
  const head = f.s.head().seq;
  const r = await f.call("run_pivot", { why: "w", pivot: "address_to_asset", value: "x", budget: 5 });
  expect(r.ok).toBe(false);
  expect(r.summary).toContain("budget");
  expect(r.view).toEqual({ error: r.summary });
  expect(f.s.head().seq).toBe(head);
  expect((await f.call("list_sources", { why: "w" }, ["list_cards"])).summary).toBe("this stage may not use list_sources");
});

test("a tool that throws is a failed result, not a crash", async () => {
  const r = await f.call("describe_source", { why: "w", source: "nope" });
  expect(r).toEqual({ ok: false, summary: "unknown source: nope", view: { error: "unknown source: nope" }, marking: null });
  const boom = parseCall(["list_sources"], "list_sources", '{"why":"w"}');
  boom.tool = { ...TOOLS.list_sources, call: async () => { throw new TypeError("odd\nsecond line"); } };
  expect((await execTool(f.ctx, boom)).summary).toBe("odd");
  boom.tool = { ...TOOLS.list_sources, call: async () => { throw new ToolError("plain"); } };
  expect((await execTool(f.ctx, boom)).summary).toBe("plain");
});

test("list_sources and describe_source never show where a source is or how to sign in", async () => {
  const listed = await f.call("list_sources", { why: "w" });
  const described = await Promise.all(["reputation", "flows", "assets"].map((source) => f.call("describe_source", { why: "w", source })));
  const text = JSON.stringify([listed.view, ...described.map((d) => d.view)]);
  for (const key of ['"location"', '"credential"', '"user"', '"root"', '"dir"', "127.0.0.1"]) expect(text).not.toContain(key);
  const sources = (listed.view as { sources: { id: string; free: boolean; adhoc: boolean }[] }).sources;
  expect(sources.map((s) => s.id).sort()).toEqual(["assets", "dns-logs", "flows", "leases", "reputation", "signins"]);
  expect(sources.find((s) => s.id === "reputation")!.free).toBe(false);
  const flows = described[1]!.view as { tables: { name: string }[]; pivots: { id: string; free: boolean }[]; limits: { max_rows: number } };
  expect(flows.tables.map((t) => t.name)).toEqual(["flows"]);
  expect(flows.pivots.map((p) => p.id)).toEqual(["address_to_internal_peers"]);
  expect(flows.limits.max_rows).toBe(200);
  expect(listed.marking).toBeNull();
});

test("find_routes returns the seeker's routes and writes nothing", async () => {
  const head = f.s.head().seq;
  const r = await f.call("find_routes", { why: "w", have: [{ type: "address", value: "198.51.100.77" }], want: "asset" });
  const routes = (r.view as { routes: { weight: number; hops: { pivot: string }[] }[] }).routes;
  expect(routes.length).toBeGreaterThan(0);
  expect(routes[0]!.hops.map((h) => h.pivot)).toEqual(["address_to_asset"]);
  expect(JSON.stringify(routes)).toEqual(JSON.stringify(f.ctx.seeker.routes(["address"], "asset", f.ctx.limits).map((x) => ({ weight: x.weight, hops: x.hops }))));
  expect(f.s.head().seq).toBe(head);
});

test("a view over the size limit is cut and says so", () => {
  const rows = Array.from({ length: 400 }, (_, i) => [i, "x".repeat(50)]);
  const result: ToolResult = { ok: true, summary: "s", view: { status: "done", columns: ["a", "b"], data: rows }, marking: null };
  const text = viewText(result);
  expect(text.length).toBeLessThanOrEqual(TOOL_VIEW_CHARS);
  const view = JSON.parse(text) as { truncated: boolean; status: string; columns: string[]; data: unknown[] };
  expect(view.truncated).toBe(true);
  expect(view.status).toBe("done");
  expect(view.columns).toEqual(["a", "b"]);
  expect(view.data.length).toBeGreaterThan(0);
  expect(view.data.length).toBeLessThan(400);
  const small: ToolResult = { ok: true, summary: "s", view: { a: 1 }, marking: null };
  expect(viewText(small)).toBe('{"a":1}');
  const record = { ok: true, summary: "s", view: { text: "y".repeat(7000), rows: [] }, marking: null } satisfies ToolResult;
  expect(JSON.parse(viewText(record)).error).toContain("too large");
});
