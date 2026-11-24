import type { LensId, Open } from "../app";
import type { Ui, View } from "../ui";

export interface LensDef { id: LensId; key: string; title: string; make(ui: Ui, open: Open, arg: string | null): View }
/** In shelf order. Each lens task adds its entry here; a lens with no entry has no button and no key. */
export const LENSES: LensDef[] = [];
