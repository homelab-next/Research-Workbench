export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export class CanonicalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalError";
  }
}

function write(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalError(`non-finite number at ${path}`);
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        // Index by position: map() skips holes and would emit invalid JSON such as "[,1]".
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          if (!Object.hasOwn(value, i)) throw new CanonicalError(`hole at ${path}[${i}]`);
          items.push(write(value[i], `${path}[${i}]`));
        }
        return "[" + items.join(",") + "]";
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalError(`unsupported object at ${path}`);
      }
      if (Object.getOwnPropertySymbols(value).length > 0) throw new CanonicalError(`symbol-keyed property at ${path}`);
      const obj = value as Record<string, unknown>;
      const parts = Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + write(obj[k], `${path}.${k}`));
      return "{" + parts.join(",") + "}";
    }
    default:
      throw new CanonicalError(`unsupported ${typeof value} at ${path}`);
  }
}

export function canonical(value: Json): string {
  return write(value, "$");
}
