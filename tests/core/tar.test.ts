import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { Refused } from "../../src/core/refused";
import { memberProblem, readTarGz, TarError, writeTarGz } from "../../src/core/tar";
import type { TarMember, TarSink } from "../../src/core/tar";
import { rawCaseFile } from "../helpers/tar";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "rw-tar-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const enc = new TextEncoder();
const UNREADABLE = "the file is not a readable archive";

const member = (name: string, bytes: Uint8Array, pieces = 1): TarMember => ({
  name, size: bytes.length,
  *open() {
    const step = Math.max(1, Math.ceil(bytes.length / pieces));
    for (let at = 0; at < bytes.length; at += step) yield bytes.subarray(at, at + step);
  },
});

/** A sink that keeps every member it is handed, in order. */
function keeper(): { sink: TarSink; got: { name: string; size: number; bytes: Uint8Array }[] } {
  const got: { name: string; size: number; bytes: Uint8Array }[] = [];
  return {
    got,
    sink: {
      open(name, size) {
        const pieces: Uint8Array[] = [];
        return {
          write: (p) => void pieces.push(p.slice()),
          end: () => {
            const bytes = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
            let at = 0;
            for (const p of pieces) { bytes.set(p, at); at += p.length; }
            got.push({ name, size, bytes });
          },
        };
      },
    },
  };
}

async function refusal(p: Promise<unknown>): Promise<TarError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(TarError);
    expect(err).toBeInstanceOf(Refused);
    return err as TarError;
  }
  throw new Error("expected a refusal");
}

const read = (file: string, max = 1_000_000) => {
  const k = keeper();
  return { k, done: readTarGz(file, { max, sink: k.sink, unreadable: UNREADABLE }) };
};

test("writeTarGz and readTarGz round-trip three members, byte for byte, in order", async () => {
  const big = new Uint8Array(200_000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 7) % 251;
  const deep = `manifests/${"d".repeat(80)}/${"e".repeat(60)}.yaml`;
  const members = [member("loop.json", enc.encode("{\"a\":1}")), member(deep, big, 5), member("empty", new Uint8Array(0))];
  const file = join(root, "x.tar.gz");
  await writeTarGz(file, members);
  const { k, done } = read(file);
  await done;
  expect(k.got.map((g) => [g.name, g.size])).toEqual([["loop.json", 7], [deep, 200_000], ["empty", 0]]);
  expect(k.got[0]!.bytes).toEqual(enc.encode("{\"a\":1}"));
  expect(k.got[1]!.bytes).toEqual(big);
  expect(k.got[2]!.bytes).toEqual(new Uint8Array(0));
  // writeTarGz does not overwrite
  expect((await refusal(writeTarGz(file, members))).problem).toEqual({ kind: "exists", dest: file });
});

test("the same members pack to the same bytes inside the gzip", async () => {
  const mk = () => [member("a.json", enc.encode("one")), member("b/c.txt", enc.encode("two two"), 3)];
  await writeTarGz(join(root, "1.tar.gz"), mk());
  await writeTarGz(join(root, "2.tar.gz"), mk());
  const t1 = gunzipSync(readFileSync(join(root, "1.tar.gz")));
  const t2 = gunzipSync(readFileSync(join(root, "2.tar.gz")));
  expect(t1.length).toBe(512 * 4 + 1024);
  expect(Buffer.from(t1).equals(Buffer.from(t2))).toBe(true);
  // and a writer that is handed a name it must not write refuses before the file exists
  const bad = join(root, "bad.tar.gz");
  expect((await refusal(writeTarGz(bad, [member("../x", enc.encode("x"))]))).problem.kind).toBe("bad_name");
  expect((await refusal(writeTarGz(bad, [member(`${"f".repeat(101)}`, enc.encode("x"))]))).problem.kind).toBe("long_name");
  expect(() => readFileSync(bad)).toThrow();
});

test("a link, a directory, a device, a pax header and a GNU long name are each refused by kind", async () => {
  const cases: [string, { name: string; type: string; link?: string; body?: string }, string, string][] = [
    ["a symlink", { name: "m/evil", type: "2", link: "/etc/passwd" }, "link", "m/evil is a link"],
    ["a hard link", { name: "m/evil", type: "1", link: "first" }, "link", "m/evil is a link"],
    ["a directory", { name: "m", type: "5" }, "not_regular", "m is not a regular file"],
    ["a device", { name: "m/dev", type: "3" }, "not_regular", "m/dev is not a regular file"],
    ["a pax header", { name: "PaxHeaders/x", type: "x", body: "30 path=../../etc/passwd\n" }, "not_regular", "PaxHeaders/x is not a regular file"],
    ["a GNU long name", { name: "././@LongLink", type: "L", body: "x".repeat(200) }, "not_regular", "././@LongLink is not a regular file"],
  ];
  for (const [what, m, kind, starts] of cases) {
    const file = join(root, "bad.tar.gz");
    rawCaseFile(file, [{ name: "first", body: "ok" }, m]);
    const { k, done } = read(file);
    const err = await refusal(done);
    expect({ what, kind: err.problem.kind as string, starts: err.message.startsWith(starts) }).toEqual({ what, kind, starts: true });
    // the member before it was handed on; the refused one never was
    expect(k.got.map((g) => g.name)).toEqual(["first"]);
  }
});

