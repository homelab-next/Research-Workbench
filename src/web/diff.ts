// A proposed file's diff, as the loop builder's panel and the Improve lens both draw it: one line each, its op and its text, as text nodes.
import type { DiffLine } from "../core/wire";
import type { H } from "./dom";

const OP_CLASS: Record<DiffLine["op"], string> = { "+": "diff-added", "-": "diff-removed", " ": "diff-context" };

/** The lines of a diff as a list; an op it does not know is drawn as context. */
export const diffLines = (h: H, lines: readonly DiffLine[]): HTMLElement =>
  h("div", { class: "diff", role: "list" }, lines.map((l) => h("div", { class: `diff-line ${OP_CLASS[l.op] ?? "diff-context"}`, role: "listitem" }, `${l.op}${l.text}`)));
