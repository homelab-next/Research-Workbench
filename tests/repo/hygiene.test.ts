import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnv } from "../helpers/clean-env";

const REPO = join(import.meta.dir, "../..");

function git(...args: string[]): string[] {
  const r = Bun.spawnSync(["git", ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return r.stdout.toString().split("\n").filter((l) => l !== "");
}

/** Tracked and untracked-not-ignored files that exist and read as text; the lock file is left out. */
function textFiles(): { path: string; lines: string[] }[] {
  const paths = [...new Set([...git("ls-files"), ...git("ls-files", "-o", "--exclude-standard")])].sort();
  const out: { path: string; lines: string[] }[] = [];
  for (const path of paths) {
    if (path === "bun.lock" || path.endsWith("/bun.lock")) continue;
    let buf: Buffer;
    try { buf = readFileSync(join(REPO, path)); } catch { continue; }
    if (buf.includes(0)) continue;
    out.push({ path, lines: buf.toString("utf8").split("\n") });
  }
  return out;
}

const octet = (s: string): number | null => (/^(0|[1-9]\d{0,2})$/.test(s) && Number(s) <= 255 ? Number(s) : null);

function allowed(p: number[]): boolean {
  const [a, b, c] = p as [number, number, number, number];
  if (a === 127) return true;
  if (p.every((x) => x === 0)) return true;
  if (p.every((x) => x === 255)) return true;
  return (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

test("no address in the repository is outside loopback and the documentation ranges", () => {
  const hits: string[] = [];
  for (const f of textFiles()) {
    f.lines.forEach((line, i) => {
      for (const m of line.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d]|\.\d)/g)) {
        const parts = [m[1]!, m[2]!, m[3]!, m[4]!].map(octet);
        if (parts.some((x) => x === null)) continue;
        if (!allowed(parts as number[])) hits.push(`${f.path}:${i + 1}`);
      }
    });
  }
  expect(hits).toEqual([]);
});

test.skipIf(!process.env.WORKBENCH_PRIVATE_TERMS)("no private term is in the repository", () => {
  const terms = readFileSync(process.env.WORKBENCH_PRIVATE_TERMS!, "utf8").split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  terms.forEach((t, n) => { if (t.length < 4) throw new Error(`private term #${n + 1} is under 4 characters`); });
  const lower = terms.map((t) => t.toLowerCase());
  const hits: string[] = [];
  for (const f of textFiles()) {
    f.lines.forEach((line, i) => {
      const l = line.toLowerCase();
      lower.forEach((t, n) => { if (l.includes(t)) hits.push(`${f.path}:${i + 1} (term #${n + 1})`); });
    });
  }
  expect(hits).toEqual([]);
});

test("no loop file, no imported root and no builder session is in the repository: a loop file is made from the sample, never kept beside it", () => {
  const paths = [...new Set([...git("ls-files"), ...git("ls-files", "-o", "--exclude-standard")])];
  expect(paths.filter((p) => /\.loop\.tar\.gz$/.test(p) || /(^|\/)(imported|builders)\//.test(p))).toEqual([]);
});

test("no file in the repository names a home folder: documents and tests write placeholders such as <repo> and <data>", () => {
  const hits: string[] = [];
  for (const f of textFiles()) {
    if (f.path === "tests/repo/hygiene.test.ts") continue;
    f.lines.forEach((line, i) => { if (/(?<![\w<])\/home\/[a-z_][\w.-]*\/|(?<![\w<])\/Users\/[A-Za-z][\w.-]*\//.test(line)) hits.push(`${f.path}:${i + 1}`); });
  }
  expect(hits).toEqual([]);
});

test("every test that spawns a command gives it cleanEnv", () => {
  const bad: string[] = [];
  for (const f of textFiles()) {
    if (!/^tests\/.*\.ts$/.test(f.path) || f.path === "tests/repo/hygiene.test.ts") continue;
    const text = f.lines.join("\n");
    if (!/Bun\.spawn(Sync)?\(/.test(text)) continue;
    const namesCommand = /src\/cli\/|scripts\/|"src",\s*"cli"|"scripts"/.test(text);
    if (namesCommand && !text.includes("cleanEnv(")) bad.push(f.path);
  }
  expect(bad).toEqual([]);
});

test("a spawned command reads its configuration from the given HOME", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-hyg-"));
  try {
    mkdirSync(join(home, ".config", "research-workbench"), { recursive: true });
    writeFileSync(join(home, ".config", "research-workbench", "config.yaml"), "role: boss\n");
    const r = Bun.spawnSync(["bun", "run", "src/cli/serve.ts", "--port", "0"], { cwd: REPO, env: cleanEnv(home), stdout: "pipe", stderr: "pipe", timeout: 60_000 });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain("role");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("package.json's version is the workbench version a case file names", async () => {
  const { WORKBENCH_VERSION } = await import("../../src/core/casefile");
  expect(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version).toBe(WORKBENCH_VERSION);
});

test("the sample's seeds are marked TLP:CLEAR and name only sample hosts, example domains and documentation addresses", () => {
  const seeds = textFiles().filter((f) => f.path.startsWith("sample/") && /\.ya?ml$/.test(f.path) && /^kind:\s*lesson-seeds\s*$/m.test(f.lines.join("\n")));
  expect(seeds.map((f) => f.path)).toEqual(["sample/memory/unknown-device-lessons.yaml"]);
  // the hosts the sample's own data names, by the sample's host and asset types
  const sampleTypes = Bun.YAML.parse(readFileSync(join(REPO, "sample", "types.yaml"), "utf8")) as { types: { id: string; pattern: string }[] };
  const pattern = (id: string): RegExp => new RegExp(`^(?:${sampleTypes.types.find((t) => t.id === id)!.pattern})$`);
  const isSampleName = (n: string): boolean => /\.example\.(?:com|net|org)$/.test(n) || pattern("asset").test(n);
  const problems: string[] = [];
  for (const f of seeds) {
    const body = Bun.YAML.parse(f.lines.join("\n")) as { lessons: { id: string; marking: string; title: string; text: string; triggers?: unknown[] }[] };
    expect(body.lessons.length).toBeGreaterThan(0);
    for (const l of body.lessons) {
      if (l.marking !== "TLP:CLEAR") problems.push(`${f.path}: ${l.id} is marked ${l.marking}`);
      const said = `${l.title}\n${l.text}\n${JSON.stringify(l.triggers ?? [])}`;
      for (const m of said.matchAll(/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d])/g)) {
        const parts = [m[1]!, m[2]!, m[3]!, m[4]!].map(octet);
        if (parts.some((x) => x === null) || !allowed(parts as number[])) problems.push(`${f.path}: ${l.id} names ${m[0]}`);
      }
      // a dotted name is an example domain or a sample asset; a hardware address is never written
      for (const m of said.matchAll(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}\b/gi)) if (!isSampleName(m[0].toLowerCase())) problems.push(`${f.path}: ${l.id} names ${m[0]}`);
      if (/\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\b/i.test(said)) problems.push(`${f.path}: ${l.id} names a hardware address`);
    }
  }
  expect(problems).toEqual([]);
  // the check sees what it is for
  expect(isSampleName("ws-17.example.net")).toBe(true);
  expect(isSampleName("printer.corp.internal")).toBe(false);
});

test("no file under synth/ or src/synth/ writes out an address of the fake company", async () => {
  // the fake company's internal addresses are computed in pivot (internalAddress), never written: none of them, and no 10.x address or
  // network prefix at all, is in the overlay or the workbench's synthetic code
  const { makeCompany, internalAddress } = await import("pivot/synth/company");
  const { DEFAULT_PARAMS, TINY_PARAMS } = await import("pivot/synth/params");
  const known = new Set<string>();
  for (const p of [DEFAULT_PARAMS, TINY_PARAMS]) {
    const company = makeCompany(p);
    for (const h of company.hosts) known.add(h.ip);
    for (const s of company.sites) for (const n of [1, 2, 250, 251]) { known.add(internalAddress(s, "corp", n)); known.add(internalAddress(s, "guest", n)); }
  }
  expect(known.size).toBeGreaterThan(100);
  const TEN = /(?<![\d.])10\.\d{1,3}\.\d{1,3}\.(?:\d{1,3}(?![\d])|(?!\d))/;
  const writesOne = (text: string): boolean => TEN.test(text) || [...known].some((a) => new RegExp(`(?<![\\d.])${a.replace(/\./g, "\\.")}(?![\\d])`).test(text));
  const hits: string[] = [];
  for (const f of textFiles()) {
    if (!f.path.startsWith("synth/") && !f.path.startsWith("src/synth/")) continue;
    f.lines.forEach((line, i) => { if (writesOne(line)) hits.push(`${f.path}:${i + 1}`); });
  }
  expect(hits).toEqual([]);
  // the scan sees the files it is about, and what it is for
  expect(textFiles().filter((f) => f.path.startsWith("src/synth/")).length).toBeGreaterThanOrEqual(5);
  expect(writesOne(["host", [10, 1, 20, 7].join(".")].join(" "))).toBe(true);
  expect(writesOne(`const net = "${[10, 2, 200].join(".")}.";`)).toBe(true);
  expect(writesOne(`[10, site.index + 1, net, n].join(".")`)).toBe(false);
  expect(writesOne("v10.1.2 of a library")).toBe(false);
});
