/** The only place that makes SVG elements. Tags, props and attribute names are fixed lists; text goes in as text nodes; nothing from data names a tag or an attribute. */
export type SChild = Node | string | number | null | undefined | false | SChild[];
export interface SProps {
  class?: string; id?: string; role?: string; name?: string; tabindex?: number; hidden?: boolean;      // name → aria-label; hidden → aria-hidden="true"
  x?: number; y?: number; width?: number; height?: number; cx?: number; cy?: number; r?: number; rx?: number; x1?: number; y1?: number; x2?: number; y2?: number;
  viewBox?: [number, number, number, number]; points?: [number, number][]; translate?: [number, number];
  anchor?: "start" | "middle" | "end"; stretch?: boolean;                                            // text-anchor; preserveAspectRatio="none"
  data?: Record<string, string>; aria?: Record<string, string>; on?: Record<string, (event: Event) => void>;
}
export type S = (tag: string, props?: SProps | null, ...children: SChild[]) => SVGElement;

export const SVG_TAGS: readonly string[] = ["svg", "g", "line", "rect", "circle", "path", "text", "title"];
const NS = "http://www.w3.org/2000/svg";
const PROPS = new Set(["class", "id", "role", "name", "tabindex", "hidden", "x", "y", "width", "height", "cx", "cy", "r", "rx", "x1", "y1", "x2", "y2", "viewBox", "points", "translate", "anchor", "stretch", "data", "aria", "on"]);
const TEXT_ATTRS: Record<string, string> = { class: "class", id: "id", role: "role" };
const NUMBER_ATTRS = ["x", "y", "width", "height", "cx", "cy", "r", "rx", "x1", "y1", "x2", "y2"] as const;
const ANCHORS = ["start", "middle", "end"];
const KEY = /^[a-z][a-z0-9-]*$/;

/** At most two decimals, no trailing zeros. */
function num(name: string, v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`s: ${name} must be a finite number`);
  return String(Math.round(v * 100) / 100);
}
function append(doc: Document, el: Node, child: SChild): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) { for (const c of child) append(doc, el, c); return; }
  if (typeof child === "string" || typeof child === "number") { el.appendChild(doc.createTextNode(String(child))); return; }
  el.appendChild(child);
}
function pair(name: string, v: unknown, n: number): string[] {
  if (!Array.isArray(v) || v.length !== n) throw new Error(`s: ${name} must be ${n} numbers`);
  return v.map((x) => num(name, x));
}

export function makeS(doc: Document): S {
  return (tag, props, ...children) => {
    if (!SVG_TAGS.includes(tag)) throw new Error(`s: tag not allowed: ${tag}`);
    const el = doc.createElementNS(NS, tag) as unknown as SVGElement;
    for (const [key, value] of Object.entries(props ?? {})) {
      if (!PROPS.has(key)) throw new Error(`s: prop not allowed: ${key}`);
      if (value === undefined) continue;
      if (key in TEXT_ATTRS) el.setAttribute(TEXT_ATTRS[key]!, String(value));
      else if ((NUMBER_ATTRS as readonly string[]).includes(key)) el.setAttribute(key, num(key, value));
      else if (key === "name") el.setAttribute("aria-label", String(value));
      else if (key === "tabindex") el.setAttribute("tabindex", num(key, value));
      else if (key === "hidden") { if (value === true) el.setAttribute("aria-hidden", "true"); }
      else if (key === "stretch") { if (value === true) el.setAttribute("preserveAspectRatio", "none"); }
      else if (key === "viewBox") el.setAttribute("viewBox", pair(key, value, 4).join(" "));
      else if (key === "translate") el.setAttribute("transform", `translate(${pair(key, value, 2).join(" ")})`);
      else if (key === "anchor") {
        if (!ANCHORS.includes(value as string)) throw new Error(`s: anchor not allowed: ${String(value)}`);
        el.setAttribute("text-anchor", value as string);
      } else if (key === "points") {
        if (tag !== "path") throw new Error("s: points is for path only");
        const pts = (value as unknown[]).map((p) => pair(key, p, 2).join(" "));
        el.setAttribute("d", pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p}`).join(" "));
      } else if (key === "data" || key === "aria") {
        for (const [k, v] of Object.entries(value as Record<string, string>)) {
          if (!KEY.test(k) || k.startsWith("on")) throw new Error(`s: ${key} name not allowed: ${k}`);
          el.setAttribute(`${key}-${k}`, String(v));
        }
      } else if (key === "on") {
        for (const [type, fn] of Object.entries(value as Record<string, unknown>)) {
          if (typeof fn !== "function") throw new Error(`s: handler for ${type} is not a function`);
          el.addEventListener(type, fn as EventListener);
        }
      }
    }
    for (const c of children) append(doc, el, c);
    return el;
  };
}
