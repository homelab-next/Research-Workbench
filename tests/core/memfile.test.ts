// The memory file (slice 13): the shared store packed as a case is, memory.json first. A memory file is untrusted input: nothing from one is
// written before every member is checked against memory.json.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import { caseFileName, parseCaseFileName, WORKBENCH_VERSION } from "../../src/core/casefile";
import { sha256Hex } from "../../src/core/hash";
import type { LessonDraft } from "../../src/core/lessons";
import {
  checkMemoryFile, extractMemoryFile, MAX_MEMORY_FILE_BYTES, MEMORY_FILE_FORMAT, MemoryFileError, memoryFileName, parseMemoryFileName, writeMemoryFile,
} from "../../src/core/memfile";
import type { MemoryFileManifest } from "../../src/core/memfile";
import { MemoryStore } from "../../src/core/memstore";
import { Refused } from "../../src/core/refused";
import type { Actor } from "../../src/core/types";
import { rawCaseFile } from "../helpers/tar";

const person: Actor = { kind: "human", id: "analyst" };
const draft = (over: Partial<LessonDraft> = {}): LessonDraft => ({
  case_type: "unknown-device", title: "Check the lobby access point first", text: "A device seen only on AP-3 is usually a guest in the lobby.",
  triggers: [{ observable: "address" }], marking: "TLP:GREEN", supersedes: null, ...over,
});

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "rw-memfile-"));
  dirs.push(d);
  return d;
};
let tick = 0;
const now = (): string => new Date(Date.UTC(2026, 10, 27, 10, 0, tick++)).toISOString();

/** A store of three lessons: one shared, one rejected, one proposed. Closed. */
function storeIn(d: string): { dir: string; header: Omit<MemoryFileManifest, "format" | "workbench" | "files"> } {
  const dir = join(d, "memory");
  const s = MemoryStore.open(dir, { now });
  const a = s.propose(draft(), { kind: "person" }, person).lesson;
  s.accept(a.id, { actor: person, hash: a.hash, marking: "TLP:AMBER" });
  const b = s.propose(draft({ title: "A second lesson" }), { kind: "person" }, person).lesson;
  s.reject(b.id, { actor: person, reason: "not so" });
  s.propose(draft({ title: "A third lesson" }), { kind: "person" }, person);
  const header = {
    origin: s.origin()!, head: s.head(), entries: s.head().seq,
    lessons: { proposed: 1, accepted: 1, rejected: 1, retired: 0, superseded: 0 }, marking: "TLP:AMBER" as const, exported_ts: "2026-11-27T11:00:00.000Z",
  };
  s.close();
  return { dir, header };
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(MemoryFileError);
    expect(err).toBeInstanceOf(Refused);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}

test("writeMemoryFile packs the store with memory.json first, and checkMemoryFile reads back the same manifest", async () => {
  const d = tmp();
  const { dir, header } = storeIn(d);
  const dest = join(d, "out.memory.tar.gz");
  const m = await writeMemoryFile(dir, dest, header);
  expect(MEMORY_FILE_FORMAT).toBe(1);
  expect(MAX_MEMORY_FILE_BYTES).toBe(268435456);
  expect(m).toMatchObject({ format: 1, workbench: WORKBENCH_VERSION, ...header });
  const ledger = readFileSync(join(dir, "ledger.sqlite"));
  expect(m.files).toEqual([{ path: "ledger.sqlite", sha256: sha256Hex(ledger), bytes: ledger.length }]);
  const back = await checkMemoryFile(dest);
  expect(canonical(back as unknown as Json)).toBe(canonical(m as unknown as Json));
  // memory.json is the first member: the first header's name
  const { gunzipSync } = await import("node:zlib");
  const tar = gunzipSync(readFileSync(dest));
  expect(new TextDecoder().decode(tar.subarray(0, 11))).toBe("memory.json");
  // the same store packs to the same bytes
  const again = join(d, "again.memory.tar.gz");
  await writeMemoryFile(dir, again, header);
  expect(sha256Hex(readFileSync(again))).toBe(sha256Hex(readFileSync(dest)));
  // an existing destination is not replaced
  expect(await refusal(writeMemoryFile(dir, dest, header))).toContain("already exists");
});

