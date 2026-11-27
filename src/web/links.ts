// The workbench's own links to files of this server (slice 12). Beside dom.ts, the only other place that makes an anchor.
import type { H } from "./dom";

/** A loop file's download path on this server, as `Api.loopFilePath` makes it: `/api/loop-files/<loop>.v<version>.<12 hex>.loop.tar.gz`, never `..`. */
const LOOP_FILE_PATH = /^\/api\/loop-files\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.v[0-9]{1,9}\.[0-9a-f]{12}\.loop\.tar\.gz$/;

/** An anchor that downloads a file of the loop store (slice 12); for any other path a span holding the label. The server answers it as an attachment. */
export function loopFileLink(h: H, path: string, label: string): HTMLElement {
  if (!LOOP_FILE_PATH.test(path) || path.includes("..")) return h("span", { class: "download" }, label);
  const doc = h("span").ownerDocument;
  const el = doc.createElement("a");
  el.setAttribute("href", path);
  el.setAttribute("rel", "noopener noreferrer");
  el.setAttribute("download", "");
  el.setAttribute("class", "download");
  el.appendChild(doc.createTextNode(label));
  return el;
}
