import type { Ui } from "./ui";

/** The ISO text with milliseconds, as recorded. */
export function utc(ts: string): string {
  return ts;
}

/** "14:02" today, "23 Nov 14:02" otherwise, in `zone` (the browser's own when omitted). */
export function shortLocal(ts: string, now: Date, zone?: string): string {
  const when = new Date(ts);
  if (Number.isNaN(when.getTime())) return ts;
  const parts = (d: Date): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: zone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d)) out[p.type] = p.value;
    return out;
  };
  const a = parts(when);
  const b = parts(now);
  const hm = `${a.hour}:${a.minute}`;
  const sameDay = Math.abs(when.getTime() - now.getTime()) < 36 * 3_600_000 && a.day === b.day && a.month === b.month;
  return sameDay ? hm : `${a.day} ${a.month} ${hm}`;
}

/** <time datetime=ts>: mode "utc" shows utc(ts); mode "local" shows shortLocal with utc(ts) as the tooltip. */
export function timeEl(ui: Ui, ts: string, mode: "utc" | "local"): HTMLElement {
  const el = ui.h("time", mode === "local" ? { title: utc(ts) } : null, mode === "utc" ? utc(ts) : shortLocal(ts, new Date()));
  (el as HTMLTimeElement).dateTime = ts;
  return el;
}
