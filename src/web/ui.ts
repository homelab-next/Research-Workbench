import type { CommandResult, Me, Reference } from "../core/wire";
import type { Api } from "./api";
import type { H } from "./dom";
import type { Prefs } from "./prefs";
import type { CaseStore } from "./store";

export interface View { el: HTMLElement; update(): void; destroy?(): void }
export interface Ui {
  doc: Document; win: Window; h: H; api: Api; prefs: Prefs; me: Me; ref: Reference;
  toast(message: string, undo?: { label: string; act(): void }): void;
  reducedMotion(): boolean;
  /** Sends a command for the case on screen. A refusal becomes a toast with the server's words. Refused locally while replaying. Resolves true when done. */
  act(command: string, args?: Record<string, unknown>): Promise<boolean>;
  /** The same send, answering what the server said: null when nothing was accepted (refused, replaying, no answer); the toast has been shown. `refusal` replaces the server's words in that toast. */
  send(command: string, args?: Record<string, unknown>, refusal?: string): Promise<Extract<CommandResult, { ok: true }> | null>;
}

export const REPLAY_REFUSAL = "Return to live to change the case";
export const NO_ANSWER = "The server did not answer.";

/** Real `send` and `act` for the case `current()` names. Nothing is changed here: the screen moves when the entries arrive on the stream. */
export function makeSend(ui: Pick<Ui, "api" | "toast">, current: () => CaseStore | null): Pick<Ui, "send" | "act"> {
  const send: Ui["send"] = async (command, args = {}, refusal) => {
    const store = current();
    if (store === null) { ui.toast("Open a case first"); return null; }
    if (store.at !== null) { ui.toast(REPLAY_REFUSAL); return null; }
    let result: CommandResult;
    try {
      result = await ui.api.command(store.id, command, args);
    } catch {
      ui.toast(NO_ANSWER);
      return null;
    }
    if (!result.ok) { ui.toast(refusal ?? result.refused.join("; ")); return null; }
    return result;
  };
  return { send, act: async (command, args) => (await send(command, args)) !== null };
}
