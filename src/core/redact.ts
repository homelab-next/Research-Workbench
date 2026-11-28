// Secret values in text a person or a model wrote (slice 12's builder, slice 13's memory): one search and one redaction, shared by every writer
// that must not store a credential's value. A value is found as it is written and as it is escaped inside a JSON string. Server-side core: never
// imported by src/web or src/core/state.
import { MIN_SECRET_LENGTH } from "pivot/secrets";

/** What a secret value a person typed, or a model wrote, is replaced with before it is written anywhere. */
export const REDACTED = "[redacted secret]";

/** The values searched for: each once, 8 characters or more, longest first (so a value inside another is not cut in half). */
export const searched = (secrets: readonly string[]): string[] =>
  [...new Set(secrets.filter((s) => typeof s === "string" && s.length >= MIN_SECRET_LENGTH))].sort((a, b) => b.length - a.length);

/** The forms a value is searched in: as written, and as it is escaped inside a JSON string. */
const formsOf = (s: string): string[] => {
  const escaped = JSON.stringify(s).slice(1, -1);
  return escaped === s ? [s] : [s, escaped];
};

/** The text with every secret value, as written and as it is escaped inside a JSON string, replaced by REDACTED. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of searched(secrets)) for (const form of formsOf(s)) out = out.split(form).join(REDACTED);
  return out;
}

/** Whether any of the texts holds a secret value, as written or as it is escaped inside a JSON string. */
export function holdsSecret(texts: readonly string[], secrets: readonly string[]): boolean {
  const forms = searched(secrets).flatMap(formsOf);
  return forms.some((f) => texts.some((t) => t.includes(f)));
}
