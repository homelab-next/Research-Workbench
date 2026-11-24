export interface Prefs { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }

/** Remembered choices under "rw:<key>" as JSON. A storage that throws or is null falls back to memory. */
export function makePrefs(storage: Storage | null): Prefs {
  const memory = new Map<string, unknown>();
  return {
    get<T>(key: string, fallback: T): T {
      if (memory.has(key)) return memory.get(key) as T;
      try {
        const raw = storage?.getItem(`rw:${key}`);
        if (raw === null || raw === undefined) return fallback;
        return JSON.parse(raw) as T;
      } catch { return fallback; }
    },
    set(key, value) {
      memory.set(key, value);
      try { storage?.setItem(`rw:${key}`, JSON.stringify(value)); } catch { /* memory holds it */ }
    },
  };
}
