import type { H } from "./dom";

/** What each refusal line last showed, by its key: a refusal is announced (role=alert) when first drawn and drawn quietly (role=status) on every repaint after. */
const shown = new Map<string, string>();

/**
 * Where a person's command was refused, beside the control that sent it (slice 10): "Refused: <the server's words>". Announced as an alert once; a
 * repaint of the same refusal under the same key is not announced again. Null when there is none (which also forgets the key, so a repeat is announced).
 */
export const refusalLine = (h: H, why: string | undefined, key: string): HTMLElement | null => {
  if (why === undefined) { shown.delete(key); return null; }
  const role = shown.get(key) === why ? "status" : "alert";
  shown.set(key, why);
  return h("p", { class: "refusal tag tag-attention", role }, `Refused: ${why}`);
};
