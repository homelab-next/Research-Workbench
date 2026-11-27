import type { H } from "./dom";

/** Where a person's command was refused, beside the control that sent it (slice 10): "Refused: <the server's words>", announced as an alert. Null when there is none. */
export const refusalLine = (h: H, why: string | undefined): HTMLElement | null =>
  why === undefined ? null : h("p", { class: "refusal tag tag-attention", role: "alert" }, `Refused: ${why}`);
