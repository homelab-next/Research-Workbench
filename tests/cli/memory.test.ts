import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../src/core/ledger";
import { Workbench } from "../../src/core/workbench";
import { memory } from "../../src/cli/memory";
import { cleanEnv } from "../helpers/clean-env";
import { copySample } from "../helpers/sample-root";

const REPO = join(import.meta.dir, "..", "..");
const TYPES = "kind: case-types\nid: sample-types\ntypes:\n  - { id: unknown-device, title: Unknown device, about: A device on the network that no inventory names. }\n";

let dir: string;
let out: string[], err: string[];
const io = { log: (l: string) => void out.push(l), error: (l: string) => void err.push(l) };

interface Env { config: string; data: string; root: string }
function envOf(name: string): Env {
  const root = join(dir, `${name}-root`);
  copySample(root);
  writeFileSync(join(root, "case-types.yaml"), TYPES);
  const data = join(dir, `${name}-data`);
  const config = join(dir, `${name}.yaml`);
  writeFileSync(config, [`data_dir: ${data}`, "user: analyst", "roots:", `  - { path: ${root}, trusted: true }`, ""].join("\n"));
  return { config, data, root };
}
let a: Env;
const run = (e: Env, ...argv: string[]): Promise<number> => { out = []; err = []; return memory([...argv, "--config", e.config], io); };
const proposal = (text = "Read the lease table of AP-3 before the firewall log."): string[] =>
  ["propose", "--type", "unknown-device", "--title", "Check the lobby access point first", "--text", text, "--marking", "TLP:GREEN"];
const PROPOSE = proposal();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cli-memory-"));
  a = envOf("a");
  out = []; err = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("propose, list and show: a proposal is listed as proposed with its type and marking, and shown with its triggers in words", async () => {
  expect(await run(a, ...PROPOSE, "--when", "observable=address", "--when", "finding=unknown device")).toBe(0);
  expect(err).toEqual([]);
  expect(out.join("\n")).toContain("LESSON-1");
  expect(await run(a, "list")).toBe(0);
  expect(out).toEqual(["LESSON-1  proposed  unknown-device  TLP:GREEN  Check the lobby access point first"]);
  expect(await run(a, "show", "LESSON-1")).toBe(0);
  const text = out.join("\n");
  expect(text).toContain("Check the lobby access point first");
  expect(text).toContain("Read the lease table of AP-3 before the firewall log.");
  expect(text).toContain("observable address is present");
  expect(text).toContain('a finding mentions "unknown device"');
  expect(text).toContain("proposed by a person");
  expect(text).toContain("history");
  expect(await run(a, "list", "--status", "accepted")).toBe(0);
  expect(out).toEqual([]);
  expect(await run(a, "list", "--type", "phishing")).toBe(0);
  expect(out).toEqual([]);
});

test("accept shares it, and list --status accepted holds it", async () => {
  await run(a, ...PROPOSE);
  expect(await run(a, "accept", "LESSON-1", "--marking", "TLP:AMBER")).toBe(0);
  expect(err).toEqual([]);
  expect(await run(a, "list", "--status", "accepted")).toBe(0);
  expect(out).toEqual(["LESSON-1  accepted  unknown-device  TLP:AMBER  Check the lobby access point first"]);
  // the accepting entry is a person's
  const db = new Database(join(a.data, "memory", "ledger.sqlite"), { readonly: true });
  try {
    const row = db.query("select actor from entries where type = 'lesson.accepted'").get() as { actor: string };
    expect(JSON.parse(row.actor)).toEqual({ kind: "human", id: "analyst" });
  } finally { db.close(); }
  // a marking is raised, never lowered
  await run(a, ...proposal("Another way to say it."));
  expect(await run(a, "accept", "LESSON-2", "--marking", "TLP:CLEAR")).toBe(1);
  expect(err.join("\n")).toContain("raised, never lowered");
});

test("reject and retire need --reason: usage, exit 2", async () => {
  await run(a, ...PROPOSE);
  expect(await run(a, "reject", "LESSON-1")).toBe(2);
  expect(err.join("\n")).toContain("reject needs --reason");
  expect(err.join("\n")).toContain("usage:");
  expect(await run(a, "retire", "LESSON-1")).toBe(2);
  expect(await run(a, "reject", "LESSON-1", "--reason", "too narrow")).toBe(0);
  await run(a, ...proposal("A second version."));
  await run(a, "accept", "LESSON-2");
  expect(await run(a, "retire", "LESSON-2", "--reason", "the lobby changed")).toBe(0);
  expect(await run(a, "list")).toBe(0);
  expect(out.map((l) => l.split("  ")[1])).toEqual(["rejected", "retired"]);
});

test("propose with --when color=red is refused: a trigger is observable=TYPE, source=ID or finding=WORDS", async () => {
  expect(await run(a, ...PROPOSE, "--when", "color=red")).toBe(2);
  expect(err.join("\n")).toContain("observable=TYPE, source=ID or finding=WORDS");
  expect(await run(a, ...PROPOSE, "--when", "observable")).toBe(2);
  expect(await run(a, "list")).toBe(0);
  expect(out).toEqual([]);
});

