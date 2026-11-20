// Keyboard cursor: the article id of the row j/k is on. Written by src/keyboard/useKeyboardNav.ts;
// rows may read it with useStore(focus, (id) => id === myId). The same article can be rendered
// more than once on a page, so the visual marker is the [data-kbd-current] attribute the nav hook
// puts on the ONE row element it is on - this store answers "which article", not "which row".

import type { ArticleId } from "../../shared/contract";
import { createStore, type FocusStore } from "./services";

export function createFocusStore(initial: ArticleId | null = null): FocusStore {
  const store = createStore<ArticleId | null>(initial);
  return { get: store.get, subscribe: store.subscribe, set: store.set };
}
