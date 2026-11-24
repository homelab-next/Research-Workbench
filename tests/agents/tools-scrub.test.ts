import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { scrub } from "../../src/agents/tools/kit";
import { packPart } from "../../src/agents/context";
import type { CardState } from "../../src/core/state/types";
import { card } from "../helpers/entries";
import { fixture } from "../helpers/tools-fixture";
import type { Fixture } from "../helpers/tools-fixture";

let f: Fixture;
beforeEach(() => { f = fixture(true); });
afterEach(() => {
  expect(f.s.state.skipped).toEqual([]);
  f.close();
});

const clean = (text: string): string => scrub(f.sample.registry, text);

test("a path is hidden whatever its case, encoding, dots, doubled slashes or separators", () => {
  const abs = join(f.sample.root, "data", "flows.sqlite");
  const variants = [
    `unable to open ${abs}`, `unable to open ${abs.toUpperCase()}`, `GET ${encodeURIComponent(abs)} failed`, `GET ${encodeURI(abs)} failed`,
    `no such file: ${f.sample.root}/./data/flows.sqlite`, `no such file: ${f.sample.root}//data//flows.sqlite`,
    `no such file: ${abs.replaceAll("/", "\\")}`, `open file://${abs}`, `in ${f.sample.root}`, `no such file: ../data/flows.sqlite`,
    `no such file: ../DATA/FLOWS.SQLITE`, `database flows.sqlite is locked`, `database FLOWS.sqlite is locked`,
  ];
  for (const v of variants) {
    const out = clean(v);
    expect(out.toLowerCase()).not.toContain("flows.sqlite");
    expect(out.toLowerCase()).not.toContain(f.sample.root.toLowerCase().slice(1));
    expect(out).toContain("[hidden]");
  }
});

test("a user, a credential name and a host are hidden in any case or encoding", () => {
  const s = f.sample.registry.source("flows")!;
  s.user = "Svc-User";
  s.credential = "LAKE_TOKEN_NAME";
  for (const v of ["as svc-user ok", "as SVC-USER ok", "as Svc%2DUser ok", "env lake_token_name", "env LAKE_Token_Name", `as ${encodeURIComponent("Svc-User")}`]) {
    expect(clean(v)).not.toMatch(/svc.?user|lake.token.name/i);
  }
  const h = f.sample.registry.source("reputation")!;
  h.location = "http://Example-Host.internal:4801/Base/Path";
  for (const v of [
    "fetch http://example-host.internal:4801/Base/Path/v1 failed", "connect ECONNREFUSED example-host.internal:4801", "getaddrinfo ENOTFOUND example-host.internal",
    "getaddrinfo ENOTFOUND EXAMPLE-HOST.internal", `at ${encodeURIComponent(h.location)}`, "root /Base/Path/v1",
  ]) {
    expect(clean(v).toLowerCase()).not.toMatch(/example-host|base.?path/);
  }
});

test("any url and any absolute path is hidden, even one the registry does not know", () => {
  expect(clean("another origin: https://other-host.example:9443/x/y?z=1 refused")).toBe("another origin: [hidden] refused");
  expect(clean("cannot read /srv/secret/dir/file.csv now")).toBe("cannot read [hidden] now");
  expect(clean("cannot read (/srv/secret/dir/file.csv)")).not.toContain("secret");
  expect(clean("cannot read C:\\Users\\someone\\lake\\x.db")).not.toContain("someone");
  expect(clean("no rows · proven negative")).toBe("no rows · proven negative");
  expect(clean("window 2026-11-17T00:00:00.000Z to 2026-11-24 and/or 1/2")).toBe("window 2026-11-17T00:00:00.000Z to 2026-11-24 and/or 1/2");
  // a query text keeps its shape: only the registry's own secrets come out of it
  expect(scrub(f.sample.registry, "GET /v1/reputation/198.51.100.77", { backstop: false })).toBe("GET /v1/reputation/198.51.100.77");
});

test("a partial result's detail is scrubbed in the result, the card, list_cards and read_card", async () => {
  let n = 0;
  let port = 0;
  const srv = Bun.serve({
    port: 0, hostname: "127.0.0.1",
    fetch: () => {
      n++;
      return n === 1
        ? Response.json({ columns: [{ name: "asset", type: "varchar" }], data: [["a1"]], nextUri: `http://localhost:${port}/next` })
        : Response.json({ error: { message: `lost link to http://localhost:${port}/lakebase as svc-ana-user via HOST lake-int.corp.example:8443` } });
    },
  });
  port = srv.port!;
  try {
    const src = f.sample.registry.source("assets")!;
    Object.assign(src, { connector: "trino", location: `http://localhost:${port}/lakebase`, user: "svc-ana-user", hash: `x${src.hash}` });
    const r = await f.call("run_step", { why: "w", step: "s1" });
    const l = await f.call("list_cards", { why: "w" });
    const rc = await f.call("read_card", { why: "w", card: "c1" });
    expect(f.s.state.cards.c1!.coverage).toMatchObject({ kind: "partial", reason: "source_error" });
    expect(JSON.stringify(f.s.state.cards.c1)).toContain("svc-ana-user");
    for (const out of [r, l, rc]) {
      const text = JSON.stringify([out.summary, out.view]);
      expect(text).toContain("partial");
      for (const bad of ["svc-ana-user", "lakebase", "localhost"]) expect(text).not.toContain(bad);
    }
  } finally {
    srv.stop(true);
  }
});

test("a card put in a pack has its title, body and coverage detail scrubbed as the tools scrub them", () => {
  const s = f.sample.registry.source("flows")!;
  s.user = "Svc-User";
  const h = f.sample.registry.source("reputation")!;
  h.location = "http://Example-Host.internal:4801/Base/Path";
  const abs = join(f.sample.root, "data", "flows.sqlite");
  const c = {
    ...card("c9", { title: `as Svc-User on ${abs}`, body: "fetch http://example-host.internal:4801/Base/Path/v1 gave 3 rows", source: "flows", coverage: { kind: "partial", reason: "source_error", detail: "connect ECONNREFUSED example-host.internal:4801 as svc-user" } }),
    place: "incoming", created_seq: 1, validated: null,
  } as unknown as CardState;
  const p = packPart({ card: c, registry: f.sample.registry });
  for (const text of [p.text, p.title]) {
    expect(text.toLowerCase()).not.toMatch(/svc.?user|example-host|flows\.sqlite|base.?path/);
  }
  expect(p.text).toContain("[hidden]");
  expect(p.text).toContain("partial (source_error: ");
  expect(p.marking).toBe(c.marking);
});
