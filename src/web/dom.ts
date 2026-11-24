/** The only place that makes elements. Text goes in as text nodes; tags and props are fixed lists; a link is made only for https. */
export type Child = Node | string | number | null | undefined | false | Child[];
export interface Props {
  class?: string; id?: string; title?: string; name?: string;            // name → aria-label
  role?: string; tabindex?: number; type?: string; value?: string; placeholder?: string; for?: string;
  disabled?: boolean; checked?: boolean; hidden?: boolean; current?: boolean;   // current → aria-current="true"
  data?: Record<string, string>; aria?: Record<string, string>;
  on?: Record<string, (event: Event) => void>;
}
export type H = (tag: string, props?: Props | null, ...children: Child[]) => HTMLElement;

export const TAGS: readonly string[] = [
  "div", "span", "p", "h1", "h2", "h3", "header", "footer", "main", "nav", "section", "article", "aside", "button", "input", "textarea", "select", "option", "label",
  "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "pre", "code", "time", "details", "summary", "form", "fieldset", "legend", "kbd",
];
const PROPS = new Set(["class", "id", "title", "name", "role", "tabindex", "type", "value", "placeholder", "for", "disabled", "checked", "hidden", "current", "data", "aria", "on"]);
const TEXT_ATTRS: Record<string, string> = { class: "class", id: "id", title: "title", role: "role", type: "type", placeholder: "placeholder", for: "for" };
const BOOLEAN_ATTRS = ["disabled", "checked", "hidden"] as const;
const KEY = /^[a-z][a-z0-9-]*$/;

function append(doc: Document, el: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) { for (const c of child) append(doc, el, c); return; }
  if (typeof child === "string" || typeof child === "number") { el.appendChild(doc.createTextNode(String(child))); return; }
  el.appendChild(child);
}

/** Children that are strings or numbers become text nodes. A tag outside TAGS, or a prop outside Props, throws. */
export function makeH(doc: Document): H {
  return (tag, props, ...children) => {
    if (!TAGS.includes(tag)) throw new Error(`h: tag not allowed: ${tag}`);
    const el = doc.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (!PROPS.has(key)) throw new Error(`h: prop not allowed: ${key}`);
      if (value === undefined) continue;
      if (key in TEXT_ATTRS) el.setAttribute(TEXT_ATTRS[key]!, String(value));
      else if (key === "name") el.setAttribute("aria-label", String(value));
      else if (key === "tabindex") el.setAttribute("tabindex", String(value));
      else if (key === "value") { el.setAttribute("value", String(value)); (el as HTMLInputElement).value = String(value); }
      else if ((BOOLEAN_ATTRS as readonly string[]).includes(key)) { if (value === true) el.setAttribute(key, ""); }
      else if (key === "current") { if (value === true) el.setAttribute("aria-current", "true"); }
      else if (key === "data" || key === "aria") {
        for (const [k, v] of Object.entries(value as Record<string, string>)) {
          if (!KEY.test(k) || k.startsWith("on")) throw new Error(`h: ${key} name not allowed: ${k}`);
          el.setAttribute(`${key === "data" ? "data" : "aria"}-${k}`, String(v));
        }
      } else if (key === "on") {
        for (const [type, fn] of Object.entries(value as Record<string, unknown>)) {
          if (typeof fn !== "function") throw new Error(`h: handler for ${type} is not a function`);
          el.addEventListener(type, fn as EventListener);
        }
      }
      if (key === "checked" && value === true) (el as HTMLInputElement).checked = true;
    }
    for (const c of children) append(doc, el, c);
    return el;
  };
}

/** An anchor only for a URL that parses with protocol "https:"; rel="noopener noreferrer", target="_blank". Anything else is a span holding the label. */
export function link(h: H, url: string, label: string): HTMLElement {
  let ok = false;
  try { ok = url.startsWith("https://") && new URL(url).protocol === "https:"; } catch { ok = false; }
  return ok ? anchor(h, url, label) : h("span", null, label);
}

const FILE_PATH = /^\/api\/cases\/CASE-[0-9]+\/(blobs|published)\/[a-z0-9./]+$/;
/** An anchor to a blob or bundle of this server. Otherwise a span. */
export function fileLink(h: H, path: string, label: string): HTMLElement {
  return FILE_PATH.test(path) && !path.includes("..") ? anchor(h, path, label) : h("span", null, label);
}

/** The one anchor: a label, a target and a rel, which no prop of h can set. */
function anchor(h: H, href: string, label: string): HTMLElement {
  const doc = h("span").ownerDocument;
  const el = doc.createElement("a");
  el.setAttribute("href", href);
  el.setAttribute("rel", "noopener noreferrer");
  el.setAttribute("target", "_blank");
  el.appendChild(doc.createTextNode(label));
  return el;
}

export function clear(el: HTMLElement): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/** Makes `parent`'s element children match `items` by key, reusing nodes: `make` for a new key, `update` for a kept one; order follows `items`; focus stays on a kept node. */
export function syncList<T>(parent: HTMLElement, items: readonly T[], key: (item: T) => string, make: (item: T) => HTMLElement, update: (el: HTMLElement, item: T) => void): void {
  const old = new Map<string, HTMLElement>();
  for (const el of Array.from(parent.children) as HTMLElement[]) {
    const k = (el as unknown as { __key?: string }).__key;
    if (k !== undefined) old.set(k, el);
  }
  const wanted: HTMLElement[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    const kept = old.get(k);
    let el: HTMLElement;
    if (kept) { update(kept, item); el = kept; } else { el = make(item); (el as unknown as { __key?: string }).__key = k; }
    wanted.push(el);
  }
  for (const [k, el] of old) if (!seen.has(k)) el.remove();
  // Move only what is out of place, so a kept node (and the focus in it) is not detached.
  let at: Node | null = parent.firstElementChild;
  for (const el of wanted) {
    if (el === at) { at = el.nextElementSibling; continue; }
    parent.insertBefore(el, at);
  }
}
