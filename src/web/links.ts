// The workbench's own links to files of this server (slice 12, and slice 13's memory files). Beside dom.ts, the only other place that makes an anchor.
import type { H } from "./dom";

/** A loop file's download path on this server, as `Api.loopFilePath` makes it: `/api/loop-files/<loop>.v<version>.<12 hex>.loop.tar.gz`, never `..`. */
const LOOP_FILE_PATH = /^\/api\/loop-files\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.v[0-9]{1,9}\.[0-9a-f]{12}\.loop\.tar\.gz$/;
/** A memory file's download path, as `Api.memoryFilePath` makes it: `/api/memory/files/memory.<marking>.<12 hex>.memory.tar.gz` (a "+" of the marking encoded). */
const MEMORY_FILE_PATH = /^\/api\/memory\/files\/memory\.(?:[A-Za-z0-9_-]|%2B){1,64}\.[0-9a-f]{12}\.memory\.tar\.gz$/;

/** An anchor that downloads `path` when it matches `shape`; for any other path a span holding the label. The server answers it as an attachment. */
function downloadLink(h: H, shape: RegExp, path: string, label: string): HTMLElement {
  if (!shape.test(path) || path.includes("..")) return h("span", { class: "download" }, label);
  const doc = h("span").ownerDocument;
  const el = doc.createElement("a");
  el.setAttribute("href", path);
  el.setAttribute("rel", "noopener noreferrer");
  el.setAttribute("download", "");
  el.setAttribute("class", "download");
  el.appendChild(doc.createTextNode(label));
  return el;
}

/** An anchor that downloads a file of the loop store (slice 12). */
export const loopFileLink = (h: H, path: string, label: string): HTMLElement => downloadLink(h, LOOP_FILE_PATH, path, label);
/** An anchor that downloads a file of the memory files folder (slice 13). */
export const memoryFileLink = (h: H, path: string, label: string): HTMLElement => downloadLink(h, MEMORY_FILE_PATH, path, label);