test("the name is memory.<marking>.<12 hex>.memory.tar.gz and parseMemoryFileName reads it; a case file's name is not one", () => {
  const head = "0123456789abcdef".repeat(4);
  expect(memoryFileName("TLP:AMBER+STRICT", head)).toBe("memory.TLP-AMBER+STRICT.0123456789ab.memory.tar.gz");
  expect(memoryFileName("TLP:CLEAR", head)).toBe(`memory.${caseFileName("X", "TLP:CLEAR").split(".")[1]}.0123456789ab.memory.tar.gz`);
  expect(parseMemoryFileName("memory.TLP-AMBER+STRICT.0123456789ab.memory.tar.gz")).toEqual({ marking: "TLP-AMBER+STRICT", hash12: "0123456789ab" });
  expect(parseMemoryFileName("CASE-1.TLP-GREEN.tar.gz")).toBeNull();
  expect(parseMemoryFileName("memory.TLP-GREEN.0123456789a.memory.tar.gz")).toBeNull();
  expect(parseMemoryFileName("memory.TLP-GREEN.0123456789AB.memory.tar.gz")).toBeNull();
  expect(parseMemoryFileName("memory.TLP:GREEN.0123456789ab.memory.tar.gz")).toBeNull();
  expect(parseMemoryFileName("../memory.TLP-GREEN.0123456789ab.memory.tar.gz")).toBeNull();
  expect(parseCaseFileName(memoryFileName("TLP:GREEN", head))).toBeNull();
});

test("a file whose first member is not memory.json, with a symlink member, a name with .., a member memory.json does not list, a listed member missing, a size or a hash that differs, or more than the limit unpacked is refused and nothing is written", async () => {
  const d = tmp();
  const { dir, header } = storeIn(d);
  const ledger = readFileSync(join(dir, "ledger.sqlite"));
  const entry = { path: "ledger.sqlite", sha256: sha256Hex(ledger), bytes: ledger.length };
  const manifest = (files: unknown[]): string => canonical({ format: 1, workbench: WORKBENCH_VERSION, ...header, files } as unknown as Json);
  const json = manifest([entry]);
  const before = readdirSync(d).sort();
  const hostile: [string, { name: string; body?: string | Uint8Array; type?: string; link?: string; size?: number }[], string][] = [
    ["first", [{ name: "ledger.sqlite", body: ledger }, { name: "memory.json", body: json }], "memory.json is not the first member"],
    ["link", [{ name: "memory.json", body: json }, { name: "ledger.sqlite", type: "2", link: "/etc/hostname" }], "is a link"],
    ["dotdot", [{ name: "memory.json", body: json }, { name: "../ledger.sqlite", body: ledger }], "a path that leaves"],
    ["unlisted", [{ name: "memory.json", body: json }, { name: "ledger.sqlite", body: ledger }, { name: "blobs/extra", body: "x" }], "blobs/extra is not listed in memory.json"],
    ["missing", [{ name: "memory.json", body: manifest([{ path: "blobs/a", sha256: sha256Hex("a"), bytes: 1 }, entry]) }, { name: "ledger.sqlite", body: ledger }], "blobs/a is listed in memory.json and is not in the file"],
    ["size", [{ name: "memory.json", body: manifest([{ ...entry, bytes: entry.bytes + 1 }]) }, { name: "ledger.sqlite", body: ledger }], "ledger.sqlite is not the size memory.json lists"],
    ["hash", [{ name: "memory.json", body: manifest([{ ...entry, sha256: "f".repeat(64) }]) }, { name: "ledger.sqlite", body: ledger }], "ledger.sqlite is not what memory.json lists"],
    ["not-a-manifest", [{ name: "memory.json", body: "{}" }, { name: "ledger.sqlite", body: ledger }], "memory.json is not a memory manifest"],
    ["no-ledger", [{ name: "memory.json", body: manifest([{ path: "blobs/a", sha256: sha256Hex("a"), bytes: 1 }]) }, { name: "blobs/a", body: "a" }], "memory.json is not a memory manifest"],
    ["other-member", [{ name: "memory.json", body: manifest([entry, { path: "run.sh", sha256: sha256Hex("a"), bytes: 1 }]) }, { name: "ledger.sqlite", body: ledger }, { name: "run.sh", body: "a" }], "memory.json is not a memory manifest"],
    ["journal", [{ name: "memory.json", body: manifest([entry, { path: "ledger.sqlite-journal", sha256: sha256Hex("a"), bytes: 1 }]) }, { name: "ledger.sqlite", body: ledger }, { name: "ledger.sqlite-journal", body: "a" }], "memory.json is not a memory manifest"],
  ];
  for (const [name, members, says] of hostile) {
    const file = join(d, `${name}.tar.gz`);
    rawCaseFile(file, members);
    expect(await refusal(checkMemoryFile(file)), name).toContain(says);
    const into = join(d, `into-${name}`);
    expect(await refusal(extractMemoryFile(file, into)), name).toContain(says);
    expect(existsSync(into), name).toBe(false);
    rmSync(file);
  }
  // more than the limit unpacked: a member that declares more than 256 MiB is refused from its header, before its body is read
  const big = join(d, "big.tar.gz");
  rawCaseFile(big, [{ name: "memory.json", body: json }, { name: "ledger.sqlite", body: ledger, size: MAX_MEMORY_FILE_BYTES + 1 }]);
  expect(await refusal(checkMemoryFile(big))).toContain(`larger than the limit of ${MAX_MEMORY_FILE_BYTES} bytes`);
  rmSync(big);
  expect(await refusal(checkMemoryFile(join(d, "nothing-here")))).toContain("there is no file there");
  expect(readdirSync(d).sort()).toEqual(before);
});

