// "Skip to headlines": the first focusable element of the page (V1 had 33 tab stops before the
// first section headline and no way past them).

import type { MouseEvent } from "react";
import { MAIN_ID } from "./ids";

export function SkipLink() {
  const onClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    const main = document.getElementById(MAIN_ID);
    if (!main) return;
    // Handled in script so the hash (which holds the route) is left alone.
    event.preventDefault();
    main.focus({ preventScroll: true });
    main.scrollIntoView({ block: "start" });
  };
  return (
    <a className="skip-link" href={`#${MAIN_ID}`} onClick={onClick}>
      Skip to headlines
    </a>
  );
}
