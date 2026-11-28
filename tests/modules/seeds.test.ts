import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lessonHash } from "../../src/core/lessons";
import { MemoryStore } from "../../src/core/memstore";
import type { CaseType } from "../../src/modules/case-types";
import type { RootConfig } from "../../src/modules/config";
import { loadRegistry } from "../../src/modules/registry-record";
import { fileSeeds, loadSeeds } from "../../src/modules/seeds";

const person = { kind: "human", id: "analyst" } as const;
const TYPES: CaseType[] = [{ id: "unknown-device", title: "Unknown device", about: "A device nobody knows" }];
const dirs: string[] = [];
const stores: MemoryStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "rw-seeds-"));
  dirs.push(d);
  return d;
}
function root(files: Record<string, string>, trusted = true): RootConfig {
  const dir = tmp();
  for (const [name, text] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return { path: dir, trusted, credentials: [] };
}
function store(): MemoryStore {
  const s = MemoryStore.open(join(tmp(), "memory"));
  stores.push(s);
  return s;
}

const SEEDS = `kind: lesson-seeds
id: sample-seeds
title: Sample lessons
lessons:
  - id: lobby-ap
    case_type: unknown-device
    title: Check the lobby access point first
    text: A device seen only on AP-3 is usually a guest in the lobby.
    triggers:
      - { observable: address }
      - { source: wifi }
    marking: TLP:GREEN
  - id: dhcp-name
    case_type: unknown-device
    title: Read the DHCP name
    text: The DHCP lease often names the device's maker.
    marking: TLP:CLEAR
`;

test("the lessons of a lesson-seeds manifest are read, each with the hash of what it says", () => {
  const { seeds, problems } = loadSeeds(loadRegistry([root({ "seeds/sample.yaml": SEEDS })]), TYPES);
  expect(problems).toEqual([]);
  const lobby = {
    case_type: "unknown-device", title: "Check the lobby access point first", text: "A device seen only on AP-3 is usually a guest in the lobby.",
    triggers: [{ observable: "address" }, { source: "wifi" }], marking: "TLP:GREEN" as const, supersedes: null,
  };
  const dhcp = {
    case_type: "unknown-device", title: "Read the DHCP name", text: "The DHCP lease often names the device's maker.", triggers: [], marking: "TLP:CLEAR" as const, supersedes: null,
  };
  expect(seeds).toEqual([
    { ...lobby, manifest: "sample-seeds", item: "lobby-ap", hash: lessonHash(lobby) },
    { ...dhcp, manifest: "sample-seeds", item: "dhcp-name", hash: lessonHash(dhcp) },
  ]);
});

test("a seed that names no loaded case type, or is not a lesson, is a problem and the others are read", () => {
  const bad = `kind: lesson-seeds
id: mixed
lessons:
  - id: good
    case_type: unknown-device
    title: Good
    text: A good lesson.
    marking: TLP:CLEAR
  - id: other-type
    case_type: phishing
    title: Phishing
    text: Not a type here.
    marking: TLP:CLEAR
  - id: no-text
    case_type: unknown-device
    title: No text
    marking: TLP:CLEAR
  - id: bad-trigger
    case_type: unknown-device
    title: Bad trigger
    text: Its trigger is two at once.
    triggers: [{ observable: address, source: wifi }]
    marking: TLP:CLEAR
  - id: good
    case_type: unknown-device
    title: Good again
    text: The same item twice.
    marking: TLP:CLEAR
  - just a string
`;
  const { seeds, problems } = loadSeeds(loadRegistry([root({ "seeds/mixed.yaml": bad })]), TYPES);
  expect(seeds.map((s) => s.item)).toEqual(["good"]);
  expect(problems).toEqual([
    'lesson-seeds "mixed": lesson other-type: there is no case type "phishing"',
    'lesson-seeds "mixed": lesson no-text: a lesson needs text of 1 to 1200 characters',
    'lesson-seeds "mixed": lesson bad-trigger: a trigger is { observable: <type> }, { source: <id> } or { finding: <3 to 200 characters> }',
    'lesson-seeds "mixed": lesson good: the item is given twice; the first is kept',
    'lesson-seeds "mixed": lesson #6: a lesson is a mapping with an id',
  ]);
  const notList = loadSeeds(loadRegistry([root({ "seeds/x.yaml": "kind: lesson-seeds\nid: x\nlessons: 3\n" })]), TYPES);
  expect(notList).toEqual({ seeds: [], problems: ['lesson-seeds "x": lessons must be a list'] });
});

test("fileSeeds files each seed once: a second call files nothing", () => {
  const { seeds } = loadSeeds(loadRegistry([root({ "seeds/sample.yaml": SEEDS })]), TYPES);
  const s = store();
  expect(fileSeeds(s, seeds)).toEqual(["LESSON-1", "LESSON-2"]);
  expect(s.state.lessons["LESSON-1"]).toMatchObject({
    status: "proposed", from: { kind: "seed", manifest: "sample-seeds", item: "lobby-ap", hash: seeds[0]!.hash },
    proposed: { by: { kind: "system", id: "seed" } },
  });
  expect(fileSeeds(s, seeds)).toEqual([]);
  // a seed the person rejected is not filed again either
  s.reject("LESSON-2", { actor: person, reason: "not here" });
  expect(fileSeeds(s, seeds)).toEqual([]);
  expect(s.entries().length).toBe(3);
  expect(s.state.skipped).toEqual([]);
});

test("a seed edited after its lesson was shared is filed again, superseding that lesson; nothing is accepted", () => {
  const first = loadSeeds(loadRegistry([root({ "seeds/sample.yaml": SEEDS })]), TYPES).seeds;
  const s = store();
  const lobby = first.filter((x) => x.item === "lobby-ap");
  expect(fileSeeds(s, lobby)).toEqual(["LESSON-1"]);
  s.accept("LESSON-1", { actor: person, hash: s.state.lessons["LESSON-1"]!.hash });
  const edited = loadSeeds(loadRegistry([root({ "seeds/sample.yaml": SEEDS.replace("usually a guest", "nearly always a guest") })]), TYPES).seeds;
  expect(fileSeeds(s, edited.filter((x) => x.item === "lobby-ap"))).toEqual(["LESSON-2"]);
  expect(s.state.lessons["LESSON-2"]).toMatchObject({ status: "proposed", supersedes: "LESSON-1" });
  expect(s.state.lessons["LESSON-1"]!.status).toBe("accepted");
  // a seed holding a secret value is not filed, and the problem says so without the value
  const problems: string[] = [];
  const secret = "synthetic-secret-value";
  const leaky = edited.filter((x) => x.item === "dhcp-name").map((x) => ({ ...x, text: `${x.text} ${secret}` }));
  expect(fileSeeds(s, leaky, { secrets: [secret], problems })).toEqual([]);
  expect(problems).toEqual(['lesson-seeds "sample-seeds": lesson dhcp-name: the lesson holds a secret value']);
  expect(s.state.skipped).toEqual([]);
});