test("an absolute name, a name with .., an empty segment, a backslash or a NUL is refused", async () => {
  const cases: [string, string][] = [
    ["/abs", "/abs: an absolute path"],
    ["../x", "../x: a path that leaves the case folder"],
    ["m/../../x", "m/../../x: a path that leaves the case folder"],
    ["m//x", "m//x: an empty path segment"],
    ["m\\x", "m\\x: a backslash in a path"],
    ["m/a\0b", "m/a�b: a NUL in a path"],
  ];
  for (const [name, message] of cases) {
    expect(memberProblem(name)).not.toBeNull();
    const file = join(root, "bad.tar.gz");
    rawCaseFile(file, [{ name, body: "x" }]);
    const { k, done } = read(file);
    const err = await refusal(done);
    expect({ name, message: err.message, kind: err.problem.kind }).toEqual({ name, message, kind: "bad_name" });
    expect(k.got).toEqual([]);
  }
  expect(memberProblem("manifests/loops/a.yaml")).toBeNull();
});

test("a name twice is refused; more than max bytes is refused from the header and again from the stream", async () => {
  const twice = join(root, "twice.tar.gz");
  rawCaseFile(twice, [{ name: "a", body: "1" }, { name: "b", body: "2" }, { name: "a", body: "3" }]);
  const t = read(twice);
  const err = await refusal(t.done);
  expect([err.message, err.problem]).toEqual(["a appears twice", { kind: "twice", name: "a" }]);
  expect(t.k.got.map((g) => g.name)).toEqual(["a", "b"]);

  // a header that says 3 GB with no body behind it: refused by the header alone, before the sink is asked
  const huge = join(root, "huge.tar.gz");
  rawCaseFile(huge, [{ name: "a", body: "1" }, { name: "big", size: 3_000_000_000 }]);
  const h = read(huge, 16_777_216);
  expect((await refusal(h.done)).problem).toEqual({ kind: "too_large", max: 16_777_216 });
  expect(h.k.got.map((g) => g.name)).toEqual(["a"]);

  // a header that says 10 over a body gzip makes from almost nothing: refused by the bytes that come out of gzip
  const bomb = join(root, "bomb.tar.gz");
  rawCaseFile(bomb, [{ name: "small", size: 10, body: new Uint8Array(1 << 20) }]);
  expect(readFileSync(bomb).length).toBeLessThan(4096);
  const b = read(bomb, 100_000);
  expect((await refusal(b.done)).problem).toEqual({ kind: "too_large", max: 100_000 });

  // damaged bytes are the caller's sentence for an unreadable file; a missing file is not called unreadable
  const junk = join(root, "junk.tar.gz");
  writeFileSync(junk, "this is not gzip");
  const j = await refusal(read(junk).done);
  expect([j.message, j.problem.kind]).toEqual([UNREADABLE, "unreadable"]);
  const m = await refusal(read(join(root, "missing.tar.gz")).done);
  expect(m.problem.kind).toBe("missing");
});

test("a sink's refusal is passed on as it was thrown", async () => {
  const file = join(root, "x.tar.gz");
  await writeTarGz(file, [member("a", enc.encode("1"))]);
  class Mine extends Error {}
  const thrown = new Mine("not this one");
  let caught: unknown;
  try {
    await readTarGz(file, { max: 1000, unreadable: UNREADABLE, sink: { open: () => { throw thrown; } } });
  } catch (err) { caught = err; }
  expect(caught).toBe(thrown);
});

test("every case-file test still passes with casefile.ts reading and writing through tar.ts", async () => {
  // the existing tests/core/casefile.test.ts runs unchanged; this holds casefile.ts to the one tar reader and writer
  const text = readFileSync(join(import.meta.dir, "../../src/core/casefile.ts"), "utf8");
  expect(text).toMatch(/from "\.\/tar"/);
  for (const gone of ["function ustarHeader", "function splitName", "function octalField", "function gzipInto", "class Source", "function readHeader", "function kindProblem", "createGunzip", "createGzip"]) {
    expect({ gone, found: text.includes(gone) }).toEqual({ gone, found: false });
  }
  const casefile = await import("../../src/core/casefile");
  expect(casefile.memberProblem).toBe(memberProblem);
});