test("export writes memory.<marking>.<12 hex>.memory.tar.gz and prints its name; load of it into an empty data folder prints the lessons it holds", async () => {
  await run(a, ...PROPOSE);
  await run(a, "accept", "LESSON-1");
  expect(await run(a, "export")).toBe(0);
  expect(err).toEqual([]);
  const files = readdirSync(join(a.data, "memory-files"));
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^memory\.TLP-GREEN\.[0-9a-f]{12}\.memory\.tar\.gz$/);
  expect(out.join("\n")).toContain(files[0]!);
  const to = join(dir, "out");
  mkdirSync(to);
  expect(await run(a, "export", "--to", to)).toBe(0);
  expect(readdirSync(to)).toEqual(files);
  const b = envOf("b");
  expect(await run(b, "load", join(to, files[0]!))).toBe(0);
  expect(err).toEqual([]);
  expect(out.join("\n")).toContain("1 lesson");
  expect(await run(b, "list")).toBe(0);
  expect(out).toEqual(["LESSON-1  accepted  unknown-device  TLP:GREEN  Check the lobby access point first"]);
});

test("load of a file of another store into a store that holds lessons exits 1 with the reason", async () => {
  await run(a, ...PROPOSE);
  expect(await run(a, "export")).toBe(0);
  const file = join(a.data, "memory-files", readdirSync(join(a.data, "memory-files"))[0]!);
  const b = envOf("b");
  await run(b, ...proposal("Something else entirely."));
  expect(await run(b, "load", file)).toBe(1);
  expect(err.join("\n")).toContain("stores are not merged");
  expect(await run(b, "list")).toBe(0);
  expect(out).toHaveLength(1);
});

test("verify exits 0 for a good store and 1 after the ledger file is edited", async () => {
  await run(a, ...PROPOSE);
  expect(await run(a, "verify")).toBe(0);
  expect(out.join("\n")).toContain("case memory: chain intact");
  const db = new Database(join(a.data, "memory", "ledger.sqlite"));
  db.run("UPDATE entries SET payload = replace(payload, 'lobby', 'attic') WHERE seq = 1");
  db.close();
  expect(await run(a, "verify")).toBe(1);
  expect(out.join("\n")).toContain("BROKEN");
});

test("verify --case reports each locked lesson against the store", async () => {
  await run(a, ...PROPOSE);
  await run(a, "accept", "LESSON-1");
  const wb = Workbench.open(a.data, { onError: () => {} });
  const origin = wb.memory.origin()!, head = wb.memory.head();
  const hash = wb.memory.state.lessons["LESSON-1"]!.hash;
  wb.createCase({ title: "T", asked: "Q", why: "W", starting: [{ type: "address", value: "198.51.100.77" }], window: { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" }, objective: null, marking: "TLP:GREEN" }, { kind: "human", id: "analyst" });
  wb.close();
  const l = Ledger.open(join(a.data, "cases", "CASE-1", "ledger.sqlite"), "CASE-1");
  l.append({ type: "memory.bound", actor: { kind: "human", id: "analyst" }, payload: { lock: { blob: "0".repeat(64), bytes: 1 }, store: { origin, head }, case_type: "unknown-device", lessons: [{ lesson: "LESSON-1", hash }] } } as never);
  l.close();
  expect(await run(a, "verify", "--case", "CASE-1")).toBe(0);
  expect(out.join("\n")).toMatch(/LESSON-1.*matches/);
  expect(await run(a, "verify", "--case", "CASE-9")).toBe(1);
  expect(err.join("\n")).toContain("CASE-9");
});

test("an unknown command, a missing id and an option given twice are usage errors", async () => {
  expect(await run(a, "frobnicate")).toBe(2);
  expect(err.join("\n")).toContain("unknown command: frobnicate");
  expect(await run(a, "show")).toBe(2);
  expect(err.join("\n")).toContain("show needs a lesson id");
  expect(await run(a, "accept", "lesson-one")).toBe(2);
  expect(await run(a, "propose", ...PROPOSE.slice(1), "--title", "again")).toBe(2);
  expect(err.join("\n")).toContain("--title was given twice");
  expect(await run(a, "list", "--status", "weird")).toBe(2);
  expect(await run(a, "list", "--bogus", "x")).toBe(2);
  expect(await run(a)).toBe(2);
});

test("the package script and the usage name the same commands: bun run memory with no command is a usage error", () => {
  const scripts = (JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  expect(scripts.memory).toBe("bun run src/cli/memory.ts");
  const r = Bun.spawnSync(["bun", "run", "memory", "--help"], { cwd: REPO, env: cleanEnv(dir), stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  expect(r.exitCode).toBe(2);
  const text = r.stderr.toString();
  for (const w of ["list", "show", "propose", "accept", "reject", "retire", "export", "load", "verify"]) expect(text).toContain(`bun run memory ${w}`);
  expect(existsSync(join(dir, "memory"))).toBe(false);
});
