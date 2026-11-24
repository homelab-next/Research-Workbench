import type { CaseState, LaneState } from "../../core/state";
import { clear, syncList } from "../dom";
import type { CaseStore } from "../store";
import type { Ui, View } from "../ui";

interface LaneControl { el: HTMLElement; update(state: CaseState, lane: LaneState): void; edit(): void }

/** The lanes: one column per lane, the target highlighted, and `+ New lane`. */
export function makeLanes(ui: Ui, store: CaseStore, card: (id: string, state: CaseState) => HTMLElement, patch: (id: string, state: CaseState) => void): View & { rename(lane: string): void } {
  const { h } = ui;
  const controls = new Map<string, LaneControl>();
  const readonly = (): boolean => store.at !== null;

  /** A lane's node is made for its being the target or not (aria-current can only be set when a node is made), so the target changing makes a new node; the cards in it are the pool's and carry over. */
  const makeLane = (lane: LaneState, isTarget: boolean): LaneControl => {
    let editing = false;
    let shown: unknown[] | null = null;
    let latest: LaneState = lane;
    const head = h("div", { class: "lane-head" });
    const cards = h("div", { class: "lane-cards" });
    const el = h("section", { class: isTarget ? "lane target" : "lane", current: isTarget, tabindex: -1, data: { lane: lane.id, drop: "lane" }, on: {
      keydown: (e) => {
        const k = e as KeyboardEvent;
        if (k.key === "F2" && (k.target as HTMLElement).tagName.toLowerCase() !== "input") { k.preventDefault(); edit(); }
      },
    } }, head, cards);

    const edit = (): void => {
      if (readonly()) { ui.toast("Return to live to change the case"); return; }
      editing = true; shown = null; paint(store.shown, latest);
      const input = head.querySelector("input");
      if (input !== null) { input.focus(); input.select(); }
    };
    const stop = (): void => { if (!editing) return; editing = false; shown = null; paint(store.shown, latest); (head.querySelector(".lane-title") as HTMLElement | null)?.focus(); };

    function paint(state: CaseState, l: LaneState): void {
      const question = l.subgoal === null ? undefined : state.plan.current?.subgoals.find((g) => g.id === l.subgoal)?.question;
      const ro = readonly();
      const sig = [l.title, l.cards.length, question, editing, ro];
      if (shown !== null && sig.every((x, i) => x === shown![i])) return;
      shown = sig;
      clear(head);
      if (editing) {
        const input = h("input", {
          type: "text", name: `Rename lane ${l.title}`, value: l.title,
          on: {
            keydown: (e) => {
              const k = e as KeyboardEvent;
              const box = k.target as HTMLInputElement;
              if (k.key === "Escape") { k.stopPropagation(); stop(); }
              else if (k.key === "Enter") {
                const title = box.value.trim();
                editing = false; shown = null; paint(store.shown, latest);
                if (title !== "" && title !== l.title) void ui.act("rename_lane", { lane: l.id, title });
              }
            },
            blur: () => stop(),
          },
        });
        head.appendChild(input);
      } else {
        head.appendChild(h("button", {
          type: "button", class: "lane-title", title: question ?? "Make this the lane new cards are kept in", disabled: ro,
          on: { click: () => void ui.act("set_target", { lane: l.id }), dblclick: () => edit() },
        }, l.title));
      }
      head.appendChild(h("span", { class: "count muted" }, `${l.cards.length}`));
      if (l.cards.length === 0) head.appendChild(h("button", { type: "button", class: "remove", name: `Remove lane ${l.title}`, title: "Remove this empty lane", disabled: ro, on: { click: () => void ui.act("remove_lane", { lane: l.id }) } }, "×"));
    }

    return {
      el, edit,
      update(state, l) {
        latest = l;
        paint(state, l);
        syncList(cards, l.cards, (id) => id, (id) => card(id, state), (_e, id) => patch(id, state));
      },
    };
  };

  const list = h("div", { class: "lane-list" });
  const box = h("div", { class: "new-lane-box" });
  const el = h("div", { class: "lanes", tabindex: 0, data: { area: "lanes" }, name: "Lanes" }, list, box);
  let adding = false;
  const paintBox = (): void => {
    clear(box);
    if (!adding) {
      box.appendChild(h("button", { type: "button", class: "new-lane", disabled: readonly(), on: { click: () => { adding = true; paintBox(); (box.querySelector("input") as HTMLInputElement | null)?.focus(); } } }, "+ New lane"));
      return;
    }
    const input = h("input", {
      type: "text", name: "New lane title", placeholder: "Lane title",
      on: { keydown: (e) => {
        const k = e as KeyboardEvent;
        const field = k.target as HTMLInputElement;
        if (k.key === "Escape") { k.stopPropagation(); adding = false; paintBox(); }
        else if (k.key === "Enter" && field.value.trim() !== "") { const title = field.value.trim(); adding = false; paintBox(); void ui.act("add_lane", { title }); }
      } },
    });
    box.appendChild(h("form", { class: "new-lane-form", on: { submit: (e) => e.preventDefault() } }, input));
  };
  let boxRo: boolean | null = null;
  return {
    el,
    rename: (lane) => { controls.get(lane)?.edit(); },
    update() {
      const state = store.shown;
      const active = ui.doc.activeElement as HTMLElement | null;
      const focusedLane = active?.closest?.(".lane")?.getAttribute("data-lane") ?? null;
      syncList(list, state.lanes, (l) => (state.target === l.id ? `${l.id}*` : l.id),
        (l) => { const c = makeLane(l, state.target === l.id); controls.set(l.id, c); c.update(state, l); return c.el; },
        (_e, l) => controls.get(l.id)?.update(state, l));
      for (const id of [...controls.keys()]) if (!state.lanes.some((l) => l.id === id)) controls.delete(id);
      if (focusedLane !== null && (ui.doc.activeElement === null || ui.doc.activeElement === ui.doc.body)) {
        ([...list.querySelectorAll(".lane")] as HTMLElement[]).find((n) => n.dataset.lane === focusedLane)?.querySelector<HTMLElement>(".lane-title")?.focus();
      }
      if (boxRo !== readonly()) { boxRo = readonly(); paintBox(); }
    },
  };
}
