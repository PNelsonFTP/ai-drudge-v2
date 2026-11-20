// Search box: a real <label>, and the query lives in the URL (#/q/<query>) so results are
// linkable and Back works. Typing navigates after a short pause; Enter navigates at once.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { normalizeQuery } from "../../app/routes";
import { useServices, useStore } from "../../app/services";
import { SEARCH_INPUT_ID } from "./ids";
import { handleSearchKeyDown, shortcutsEnabled } from "./model";

export const SEARCH_DEBOUNCE_MS = 250;

export interface SearchBoxProps {
  /** The reader is about to search: start loading what the results page needs (called on focus). */
  onIntent?: () => void;
}

export function SearchBox({ onIntent }: SearchBoxProps = {}) {
  const { router, settings } = useServices();
  const shortcuts = useStore(settings, shortcutsEnabled);
  const route = useStore(router);
  const routeQuery = route.name === "search" ? route.q : null;
  const [text, setText] = useState(routeQuery ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textRef = useRef(text);
  textRef.current = text;

  // Follow the URL (deep link, Back/Forward, leaving the search page) - but never rewrite what the
  // reader is typing just because the route holds the trimmed form of it.
  useEffect(() => {
    if (routeQuery === null) setText("");
    else if (routeQuery !== normalizeQuery(textRef.current)) setText(routeQuery);
  }, [routeQuery]);

  const cancel = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => cancel, []);

  const navigate = (value: string): void => {
    cancel();
    const q = normalizeQuery(value);
    const current = router.get();
    if (q === "") {
      if (current.name === "search") router.go({ name: "home" }, { replace: true });
      return;
    }
    // The first keystroke adds a history entry (Back returns to the page you searched from);
    // refining the query replaces it.
    router.go({ name: "search", q }, { replace: current.name === "search" });
  };

  const onChange = (value: string): void => {
    setText(value);
    cancel();
    timer.current = setTimeout(() => navigate(value), SEARCH_DEBOUNCE_MS);
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    navigate(text);
  };

  return (
    <form className="search-form" role="search" onSubmit={onSubmit}>
      <label className="visually-hidden" htmlFor={SEARCH_INPUT_ID}>
        Search headlines
      </label>
      <input
        id={SEARCH_INPUT_ID}
        type="search"
        className="search-input"
        placeholder="Search headlines and sources"
        value={text}
        onChange={(event) => onChange(event.target.value)}
        // Escape leaves the field and keeps the query (a pending debounce still navigates).
        onKeyDown={handleSearchKeyDown}
        onFocus={onIntent}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        aria-keyshortcuts={shortcuts ? "/" : undefined}
      />
    </form>
  );
}
