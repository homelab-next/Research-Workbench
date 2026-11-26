import type { Observable, TimeWindow } from "../../core/types";
import type { PlaybookRunState } from "../../core/state/types";
import { BELONGS_ID } from "../../core/wire";
import type { Nav } from "../app";
import { belongsLines, belongsVerdict } from "../belongs";
import { cardChip } from "../chips";
import { clear } from "../dom";
import type { CaseStore } from "../store";
import type { Ui, View } from "../ui";


export interface PlaybookBlock extends View { setValues(values: Observable[]): void }

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The playbook block of the Pivot panel (design §5.3, §7.3): the playbooks the card's values can fill, "does it belong?" for each value, and the
 * trail of the newest one started from here, read from the fold. Every button says what it will do; nothing here asks a source.
 */
export function makePlaybookBlock(ui: Ui, store: CaseStore, nav: Pick<Nav, "focusCard">, ask: { window(): TimeWindow | null; why(): string }): PlaybookBlock {
  const { h } = ui;
  let values: Observable[] = [];
  /** The store's seq when a button was last pressed: the trail is the newest run that started after it. */
  let base: number | null = null;
  let sig = "";
  const el = h("div", { class: "playbook-block" });

  const ro = (): boolean => store.at !== null;
  const pivotTitle = (id: string): string => ui.ref.pivots.find((x) => x.id === id)?.title ?? id;
  const disabledWhy = (): string | null => {
    if (ro()) return "Return to live to run a playbook";
    if (ask.why().trim() === "") return "Say why first";
    if (ask.window() === null) return "The custom window needs two UTC times, the first not after the second";
    return null;
  };
  const inventoriesFor = (type: string): number => ui.ref.pivots.filter((x) => x.from === type && x.inventory !== null && ui.ref.inventories.some((i) => i.id === x.inventory)).length;
  const filled = () => ui.ref.playbooks.flatMap((pb) => {
    if (pb.inputs.length === 0 || !pb.inputs.every((i) => values.some((v) => v.type === i.type))) return [];
    const inputs = pb.inputs.map((i) => ({ type: i.type, value: values.find((v) => v.type === i.type)!.value }));
    return [{ pb, inputs }];
  });

  async function press(command: string, args: Record<string, unknown>): Promise<void> {
    const window = ask.window();
    if (window === null || ro() || ask.why().trim() === "") return;
    const seq = store.live.seq;
    const sent = await ui.send(command, { ...args, window, why: ask.why().trim() });
    if (sent === null) return;
    base = seq; sig = "";
    paint();
  }

  const newest = (): PlaybookRunState | null => {
    if (base === null) return null;
    let found: PlaybookRunState | null = null;
    for (const r of Object.values(store.shown.playbooks)) if (r.started_seq > base && (found === null || r.started_seq > found.started_seq)) found = r;
    return found;
  };

  function trail(run: PlaybookRunState): HTMLElement {
    const box = h("div", { class: "playbook-trail", role: "status" });
    const status = run.status === "interrupted" ? "Interrupted: the server stopped. Run it again; answered lookups are reused." : run.status === "running" ? "Running" : `Finished: ${run.status}`;
    if (run.playbook === BELONGS_ID && run.status !== "running") {
      const v = belongsVerdict(run, ui.ref, store.shown.cards);
      box.append(h("p", { class: `belongs-verdict ${v.verdict.replace(/[^a-z]+/g, "-")}` }, v.text),
        h("div", { class: "belongs-lines" }, belongsLines(run, ui.ref, store.shown.cards).map((l) => h("p", { class: "belongs-line", data: { inventory: l.inventory } }, l.line))));
    }
    box.append(h("p", { class: `status ${run.status}` }, status));
    for (const id of run.order) {
      const s = Object.hasOwn(run.steps, id) ? run.steps[id]! : null;
      if (s === null) continue;
      box.append(h("div", { class: `step ${s.status}`, data: { step: id } },
        h("span", { class: "what" }, `${id} · ${pivotTitle(s.pivot)}`),
        s.status === "skipped" ? h("span", { class: "skipped" }, ` skipped: ${s.reason}`) : null,
        s.lookups.map((l) => h("div", { class: `lookup ${l.outcome}` },
          h("span", null, `${l.value}: ${l.outcome}`), l.reused ? h("span", { class: "reused" }, " · reused, no query sent") : null,
          // what the lookup's answer means, as the record says: proven negative, not seen, the reuse, the failure
          l.detail === "" ? null : h("span", { class: "detail" }, ` · ${l.detail}`),
          l.card === null ? null : " ", l.card === null ? null : cardChip(ui, l.card, (c) => nav.focusCard(c)))),
        s.left > 0 ? h("div", { class: "left" }, `${s.left} values not followed`) : null));
    }
    for (const c of run.caveats) box.append(h("p", { class: "caveat" }, c));
    return box;
  }

  function paint(): void {
    const run = newest();
    const next = JSON.stringify([values, ask.window(), ask.why(), ro(), run, ui.ref.playbooks.length]);
    if (next === sig) return;
    sig = next;
    clear(el);
    const why = disabledWhy();
    const buttons: HTMLElement[] = [];
    for (const { pb, inputs } of filled()) {
      const first = inputs[0]!.value;
      buttons.push(h("button", {
        type: "button", class: "action run-playbook", data: { playbook: pb.id }, disabled: why !== null,
        title: why ?? `Run ${pb.title} on ${first}: up to ${plural(pb.max_lookups, "lookup", "lookups")}, no model`,
        on: { click: () => { void press("run_playbook", { playbook: pb.id, inputs }); } },
      }, `Run ${pb.title} on ${first} · up to ${pb.max_lookups} lookups, no model${pb.free ? "" : " · costly lookups will wait for a budget"}`));
    }
    for (const v of values) {
      const n = inventoriesFor(v.type);
      if (n === 0) continue;
      buttons.push(h("button", {
        type: "button", class: "action belongs", data: { value: v.value }, disabled: why !== null,
        title: why ?? `Ask ${plural(n, "inventory", "inventories")} whether ${v.value} is listed`,
        on: { click: () => { void press("check_belongs", { type: v.type, value: v.value }); } },
      }, `Does ${v.value} belong? · asks ${plural(n, "inventory", "inventories")}`));
    }
    el.hidden = buttons.length === 0 && run === null;
    if (buttons.length > 0) el.append(h("div", { class: "row playbooks" }, buttons.flatMap((b) => [b, " "])));
    if (run !== null) el.append(trail(run));
  }

  return {
    el,
    setValues(next) { values = next.map((o) => ({ type: o.type, value: o.value })); paint(); },
    update() { paint(); },
  };
}
