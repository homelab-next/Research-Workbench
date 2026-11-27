import type { Config } from "../modules/config";

export type Role = Config["role"];
export type Reading = "page" | "me" | "cases" | "reference" | "entries" | "models" | "custody" | "blob" | "bundle" | "preview" | "routes" | "difference" | "agent" | "store" | "loops" | "loop_files";
/** The commands of the Loops page: routes of their own, each a person's act, checked like every command. */
export const LOOP_COMMANDS = ["copy_loop", "save_loop", "export_loop", "import_loop", "trust_root"] as const;

/** The analyst reads everything; the other views read the page and who they are, and nothing else. Checked on the server for every read. */
export function mayRead(role: Role, what: Reading): boolean {
  return role === "analyst" || what === "page" || what === "me";
}

/** The analyst does every command; the other views do none in this slice. */
export function mayDo(role: Role, _command: string): boolean {
  return role === "analyst";
}
