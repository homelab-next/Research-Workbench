export interface Prefs { get<T>(key: string, fallback: T, valid?: (v: unknown) => v is T): T; set(key: string, value: unknown): void }

/** Remembered choices under "rw:<key>" as JSON; a value that fails `valid` is the fallback. A storage that throws or is null falls back to memory. */
export function makePrefs(storage: Storage | null): Prefs {
  const memory = new Map<string, unknown>();
  return {
    get<T>(key: string, fallback: T, valid?: (v: unknown) => v is T): T {
      const checked = (v: unknown): T => (valid === undefined || valid(v) ? (v as T) : fallback);
      if (memory.has(key)) return checked(memory.get(key));
      try {
        const raw = storage?.getItem(`rw:${key}`);
        if (raw === null || raw === undefined) return fallback;
        return checked(JSON.parse(raw));
      } catch { return fallback; }
    },
    set(key, value) {
      memory.set(key, value);
      try { storage?.setItem(`rw:${key}`, JSON.stringify(value)); } catch { /* memory holds it */ }
    },
  };
}