test("extractMemoryFile writes the members under a new folder and removes it when the file is refused part way", async () => {
  const d = tmp();
  const { dir, header } = storeIn(d);
  const file = join(d, "store.memory.tar.gz");
  const m = await writeMemoryFile(dir, file, header);
  const into = join(d, "into");
  const back = await extractMemoryFile(file, into);
  expect(canonical(back as unknown as Json)).toBe(canonical(m as unknown as Json));
  expect(readdirSync(into).sort()).toEqual(["ledger.sqlite"]);
  expect(sha256Hex(readFileSync(join(into, "ledger.sqlite")))).toBe(sha256Hex(readFileSync(join(dir, "ledger.sqlite"))));
  // the folder must not exist
  expect(await refusal(extractMemoryFile(file, into))).toContain("already exists");
  // a file refused after its first member was written: the folder is gone
  const ledger = readFileSync(join(dir, "ledger.sqlite"));
  const json = canonical({ format: 1, workbench: WORKBENCH_VERSION, ...header, files: [
    { path: "blobs/a", sha256: sha256Hex("a"), bytes: 1 }, { path: "ledger.sqlite", sha256: "e".repeat(64), bytes: ledger.length },
  ] } as unknown as Json);
  const bad = join(d, "bad.tar.gz");
  rawCaseFile(bad, [{ name: "memory.json", body: json }, { name: "blobs/a", body: "a" }, { name: "ledger.sqlite", body: ledger }]);
  const part = join(d, "part");
  expect(await refusal(extractMemoryFile(bad, part))).toContain("ledger.sqlite is not what memory.json lists");
  expect(existsSync(part)).toBe(false);
  // a store folder holding a link is not packed
  const linked = join(d, "linked");
  const s = MemoryStore.open(linked);
  s.close();
  symlinkSync("/etc/hostname", join(linked, "blobs", "x"));
  expect(await refusal(writeMemoryFile(linked, join(d, "linked.tar.gz"), header))).toContain("is a link");
  expect(existsSync(join(d, "linked.tar.gz"))).toBe(false);
});
