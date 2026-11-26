import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Ledger } from "../../src/core/ledger";
import { sha256Hex } from "../../src/core/hash";
import type { RootConfig } from "../../src/modules/config";
import { Registry, staysInside } from "../../src/modules/registry";
import { PATTERN_PROBE_LIMIT_MS, probePattern } from "../../src/modules/observables";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "rw-registry-"));
  dirs.push(d);
  return d;
};
const ledgers: Ledger[] = [];
afterEach(() => {
  for (const l of ledgers.splice(0)) l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function root(files: Record<string, string>, grant: { trusted?: boolean; credentials?: string[] } = {}): RootConfig {
  const dir = tmp();
  for (const [name, text] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return { path: dir, trusted: grant.trusted ?? true, credentials: grant.credentials ?? [] };
}
function chain(): Ledger {
  const l = Ledger.open(join(tmp(), "ledger.sqlite"), "CASE-1");
  ledgers.push(l);
  return l;
}

const SOURCE = `kind: source
id: dns-logs
title: DNS logs
connector: files
location: data
marking: "TLP:GREEN"
where: machine
tables:
  - name: dns
    file: dns.jsonl
    format: jsonl
    time_column: ts
    columns:
      - { name: ts, type: null }
      - { name: client, type: address }
      - { name: name, type: domain }
`;
const TYPES = `kind: types
types:
  - { id: address, title: Address, pattern: '^(?:\\d{1,3}\\.){3}\\d{1,3}$' }
  - { id: domain, title: Domain, pattern: '^(?=.{1,253}$)(?:[a-z0-9-]{1,63}\\.)+[a-z]{2,63}$' }
`;
const PIVOTS = `kind: pivots
pivots:
  - id: address_to_domains
    title: Domains resolved by an address
    from: address
    to: domain
    source: dns-logs
    query: "select name as domain from dns where client = {value}"
    needs_window: true
    weight: null
    empty_means: not-seen
    yields: { domain: domain }
`;
const GOOD = { "sources/dns-logs.yaml": SOURCE, "types.yaml": TYPES, "pivots.yaml": PIVOTS };
const sourceWith = (id: string, extra = ""): string => `kind: source\nid: ${id}\ntitle: T\nconnector: files\nlocation: data\nmarking: "TLP:GREEN"\nwhere: machine\n${extra}`;

test("loads sources, types and pivots, each with the hash of its file", () => {
  const rootA = root(GOOD);
  const r = Registry.load([rootA]);
  expect(r.problems).toEqual([]);
  expect(r.source("dns-logs")).toMatchObject({ connector: "files", marking: "TLP:GREEN", limits: { max_rows: 500, timeout_ms: 10000 }, adhoc: false });
  expect(r.source("dns-logs")!.hash).toBe(sha256Hex(readFileSync(join(rootA.path, "sources/dns-logs.yaml"))));
  expect(r.pivot("address_to_domains")).toMatchObject({ from: "address", to: "domain", source: "dns-logs", weight: null });
  expect(r.types().map(t => t.id)).toEqual(["address", "domain"]);
  expect(r.pivots()[0]!.hash).toBe(sha256Hex(readFileSync(join(rootA.path, "pivots.yaml"))));
  expect(r.source("dns-logs")).toMatchObject({ credential: null, user: null, tls_verify: true, confirmed: true, cost: { weight: 0, unit: "seconds" }, quality: "", quality_notes: [], endpoints: [] });
  expect(r.source("dns-logs")!.tables[0]).toMatchObject({ name: "dns", time_column: "ts", guarded: false, large_columns: [], format: "jsonl" });
  expect(r.source("nope")).toBeNull();
});

test("optional keys left bare (null) count as not given", () => {
  const r = Registry.load([root({ "s.yaml": sourceWith("s", "credential:\nquality:\nconfirmed:\nlimits:\n") })]);
  expect(r.problems).toEqual([]);
  expect(r.source("s")).toMatchObject({ credential: null, quality: "", confirmed: true, limits: { max_rows: 500, timeout_ms: 10000 } });
});

test("a source's dir is the folder its manifest is in", () => {
  const rootA = root(GOOD);
  expect(Registry.load([rootA]).source("dns-logs")!.dir).toBe(join(rootA.path, "sources"));
});

test("a markdown file with front matter loads, with its body as text", () => {
  const rootA = root({ "personas/analyst.md": "---\nkind: persona\nid: analyst\n---\nYou are careful.\n" });
  const r = Registry.load([rootA]);
  expect(r.problems).toEqual([]);
  const m = r.get("persona", "analyst")!;
  expect(m.text).toBe("You are careful.\n");
  expect(m).toMatchObject({ title: "analyst", root: rootA.path, path: join(rootA.path, "personas/analyst.md"), dir: join(rootA.path, "personas") });
});

test("a markdown file without front matter is a problem", () => {
  const r = Registry.load([root({ "a.md": "just text\n" })]);
  expect(r.problems).toHaveLength(1);
});

test("kinds this plan does not validate are loaded as they are", () => {
  const r = Registry.load([root({ "p.yaml": "kind: pipeline\nid: deep\ntitle: Deep\nstages: [a, b]\n", "q.yml": "kind: profile\nid: x\n" })]);
  expect(r.problems).toEqual([]);
  expect(r.get("pipeline", "deep")).toMatchObject({ title: "Deep", text: null, body: { stages: ["a", "b"] } });
  expect(r.get("profile", "x")!.title).toBe("x");
  expect(r.all("pipeline")).toHaveLength(1);
  expect(r.all("nothing")).toEqual([]);
});

test("files under a folder named data, and dotfiles, are skipped", () => {
  const r = Registry.load([root({ ...GOOD, "data/x.yaml": "kind: a\nid: x\n", "sources/data/y.yaml": "kind: a\nid: y\n", ".hidden.yaml": "kind: a\nid: z\n", ".git/w.yaml": "kind: a\nid: w\n", "notes.txt": "kind: a" })]);
  expect(r.problems).toEqual([]);
  expect(r.all("a")).toEqual([]);
});

test("symlinks are not followed", () => {
  const outside = root({ "o.yaml": "kind: a\nid: o\n" });
  const rootA = root(GOOD);
  symlinkSync(outside.path, join(rootA.path, "link"));
  symlinkSync(join(outside.path, "o.yaml"), join(rootA.path, "o.yaml"));
  expect(Registry.load([rootA]).all("a")).toEqual([]);
});

test("invalid YAML is a problem and the rest still load", () => {
  const rootA = root({ ...GOOD, "bad.yaml": "kind: [unclosed\n" });
  const r = Registry.load([rootA]);
  expect(r.problems).toHaveLength(1);
  expect(r.problems[0]).toMatchObject({ root: rootA.path, path: join(rootA.path, "bad.yaml") });
  expect(r.source("dns-logs")).not.toBeNull();
});

test("a manifest with no kind or no id is a problem", () => {
  const r = Registry.load([root({ "a.yaml": "id: x\n", "b.yaml": "kind: thing\n", "c.yaml": "kind: thing\nid: 5\n", "d.yaml": "- 1\n" })]);
  expect(r.problems.map(p => p.path.split("/").pop())).toEqual(["a.yaml", "b.yaml", "c.yaml", "d.yaml"]);
});

test("a source failing its schema is a problem naming the field", () => {
  const r = Registry.load([root({ "s.yaml": SOURCE.replace('"TLP:GREEN"', "SECRET") })]);
  expect(r.source("dns-logs")).toBeNull();
  expect(r.problems).toHaveLength(1);
  expect(r.problems[0]!.error).toContain("marking");
});

test("a source with a bad connector, a missing required key or an unknown key is a problem", () => {
  const r = Registry.load([root({
    "a.yaml": sourceWith("a").replace("files", "ftp"),
    "b.yaml": sourceWith("b").replace("location: data\n", ""),
    "c.yaml": sourceWith("c", "colour: red\n"),
  })]);
  expect(r.problems.map(p => p.error.match(/connector|location|colour/)?.[0])).toEqual(["connector", "location", "colour"]);
});

test("a pivot naming a missing source or type is a problem", () => {
  const noSource = Registry.load([root({ "types.yaml": TYPES, "pivots.yaml": PIVOTS })]);
  expect(noSource.pivot("address_to_domains")).toBeNull();
  expect(noSource.problems).toHaveLength(1);
  expect(noSource.problems[0]!.error).toContain("dns-logs");
  const noType = Registry.load([root({ "sources/s.yaml": SOURCE, "pivots.yaml": PIVOTS, "types.yaml": TYPES.replace("id: domain", "id: other") })]);
  expect(noType.pivot("address_to_domains")).toBeNull();
  expect(noType.problems.some(p => p.error.includes("domain"))).toBe(true);
});

test("a column typed with a missing observable type is a problem", () => {
  const r = Registry.load([root({ "sources/s.yaml": SOURCE, "types.yaml": TYPES.replace("id: domain", "id: other") })]);
  expect(r.source("dns-logs")).toBeNull();
  expect(r.problems).toHaveLength(1);
  expect(r.problems[0]!.error).toContain("domain");
});

test("a duplicate id in one root keeps the first and reports the second; in two roots neither loads", () => {
  const a = root({ "s.yaml": sourceWith("dup").replace("title: T", "title: First") });
  const b = root({ "s.yaml": sourceWith("dup").replace("title: T", "title: Second") });
  const r = Registry.load([a, b]);
  expect(r.source("dup")).toBeNull();
  expect(r.problems.map((p) => p.path).sort()).toEqual([join(a.path, "s.yaml"), join(b.path, "s.yaml")].sort());
  const within = Registry.load([root({ "a.yaml": "kind: k\nid: x\n", "b.yaml": "kind: k\nid: x\n" })]);
  expect(within.all("k")).toHaveLength(1);
  expect(within.problems).toHaveLength(1);
  expect(within.problems[0]!.path.endsWith("b.yaml")).toBe(true);
  const types = Registry.load([root({ "t.yaml": TYPES + "  - { id: domain, pattern: x }\n" })]);
  expect(types.types()).toHaveLength(2);
  expect(types.problems).toHaveLength(1);
});

test("a location that climbs out of its root is a problem", () => {
  const r = Registry.load([root({ "sources/s.yaml": sourceWith("s").replace("location: data", "location: ../../etc"), "sources/ok.yaml": sourceWith("ok").replace("location: data", "location: ../data") })]);
  expect(r.source("s")).toBeNull();
  expect(r.problems).toHaveLength(1);
  expect(r.problems[0]!.error).toContain("location");
  expect(r.source("ok")).not.toBeNull();
});

test("an absolute location is a problem for files and sql, but fine for http", () => {
  const r = Registry.load([root({
    "a.yaml": sourceWith("a").replace("location: data", "location: /etc"),
    "b.yaml": sourceWith("b").replace("location: data", "location: http://127.0.0.1:1/").replace("files", "http"),
  })]);
  expect(r.source("a")).toBeNull();
  expect(r.source("b")).not.toBeNull();
});

test("an invalid type pattern is a problem", () => {
  const r = Registry.load([root({ "t.yaml": "kind: types\ntypes:\n  - { id: bad, title: Bad, pattern: '(' }\n  - { id: ok, title: Ok, pattern: '^a$' }\n" })]);
  expect(r.types().map(t => t.id)).toEqual(["ok"]);
  expect(r.problems).toHaveLength(1);
  expect(r.problems[0]!.error).toContain("bad");
});

test("loading records each manifest on the chain once per content", () => {
  const rootA = root(GOOD);
  const c = chain();
  const loaded = () => c.read().filter(e => e.type === "module.loaded").map(e => e.payload as { kind: string; id: string; hash: string; root: string; path: string });
  Registry.load([rootA], { chain: c });
  expect(loaded().map(p => `${p.kind}:${p.id}`).sort()).toEqual(["pivot:address_to_domains", "source:dns-logs", "type:address", "type:domain"]);
  expect(loaded().find(p => p.id === "dns-logs")).toEqual({
    kind: "source", id: "dns-logs", hash: sha256Hex(readFileSync(join(rootA.path, "sources/dns-logs.yaml"))), root: rootA.path, path: join(rootA.path, "sources/dns-logs.yaml"),
  });
  Registry.load([rootA], { chain: c });
  expect(loaded()).toHaveLength(4);
  writeFileSync(join(rootA.path, "sources/dns-logs.yaml"), SOURCE + "quality: changed\n");
  Registry.load([rootA], { chain: c });
  expect(loaded()).toHaveLength(5);
  expect(loaded()[4]!.id).toBe("dns-logs");
  expect(c.read().every(e => e.actor.kind === "system" && e.actor.id === "registry")).toBe(true);
});

test("problems are recorded on the chain as module.rejected", () => {
  const rootA = root({ ...GOOD, "bad.yaml": "kind: [unclosed\n" });
  const c = chain();
  const r = Registry.load([rootA], { chain: c, actor: { kind: "system", id: "test" } });
  const rejected = c.read().filter(e => e.type === "module.rejected");
  expect(rejected.map(e => e.payload)).toEqual(r.problems);
  expect(rejected[0]!.actor).toEqual({ kind: "system", id: "test" });
  Registry.load([rootA], { chain: c });
  expect(c.read().filter(e => e.type === "module.rejected")).toHaveLength(1);
});

test("rootOf finds the root a path belongs to", () => {
  const a = root(GOOD), b = root({});
  const r = Registry.load([a, b]);
  expect(r.rootOf(join(a.path, "sources/dns-logs.yaml"))).toEqual(a);
  expect(r.rootOf(b.path)).toEqual(b);
  expect(r.rootOf(a.path + "-sibling/x")).toBeNull();
  expect(r.rootOf(join(a.path, "../elsewhere"))).toBeNull();
});

test("a missing root is a problem and the other roots still load", () => {
  const gone = { path: join(tmp(), "gone"), trusted: false, credentials: [] };
  const r = Registry.load([gone, root(GOOD)]);
  expect(r.problems).toHaveLength(1);
  expect(r.problems[0]!.root).toBe(gone.path);
  expect(r.source("dns-logs")).not.toBeNull();
});

const withFile = (file: string): string => sourceWith("s", `tables:\n  - { name: t, file: "${file}", format: csv }\n`);

test("a table file that climbs out of the root, or is absolute, is a problem", () => {
  for (const file of ["../../../../etc/passwd", "/etc/passwd", "a/../../../x", "..\\\\x"]) {
    const r = Registry.load([root({ "sources/s.yaml": withFile(file) })]);
    expect(r.source("s")).toBeNull();
    expect(r.problems[0]!.error).toContain("file");
  }
  expect(Registry.load([root({ "sources/s.yaml": withFile("sub/x.csv") })]).source("s")).not.toBeNull();
});

test("a table file reached through a symlink out of the root is a problem", () => {
  const outside = tmp();
  const rootA = root({ "sources/s.yaml": withFile("lnk/missing.csv"), "sources/data/keep": "" });
  symlinkSync(outside, join(rootA.path, "sources/data/lnk"));
  const r = Registry.load([rootA]);
  expect(r.source("s")).toBeNull();
  expect(r.problems[0]!.error).toContain("outside");
});

test("a location that is a symlink to outside, with a missing leaf, is a problem", () => {
  const outside = tmp();
  const rootA = root({ "sources/s.yaml": sourceWith("s").replace("location: data", "location: lnk/nonexistent") });
  symlinkSync(outside, join(rootA.path, "sources/lnk"));
  const r = Registry.load([rootA]);
  expect(r.source("s")).toBeNull();
  expect(r.problems).toHaveLength(1);
});

test("staysInside judges spelling, symlinks, and missing leaves", () => {
  const outside = tmp();
  const rootA = root({ "a/b.txt": "x" });
  symlinkSync(outside, join(rootA.path, "out"));
  symlinkSync(join(outside, "gone"), join(rootA.path, "dangling"));
  symlinkSync(join(rootA.path, "a"), join(rootA.path, "inner"));
  expect(staysInside(rootA.path, join(rootA.path, "a/b.txt"))).toBe(true);
  expect(staysInside(rootA.path, join(rootA.path, "a/not-yet/x"))).toBe(true);
  expect(staysInside(rootA.path, join(rootA.path, "inner/b.txt"))).toBe(true);
  expect(staysInside(rootA.path, rootA.path)).toBe(true);
  expect(staysInside(rootA.path, join(rootA.path, "../x"))).toBe(false);
  expect(staysInside(rootA.path, join(rootA.path, "a/../../x"))).toBe(false);
  expect(staysInside(rootA.path, join(rootA.path, "out/file"))).toBe(false);
  expect(staysInside(rootA.path, join(rootA.path, "out/missing/deeper"))).toBe(false);
  expect(staysInside(rootA.path, join(rootA.path, "dangling"))).toBe(false);
  expect(staysInside(rootA.path, join(rootA.path, "dangling/x"))).toBe(false);
  expect(staysInside(rootA.path, outside)).toBe(false);
});

test("a source records the absolute root it came from", () => {
  const rootA = root(GOOD);
  expect(Registry.load([rootA]).source("dns-logs")!.root).toBe(rootA.path);
});

test("a manifest over 1 MiB is not read and is a problem naming its size", () => {
  const big = "kind: k\nid: big\nnote: " + "a".repeat(1048576) + "\n";
  const r = Registry.load([root({ "big.yaml": big, "small.yaml": "kind: k\nid: small\n" })]);
  expect(r.get("k", "big")).toBeNull();
  expect(r.get("k", "small")).not.toBeNull();
  expect(r.problems).toHaveLength(1);
  expect(r.problems[0]!.error).toContain(String(big.length));
});

test("a manifest body that is not plain JSON is a problem naming the path", () => {
  const r = Registry.load([root({ "a.yaml": "kind: k\nid: a\nnested:\n  w: 1e999\n", "b.yaml": "kind: k\nid: b\nwhen: 2026-11-20\nat: 2026-11-20T00:00:00Z\n" })]);
  expect(r.get("k", "a")).toBeNull();
  expect(r.problems).toHaveLength(1);
  expect(r.problems[0]!.error).toContain("$.nested.w");
  // Bun reads unquoted dates as strings, so they are plain JSON and load.
  expect(r.get("k", "b")!.body.when).toBe("2026-11-20");
});

test("a catastrophic type pattern is a problem naming the type; safe ones load", () => {
  const types = (p: string) => `kind: types\ntypes:\n  - { id: t, pattern: '${p}' }\n`;
  for (const p of ["(a+)+", "(a*)*", "(?:a|aa)+", "(\\d+){2,}", "((a+)b)*", "(a{2,})+"]) {
    const r = Registry.load([root({ "t.yaml": types(p) })]);
    expect(r.types()).toEqual([]);
    expect(r.problems[0]!.error).toContain('type "t"');
  }
  for (const p of ["^(?:\\d{1,3}\\.){3}\\d{1,3}$", "[(+*]+x", "(?=.{1,9}$)(?:[a-z]{1,63}\\.)+[a-z]+", "(a+)?", "(ab)+", "\\(a+\\)+"]) {
    const r = Registry.load([root({ "t.yaml": types(p) })]);
    expect(r.problems).toEqual([]);
  }
});

test("a pivot whose yields map no column to its target type is a problem naming the pivot", () => {
  const bare = PIVOTS.replace("    yields: { domain: domain }\n", "");
  const wrongType = PIVOTS.replace("yields: { domain: domain }", "yields: { name: address }");
  for (const text of [bare, wrongType]) {
    const r = Registry.load([root({ ...GOOD, "pivots.yaml": text })]);
    expect(r.pivot("address_to_domains")).toBeNull();
    expect(r.problems.map(p => p.error)).toEqual([`pivot "address_to_domains": yields maps no column to its target type "domain"`]);
  }
});

// ---------- final review finding 1: what a root may cause ----------
const httpSource = (id: string, extra = ""): string =>
  `kind: source\nid: ${id}\ntitle: T\nconnector: http\nlocation: https://rep.example.com\nmarking: "TLP:GREEN"\nwhere: network\n${extra}endpoints:\n  - { name: x, method: GET, path: /x, columns: [a] }\n`;
const trinoSource = (id: string, extra = ""): string =>
  `kind: source\nid: ${id}\ntitle: T\nconnector: trino\nlocation: https://lake.example.com\nuser: u\nmarking: "TLP:GREEN"\nwhere: network\ncost: { weight: 1, unit: rows }\n${extra}`;

test("an untrusted root may not define types, network sources or sources that name a credential", () => {
  const r = Registry.load([root({
    "types.yaml": TYPES,
    "sources/web.yaml": httpSource("web"),
    "sources/lake.yaml": trinoSource("lake"),
    "sources/home.yaml": sourceWith("home", "credential: HOME\n"),
    "sources/ok.yaml": sourceWith("ok"),
    "p.yaml": "kind: pipeline\nid: deep\n",
  }, { trusted: false, credentials: ["HOME"] })]);
  expect(r.types()).toEqual([]);
  expect(r.sources().map(x => x.id)).toEqual(["ok"]);
  expect(r.get("pipeline", "deep")).not.toBeNull();
  const why = Object.fromEntries(r.problems.map(p => [p.path.split("/").pop(), p.error]));
  expect(why["types.yaml"]).toMatch(/types are accepted only from a trusted root/);
  expect(why["web.yaml"]).toMatch(/http source is accepted only from a trusted root/);
  expect(why["lake.yaml"]).toMatch(/trino source is accepted only from a trusted root/);
  expect(why["home.yaml"]).toMatch(/names credential "HOME"; only a trusted root may name a credential/);
});

test("an untrusted root may still supply sql and files sources and pivots", () => {
  const types = root({ "types.yaml": TYPES });
  const share = root({ "sources/dns-logs.yaml": SOURCE, "pivots.yaml": PIVOTS }, { trusted: false });
  const r = Registry.load([types, share]);
  expect(r.problems).toEqual([]);
  expect(r.source("dns-logs")).not.toBeNull();
  expect(r.pivot("address_to_domains")).not.toBeNull();
});

test("a trusted root's source may name only a credential granted to that root", () => {
  const r = Registry.load([root({
    "sources/web.yaml": httpSource("web", "credential: REP_KEY\n"),
    "sources/other.yaml": httpSource("other", "credential: MODEL_API_KEY\n"),
    "sources/none.yaml": httpSource("none"),
  }, { trusted: true, credentials: ["REP_KEY"] })]);
  expect(r.sources().map(x => x.id).sort()).toEqual(["none", "web"]);
  expect(r.problems).toHaveLength(1);
  expect(r.problems[0]!.error).toMatch(/names credential "MODEL_API_KEY", which the configuration does not grant to this root/);
  // a grant on another root does not carry over
  const two = Registry.load([root({}, { trusted: true, credentials: ["MODEL_API_KEY"] }), root({ "s.yaml": httpSource("s", "credential: MODEL_API_KEY\n") }, { trusted: true })]);
  expect(two.source("s")).toBeNull();
});

test("a type pattern that is slow on a 512-character probe is a problem; the sample's patterns load", () => {
  const types = (p: string) => `kind: types\ntypes:\n  - { id: slow, pattern: '${p}' }\n  - { id: ok, pattern: 'a' }\n`;
  // no nested quantifier, so only the timing catches them: polynomial backtracking on a long failing string
  for (const p of ["\\d+\\d+\\d+\\d+x", "a{0,500}a{0,500}a{0,500}a{0,500}b"]) {
    const r = Registry.load([root({ "t.yaml": types(p) })]);
    expect(r.types().map(t => t.id)).toEqual(["ok"]);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]!.error).toMatch(/type "slow": pattern .* refused: it took \d+ ms on a probe string of at most 512 characters \(the limit is 50 ms\)/);
  }
  const sample = Registry.load([{ path: join(import.meta.dir, "..", "..", "sample"), trusted: true, credentials: [] }]);
  expect(sample.problems).toEqual([]);
  expect(sample.types()).toHaveLength(6);
});

test("probePattern builds its probes from the pattern's own characters", () => {
  expect(probePattern("(?:\\d{1,3}\\.){3}\\d{1,3}")).toBeLessThan(PATTERN_PROBE_LIMIT_MS);
  expect(probePattern("\\d+\\d+\\d+\\d+x")).toBeGreaterThan(PATTERN_PROBE_LIMIT_MS);
  expect(probePattern("[0-9]+[0-9]+[0-9]+[0-9]+x")).toBeGreaterThan(PATTERN_PROBE_LIMIT_MS);
});

test("a trino source's cost unit must be rows", () => {
  const r = Registry.load([root({
    "sources/a.yaml": trinoSource("a"),
    "sources/b.yaml": trinoSource("b").replace("unit: rows", "unit: seconds"),
    "sources/c.yaml": trinoSource("c").replace("cost: { weight: 1, unit: rows }\n", ""),
  })]);
  expect(r.sources().map(x => x.id)).toEqual(["a"]);
  expect(r.problems.map(p => p.error).sort()).toEqual([
    "a trino source's cost unit must be rows (the engine estimates in rows), not seconds",
    "a trino source's cost unit must be rows (the engine estimates in rows), not seconds",
  ]);
});

test("a guarded table needs a time_column, or its source does not load", () => {
  const tables = (t: string): string => `tables:\n  - { name: lake.archive.events, ${t}guarded: true, columns: [] }\n`;
  const r = Registry.load([root({
    "sources/ok.yaml": trinoSource("ok", tables("time_column: event_time, ")),
    "sources/bad.yaml": trinoSource("bad", tables("")),
    "sources/free.yaml": trinoSource("free", "tables:\n  - { name: lake.archive.events, columns: [] }\n"),
  })]);
  expect(r.sources().map(x => x.id).sort()).toEqual(["free", "ok"]);
  expect(r.problems.map(p => p.error)).toEqual(["guarded table lake.archive.events needs a time_column"]);
});

// ---------- plan 3 task 0: a pivot may not borrow a source; an id from two roots loads from neither ----------
const REP_SOURCE = httpSource("rep", "cost: { weight: 5, unit: lookups }\n");
const pivotFor = (id: string, source: string, extra = ""): string =>
  `kind: pivots\npivots:\n  - { id: ${id}, title: T, from: address, to: address, source: ${source}, query: x, ${extra}yields: { a: address } }\n`;

test("a pivot from an untrusted root may not name a trusted root's source", () => {
  const r = Registry.load([
    root({ "types.yaml": TYPES, "sources/rep.yaml": REP_SOURCE }),
    root({ "pivots.yaml": pivotFor("a_free_rep", "rep", "weight: 0, empty_means: proven-negative, ") }, { trusted: false }),
  ]);
  expect(r.source("rep")).not.toBeNull();
  expect(r.pivot("a_free_rep")).toBeNull();
  expect(r.problems.map((p) => p.error)).toContain('pivot "a_free_rep": source "rep" belongs to another root; only a pivot from a trusted root may use it');
});

test("an untrusted root's pivot may use its own sources", () => {
  const r = Registry.load([
    root({ "types.yaml": TYPES }),
    root({ "sources/own.yaml": sourceWith("own"), "pivots.yaml": pivotFor("mine", "own") }, { trusted: false }),
  ]);
  expect(r.problems).toEqual([]);
  expect(r.pivot("mine")).not.toBeNull();
});

test("a trusted root's pivot may use another trusted root's source, never an untrusted one", () => {
  const r = Registry.load([
    root({ "types.yaml": TYPES, "sources/rep.yaml": REP_SOURCE }),
    root({ "sources/own.yaml": sourceWith("own") }, { trusted: false }),
    root({ "pivots.yaml": pivotFor("to_trusted", "rep") + "" }),
    root({ "pivots.yaml": pivotFor("to_untrusted", "own") }),
  ]);
  expect(r.pivot("to_trusted")).not.toBeNull();
  expect(r.pivot("to_untrusted")).toBeNull();
  expect(r.problems.map((p) => p.error)).toEqual(['pivot "to_untrusted": source "own" belongs to another root; only a pivot from a trusted root may use it']);
});

test("a pivot id defined in a trusted and an untrusted root loads from neither", () => {
  const r = Registry.load([
    root({ "types.yaml": TYPES, "sources/own.yaml": sourceWith("own"), "pivots.yaml": pivotFor("p1", "own") }, { trusted: false }),
    root({ "sources/mine.yaml": sourceWith("mine"), "pivots.yaml": pivotFor("p1", "mine") }),
  ]);
  expect(r.pivot("p1")).toBeNull();
  expect(r.get("pivot", "p1")).toBeNull();
  expect(r.problems.filter((p) => p.error.includes("defined in two module roots"))).toHaveLength(2);
});

test("a source id defined in two roots loads from neither, and a pivot naming it is dropped", () => {
  const r = Registry.load([
    root({ "types.yaml": TYPES, "sources/s.yaml": sourceWith("s") }),
    root({ "sources/s.yaml": sourceWith("s") }, { trusted: false }),
    root({ "pivots.yaml": pivotFor("p", "s") }),
  ]);
  expect(r.source("s")).toBeNull();
  expect(r.pivot("p")).toBeNull();
});

// ---------- 6b: a pivot's time columns ----------
const TIMED = (times: string): string => `kind: pivots
pivots:
  - id: p
    from: address
    to: domain
    source: dns-logs
    query: "select name, min(ts) as first_seen, max(ts) as last_seen, count(*) as events, ts from dns where client = {value} group by name"
    yields: { name: domain }
${times === "" ? "" : `    ${times}\n`}`;
const load = (times: string): Registry => Registry.load([root({ ...GOOD, "pivots.yaml": TIMED(times) })]);

test("a pivot may declare a span or points, with an optional count", () => {
  expect(load('times: { first: first_seen, last: last_seen, count: events }').pivot("p")!.times).toEqual({ kind: "span", first: "first_seen", last: "last_seen", count: "events" });
  expect(load("times: { at: ts }").pivot("p")!.times).toEqual({ kind: "points", at: "ts", count: null });
  expect(load("").pivot("p")!.times).toBeNull();
  expect(load("times: { at: ts }").problems).toEqual([]);
});

test("each wrong times declaration is rejected with its reason", () => {
  for (const [times, reason] of [
    ["{ first: a }", 'pivot "p": times needs first and last together, or at alone'],
    ["{ first: a, last: b, at: c }", 'pivot "p": times needs first and last together, or at alone'],
    ["{ first: a, last: a }", 'pivot "p": times names the column "a" twice'],
    ["{ at: name }", 'pivot "p": times column "name" is a yielded value'],
    ["{ at: when }", 'pivot "p": times column "when" is not in its query'],
  ] as const) {
    const r = load(`times: ${times}`);
    expect(r.pivot("p")).toBeNull();
    expect(r.problems.map(p => p.error)).toEqual([reason]);
  }
});

test("a column named only as part of a longer word is not in the query", () => {
  const r = load("times: { at: first }");
  expect(r.problems.map(p => p.error)).toEqual(['pivot "p": times column "first" is not in its query']);
});

test("a wrong times declaration rejects only that pivot; the others in the file load", () => {
  const text = `${TIMED("times: { first: a }")}${PIVOTS.replace("kind: pivots\npivots:\n", "")}`;
  const r = Registry.load([root({ ...GOOD, "pivots.yaml": text })]);
  expect(r.pivot("address_to_domains")).not.toBeNull();
  expect(r.pivot("p")).toBeNull();
});

test("on an http source a times column must be one of the endpoint's columns", () => {
  const rep = `kind: source\nid: rep\ntitle: T\nconnector: http\nlocation: https://rep.example.com\nmarking: "TLP:GREEN"\nwhere: network\nendpoints:\n  - { name: lookup, method: GET, path: /x, columns: [name, seen] }\n`;
  const pivots = (at: string): string => `kind: pivots\npivots:\n  - { id: p, from: address, to: domain, source: rep, query: lookup, yields: { name: domain }, times: { at: ${at} } }\n`;
  const good = Registry.load([root({ ...GOOD, "sources/rep.yaml": rep, "pivots.yaml": pivots("seen") })]);
  expect(good.problems).toEqual([]);
  expect(good.pivot("p")!.times).toEqual({ kind: "points", at: "seen", count: null });
  const bad = Registry.load([root({ ...GOOD, "sources/rep.yaml": rep, "pivots.yaml": pivots("when") })]);
  expect(bad.pivot("p")).toBeNull();
  expect(bad.problems.map(p => p.error)).toEqual(['pivot "p": times column "when" is not a column of the endpoint lookup']);
});
