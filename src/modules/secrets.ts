import { readFileSync, statSync } from "node:fs";
import { isPlainObject } from "../core/canonical";

/** The shortest credential value accepted. A shorter one is too easy to find by chance in a result, and too easy to guess. */
export const MIN_SECRET_LENGTH = 8;

export class SecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretError";
  }
}

/**
 * Secret values from the environment first, then from a YAML map of name to string kept at mode 0600.
 * Values live in private fields, so nothing enumerates, prints or serialises them. Only the connectors call
 * `get`, and only with a credential name the registry has allowed for the source's root.
 */
export class Secrets {
  readonly #env: Record<string, string | undefined>;
  readonly #fromFile = new Map<string, string>();

  constructor(env: Record<string, string | undefined>, file: string | null) {
    this.#env = env;
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
      if (typeof v === "string" || typeof v === "number") this.#fromFile.set(k, String(v));
    }
  }

  /** The value, or null when there is none. Throws SecretError for a value that is empty or shorter than MIN_SECRET_LENGTH. */
  get(name: string): string | null {
    const value = Object.hasOwn(this.#env, name) && this.#env[name] !== undefined ? this.#env[name]! : this.#fromFile.get(name) ?? null;
    if (value !== null && value.length < MIN_SECRET_LENGTH) {
      throw new SecretError(`credential ${name} is ${value === "" ? "empty" : `shorter than ${MIN_SECRET_LENGTH} characters`}; refused`);
    }
    return value;
  }
}
