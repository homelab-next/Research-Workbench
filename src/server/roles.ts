import type { Config } from "../modules/config";

export type Role = Config["role"];
export type Reading = "page" | "me" | "cases" | "reference" | "entries" | "models" | "custody" | "blob" | "bundle" | "preview" | "routes" | "difference" | "agent" | "store" | "loops" | "loop_files" | "builders" | "memory" | "improve";
/** The commands of the Loops page: routes of their own, each a person's act, checked like every command. */
export const LOOP_COMMANDS = ["copy_loop", "save_loop", "export_loop", "import_loop", "trust_root"] as const;
/** The loop builder's commands (slice 12, part B): routes of their own, each a person's act. */
export const BUILDER_COMMANDS = ["create_builder", "builder_ask", "builder_decide", "builder_probe", "builder_model"] as const;
/** The Memory page's commands (slice 13): routes of their own, each a person's act. Only a person proposes, accepts, rejects or retires a lesson here. */
export const MEMORY_COMMANDS = ["propose_lesson", "accept_lesson", "reject_lesson", "retire_lesson", "export_memory", "load_memory"] as const;

/**
 * The improve loop's commands (slice 14), each a person's act: an improve case is made by its own route; a known answer is set and withdrawn,
 * and the chosen candidate is accepted or rejected whole at the adopt gate, as case commands.
 */
export const IMPROVE_COMMANDS = ["create_improve", "set_known_answer", "withdraw_known_answer", "adopt_decide"] as const;

/** The analyst reads everything; the other views read the page and who they are, and nothing else. Checked on the server for every read. */
export function mayRead(role: Role, what: Reading): boolean {
  return role === "analyst" || what === "page" || what === "me";
}

/** The analyst does every command; the other views do none in this slice. */
export function mayDo(role: Role, _command: string): boolean {
  return role === "analyst";
}
