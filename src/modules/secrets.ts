import { readFileSync, statSync } from "node:fs";
import { isPlainObject } from "../core/canonical";

/** Secret values from the environment first, then from a YAML map of name to string kept at mode 0600. */
export class Secrets {
  private readonly fromFile = new Map<string, string>();

  constructor(private readonly env: Record<string, string | undefined>, file: string | null) {
    if (file === null) return;
    let mode: number;
    try {
      mode = statSync(file).mode;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`secrets file ${file} cannot be read: ${(err as Error).message}`);
    }
    if ((mode & 0o077) !== 0) {
      throw new Error(`secrets file ${file} is readable by others (mode ${(mode & 0o777).toString(8)}); set it to 0600`);
    }
    const parsed: unknown = Bun.YAML.parse(readFileSync(file, "utf8"));
    if (parsed === null || parsed === undefined) return;
    if (!isPlainObject(parsed)) throw new Error(`secrets file ${file} must be a mapping of name to value`);
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string" || typeof v === "number") this.fromFile.set(k, String(v));
    }
  }

  get(name: string): string | null {
    if (Object.hasOwn(this.env, name) && this.env[name] !== undefined) return this.env[name]!;
    return this.fromFile.get(name) ?? null;
  }
}
