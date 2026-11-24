import type { Config } from "../modules/config";

export type Role = Config["role"];
export type Reading = "page" | "me" | "cases" | "reference" | "entries" | "models" | "custody" | "blob" | "bundle" | "preview" | "routes";

/** The analyst reads everything; the other views read the page and who they are, and nothing else. Checked on the server for every read. */
export function mayRead(role: Role, what: Reading): boolean {
  return role === "analyst" || what === "page" || what === "me";
}

/** The analyst does every command; the other views do none in this slice. */
export function mayDo(role: Role, _command: string): boolean {
  return role === "analyst";
}
