import type { Me, Reference } from "../core/wire";
import type { Api } from "./api";
import type { H } from "./dom";
import type { Prefs } from "./prefs";

export interface View { el: HTMLElement; update(): void; destroy?(): void }
export interface Ui {
  doc: Document; win: Window; h: H; api: Api; prefs: Prefs; me: Me; ref: Reference;
  toast(message: string, undo?: { label: string; act(): void }): void;
  reducedMotion(): boolean;
  /** Sends a command for the case on screen. A refusal becomes a toast with the server's words. Refused locally while replaying. Resolves true when done. */
  act(command: string, args?: Record<string, unknown>): Promise<boolean>;
}
