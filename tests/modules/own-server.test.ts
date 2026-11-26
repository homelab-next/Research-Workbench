import { afterEach, expect, test } from "bun:test";
import { LocalProvider } from "../../src/agents/providers/local";
import { Secrets } from "../../src/modules/secrets";
import { startModelStandin } from "../helpers/model-standin";

// The connectors' own-server tests moved to pivot with the connectors; the model provider's stays here.
const OWN = "the workbench's own server";
const stops: (() => void)[] = [];
afterEach(() => { while (stops.length > 0) stops.pop()!(); });

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
