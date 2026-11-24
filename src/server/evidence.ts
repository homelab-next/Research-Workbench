/** Blobs, published bundles and the custody report, served from the record. No path is ever built from a request. */
import { BlobCorruptError, BlobMissingError, isBlobRef } from "../core/blobs";
import { canonical, parseJson } from "../core/canonical";
import type { Json } from "../core/canonical";
import type { CaseSession } from "../core/session";
import { BLOB_FIELDS } from "../core/types";
import { verifyCase } from "../core/verify";
import type { Custody } from "../core/wire";

const HASH = /^[0-9a-f]{64}$/;
const BUNDLE_N = /^[1-9][0-9]{0,5}$/;

const refused = (status: number, reason: string): Response => Response.json({ ok: false, refused: [reason] }, { status });

/** The recorded media types that are served as what they say; every other one is bytes to save. Never HTML or SVG. */
const BLOB_TYPES: Readonly<Record<string, { type: string; ext: string }>> = {
  "application/json": { type: "application/json", ext: "json" },
  "text/plain": { type: "text/plain; charset=utf-8", ext: "txt" },
  "text/csv": { type: "text/plain; charset=utf-8", ext: "txt" },
  "application/x-ndjson": { type: "text/plain; charset=utf-8", ext: "txt" },
};
const OTHER = { type: "application/octet-stream", ext: "bin" };
/** The recorded media with any parameters (`;charset=utf-8`) and case dropped, looked up in the list above. */
const blobType = (media: string | undefined): { type: string; ext: string } => {
  const base = media?.split(";")[0]!.trim().toLowerCase();
  return base !== undefined && Object.hasOwn(BLOB_TYPES, base) ? BLOB_TYPES[base]! : OTHER;
};

/** The first reference to `hash` at a typed blob position of this case's entries, with the media recorded on it; null when the case names no such blob. */
function referenceTo(session: CaseSession, hash: string): { media: string | undefined } | null {
  for (const e of session.entries()) {
    if (!Object.hasOwn(BLOB_FIELDS, e.type)) continue;
    const payload = e.payload as unknown as Record<string, unknown>;
    for (const field of BLOB_FIELDS[e.type as keyof typeof BLOB_FIELDS] as readonly string[]) {
      const ref = payload[field];
      if (isBlobRef(ref) && ref.blob === hash) return { media: typeof ref.media === "string" ? ref.media : undefined };
    }
  }
  return null;
}

/** The bytes of a blob this case names, re-hashed as they are read. A mismatch is a 500 that says so and sends no bytes. */
export function blobResponse(session: CaseSession, hash: string): Response {
  if (!HASH.test(hash)) return refused(400, "a blob is named by 64 lower-case hexadecimal characters");
  const ref = referenceTo(session, hash);
  if (ref === null) return refused(404, `blob ${hash} is not part of this case`);
  let bytes: Uint8Array;
  try {
    bytes = session.blobs.get(hash);
  } catch (error) {
    if (error instanceof BlobMissingError) return refused(404, `blob ${hash} is missing`);
    if (error instanceof BlobCorruptError) return refused(500, `blob ${hash} is corrupt`);
    throw error;
  }
  const kind = blobType(ref.media);
  return new Response(new Uint8Array(bytes), { headers: { "content-type": kind.type, "content-disposition": `attachment; filename="${hash.slice(0, 12)}.${kind.ext}"` } });
}

/** A case id as a file name part: only characters that cannot end a quoted name or start a path. */
const safeName = (text: string): string => text.replace(/[^A-Za-z0-9._-]/g, "_");

/** One file of published bundle `n`, from the bundle blob its product.published entry names, looked up by name in that bundle's manifest. */
export function bundleFile(session: CaseSession, n: string, file: string): Response {
  if (!BUNDLE_N.test(n)) return refused(404, "there is no such bundle");
  const entry = session.entries().find((e) => e.type === "product.published" && e.payload.n === Number(n));
  if (entry === undefined || entry.type !== "product.published") return refused(404, `bundle ${n} was not published`);
  const hash = entry.payload.bundle.blob;
  let body: Json;
  try {
    const parsed = parseJson(new TextDecoder().decode(session.blobs.get(hash)));
    if (parsed === null) return refused(500, `the blob of bundle ${n} is not a bundle`);
    body = parsed.value;
  } catch (error) {
    if (error instanceof BlobMissingError) return refused(404, `the blob of bundle ${n} is missing`);
    if (error instanceof BlobCorruptError) return refused(500, `the blob of bundle ${n} is corrupt`);
    throw error;
  }
  const bundle = body as { manifest?: { files?: { name?: unknown }[] }; files?: Record<string, unknown> } | null;
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle) || typeof bundle.manifest !== "object" || bundle.manifest === null
    || !Array.isArray(bundle.manifest.files) || typeof bundle.files !== "object" || bundle.files === null) return refused(500, `the blob of bundle ${n} is not a bundle`);
  let text: string;
  if (file === "manifest.json") text = canonical(bundle.manifest as unknown as Json);
  else {
    // the name must be one the manifest lists; the text is then the bundle's own, never a file of the folder
    const listed = bundle.manifest.files.some((f) => f.name === file);
    const content = listed && Object.hasOwn(bundle.files, file) ? bundle.files[file] : undefined;
    if (typeof content !== "string") return refused(404, `bundle ${n} has no file ${file.slice(0, 40)}`);
    text = content;
  }
  const type = file.endsWith(".md") ? "text/markdown; charset=utf-8" : file.endsWith(".json") ? "application/json" : "application/octet-stream";
  return new Response(text, { headers: { "content-type": type, "content-disposition": `attachment; filename="${safeName(session.id)}-${n}-${safeName(file)}"` } });
}

/** What the check of the record found, from verify's own result, with the one sentence that says it. */
export function custodyOf(session: CaseSession): Custody {
  const r = verifyCase(session.dir);
  const badBundle = r.published.bundles.find((b) => b.state !== "ok");
  let line = `chain intact · ${r.entries} entries`;
  if (!r.ok) {
    if (r.firstBad !== null) line = `chain broken at entry ${r.firstBad.seq} (${r.firstBad.reason})`;
    else if (r.blobs.bad.length > 0) line = `${r.blobs.bad.length} blob(s) missing or corrupt, first at entry ${r.blobs.bad[0]!.seq}`;
    else if (badBundle !== undefined) line = `published bundle ${badBundle.n} ${badBundle.state}`;
    else line = `published folder ${r.published.unrecorded[0] ?? "?"} is not recorded by any entry`;
  }
  return {
    ok: r.ok, entries: r.entries, head: r.head, first_bad: r.firstBad === null ? null : { seq: r.firstBad.seq, reason: r.firstBad.reason },
    bad_blobs: r.blobs.bad, published: r.published, skipped: session.state.skipped.length, line,
  };
}
