// A hand-made case file for the tests of a hostile archive: ustar headers written as given, gzipped, with no check of any kind.
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const enc = new TextEncoder();

function put(block: Uint8Array, at: number, len: number, text: string | Uint8Array): void {
  const bytes = typeof text === "string" ? enc.encode(text) : text;
  block.set(bytes.subarray(0, len), at);
}

const octal = (n: number, len: number): string => n.toString(8).padStart(len - 1, "0") + "\0";

function header(name: string, size: number, type: string, link: string): Uint8Array {
  const b = new Uint8Array(512);
  const nameBytes = enc.encode(name);
  if (nameBytes.length > 100) {
    // The whole name does not fit the name field: split it at the last "/" that leaves at most 100 bytes after it.
    const cut = name.lastIndexOf("/", name.length - 1);
    put(b, 0, 100, name.slice(cut + 1));
    put(b, 345, 155, name.slice(0, cut));
  } else {
    put(b, 0, 100, nameBytes);
  }
  put(b, 100, 8, octal(0o644, 8));
  put(b, 108, 8, octal(0, 8));
  put(b, 116, 8, octal(0, 8));
  put(b, 124, 12, octal(size, 12));
  put(b, 136, 12, octal(0, 12));
  put(b, 148, 8, "        ");
  put(b, 156, 1, type);
  put(b, 157, 100, link);
  put(b, 257, 6, "ustar\0");
  put(b, 263, 2, "00");
  let sum = 0;
  for (const x of b) sum += x;
  put(b, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return b;
}

/** A gzipped tar of exactly these members, written as given: no check of any kind. `type` is the tar type flag ("0" file, "1" hard link, "2" symlink, "5" directory, "x" pax); `size` overrides the size field. */
export function rawCaseFile(path: string, members: { name: string; body?: string | Uint8Array; type?: string; link?: string; size?: number }[]): void {
  const parts: Uint8Array[] = [];
  for (const m of members) {
    const body = m.body === undefined ? new Uint8Array(0) : typeof m.body === "string" ? enc.encode(m.body) : m.body;
    parts.push(header(m.name, m.size ?? body.length, m.type ?? "0", m.link ?? ""));
    parts.push(body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad > 0) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const tar = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { tar.set(p, at); at += p.length; }
  writeFileSync(path, gzipSync(tar));
}
