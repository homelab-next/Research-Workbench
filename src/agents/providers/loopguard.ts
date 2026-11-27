import type { Schema } from "../../core/schema";

/** The model manifest's `loop_guard`: watch a streamed reply and stop it when it repeats itself. */
export interface LoopGuardSettings {
  enabled: boolean;
  /** How many of the latest characters are looked for earlier in the same text. */
  window: number;
  /** How many times the window must already have appeared earlier (each apart from the others) for the text to be a loop. */
  repeats: number;
}

export const DEFAULT_LOOP_GUARD: LoopGuardSettings = { enabled: true, window: 400, repeats: 3 };

export const LOOP_GUARD_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    window: { type: "integer", minimum: 50, maximum: 20000 },
    repeats: { type: "integer", minimum: 1, maximum: 100 },
  },
};

/** The short-unit check: a unit of SHORT_MIN to SHORT_MAX characters, repeated SHORT_TIMES times back to back at the end of the text. */
export const SHORT_MIN = 20;
export const SHORT_MAX = 200;
export const SHORT_TIMES = 8;
/** The repeated text a hit reports, at most this long. */
export const SHOWN_CHARS = 120;

/** The given settings over the defaults. */
export function loopGuardSettings(given: Partial<LoopGuardSettings> | undefined): LoopGuardSettings {
  return {
    enabled: given?.enabled ?? DEFAULT_LOOP_GUARD.enabled,
    window: given?.window ?? DEFAULT_LOOP_GUARD.window,
    repeats: given?.repeats ?? DEFAULT_LOOP_GUARD.repeats,
  };
}

/** True when `s` from `from` to its end has period `p`: each character equals the one `p` before it. */
function hasPeriod(s: string, from: number, p: number): boolean {
  for (let i = s.length - 1; i >= from + p; i--) if (s.charCodeAt(i) !== s.charCodeAt(i - p)) return false;
  return true;
}

/**
 * Watches one text as it grows (a reply's reasoning, or its content) and says when it has fallen into a loop. Deterministic: the checks run
 * whenever the text has grown by `step` characters since the last check, and look only at the text.
 */
export class LoopGuard {
  readonly #s: LoopGuardSettings;
  readonly #step: number;
  #text = "";
  #checked = 0;

  constructor(settings: LoopGuardSettings) {
    this.#s = settings;
    this.#step = Math.max(16, Math.min(100, Math.floor(settings.window / 4)));
  }

  /** Everything fed so far. */
  get text(): string { return this.#text; }

  /** Adds `piece`; returns the repeated text (at most SHOWN_CHARS) once the text is a loop, else null. */
  feed(piece: string): string | null {
    if (piece === "") return null;
    this.#text += piece;
    if (!this.#s.enabled || this.#text.length - this.#checked < this.#step) return null;
    this.#checked = this.#text.length;
    return this.#short() ?? this.#window();
  }

  /** A unit of SHORT_MIN to SHORT_MAX characters repeated SHORT_TIMES times at the end; a run of a shorter unit is left to the window check. */
  #short(): string | null {
    const t = this.#text;
    for (let p = SHORT_MIN; p <= SHORT_MAX; p++) {
      const from = t.length - p * SHORT_TIMES;
      if (from < 0) break;
      if (!hasPeriod(t, from, p)) continue;
      const unit = t.slice(t.length - p);
      for (let q = 1; q < SHORT_MIN; q++) if (hasPeriod(unit, 0, q)) return null;
      return unit.slice(0, SHOWN_CHARS);
    }
    return null;
  }

  /** The last `window` characters already seen `repeats` times earlier, each apart from the others and from the window itself. */
  #window(): string | null {
    const t = this.#text;
    const w = this.#s.window;
    if (t.length < (this.#s.repeats + 1) * w) return null;
    const last = t.length - 2 * w;
    const needle = t.slice(t.length - w);
    let seen = 0;
    for (let i = t.indexOf(needle); i !== -1 && i <= last; i = t.indexOf(needle, i + w)) {
      if (++seen >= this.#s.repeats) return needle.slice(0, SHOWN_CHARS);
    }
    return null;
  }
}
