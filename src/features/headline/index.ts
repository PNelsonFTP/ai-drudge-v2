// Entry point of the headline feature for the app wiring (src/main.tsx):
//
//   import { HeadlineRow, HoverCard } from "../features/headline";
//   ui: { HeadlineRow }                 // UiSlots
//   <HoverCard />                       // once, in the shell (src/app/AppShell.tsx)
//
// This file imports the stylesheet, so it is for the BROWSER bundle. Node tests import
// ./HeadlineRow directly (node cannot load .css).

import "./headline.css";

export { HeadlineRow } from "./HeadlineRow";
export { HoverCard } from "./HoverCard";
export { ROW_ACTION_EVENT, ROW_ACTIONS, type RowAction } from "./rowActions";
