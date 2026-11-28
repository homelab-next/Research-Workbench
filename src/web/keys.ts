/** The keyboard map: the one table both the key handler and the "?" card are made from. */
export type Area = "anywhere" | "incoming" | "columns" | "lanes" | "lenses" | "replay";
export interface KeyBinding { area: Area; keys: readonly string[]; action: string; label: string }

const b = (area: Area, keys: readonly string[], action: string, label: string): KeyBinding => ({ area, keys, action, label });
const LENS_KEYS: readonly [string, string, string][] = [
  ["a", "agent", "Agent"], ["s", "steps", "Steps"], ["t", "timeline", "Timeline"], ["g", "graph", "Graph"], ["r", "narrative", "Narrative"], ["w", "worklog", "Worklog"], ["m", "memory", "Memory"],
  ["d", "discarded", "Discarded"], ["b", "jobs", "Jobs"], ["q", "pipeline", "Pipeline"], ["i", "improve", "Improve"], ["e", "replay", "Replay"],
];

export const KEYMAP: readonly KeyBinding[] = [
  b("anywhere", ["?"], "help", "Show keys"),
  b("anywhere", ["/"], "command_bar", "Command bar"),
  b("anywhere", ["Escape"], "up", "Close, then step up a level"),
  b("anywhere", ["Shift+Enter"], "next_thing", "Do what the run waits on"),
  b("incoming", ["j", "ArrowDown"], "next_card", "Next card"),
  b("incoming", ["k", "ArrowUp"], "prev_card", "Previous card"),
  b("incoming", ["Space", "ArrowRight"], "keep", "Keep into the target lane"),
  b("incoming", ["x", "ArrowLeft", "Backspace"], "discard", "Discard"),
  b("incoming", ["p"], "pin", "Pin"),
  b("incoming", ["o"], "keep_open", "Keep open"),
  b("incoming", ["Enter"], "open_card", "Open"),
  b("incoming", ["u"], "undo", "Undo"),
  b("incoming", ["c"], "cite", "Cite"),
  b("columns", ["Tab", "l", "]"], "next_column", "Next column"),
  b("columns", ["Shift+Tab", "h", "["], "prev_column", "Previous column"),
  b("columns", ["0"], "focus_incoming", "Incoming"),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => b("columns", [`${n}`], `target_${n}`, "Set keep target")),
  b("lanes", ["j", "ArrowDown"], "next_card", "Next card"),
  b("lanes", ["k", "ArrowUp"], "prev_card", "Previous card"),
  b("lanes", ["Shift+H"], "card_left", "Move the card one lane left"),
  b("lanes", ["Shift+L"], "card_right", "Move the card one lane right"),
  b("lanes", ["F2"], "rename_lane", "Rename the lane"),
  b("lanes", ["Enter"], "open_card", "Open"),
  b("lanes", ["x", "Backspace"], "discard", "Discard"),
  b("lanes", ["u"], "undo", "Undo"),
  b("lanes", ["c"], "cite", "Cite"),
  ...LENS_KEYS.map(([key, id, title]) => b("lenses", [key], `lens_${id}`, title)),
  b("lenses", ["v"], "dock_side", "Dock side"),
  b("replay", ["j", "ArrowDown"], "replay_next", "Next entry"),
  b("replay", ["k", "ArrowUp"], "replay_prev", "Previous entry"),
];

/** "j", "J" → "j"; with Shift held a letter is "Shift+H"; " " → "Space"; Shift+Tab and Shift+Enter keep their Shift; everything else as typed. */
export function keyOf(event: KeyboardEvent): string {
  const key = event.key;
  if (key === " ") return "Space";
  if (key.length === 1 && key.toLowerCase() !== key.toUpperCase()) return event.shiftKey ? `Shift+${key.toUpperCase()}` : key.toLowerCase();
  if ((key === "Tab" || key === "Enter") && event.shiftKey) return `Shift+${key}`;
  return key;
}

const CONTROLS = "button, a, input, textarea, select, [contenteditable]";
/** The kind of thing that has focus: "text" where typing happens (and the key belongs to the field), "control" for a button or link, else null. */
export function controlOf(target: Element | null): "text" | "control" | null {
  const node = target !== null && typeof target.closest === "function" ? target.closest(CONTROLS) : null;
  if (node === null) return null;
  const tag = node.tagName.toLowerCase();
  if (tag === "button" || tag === "a") return "control";
  if (tag === "input" || tag === "textarea" || tag === "select") return "text";
  const ce = node.getAttribute("contenteditable");
  return ce === null || ce === "false" ? null : "text";
}

/** The area of the focused element: the nearest ancestor's data-area. Null when focus is in a button, input, textarea, select or link. */
export function areaOf(target: Element | null): Area | null {
  if (controlOf(target) !== null) return null;
  const node = target !== null && typeof target.closest === "function" ? target.closest("[data-area]") : null;
  switch (node?.getAttribute("data-area")) {
    case "incoming": return "incoming";
    case "lanes": return "lanes";
    case "lens": return "lenses";
    case "replay": return "replay";
    default: return "anywhere";
  }
}

/** The binding for `key` in the focused area, then (for a column area) "columns", then "lenses", then "anywhere". */
export function bindingFor(area: Area, key: string): KeyBinding | null {
  const order: Area[] = area === "incoming" || area === "lanes" ? [area, "columns", "lenses", "anywhere"] : area === "anywhere" ? ["lenses", "anywhere"] : [area, "lenses", "anywhere"];
  for (const a of order) {
    const hit = KEYMAP.find((x) => x.area === a && x.keys.includes(key));
    if (hit !== undefined) return hit;
  }
  return null;
}

/** Keys that still work when a button or link has focus (the page's own, not a card's). */
const FROM_CONTROLS = new Set(["?", "/", "Escape"]);

/** Finds the binding for the key in the focused area and calls its action. Returns whether one ran; the caller prevents the default when it did. A field keeps every key; a button or link keeps all but `?`, `/` and Escape. */
export function dispatchKey(event: KeyboardEvent, actions: Readonly<Record<string, () => void>>): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  const target = event.target as Element | null;
  const control = controlOf(target);
  if (control === "text") return false;
  const key = keyOf(event);
  let area = areaOf(target);
  if (area === null) { if (!FROM_CONTROLS.has(key)) return false; area = "anywhere"; }
  const hit = bindingFor(area, key);
  if (hit === null) return false;
  const run = Object.hasOwn(actions, hit.action) ? actions[hit.action] : undefined;
  if (run === undefined) return false;
  run();
  return true;
}
