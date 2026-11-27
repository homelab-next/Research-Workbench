import type { Registry } from "./registry";

/** A kind of case a person can say a case is, so the lessons for that kind can be given to its runs. */
export interface CaseType { id: string; title: string; about: string }

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Every type of every `case-types` manifest of a trusted root, by id with `<`. A type id two manifests give is a problem and the first manifest by path keeps it. */
export function loadCaseTypes(registry: Registry): { types: CaseType[]; problems: string[] } {
  const problems: string[] = [];
  const kept = new Map<string, CaseType>();
  const manifests = registry.all("case-types").sort((a, b) => lt(a.path, b.path));
  for (const m of manifests) {
    const list = m.body.types;
    if (!Array.isArray(list)) {
      problems.push(`case-types "${m.id}": types must be a list`);
      continue;
    }
    list.forEach((raw, i) => {
      const t = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      const id = t !== null && typeof t.id === "string" ? t.id : null;
      const at = `case-types "${m.id}": type ${id ?? `#${i + 1}`}`;
      if (t === null || id === null || !ID.test(id)) { problems.push(`${at}: its id must be lower-case letters, digits and hyphens, 1 to 64 characters, starting with a letter or digit`); return; }
      if (typeof t.title !== "string" || t.title.length < 1 || t.title.length > 80) { problems.push(`${at}: its title must be 1 to 80 characters`); return; }
      if (t.about !== undefined && (typeof t.about !== "string" || t.about.length > 300)) { problems.push(`${at}: its about must be at most 300 characters`); return; }
      if (kept.has(id)) { problems.push(`${at}: the id is already given by an earlier manifest or an earlier entry; the first is kept`); return; }
      kept.set(id, { id, title: t.title, about: typeof t.about === "string" ? t.about : "" });
    });
  }
  return { types: [...kept.values()].sort((a, b) => lt(a.id, b.id)), problems };
}
