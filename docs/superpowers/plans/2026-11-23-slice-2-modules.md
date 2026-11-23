# Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make data reachable: load modules from configured folders, run read-only queries against four kinds of source, log every query in the ledger with its raw bytes, turn results into cards, and find the cheapest route from what you have to what you want.

**Architecture:** A module is a manifest file in a module root. The registry loads and hashes manifests; code in this repository (connectors, the route finder) is chosen by name in them. Every query goes through one function, `runQuery`, which applies the cost rule, writes the ledger entries and the blob, and makes the card. Connectors enforce read-only themselves.

**Tech Stack:** Bun 1.3.14, TypeScript 7 (strict), `bun:sqlite`, `Bun.YAML`, `fetch`, `bun test`. No new npm dependencies.

**Spec:** [`docs/superpowers/specs/2026-11-23-investigation-slice-design.md`](../specs/2026-11-23-investigation-slice-design.md), sections 3, 6.7, 7 and 12. Roadmap: [`2026-11-23-slice-roadmap.md`](2026-11-23-slice-roadmap.md). This is plan 2 of 5. It builds on plan 1 (`src/core/`).

## Global Constraints

- **Read-only sources.** No connector may send a statement or request that writes. Each connector enforces this itself; it does not trust the query text it is given.
- **Every query is logged.** Nothing reaches a source except through `runQuery`, which writes `query.issued` before the source is contacted and `query.result` or `query.failed` after.
- **Raw bytes are kept.** The bytes a source returned are stored as a blob, unmodified, and referenced from `query.result`.
- **Honest negatives.** A result with zero rows is a proven negative only when the pivot says `proven-negative` and coverage is `full`. Partial coverage is never a proven negative.
- **Cost before action.** A source with weight above zero is costly. A costly query does not run without a budget.
- **No secrets** in entries, blobs, manifests or the repository. Manifests name a credential; the value comes from the environment or a secrets file.
- **No code from module roots runs inside the server.** Manifests choose and configure code that lives in `src/`.
- **Tests never touch a real system.** Network tests use a stand-in server on loopback started by the test. No test contacts any address that is not `127.0.0.1`.
- **No real names.** Samples and tests use RFC 5737 addresses (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`), `example.*` domains and invented account names only.
- **Browser-shared code stays browser-safe:** nothing under `src/core/state/`, nor `src/core/types.ts`, `canonical.ts`, `schema.ts`, may import from `src/modules/`.
- **TypeScript:** `strict: true`. No `any` in exported signatures.
- **Tests:** `bun test`. Every test creates its files under a fresh `mkdtempSync` directory and removes it afterwards.
- **Commits:** one per task, on the current branch, never pushed. Every commit message ends with these two lines:

  ```
  Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01D8GtDHHT7t7xiiX8BzcgNi
  ```

## Review Focus

1. **A query that looks like a read but is not.** `WITH x AS (...) DELETE ...`, two statements separated by `;`, a write hidden behind a comment, `EXPLAIN ANALYZE` of a write. Each is refused before it reaches the source. (Task 2)
2. **A value that breaks out of its quotes.** A starting value such as `x' OR '1'='1` or one containing a newline reaches a pivot. It is refused because it does not match its observable type, and where literals are rendered, quotes are doubled. (Tasks 5, 7)
3. **A source that is slow, down, or returns rubbish.** A timeout, a refused connection, a non-JSON body, a 500. The query is recorded as failed or partial with the reason; nothing hangs; no card claims a negative. (Tasks 4, 5, 6)
4. **A result too large to hold.** A source returns more rows than the cap. The connector stops, cancels the remote query where it can, and reports partial coverage. (Tasks 3, 5)
5. **A broken or hostile manifest.** Invalid YAML, a pivot naming a source that does not exist, a duplicate id, a location that escapes the module root with `..`. The manifest is rejected with a clear reason, the rest still load, and the server does not stop. (Task 1)

---

### Task 1: Configuration, module roots, manifests, observable types

**Files:**
- Create: `src/modules/config.ts`, `src/modules/manifests.ts`, `src/modules/registry.ts`, `src/modules/observables.ts`
- Test: `tests/modules/config.test.ts`, `tests/modules/registry.test.ts`, `tests/modules/observables.test.ts`

**Interfaces:**
- Consumes (plan 1): `Ledger`, `Actor`, `Marking`, `Where`, `Json`, `Schema`, `validate`, `sha256Hex`.
- Produces:
  - `interface RootConfig { path: string; trusted_scripts: boolean }`
  - `interface Config { path: string | null; data_dir: string; user: string; role: "analyst" | "requester" | "leader"; roots: RootConfig[]; secrets_file: string | null; seeker: string; marking_policy: Record<Marking, Where[]>; server: { port: number }; research: { parallel: number } }`
  - `loadConfig(opts?: { path?: string; env?: Record<string, string | undefined>; home?: string; repoRoot?: string }): Config`
  - `class ConfigError extends Error`
  - `interface LoadedManifest { kind: string; id: string; title: string; hash: string; root: string; path: string; dir: string; body: Record<string, Json>; text: string | null }`
  - `interface QualityNote { id: string; text: string; from: string | null; to: string | null }`
  - `interface TableManifest { name: string; time_column: string | null; guarded: boolean; large_columns: string[]; file: string | null; format: "csv" | "jsonl" | null; columns: { name: string; type: string | null }[] }`
  - `interface EndpointManifest { name: string; method: "GET" | "POST"; path: string; read: boolean; rows: string; columns: string[] }`
  - `interface SourceManifest { id: string; title: string; hash: string; dir: string; connector: "sql" | "files" | "http" | "trino"; location: string; credential: string | null; user: string | null; tls_verify: boolean; marking: Marking; where: Where; confirmed: boolean; adhoc: boolean; cost: { weight: number; unit: string }; limits: { max_rows: number; timeout_ms: number }; quality: string; quality_notes: QualityNote[]; tables: TableManifest[]; endpoints: EndpointManifest[] }`
  - `interface ObservableType { id: string; title: string; pattern: string }`
  - `interface PivotManifest { id: string; title: string; hash: string; from: string; to: string; source: string; query: string; needs_window: boolean; weight: number | null; empty_means: "proven-negative" | "not-seen"; yields: Record<string, string> }`
  - `class Registry` with:
    - `static load(roots: RootConfig[], opts?: { chain?: Ledger; actor?: Actor }): Registry`
    - `readonly problems: { root: string; path: string; error: string }[]`
    - `all(kind: string): LoadedManifest[]`, `get(kind: string, id: string): LoadedManifest | null`
    - `sources(): SourceManifest[]`, `source(id: string): SourceManifest | null`
    - `types(): ObservableType[]`
    - `pivots(): PivotManifest[]`, `pivot(id: string): PivotManifest | null`
    - `rootOf(path: string): RootConfig | null`
  - `class Observables { constructor(types: ObservableType[]); recognise(value: unknown): string | null; matches(type: string, value: string): boolean; columnTypes(columns: string[], hints: Record<string, string | null>, rows: Json[][]): (string | null)[] }`

**Configuration file** (`config.yaml`), every key optional:

```yaml
data_dir: ~/.local/share/research-workbench
user: analyst
role: analyst
roots:
  - path: ./sample
    trusted_scripts: true
secrets_file: ~/.config/research-workbench/secrets.yaml
seeker: cheapest
marking_policy:
  "TLP:CLEAR": [machine, network, hosted]
  "TLP:GREEN": [machine, network, hosted]
  "TLP:AMBER": [machine, network]
  "TLP:AMBER+STRICT": [machine, network]
  "TLP:RED": [machine]
server: { port: 4747 }
research: { parallel: 3 }
```

The values shown are the defaults, except: `user` defaults to `env.USER` or `"analyst"`; `data_dir` uses `env.XDG_DATA_HOME` when set; the default root is `<repoRoot>/sample` with `trusted_scripts: true`; `secrets_file` defaults to that path only if the file exists, otherwise `null`.

**Manifest files.** A manifest is a `.yaml`/`.yml` file, or a `.md` file whose YAML front matter (between two `---` lines) is the manifest and whose remainder becomes `text`. Every manifest has `kind`. Three kinds are validated here:

```yaml
kind: source
id: dns-logs
title: DNS logs
connector: files            # sql | files | http | trino
location: data              # sql: a SQLite file; files: a folder; http, trino: a base URL
credential: null            # the NAME of a secret, never its value
user: null                  # trino: the identity to query as
tls_verify: true
marking: "TLP:GREEN"
where: machine              # machine | network | hosted
confirmed: true
adhoc: false
cost: { weight: 0, unit: seconds }
limits: { max_rows: 500, timeout_ms: 10000 }
quality: Synthetic resolver logs; complete for the sample window.
quality_notes:
  - { id: dup-1, text: Events recorded twice, from: "2026-11-20T00:00:00Z", to: "2026-11-21T00:00:00Z" }
tables:
  - name: dns
    file: dns.jsonl          # files connector only
    format: jsonl            # csv | jsonl
    time_column: ts
    guarded: false
    large_columns: []
    columns:
      - { name: ts, type: null }
      - { name: client, type: address }
      - { name: name, type: domain }
endpoints: []                # http connector only: { name, method, path, read, rows, columns }
```

```yaml
kind: types
types:
  - { id: address, title: Address, pattern: '^(?:\d{1,3}\.){3}\d{1,3}$' }
```

```yaml
kind: pivots
pivots:
  - id: address_to_domains
    title: Domains resolved by an address
    from: address
    to: domain
    source: dns-logs
    query: "select name as domain, min(ts) as first_seen, count(*) as lookups from dns where client = {value} and ts >= {window.from} and ts < {window.to} group by name"
    needs_window: true
    weight: null             # null: use the source's weight
    empty_means: not-seen    # proven-negative | not-seen
    yields: { domain: domain }
```

Defaults for omitted source keys: `credential: null`, `user: null`, `tls_verify: true`, `confirmed: true`, `adhoc: false`, `cost: { weight: 0, unit: "seconds" }`, `limits: { max_rows: 500, timeout_ms: 10000 }`, `quality: ""`, `quality_notes: []`, `tables: []`, `endpoints: []`. Required: `id`, `title`, `connector`, `location`, `marking`, `where`.

Any other `kind` is loaded as-is: it must have string `kind` and `id`; `title` defaults to `id`. Plan 3 gives those kinds meaning.

- [ ] **Step 1: Write the failing tests**

`tests/modules/config.test.ts`:

```ts
test("with no file, defaults point at the bundled sample root", () => {
  const c = loadConfig({ env: { USER: "pat" }, home: "/h", repoRoot: "/repo" });
  expect(c).toMatchObject({ path: null, user: "pat", role: "analyst", seeker: "cheapest", data_dir: "/h/.local/share/research-workbench",
    roots: [{ path: "/repo/sample", trusted_scripts: true }], server: { port: 4747 }, research: { parallel: 3 }, secrets_file: null });
  expect(c.marking_policy["TLP:RED"]).toEqual(["machine"]);
});
test("XDG_DATA_HOME moves the data directory", ...);                   // "/x/research-workbench"
test("an explicit path wins over the environment, which wins over the home file", ...);
test("relative root paths resolve against the config file's folder, and ~ expands", ...);
test("roots given without trusted_scripts are not trusted", ...);
test("an unknown key is refused", () => {
  // file contains "rooots: []" -> ConfigError whose message names "rooots"
});
test("a bad role or a non-numeric port is refused", ...);
test("a partial marking_policy keeps the defaults for markings it omits", ...);
```

`tests/modules/registry.test.ts`. A helper `root(files: Record<string, string>)` writes a temp module root and returns its `RootConfig`.

```ts
test("loads sources, types and pivots, each with the hash of its file", () => {
  const r = Registry.load([rootA]);
  expect(r.problems).toEqual([]);
  expect(r.source("dns-logs")).toMatchObject({ connector: "files", marking: "TLP:GREEN", limits: { max_rows: 500, timeout_ms: 10000 }, adhoc: false });
  expect(r.source("dns-logs")!.hash).toBe(sha256Hex(readFileSync(join(rootA.path, "sources/dns-logs.yaml"))));
  expect(r.pivot("address_to_domains")).toMatchObject({ from: "address", to: "domain", source: "dns-logs", weight: null });
  expect(r.types().map(t => t.id)).toEqual(["address", "domain"]);
});
test("a source's dir is the folder its manifest is in", ...);
test("a markdown file with front matter loads, with its body as text", () => {
  // personas/analyst.md: "---\nkind: persona\nid: analyst\n---\nYou are careful.\n" -> get("persona","analyst").text === "You are careful.\n"
});
test("kinds this plan does not validate are loaded as they are", ...);
test("files under a folder named data, and dotfiles, are skipped", ...);
test("invalid YAML is a problem and the rest still load", ...);
test("a manifest with no kind or no id is a problem", ...);
test("a source failing its schema is a problem naming the field", ...);          // marking: "SECRET" -> error mentions "marking"
test("a pivot naming a missing source or type is a problem", ...);
test("a column typed with a missing observable type is a problem", ...);
test("a duplicate id keeps the first and reports the second", ...);              // across two roots, and within one
test("a location that climbs out of its root is a problem", ...);                // location: ../../etc
test("an invalid type pattern is a problem", ...);                               // pattern: "("
test("loading records each manifest on the chain once per content", () => {
  // load twice with the same chain -> one module.loaded per manifest; change a file, load again -> one more for that manifest only
});
test("problems are recorded on the chain as module.rejected", ...);
test("rootOf finds the root a path belongs to", ...);
```

`tests/modules/observables.test.ts`:

```ts
const obs = new Observables([
  { id: "address", title: "Address", pattern: "^(?:\\d{1,3}\\.){3}\\d{1,3}$" },
  { id: "domain", title: "Domain", pattern: "^(?=.{1,253}$)(?:[a-z0-9-]{1,63}\\.)+[a-z]{2,63}$" },
]);
test("recognises the first matching type", () => {
  expect(obs.recognise("192.0.2.7")).toBe("address");
  expect(obs.recognise("cdn.example.org")).toBe("domain");
  expect(obs.recognise("hello")).toBeNull();
  expect(obs.recognise(42)).toBeNull();
});
test("matches checks one type and rejects injection text", () => {
  expect(obs.matches("address", "192.0.2.7")).toBe(true);
  expect(obs.matches("address", "192.0.2.7' OR '1'='1")).toBe(false);
  expect(obs.matches("address", "192.0.2.7\n")).toBe(false);
  expect(obs.matches("nope", "x")).toBe(false);
});
test("columnTypes uses hints first, then what most values look like", () => {
  expect(obs.columnTypes(["a", "b", "c"], { a: "domain" }, [["x", "192.0.2.1", 5], ["y", "192.0.2.2", 6]])).toEqual(["domain", "address", null]);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/modules`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `loadConfig` in `src/modules/config.ts`**

Resolution order for the file: `opts.path`, then `env.RESEARCH_WORKBENCH_CONFIG`, then `<home>/.config/research-workbench/config.yaml` if it exists, then defaults. `home` defaults to `os.homedir()`, `env` to `process.env`, `repoRoot` to the folder two levels above this file's folder. Parse with `Bun.YAML.parse`. Validate with a `Schema` and `validate` from plan 1; top level uses `additionalProperties: false`.

- [ ] **Step 4: Implement manifest parsing and schemas in `src/modules/manifests.ts`**

Export `SOURCE_SCHEMA`, `TYPES_SCHEMA`, `PIVOTS_SCHEMA` and a function `parseManifestFile(path: string, bytes: Uint8Array): { kind: string; body: Record<string, Json>; text: string | null }` that throws `ManifestError` with a one-line reason.

- [ ] **Step 5: Implement `Registry` in `src/modules/registry.ts`**

Walk each root in order, depth-first, file names sorted. Skip dotfiles and any folder named `data`. `hash` is `sha256Hex` of the file's bytes; items of a `types` or `pivots` file share that file's hash. Cross-checks run after every file is read. A `location` for `sql` and `files` is resolved against the manifest's folder and must stay inside its root. Test every type pattern with `new RegExp`.

Chain recording: before appending, read the chain's existing `module.loaded` entries and skip a manifest whose latest recorded hash for the same `kind`, `id` and `root` is unchanged. The default actor is `{ kind: "system", id: "registry" }`.

- [ ] **Step 6: Implement `Observables` in `src/modules/observables.ts`**

Compile each pattern once. `matches` and `recognise` test the whole string as given, with no trimming. `columnTypes`: a hint wins when present; otherwise the type recognised for more than half of the non-null string values in that column across the given rows, or `null`.

- [ ] **Step 7: Run the tests and the type check**

Run: `bun test && bun run typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/modules tests/modules
git commit -m "feat(modules): configuration, manifest registry and observable types"
```

---

### Task 2: SQL guard

**Files:**
- Create: `src/modules/sqlguard.ts`
- Test: `tests/modules/sqlguard.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `class GuardError extends Error { readonly violations: string[] }`
  - `assertReadOnly(sql: string): void` — throws `GuardError` unless `sql` is exactly one read statement
  - `interface TableGuard { table: string; time_column: string | null; large_columns: string[] }`
  - `checkGuardrails(sql: string, guards: TableGuard[]): string[]` — plain-language violations; empty means allowed
  - `stripForAnalysis(sql: string): string` — lower-cased, comments removed, every string literal replaced by `''`, whitespace collapsed

- [ ] **Step 1: Write the failing tests**

`tests/modules/sqlguard.test.ts`:

```ts
test.each([
  "select 1",
  "SELECT a FROM t WHERE b = 'x;y'",
  "with x as (select 1) select * from x",
  "show tables from iceberg.s",
  "describe iceberg.s.t",
  "explain select 1",
  "explain analyze select 1",
  "select 1;",
  "select update_time, deleted_at from t",
  "select 'drop table t' as s",
  "-- note\nselect 1",
])("allows read: %s", sql => { expect(() => assertReadOnly(sql)).not.toThrow(); });

test.each([
  ["insert into t values (1)", "write"],
  ["with x as (select 1) delete from t", "write"],
  ["select 1; drop table t", "one statement"],
  ["select 1; select 2", "one statement"],
  ["/* hi */ update t set a = 1", "write"],
  ["explain analyze delete from t", "write"],
  ["create table t (a int)", "write"],
  ["pragma journal_mode = wal", "write"],
  ["attach database 'x' as y", "write"],
  ["call system.sync()", "write"],
  ["set session x = 1", "write"],
  ["", "empty"],
  ["   ", "empty"],
])("refuses: %s", (sql, why) => {
  expect(() => assertReadOnly(sql)).toThrow(GuardError);
  try { assertReadOnly(sql); } catch (e) { expect((e as GuardError).violations.join(" ")).toContain(why); }
});

const guards: TableGuard[] = [{ table: "iceberg.wazuh_archive.events", time_column: "event_timestamp", large_columns: ["full_log"] }];
const ok = "select rule_id, count(*) c from iceberg.wazuh_archive.events where event_timestamp >= timestamp '2026-11-20 00:00:00 UTC' group by rule_id order by c desc limit 50";
test("a bounded, projected, limited query passes", () => { expect(checkGuardrails(ok, guards)).toEqual([]); });
test("a query on an unguarded table is not checked", () => { expect(checkGuardrails("select * from other", guards)).toEqual([]); });
test.each([
  ["select rule_id from iceberg.wazuh_archive.events", "time filter"],
  ["select * from iceberg.wazuh_archive.events where event_timestamp > now() - interval '1' day", "select *"],
  ["select e.* from iceberg.wazuh_archive.events e where event_timestamp > now() - interval '1' day", "select *"],
  ["select count(distinct agent_id) from iceberg.wazuh_archive.events where event_timestamp > now() - interval '1' day", "approx_distinct"],
  ["select rule_id from iceberg.wazuh_archive.events where event_timestamp > now() - interval '1' day order by rule_id", "limit"],
  ["select rule_id from iceberg.wazuh_archive.events where event_timestamp >= timestamp '2026-11-20 00:00:00'", "time zone"],
])("violation: %s", (sql, why) => { expect(checkGuardrails(sql, guards).join(" ")).toContain(why); });
test("several violations are all reported", ...);                      // select * with no filter -> two entries
test("the table name matches case-insensitively and when quoted", ...); // "ICEBERG"."wazuh_archive"."events"
test("stripForAnalysis removes comments and empties literals", () => {
  expect(stripForAnalysis("SELECT 'a;b' -- x\n FROM t /* y */")).toBe("select '' from t");
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/modules/sqlguard.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the guard in `src/modules/sqlguard.ts`**

This is a refusal filter, not a SQL parser. It errs toward refusing.

`stripForAnalysis`: one pass over the text handling `'...'` literals (with `''` as an escaped quote), `"..."` quoted identifiers (kept, quotes removed), `--` comments to end of line and `/* */` comments.

`assertReadOnly`, on the stripped text:
1. Empty → violation `"empty statement"`.
2. Remove one trailing `;`. Any remaining `;` → `"only one statement is allowed"`.
3. The first word must be one of `select`, `with`, `show`, `describe`, `desc`, `explain`; otherwise `"not a read statement (write refused)"`.
4. Any of these words anywhere, matched on word boundaries, → `"write keyword refused: <word>"`: `insert update delete merge create drop alter truncate grant revoke call set use commit rollback attach detach pragma vacuum replace copy refresh reset prepare execute deallocate`.

`checkGuardrails`, for each guard whose table name appears in the stripped text:
- no comparison on the time column (`<col>` followed, after optional whitespace, by `>`, `<`, `=` or `between`) → `"needs a time filter on <col>"`;
- `select *` or `<alias>.*` in a select list → `"select * is not allowed on <table>; name the columns"`;
- `count(distinct` → `"exact distinct counts are not allowed; use approx_distinct"`;
- `order by` with no `limit` → `"a sort needs a limit"`;
- a `timestamp '...'` literal in the original text that ends in neither ` UTC`, `Z` nor a `+hh:mm`/`-hh:mm` offset → `"time literals need an explicit time zone"`.

The last rule reads the original text, since stripping empties the literals.

- [ ] **Step 4: Run the tests and the type check**

Run: `bun test tests/modules/sqlguard.test.ts && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/sqlguard.ts tests/modules/sqlguard.test.ts
git commit -m "feat(modules): SQL guard for read-only statements and table guardrails"
```

---

### Task 3: Connector interface, secrets, `sql` and `files` connectors

**Files:**
- Create: `src/modules/connectors/types.ts`, `src/modules/connectors/placeholders.ts`, `src/modules/connectors/sqlite.ts`, `src/modules/connectors/files.ts`, `src/modules/connectors/index.ts`, `src/modules/secrets.ts`
- Test: `tests/modules/secrets.test.ts`, `tests/modules/connector-sqlite.test.ts`, `tests/modules/connector-files.test.ts`

**Interfaces:**
- Consumes: `SourceManifest`, `Observables` (Task 1); `assertReadOnly`, `GuardError` (Task 2); `Json`, `Coverage`, `Cost`, `Window` (plan 1).
- Produces:
  - `type Bound = Record<string, string | number | null>`
  - `interface QueryRequest { text: string; bound: Bound; window: Window; max_rows: number; timeout_ms: number; budget: number | null }`
  - `interface QueryOutcome { columns: string[]; rows: Json[][]; raw: Uint8Array; media: string; coverage: Coverage; cost: Cost | null }`
  - `interface Connector { readonly kind: "sql" | "files" | "http" | "trino"; render(req: QueryRequest): string; estimate(req: QueryRequest): Promise<Cost | null>; run(req: QueryRequest): Promise<QueryOutcome>; close(): void }`
  - `interface ConnectorContext { secrets: Secrets; observables: Observables }`
  - `class ConnectorError extends Error`
  - `const MIN_TS = "0001-01-01T00:00:00.000Z"`, `const MAX_TS = "9999-12-31T23:59:59.999Z"`
  - `placeholders(text: string): string[]` — names inside `{...}`, in order of first use
  - `effectiveBound(req: QueryRequest): Bound` — `req.bound` plus `"window.from"` and `"window.to"` from `req.window`, with open ends replaced by `MIN_TS` / `MAX_TS`
  - `class Secrets { constructor(env: Record<string, string | undefined>, file: string | null); get(name: string): string | null }`
  - `makeConnector(source: SourceManifest, ctx: ConnectorContext): Connector` (throws `ConnectorError` for a kind it does not know)
  - `class ConnectorPool { constructor(ctx: ConnectorContext); for(source: SourceManifest): Connector; closeAll(): void }` — one connector per source id, rebuilt when the source's hash changes

- [ ] **Step 1: Write the failing tests**

`tests/modules/secrets.test.ts`:

```ts
test("reads from the environment first, then the file", ...);        // env {A:"1"}, file "A: 2\nB: 3\n" -> get("A") "1", get("B") "3", get("C") null
test("a secrets file readable by others is refused", ...);            // chmod 0644 -> constructor throws naming the path and "0600"
test("a missing file is the same as no file", ...);
```

`tests/modules/connector-sqlite.test.ts`. Build a SQLite file with table `flows(ts TEXT, src TEXT, dst TEXT, bytes INTEGER)` and 10 rows; a source manifest object pointing at it with `limits.max_rows` 5.

```ts
test("render replaces placeholders with named parameters", () => {
  expect(c.render(req("select dst from flows where src = {value} and ts >= {window.from} and ts < {window.to}")))
    .toBe("select dst from flows where src = $value and ts >= $window_from and ts < $window_to");
});
test("run binds values instead of pasting them", async () => {
  const out = await c.run(req("select dst from flows where src = {value}", { value: "192.0.2.17' OR '1'='1" }));
  expect(out.rows).toEqual([]);
});
test("run returns columns, rows and the raw bytes as JSON", async () => {
  const out = await c.run(req("select src, bytes from flows where src = {value} order by bytes limit 2", { value: "192.0.2.17" }));
  expect(out.columns).toEqual(["src", "bytes"]);
  expect(out.rows).toHaveLength(2);
  expect(out.media).toBe("application/json");
  expect(JSON.parse(new TextDecoder().decode(out.raw))).toEqual({ columns: out.columns, rows: out.rows });
  expect(out.coverage).toEqual({ kind: "full" });
});
test("an open window binds the minimum and maximum timestamps", ...);
test("stopping at the row cap is partial coverage", async () => {
  const out = await c.run(req("select * from flows"));                 // 10 rows, cap 5
  expect(out.rows).toHaveLength(5);
  expect(out.coverage).toEqual({ kind: "partial", reason: "row_limit", detail: "stopped at 5 rows" });
});
test("a write is refused before it reaches the database", () => {
  expect(() => c.render(req("delete from flows"))).toThrow(GuardError);
});
test("the database is opened read-only", ...);                         // new Database(path, {readonly:true}) semantics: a raw write through the connector's handle fails
test("a placeholder with no bound value is refused", ...);             // ConnectorError naming the placeholder
test("a missing database file is a ConnectorError", ...);
test("estimate is null", ...);
```

`tests/modules/connector-files.test.ts`. A folder with `dns.jsonl` (6 lines of `{ts, client, name, answer}`) and `assets.csv` (header `asset,address,owner`, 3 rows, one value containing a quoted comma).

```ts
test("jsonl and csv files are queryable as tables", async () => {
  const out = await c.run(req("select d.name, a.owner from dns d join assets a on a.address = d.client where d.client = {value}", { value: "192.0.2.17" }));
  expect(out.columns).toEqual(["name", "owner"]);
});
test("csv quoting is honoured", ...);                                  // the value with a comma survives
test("numbers in jsonl stay numbers and missing keys are null", ...);
test("a blank or malformed jsonl line is skipped and reported as partial coverage", async () => {
  // add the line "{not json" -> coverage { kind: "partial", reason: "source_error", detail: "1 unreadable line in dns.jsonl" }
});
test("a changed file is re-read on the next query", ...);
test("a table whose file is missing is a ConnectorError naming the file", ...);
test("writes are refused", ...);
test("the row cap applies", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/modules/secrets.test.ts tests/modules/connector-sqlite.test.ts tests/modules/connector-files.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the shared types and helpers**

`types.ts` holds the interfaces and constants. `placeholders.ts` holds `placeholders` and `effectiveBound`. `secrets.ts`: the file is a YAML map of name to string; refuse to construct if the file's mode has any group or other bit set.

- [ ] **Step 4: Implement the `sql` connector in `src/modules/connectors/sqlite.ts`**

`location` is a path, resolved against `source.dir`. Open with `{ readonly: true }`. `render` calls `assertReadOnly`, then replaces each `{name}` with `$name`, turning dots into underscores. `run` iterates rows and stops after `max_rows`, reporting partial coverage if another row exists. `raw` is the UTF-8 of `JSON.stringify({ columns, rows })`. There is no timeout: `bun:sqlite` is synchronous and local.

- [ ] **Step 5: Implement the `files` connector in `src/modules/connectors/files.ts`**

`location` is a folder. Each table in the manifest names a `file` in it and a `format`. On each `run`, if any file's size or modification time changed since the last load, rebuild an in-memory SQLite database with one table per file (columns from the manifest's `columns`, or the header / first object's keys when the manifest lists none), then delegate rendering and running to the same logic as the `sql` connector. Share that logic; do not copy it.

- [ ] **Step 6: Implement `makeConnector` and `ConnectorPool` in `src/modules/connectors/index.ts`**

A map from kind to factory. Only `sql` and `files` are registered in this task.

- [ ] **Step 7: Run the tests and the type check**

Run: `bun test && bun run typecheck`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add src/modules/connectors src/modules/secrets.ts tests/modules
git commit -m "feat(modules): connector interface, secrets, sql and files connectors"
```

---

### Task 4: `http` connector

**Files:**
- Create: `src/modules/connectors/http.ts`
- Modify: `src/modules/connectors/index.ts` (register `http`)
- Create: `tests/helpers/http-standin.ts`
- Test: `tests/modules/connector-http.test.ts`

**Interfaces:**
- Consumes: `Connector`, `QueryRequest`, `QueryOutcome`, `ConnectorContext`, `ConnectorError`, `effectiveBound`, `placeholders` (Task 3); `SourceManifest`, `EndpointManifest` (Task 1).
- Produces:
  - the `http` connector, registered under kind `"http"`
  - test helper `startStandin(routes: Record<string, (req: Request) => Response | Promise<Response>>): { url: string; requests: { method: string; path: string; headers: Record<string, string>; body: string }[]; stop(): void }` — a `Bun.serve` on `127.0.0.1` with port `0`; keys are `"GET /path"`

For this connector `QueryRequest.text` is the **name of an endpoint** in the source manifest. An endpoint:

```yaml
endpoints:
  - name: reputation
    method: GET
    path: /v1/reputation/{value}?days={days}
    read: true
    rows: results          # dot path to the array of row objects in the response; "" means the body itself is the array
    columns: [address, verdict, first_seen]
```

- [ ] **Step 1: Write the failing tests**

```ts
test("render shows the method and the full URL with values encoded", () => {
  expect(c.render(req("reputation", { value: "198.51.100.77", days: 7 }))).toBe(`GET ${s.url}/v1/reputation/198.51.100.77?days=7`);
  expect(c.render(req("reputation", { value: "a b/c", days: 7 }))).toBe(`GET ${s.url}/v1/reputation/a%20b%2Fc?days=7`);
});
test("run maps the response to rows and keeps the body bytes exactly", async () => {
  const out = await c.run(req("reputation", { value: "198.51.100.77", days: 7 }));
  expect(out.columns).toEqual(["address", "verdict", "first_seen"]);
  expect(out.rows).toEqual([["198.51.100.77", "suspicious", "2026-11-19"]]);
  expect(new TextDecoder().decode(out.raw)).toBe(bodyTextTheStandinSent);
});
test("the credential goes in the Authorization header and nowhere else", async () => {
  // source.credential "REP_KEY", secret value "s3cr3t" -> standin saw header authorization "Bearer s3cr3t";
  // render() output and out.raw do not contain "s3cr3t"
});
test("a GET never has a body; a POST is refused unless the endpoint is marked read", ...);
test("an unknown endpoint is a ConnectorError", ...);
test("a non-https base URL is refused unless it is loopback", ...);        // http://203.0.113.5 -> ConnectorError; http://127.0.0.1 allowed
test("a 500 is an error naming the status", ...);                          // run rejects with ConnectorError "HTTP 500"
test("a body that is not JSON is an error", ...);
test("a refused connection is an error, not a hang", ...);
test("a slow response times out as partial coverage", async () => {
  // standin delays 300ms, timeout_ms 50 -> resolves with rows [] and coverage { kind: "partial", reason: "timeout" }
});
test("more rows than the cap is partial coverage", ...);
test("the cost is one lookup in the source's unit", async () => {
  // source.cost { weight: 5, unit: "lookups" } -> estimate() resolves { amount: 1, unit: "lookups" }; out.cost the same
});
test("redirects are not followed", ...);                                   // a 302 is a ConnectorError
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/modules/connector-http.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the stand-in helper `tests/helpers/http-standin.ts`**

- [ ] **Step 4: Implement the connector in `src/modules/connectors/http.ts` and register it**

Path and query placeholders are filled with `encodeURIComponent`. The base URL must be `https:`, or `http:` with host `127.0.0.1`, `localhost` or `::1`. Use `fetch` with `redirect: "manual"` and an `AbortController` for the timeout. When `source.credential` is set, send `Authorization: Bearer <secret>`; if the secret is missing, throw `ConnectorError` naming the credential. Rows: follow the endpoint's `rows` dot path to an array of objects, then pick the endpoint's `columns` from each (missing keys are `null`). `raw` is the response body's bytes, untouched; `media` is the response's content type.

- [ ] **Step 5: Run the tests and the type check**

Run: `bun test && bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/modules/connectors tests/helpers/http-standin.ts tests/modules/connector-http.test.ts
git commit -m "feat(modules): http connector"
```

---

### Task 5: `trino` connector

**Files:**
- Create: `src/modules/connectors/trino.ts`
- Modify: `src/modules/connectors/index.ts` (register `trino`)
- Create: `tests/helpers/trino-standin.ts`
- Test: `tests/modules/connector-trino.test.ts`

**Interfaces:**
- Consumes: `Connector` and friends (Task 3); `assertReadOnly`, `checkGuardrails`, `GuardError`, `TableGuard` (Task 2); `SourceManifest` (Task 1).
- Produces:
  - the `trino` connector, registered under kind `"trino"`
  - `renderLiteral(name: string, value: string | number | null): string` (exported for tests)
  - test helper `startTrino(): { url: string; statements: { sql: string; headers: Record<string, string> }[]; cancelled: string[]; on(match: RegExp, reply: { columns?: string[]; pages?: Json[][][]; error?: string; delayMs?: number }): void; stop(): void }`

**The protocol the stand-in speaks** (and the connector uses):
- `POST /v1/statement` with the SQL as the body. Reply: `{ "id": "q1", "nextUri": "<url>/v1/statement/q1/1", "stats": { "state": "QUEUED" } }`.
- `GET <nextUri>`: `{ "id": "q1", "columns": [{ "name": "a" }], "data": [[1]], "nextUri": "<next page>", "stats": { "state": "RUNNING" } }`. `columns` and `data` may be absent on a page. The last page has no `nextUri` and state `FINISHED`.
- A failure is a page with `"error": { "message": "..." }` and no `nextUri`.
- `DELETE <nextUri>` cancels; the stand-in records the query id in `cancelled`.

- [ ] **Step 1: Write the failing tests**

The source used in tests has `user: "workbench"`, `limits: { max_rows: 5, timeout_ms: 200 }`, and one guarded table `iceberg.s.events` with `time_column: "ts"`.

```ts
test("literals are rendered safely", () => {
  expect(renderLiteral("value", "ws-17")).toBe("'ws-17'");
  expect(renderLiteral("value", "o'brien")).toBe("'o''brien'");
  expect(renderLiteral("value", 42)).toBe("42");
  expect(renderLiteral("value", null)).toBe("NULL");
  expect(renderLiteral("window.from", "2026-11-20T00:00:00.000Z")).toBe("TIMESTAMP '2026-11-20 00:00:00.000 UTC'");
});
test("a value with a control character is refused", () => {
  expect(() => renderLiteral("value", "a\nb")).toThrow(ConnectorError);
});
test("render fills placeholders with literals", () => {
  expect(c.render(req("select a from iceberg.s.events where host = {value} and ts >= {window.from} and ts < {window.to} limit 5", { value: "ws-17" }, win)))
    .toBe("select a from iceberg.s.events where host = 'ws-17' and ts >= TIMESTAMP '2026-11-20 00:00:00.000 UTC' and ts < TIMESTAMP '2026-11-23 00:00:00.000 UTC' limit 5");
});
test("an open-ended window on a guarded table is refused", ...);            // window.from null -> GuardError mentioning "window"
test("a write is refused before anything is sent", async () => {
  expect(() => c.render(req("delete from iceberg.s.events"))).toThrow(GuardError);
  expect(t.statements).toHaveLength(0);
});
test("a guardrail violation is refused with every reason", ...);            // select * with no time filter -> violations length 2; nothing sent
test("run sends the identity, UTC and a source tag, and follows pages to the end", async () => {
  t.on(/from iceberg\.s\.events/, { columns: ["a"], pages: [[[1], [2]], [[3]]] });
  const out = await c.run(okReq);
  expect(out.columns).toEqual(["a"]);
  expect(out.rows).toEqual([[1], [2], [3]]);
  expect(out.coverage).toEqual({ kind: "full" });
  expect(t.statements[0].headers).toMatchObject({ "x-trino-user": "workbench", "x-trino-time-zone": "UTC", "x-trino-source": "research-workbench" });
});
test("the raw bytes are the pages as received", async () => {
  // JSON.parse(text(out.raw)) is an array of the page objects, in order
});
test("the row cap stops paging and cancels the query", async () => {
  t.on(/./, { columns: ["a"], pages: [[[1], [2], [3]], [[4], [5], [6]], [[7]]] });
  const out = await c.run(okReq);
  expect(out.rows).toHaveLength(5);
  expect(out.coverage).toMatchObject({ kind: "partial", reason: "row_limit" });
  expect(t.cancelled).toHaveLength(1);
});
test("a timeout cancels the query and is partial coverage", ...);           // delayMs 500 -> coverage { kind: "partial", reason: "timeout" }; cancelled length 1
test("an engine error is a ConnectorError with the engine's message", ...);
test("a refused connection is a ConnectorError", ...);
test("a password credential is sent as basic auth and never rendered", ...);
test("estimate asks the engine for the plan and reads the row estimate", async () => {
  t.on(/^explain \(type io, format json\)/i, { columns: ["Query Plan"], pages: [[[JSON.stringify({ estimate: { outputRowCount: 1200 } })]]] });
  expect(await c.estimate(okReq)).toEqual({ amount: 1200, unit: "rows" });
});
test("estimate is null when the engine cannot say", ...);                   // error reply, or no outputRowCount
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/modules/connector-trino.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the stand-in `tests/helpers/trino-standin.ts`**

- [ ] **Step 4: Implement the connector in `src/modules/connectors/trino.ts` and register it**

`render`: fill placeholders with `renderLiteral`, then `assertReadOnly`, then `checkGuardrails` with a `TableGuard` for every table in the manifest where `guarded` is true; throw `GuardError` with all violations. Before rendering, if the text names a guarded table and `req.window.from` is `null`, throw `GuardError` with `"a guarded table needs a bounded window"`.

`renderLiteral`: names `window.from` and `window.to` render as `TIMESTAMP 'YYYY-MM-DD HH:MM:SS.mmm UTC'`. Strings double their single quotes; a string containing any character below `0x20` or `0x7f` is refused. Numbers must be finite.

`run`: `POST <location>/v1/statement` with headers `X-Trino-User: <source.user>`, `X-Trino-Time-Zone: UTC`, `X-Trino-Source: research-workbench`, `Content-Type: text/plain`. Follow `nextUri` until it is absent. Stop early at `max_rows` or when `timeout_ms` has elapsed since the POST; on an early stop send `DELETE` to the last `nextUri` and report partial coverage (`row_limit` or `timeout`). `raw` is the UTF-8 of `JSON.stringify(pages)`. When `source.credential` is set, add `Authorization: Basic base64(<user>:<secret>)`. When `source.tls_verify` is false, pass `tls: { rejectUnauthorized: false }` to `fetch`. Do not follow redirects.

`estimate`: run `EXPLAIN (TYPE IO, FORMAT JSON) <rendered text>` through the same paging code, parse the single cell as JSON and return `{ amount: estimate.outputRowCount, unit: "rows" }`, or `null` on any failure. `cost` on a run is `null`.

- [ ] **Step 5: Run the tests and the type check**

Run: `bun test && bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/modules/connectors tests/helpers/trino-standin.ts tests/modules/connector-trino.test.ts
git commit -m "feat(modules): trino connector with enforced guardrails"
```

---

### Task 6: The query runner

**Files:**
- Create: `src/modules/runner.ts`
- Test: `tests/modules/runner.test.ts`

**Interfaces:**
- Consumes: `CaseSession`, `IdAllocator`, `sha256Hex`, `canonical` and the entry types (plan 1); `Registry`, `Observables`, `SourceManifest`, `PivotManifest` (Task 1); `ConnectorPool`, `QueryRequest`, `GuardError`, `ConnectorError`, `Bound` (Tasks 2, 3).
- Produces:
  - `interface RunnerDeps { registry: Registry; pool: ConnectorPool; observables: Observables }`
  - `interface RunQueryInput { source: string; text: string; bound: Bound; window: Window; why: string; actor: Actor; pivot?: PivotManifest | null; title?: string; step?: string | null; subgoal?: string | null; verifies?: string | null; budget?: number | null; run?: string | null; stage?: string | null; job?: string | null; make_card?: boolean }`
  - `type RunQueryResult = | { status: "done"; query: string; card: string | null; outcome: "answered" | "empty" | "partial"; rows: number; rows_hash: string; coverage: Coverage; columns: string[]; data: Json[][] } | { status: "failed"; query: string; error: string } | { status: "needs_budget"; proposal: string | null; estimate: Cost | null } | { status: "refused"; reasons: string[] }`
  - `runQuery(session: CaseSession, deps: RunnerDeps, input: RunQueryInput): Promise<RunQueryResult>`
  - `rowsHash(columns: string[], rows: Json[][]): string` — `sha256Hex(canonical({ columns, rows }))`
  - `const CARD_PREVIEW_ROWS = 50`

- [ ] **Step 1: Write the failing tests**

`tests/modules/runner.test.ts`. Build a real `Workbench` case, a temp module root with a `sql` source `flows` (free), a `files` source `assets` (free), and a costly source `rep` (an `http` source with `cost: { weight: 5, unit: lookups }` pointed at a stand-in). Use real connectors.

```ts
test("a query writes issued, then result and card, and stores the raw bytes", async () => {
  const r = await runQuery(s, deps, { source: "flows", text: "select dst, bytes from flows where src = {value}", bound: { value: "192.0.2.17" }, window: win, why: "find peers", actor: human });
  expect(r).toMatchObject({ status: "done", outcome: "answered", card: "c1", query: "q1" });
  const types = s.entries().map(e => e.type);
  expect(types.slice(-3)).toEqual(["query.issued", "query.result", "card.created"]);
  const issued = s.entries().find(e => e.type === "query.issued")!.payload;
  expect(issued).toMatchObject({ query: "q1", source: "flows", connector: "sql", why: "find peers", verifies: null,
    text: "select dst, bytes from flows where src = $value", bound: { value: "192.0.2.17" }, window: win });
  expect(issued.source_hash).toBe(deps.registry.source("flows")!.hash);
  const result = s.entries().find(e => e.type === "query.result")!.payload;
  expect(s.blobs.check(result.result.blob)).toBe("ok");
  expect(result.rows_hash).toBe(rowsHash(r.columns, r.data));
});
test("issued is written before the source is contacted", ...);        // a connector stub whose run() checks s.state.queries.q1.status === "running"
test("the card carries provenance: source, why, marking, query, columns and their types", () => {
  expect(s.state.cards.c1).toMatchObject({ kind: "result", made_by: "human", query: "q1", source: "flows", why: "find peers",
    marking: "TLP:GREEN", columns: ["dst", "bytes"], column_types: ["address", null], row_count: 3, coverage: { kind: "full" }, empty: null, place: "incoming" });
});
test("a pivot supplies the card title, column types and empty meaning", ...);
test("the card previews at most 50 rows but counts them all", ...);
test("zero rows with full coverage on a proven-negative pivot is a proven negative", ...);     // card.empty "proven-negative", outcome "empty"
test("zero rows on a not-seen pivot is not a proven negative", ...);                           // card.empty "not-seen"
test("zero rows with partial coverage is never a proven negative", ...);                       // pivot says proven-negative, coverage partial -> card.empty "not-seen", outcome "partial"
test("zero rows with no pivot is not-seen", ...);
test("partial coverage with rows is outcome partial and the card says why", ...);
test("a source failure writes query.failed and makes no card", async () => {
  // rep stand-in returns 500 (budget given) -> { status: "failed" }; last entries: query.issued, query.failed; no card
});
test("a guard refusal writes nothing", async () => {
  const before = s.head().seq;
  const r = await runQuery(s, deps, { ...base, text: "delete from flows" });
  expect(r.status).toBe("refused");
  expect(s.head().seq).toBe(before);
});
test("an unknown source is refused", ...);
test("a costly query with no budget from a person asks for one and writes nothing", async () => {
  const r = await runQuery(s, deps, { source: "rep", text: "reputation", bound: { value: "198.51.100.77", days: 7 }, window: win, why: "w", actor: human });
  expect(r).toEqual({ status: "needs_budget", proposal: null, estimate: { amount: 1, unit: "lookups" } });
});
test("a costly query with no budget from an agent becomes a proposal", async () => {
  const r = await runQuery(s, deps, { ...repInput, actor: agent });
  expect(r).toMatchObject({ status: "needs_budget", proposal: "p1" });
  expect(s.state.proposals.p1).toMatchObject({ kind: "costly_query", source: "rep", estimate: { amount: 1, unit: "lookups" }, status: "open", why: "w" });
  expect(standin.requests).toHaveLength(0);
});
test("a costly query with a budget runs and records its cost", ...);
test("a pivot's own weight overrides the source's", ...);              // pivot.weight 0 on a costly source -> runs without a budget
test("a quality note overlapping the window is attached to the card", ...);     // card.quality_notes ["dup-1"]; a window outside it -> []
test("make_card false records the query but makes no card", ...);
test("verifies, step, subgoal, run, stage and job are carried onto the entries and card", ...);
test("agent-written text is refused on a source that does not allow it", async () => {
  // actor agent, no pivot, source.adhoc false -> { status: "refused", reasons: ["this source does not allow agent-written queries"] }
});
test("the whole case still verifies", () => { expect(verifyCase(s.dir).ok).toBe(true); });
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/modules/runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `runQuery` in `src/modules/runner.ts`**

Order of work:

1. Find the source; unknown → `refused`.
2. If the actor is an agent, there is no pivot, and the source's `adhoc` is false → `refused`.
3. `render` through the pool's connector. `GuardError` → `refused` with its violations; `ConnectorError` → `refused` with its message. Nothing is written.
4. Weight is `pivot.weight` when it is a number, otherwise `source.cost.weight`. If weight is above zero and `budget` is null or undefined: get `estimate`; for an agent actor commit `proposal.created` (kind `costly_query`, `title` = the card title, `by` = the actor id, `text` = the rendered text) and return its id; for a person write nothing.
5. Commit `query.issued` with the rendered text, the bound values, the estimate, the source hash, and the pivot id and hash when there is one.
6. `await connector.run(...)` with `max_rows` and `timeout_ms` from the source's limits. On a thrown error commit `query.failed` and return `failed`.
7. Store `raw` as a blob with its media type. In one commit write `query.result` and, unless `make_card` is false, `card.created`.

The card: `title` is `input.title`, else `"<pivot title>: <bound.value>"`, else `"Query on <source title>"`. `body` is one line: `"<n> rows"` plus `" · partial: <reason>"` when partial, or for zero rows `"No rows · proven negative"` / `"No rows · not seen (not proof of absence)"`. `column_types` come from `Observables.columnTypes` with hints from `pivot.yields`, then the source's table column types by column name. `rows` is the first `CARD_PREVIEW_ROWS`. `marking` is the source's. `empty` is `null` unless there are zero rows; then it is `"proven-negative"` only when the pivot says so and coverage is full, otherwise `"not-seen"`. `quality_notes` are the ids of the source's notes whose range overlaps the window (an open end overlaps everything). `event_time` is `null`.

Outcome: partial coverage → `"partial"`; else zero rows → `"empty"`; else `"answered"`.

- [ ] **Step 4: Run the tests and the type check**

Run: `bun test && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/runner.ts tests/modules/runner.test.ts
git commit -m "feat(modules): query runner with cost rule, ledger entries and cards"
```

---

### Task 7: Pivots and the route finder

**Files:**
- Create: `src/modules/pivots.ts`, `src/modules/seeker.ts`, `src/modules/routes.ts`
- Test: `tests/modules/pivots.test.ts`, `tests/modules/seeker.test.ts`, `tests/modules/routes.test.ts`

**Interfaces:**
- Consumes: `Registry`, `PivotManifest`, `Observables` (Task 1); `runQuery`, `RunnerDeps`, `RunQueryResult` (Task 6); `CaseSession`, `Observable`, `Window`, `Actor`, `EmptyMeans`, `Marking` (plan 1).
- Produces:
  - `class PivotError extends Error`
  - `bindPivot(pivot: PivotManifest, value: string, observables: Observables): { text: string; bound: Bound }` — throws `PivotError` unless `value` matches the pivot's `from` type
  - `runPivot(session: CaseSession, deps: RunnerDeps, input: { pivot: string; value: string; window: Window; why: string; actor: Actor; step?: string | null; subgoal?: string | null; budget?: number | null; run?: string | null; stage?: string | null; job?: string | null }): Promise<RunQueryResult>`
  - `yielded(pivot: PivotManifest, result: RunQueryResult, observables: Observables): Observable[]` — distinct values of the pivot's `to` type found in the result's yielded columns that match that type
  - `interface Hop { pivot: string; title: string; source: string; from: string; to: string; free: boolean; weight: number; needs_window: boolean; empty_means: EmptyMeans; confirmed: boolean; marking: Marking; unit: string }`
  - `interface Route { hops: Hop[]; weight: number }`
  - `interface SeekLimits { max_weight: number | null; allow_unconfirmed: boolean; max_hops: number }`
  - `const DEFAULT_LIMITS: SeekLimits = { max_weight: null, allow_unconfirmed: false, max_hops: 4 }`
  - `interface Seeker { routes(have: string[], want: string, limits: SeekLimits, blocked?: ReadonlySet<string>): Route[] }`
  - `cheapestSeeker(registry: Registry): Seeker`
  - `const SEEKERS: Record<string, (registry: Registry) => Seeker>` with one entry, `cheapest`
  - `interface TrailItem { hop: Hop; value: string; status: RunQueryResult["status"]; outcome: string | null; card: string | null; query: string | null; found: string[] }`
  - `runRoute(session: CaseSession, deps: RunnerDeps, seeker: Seeker, input: { have: Observable[]; want: string; window: Window; why: string; actor: Actor; limits?: SeekLimits; subgoal?: string | null; max_fanout?: number; run?: string | null; stage?: string | null; job?: string | null }): Promise<{ outcome: "answered" | "blocked"; reached: Observable[]; trail: TrailItem[]; cards: string[]; blocked: string[] }>`

- [ ] **Step 1: Write the failing tests**

`tests/modules/pivots.test.ts`:

```ts
test("bindPivot returns the template and the value", () => {
  expect(bindPivot(p, "192.0.2.17", obs)).toEqual({ text: p.query, bound: { value: "192.0.2.17" } });
});
test("a value that is not of the pivot's type is refused", () => {
  expect(() => bindPivot(p, "192.0.2.17' OR '1'='1", obs)).toThrow(PivotError);
  expect(() => bindPivot(p, "example.org", obs)).toThrow(PivotError);
});
test("runPivot runs through the runner with the pivot attached", ...);     // query.issued has pivot id and pivot_hash; card title "<pivot title>: <value>"
test("an unknown pivot is refused", ...);                                  // { status: "refused" }
test("yielded returns distinct values of the target type only", ...);      // drops nulls, duplicates and values that fail the type pattern
```

`tests/modules/seeker.test.ts`. Build a registry by hand with types `a b c d` and pivots: `ab` (source s1, weight 0), `bc` (s1, 0), `ac` (s2, weight 5), `bd` (s3, 0, unconfirmed source), `cd` (s1, 0).

```ts
test("finds the cheapest route first, fewer hops breaking ties", () => {
  const rs = seeker.routes(["a"], "c", DEFAULT_LIMITS);
  expect(rs.map(r => r.hops.map(h => h.pivot))).toEqual([["ab", "bc"], ["ac"]]);
  expect(rs.map(r => r.weight)).toEqual([0, 5]);
});
test("each hop says its source, whether it is free, and what empty means", ...);
test("a weight ceiling drops routes above it", ...);                       // max_weight 0 -> only ab,bc
test("unconfirmed sources are left out unless allowed", ...);              // a -> d: ["ab","bc","cd"]; with allow_unconfirmed also ["ab","bd"], listed first (fewer hops, same weight)
test("blocked pivots are routed around", ...);                             // blocked {bc} -> [["ac"]]
test("already holding the goal type gives one empty route", ...);          // routes(["c"], "c") -> [{ hops: [], weight: 0 }]
test("no route gives an empty list", ...);
test("max_hops limits the search and cycles are never followed", ...);
test("several starting types are all considered", ...);
test("at most five routes are returned", ...);
test("SEEKERS has cheapest", ...);
```

`tests/modules/routes.test.ts`. Real case, real `files` sources in a temp root, shaped so that: `address → domain` (pivot `ad`, free) answers; `domain → owner` (pivot `do1`, free) returns nothing for the domain found; `domain → registrar` then `registrar → owner` (pivots `dr`, `ro`, free) reach the goal.

```ts
test("a route runs hop by hop, feeding each hop's values to the next", ...);
test("an empty hop is a roadblock: the run re-routes from what it now knows", async () => {
  const r = await runRoute(s, deps, seeker, { have: [{ type: "address", value: "192.0.2.17" }], want: "owner", window: win, why: "who owns it", actor: human });
  expect(r.outcome).toBe("answered");
  expect(r.blocked).toEqual(["do1"]);
  expect(r.trail.map(t => t.hop.pivot)).toEqual(["ad", "do1", "dr", "ro"]);
  expect(r.reached).toEqual([{ type: "owner", value: "Example Hosting" }]);
  expect(r.cards).toHaveLength(4);
});
test("the pivot already run successfully is not run again after a re-route", ...);     // "ad" appears once in the trail
test("when every route is blocked the outcome is blocked, with the trail", ...);
test("a costly hop with no budget blocks that pivot and moves on", ...);               // trail item status "needs_budget"
test("fan-out is capped", ...);                                                        // 8 values found, max_fanout 3 -> next hop runs 3 times
test("every query in the trail is in the ledger with its why", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/modules/pivots.test.ts tests/modules/seeker.test.ts tests/modules/routes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `src/modules/pivots.ts`**

`runPivot` looks the pivot up, binds it, and calls `runQuery` with `source: pivot.source`, the pivot attached, and the caller's fields passed through. A `PivotError` or unknown pivot becomes `{ status: "refused", reasons: [...] }`.

- [ ] **Step 4: Implement `cheapestSeeker` in `src/modules/seeker.ts`**

Nodes are observable type ids; each pivot is an edge `from → to` with weight `pivot.weight ?? source.cost.weight`. A hop is `free` when its weight is 0; `confirmed`, `marking` and `unit` come from its source. Search simple paths (no type visited twice) from every type in `have` to `want`, up to `limits.max_hops`, skipping blocked pivots, unconfirmed sources unless allowed, and paths over `max_weight`. Sort by total weight, then number of hops, then the pivot ids joined with `>`. Return the first five. The graph is small; plain depth-first enumeration is enough.

- [ ] **Step 5: Implement `runRoute` in `src/modules/routes.ts`**

```
known  = values by type, seeded from input.have
done   = set of "pivot|value" already run
blocked = set of pivot ids
loop:
  if known has values of type `want` → outcome "answered"
  routes = seeker.routes(types in known, want, limits, blocked); none → outcome "blocked"
  hop = first hop of routes[0] whose from-type has a value not yet run with that pivot
        (if every hop of routes[0] is exhausted, block its last hop and continue)
  for each such value, up to max_fanout (default 5): runPivot; record a TrailItem; add yielded values to known
  if the hop added no value of its to-type → add its pivot to blocked
```

`reached` is `known[want]` as observables. `cards` are the card ids from the trail, in order. The `why` given to each pivot is `"<input.why> — <hop title>"`.

- [ ] **Step 6: Run the tests and the type check**

Run: `bun test && bun run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/modules/pivots.ts src/modules/seeker.ts src/modules/routes.ts tests/modules
git commit -m "feat(modules): pivots, cheapest-route finder and route running"
```

---

### Task 8: Re-validating a card

**Files:**
- Create: `src/modules/revalidate.ts`
- Test: `tests/modules/revalidate.test.ts`

**Interfaces:**
- Consumes: `runQuery`, `RunnerDeps`, `rowsHash` (Task 6); `CaseSession` and entry types (plan 1).
- Produces:
  - `revalidateCard(session: CaseSession, deps: RunnerDeps, input: { card: string; actor: Actor; why: string; budget?: number | null }): Promise<{ outcome: "matches" | "differs" | "could_not_run"; detail: string; rerun: string | null }>`

- [ ] **Step 1: Write the failing tests**

Real case and a `sql` source whose SQLite file the test can change between runs.

```ts
test("an unchanged source matches", async () => {
  const v = await revalidateCard(s, deps, { card: "c1", actor: human, why: "check before publishing" });
  expect(v).toMatchObject({ outcome: "matches", rerun: "q2" });
  expect(s.state.cards.c1.validated).toMatchObject({ outcome: "matches" });
  const e = s.entries().at(-1)!;
  expect(e.type).toBe("verify.run");
  expect(e.payload).toMatchObject({ original: "q1", rerun: "q2", card: "c1", outcome: "matches" });
});
test("the re-run is a logged query that names what it verifies and makes no card", ...);   // query.issued for q2 has verifies "q1"; card count unchanged
test("the re-run uses the original text, bound values and window", ...);
test("a changed source differs, and says how", async () => {
  // insert one more matching row -> { outcome: "differs", detail: "was 3 rows, now 4 rows; the source may have changed since" }
});
test("same row count but different content differs", ...);            // detail "same number of rows (3) but different content; the source may have changed since"
test("the original result is untouched", ...);                        // queries.q1.rows_hash unchanged; original blob still ok
test("a source that now fails could not run", ...);                   // delete the database file -> { outcome: "could_not_run" }, detail carries the error
test("a costly source with no budget could not run, and says a budget is needed", ...);
test("a card with no query could not run", ...);                      // an assessment card -> detail "this card did not come from a query"
test("an unknown card is refused with an error", ...);                // rejects
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/modules/revalidate.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `revalidateCard` in `src/modules/revalidate.ts`**

Find the card's query in state, then read the original `query.issued` entry (by `issued_seq`) for its `source`, `bound`, `window` and pivot id. Re-run through `runQuery` with `verifies` set to the original query id and `make_card: false`. When the original had a pivot, re-bind through that pivot so the text is the template again; otherwise the stored text is a rendered one, so re-run is only possible for connectors whose rendered text is still a valid template (`sql`, `files`: the `$name` form maps back to `{name}`); for the others return `could_not_run` with `"only pivot queries can be re-run on this source"`. Compare `rows_hash`. Commit `verify.run` in every case where the card exists and has a query. `rerun` is the new query id, or `null` when nothing ran.

- [ ] **Step 4: Run the tests and the type check**

Run: `bun test && bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/revalidate.ts tests/modules/revalidate.test.ts
git commit -m "feat(modules): re-validate a card by re-running its query"
```

---

### Task 9: The sample module root

**Files:**
- Create: `scripts/make-sample-data.ts`, `sample/README.md`, `sample/types.yaml`, `sample/pivots.yaml`, `sample/sources/flows.yaml`, `sample/sources/dns-logs.yaml`, `sample/sources/signins.yaml`, `sample/sources/assets.yaml`, `sample/sources/leases.yaml`, `sample/sources/reputation.yaml`, `sample/fixture/reputation-server.ts`
- Modify: `.gitignore` (add `sample/data/`), `package.json` (scripts `sample:data`, `sample:fixture`)
- Test: `tests/sample/sample.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 8.
- Produces:
  - `makeSampleData(dir: string): void` exported from `scripts/make-sample-data.ts`; run as a script it writes to `sample/data/`
  - `ensureSampleData(sampleRoot: string): void` exported from the same file — generates only when `sample/data/flows.sqlite` is missing
  - `startReputationFixture(dataDir: string, port?: number): { url: string; stop(): void }` exported from `sample/fixture/reputation-server.ts`; default port 4801
  - `const SAMPLE_WINDOW: Window = { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }` and `const SAMPLE_START: Observable = { type: "address", value: "198.51.100.77" }` exported from `scripts/make-sample-data.ts`

**The planted story** (all synthetic). At `2026-11-20T03:12:00Z` account `j.doe` signs in to workstation `ws-17.example.net` (`192.0.2.17`) from `203.0.113.50`, an address it has never used. Four minutes later `ws-17` resolves `cdn-update.example.org`, which answers `198.51.100.77`, and from then until the end of the window it connects to `198.51.100.77:443` every ten minutes with small, even byte counts. No other host talks to that address. The reputation service calls `198.51.100.77` suspicious.

**Data files** written by the generator, deterministic (a seeded generator; no `Math.random`, no current time):

| File | Content |
|---|---|
| `flows.sqlite` | table `flows(ts, src, dst, dport, bytes)`: about 3,000 background rows among `192.0.2.10`–`192.0.2.30` and a few `203.0.113.x` services, plus the beacon rows |
| `dns.jsonl` | `{ts, client, name, answer}`: background lookups of `*.example.com`, plus the `cdn-update.example.org` lookups by `192.0.2.17` |
| `signins.jsonl` | `{ts, account, host, from_address, result}`: routine sign-ins, plus the one from `203.0.113.50` |
| `assets.csv` | `asset,address,owner,role`: every internal host; complete, so absence is proof |
| `leases.csv` | `address,asset,since`: deliberately missing `192.0.2.17`, to force a re-route |
| `reputation.json` | `{ "198.51.100.77": { verdict: "suspicious", first_seen: "2026-11-19" }, ... }` read by the fixture |

**Sources:** `flows` (`sql`, free, `max_rows: 200` so the beacon query comes back partial); `dns-logs`, `signins`, `assets`, `leases` (`files`, free; `leases` has `confirmed: false`); `reputation` (`http`, `http://127.0.0.1:4801`, `cost: { weight: 5, unit: lookups }`). All `TLP:GREEN`, `where: machine`. Each has a one-sentence `quality` note. `dns-logs` carries one `quality_notes` entry covering `2026-11-18` to `2026-11-19` ("resolver logging was duplicated").

**Observable types:** `address`, `domain`, `host`, `account`, `asset`, `verdict`.

**Pivots:**

| id | from → to | source | empty means |
|---|---|---|---|
| `address_to_internal_peers` | address → address | flows | not-seen |
| `address_to_domains` | address → domain | dns-logs (by `answer`) | not-seen |
| `domain_to_clients` | domain → address | dns-logs (by `name`) | not-seen |
| `address_to_asset_by_lease` | address → asset | leases | not-seen |
| `address_to_asset` | address → asset | assets | proven-negative |
| `asset_to_accounts` | asset → account | signins | not-seen |
| `account_to_signin_addresses` | account → address | signins | not-seen |
| `address_to_verdict` | address → verdict | reputation | not-seen |

Every pivot on a source with a time column uses `{window.from}` and `{window.to}` and sets `needs_window: true`.

- [ ] **Step 1: Write the failing tests**

`tests/sample/sample.test.ts`. Generate into a temp copy of `sample/` (copy the manifests, call `makeSampleData` into its `data/`), start the fixture on port 0, and point the `reputation` source at it by rewriting `location` in the copied manifest.

```ts
test("the generator is deterministic", () => {
  // two runs into two folders: every .jsonl, .csv and .json file is byte-identical; flows.sqlite has the same rows (select * order by rowid)
});
test("the sample root loads with no problems", () => { expect(Registry.load([root]).problems).toEqual([]); });
test("the sample holds only reserved addresses and example domains", () => {
  // every address in every data file matches 192.0.2.x, 198.51.100.x or 203.0.113.x; every domain ends example.com, example.net or example.org
});
test("from the suspicious address, a route reaches the account behind it", async () => {
  const r = await runRoute(s, deps, seeker, { have: [SAMPLE_START], want: "account", window: SAMPLE_WINDOW, why: "who is behind this", actor: human });
  expect(r.outcome).toBe("answered");
  expect(r.reached.map(o => o.value)).toContain("j.doe");
  expect(verifyCase(s.dir).ok).toBe(true);
});
test("the unconfirmed lease source is skipped by default, and is a dead end when allowed", async () => {
  // allow_unconfirmed true: the trail includes address_to_asset_by_lease with no values found, then address_to_asset
});
test("the beacon query is partial because of the row cap", ...);       // address_to_internal_peers for 198.51.100.77 over the window: coverage partial row_limit
test("an external address is a proven negative in the asset list", ...); // address_to_asset for 198.51.100.77 -> card.empty "proven-negative"
test("the reputation lookup is costly and needs a budget", ...);       // needs_budget, estimate { amount: 1, unit: "lookups" }; with budget 1 -> verdict "suspicious"
test("a card over the duplicated-logging days carries the quality note", ...);
test("ensureSampleData generates once and then leaves the data alone", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `bun test tests/sample`
Expected: FAIL.

- [ ] **Step 3: Write the generator `scripts/make-sample-data.ts`**

Use a small seeded generator (for example mulberry32 with seed `20261123`). Timestamps are computed from the fixed window, never from the clock. Write JSON lines and CSV with `\n` line endings. Create `flows.sqlite` fresh each run (delete any existing file first).

- [ ] **Step 4: Write the manifests under `sample/` and `sample/README.md`**

The README says in a few lines what the sample is, that it is synthetic, how to regenerate the data (`bun run sample:data`) and how to start the fixture (`bun run sample:fixture`).

- [ ] **Step 5: Write the fixture `sample/fixture/reputation-server.ts`**

`GET /v1/reputation/<address>` returns `{ "results": [{ "address": ..., "verdict": ..., "first_seen": ... }] }`, or `{ "results": [] }` for an unknown address. Binds `127.0.0.1` only. Run as a script it serves `sample/data/reputation.json` on port 4801.

- [ ] **Step 6: Run the whole suite and the type check**

Run: `bun test && bun run typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add scripts sample tests/sample .gitignore package.json
git commit -m "feat(sample): synthetic module root with a planted story"
```
