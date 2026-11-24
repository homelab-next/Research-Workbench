import { afterEach, expect, test } from "bun:test";
import { LocalProvider } from "../../src/agents/providers/local";
import { ConnectorError, makeConnector } from "../../src/modules/connectors";
import { refuseOwnServer } from "../../src/modules/connectors/shared";
import type { QueryRequest } from "../../src/modules/connectors";
import type { SourceManifest } from "../../src/modules/manifests";
import { Observables } from "../../src/modules/observables";
import { Secrets } from "../../src/modules/secrets";
import { startModelStandin } from "../helpers/model-standin";
import { startTrino } from "../helpers/trino-standin";
import type { TrinoStandin } from "../helpers/trino-standin";

const OWN = "the workbench's own server";
const stops: (() => void)[] = [];
afterEach(() => { while (stops.length > 0) stops.pop()!(); });

test("the shared check: the same host:port under any loopback name, https or http, is the server; another port is not", () => {
  expect(() => refuseOwnServer("http://127.0.0.1:4747", ["127.0.0.1:4747"])).toThrow(OWN);
  expect(() => refuseOwnServer("http://localhost:4747/x", ["127.0.0.1:4747"])).toThrow(OWN);
  expect(() => refuseOwnServer("http://[::1]:4747", ["127.0.0.1:4747"])).toThrow(OWN);
  expect(() => refuseOwnServer("http://127.0.0.1:4748", ["127.0.0.1:4747"])).not.toThrow();
  expect(() => refuseOwnServer("https://lake.example.com", ["127.0.0.1:4747"])).not.toThrow();
  expect(() => refuseOwnServer("http://127.0.0.1:4747", [])).not.toThrow();
  expect(() => refuseOwnServer("not a url", ["127.0.0.1:4747"])).not.toThrow();
});

function source(location: string): SourceManifest {
  return {
    id: "lake", title: "Lake", hash: "h1", dir: "/nonexistent", root: "/nonexistent", connector: "trino", location, credential: null, user: "workbench",
    tls_verify: true, marking: "TLP:AMBER", where: "hosted", confirmed: true, adhoc: false, cost: { weight: 0, unit: "" },
    limits: { max_rows: 5, timeout_ms: 500 }, quality: "", quality_notes: [],
    tables: [{ name: "iceberg.s.events", time_column: "ts", guarded: true, large_columns: [], file: null, format: null, columns: [] }], endpoints: [],
  };
}
const req: QueryRequest = {
  text: "select a from iceberg.s.events where ts >= {window.from} and ts < {window.to} limit 5", bound: {},
  window: { from: "2026-11-20T00:00:00.000Z", to: "2026-11-23T00:00:00.000Z" }, max_rows: 5, timeout_ms: 500, budget: null,
};

test("the trino connector refuses a source that points at the server, at construction and before each request", async () => {
  const t: TrinoStandin = startTrino();
  stops.push(() => t.stop());
  const own = new URL(t.url).host;
  const ctx = (hosts: () => readonly string[]) => ({ secrets: new Secrets({}, null), observables: new Observables([]), refuse_hosts: hosts });
  expect(() => makeConnector(source(t.url), ctx(() => [own]))).toThrow(OWN);
  expect(() => makeConnector(source(t.url), ctx(() => ["127.0.0.1:1"]))).not.toThrow();
  let hosts: string[] = [];
  const c = makeConnector(source(t.url), ctx(() => hosts));
  hosts = [own];
  const before = t.statements.length;
  const err = await c.run(req).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectorError);
  expect((err as Error).message).toBe(`this source points at ${OWN}`);
  expect(t.statements.length).toBe(before);
});

test("the local model provider refuses a base_url that points at the server, at construction and before each request", async () => {
  const m = startModelStandin({ replies: [{ json: { choices: [{ finish_reason: "stop", message: { content: "ok" } }] } }] });
  stops.push(m.stop);
  const own = new URL(m.url).host;
  const make = (hosts: () => readonly string[]) => new LocalProvider({
    id: "lm", base_url: m.url, where: "machine", credential: null, secrets: new Secrets({}, null), context: null, efforts: [], timeout_ms: 2000, refuse_hosts: hosts,
  });
  expect(() => make(() => [own])).toThrow(OWN);
  expect(() => make(() => ["127.0.0.1:1"])).not.toThrow();
  let hosts: string[] = [];
  const p = make(() => hosts);
  hosts = [own];
  const seen = m.requests.length;
  const r = await p.turn({ model: "m", effort: null, key: "a", ordinal: 0, messages: [{ role: "user", content: "hi" }], tools: [] });
  expect(r.kind).toBe("error");
  expect(r.kind === "error" ? r.message : "").toContain(OWN);
  await expect(p.models()).rejects.toThrow(OWN);
  expect(m.requests.length).toBe(seen);
});
