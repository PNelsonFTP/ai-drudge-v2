// The navy masthead row: "AI DRUDGE" (the page's only <h1>, linking home), the ticking tagline and
// the toolbar. Every toolbar control has a text label and exposes its state (aria-current /
// aria-pressed) - no bare glyph buttons.

import { useCallback, useEffect, useRef, useState, type ComponentType, type Ref } from "react";
import { useNow, useServices, useStore, type Route, type RouteName } from "../../app/services";
import type { BriefingDialogProps } from "./BriefingDialog";
import { useResolvedTheme } from "./hooks";
import { TOOLBAR_ID } from "./ids";
import { retryableLoader, taglineModel } from "./model";

// The briefing dialog (panel, briefing builder, kit stylesheet) is a chunk of its own, fetched when
// the button is pointed at, focused or clicked - not part of the entry bundle. Loaded in an event
// handler rather than through React.lazy: a failed chunk must leave the page alone and be
// retryable, never reach the app-level error boundary.
const loadBriefingDialog = retryableLoader(() => import("./BriefingDialog"));

type BriefingLoad = "idle" | "loading" | "error";

function useBriefingDialog() {
  const [Dialog, setDialog] = useState<ComponentType<BriefingDialogProps> | null>(null);
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<BriefingLoad>("idle");

  const preload = useCallback(() => {
    loadBriefingDialog().catch(() => undefined);
  }, []);
  const show = useCallback(() => {
    setOpen(true);
    setLoad("loading");
    loadBriefingDialog().then(
      (mod) => {
        // Function form: a component must not be mistaken for a state updater.
        setDialog(() => mod.default);
        setLoad("idle");
      },
      () => {
        setOpen(false);
        setLoad("error");
      },
    );
  }, []);
  const close = useCallback(() => setOpen(false), []);

  return { Dialog, open, load, preload, show, close };
}

interface ToolLink {
  label: string;
  route: Route;
  /** Is this the current page? */
  current: (route: Route) => boolean;
  count?: number;
  countLabel?: string;
}

function Tagline() {
  const { edition } = useServices();
  const state = useStore(edition);
  const now = useNow();
  const model = taglineModel(state, now, edition.staleHours(now));
  return (
    <p className="tagline">
      <span className="tagline-lead">Machine intelligence · </span>
      {model.stories && <>{model.stories} · </>}
      {model.stale ? <span className="stale">{model.updated} · delayed</span> : model.updated}
    </p>
  );
}

export interface MastheadProps {
  /** Ref to the sticky <header> (AppShell measures it). */
  headerRef?: Ref<HTMLElement>;
  /** Start downloading a page's chunk when its link is pointed at or focused. */
  onPreload?: (name: RouteName) => void;
}

export function Masthead({ headerRef, onPreload }: MastheadProps) {
  const { router, saved, settings } = useServices();
  const route = useStore(router);
  const bookmarkCount = useStore(saved, (s) => s.bookmarks.size);
  const laterCount = useStore(saved, (s) => s.later.size);
  const theme = useStore(settings, (s) => s.theme);
  const dark = useResolvedTheme(theme) === "dark";
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const briefing = useBriefingDialog();
  const BriefingDialog = briefing.Dialog;

  // The phone menu is a disclosure, not a page: any navigation closes it.
  useEffect(() => setMenuOpen(false), [route]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      // This Escape belongs to an open dialog (briefing, shortcuts); closing the menu under it
      // would hide the control its focus returns to.
      if (document.querySelector("dialog[open]")) return;
      // The toolbar is about to become display:none: focus inside it would drop to <body>.
      if (document.getElementById(TOOLBAR_ID)?.contains(document.activeElement)) menuButtonRef.current?.focus();
      setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const links: ToolLink[] = [
    { label: "Saved", route: { name: "saved", tab: "bookmarks" }, current: (r) => r.name === "saved" && r.tab === "bookmarks", count: bookmarkCount, countLabel: "bookmarks" },
    { label: "Later", route: { name: "saved", tab: "later" }, current: (r) => r.name === "saved" && r.tab === "later", count: laterCount, countLabel: "to read later" },
    { label: "Watch", route: { name: "watch" }, current: (r) => r.name === "watch" },
    { label: "Sources", route: { name: "sources" }, current: (r) => r.name === "sources" },
    { label: "Settings", route: { name: "settings" }, current: (r) => r.name === "settings" },
  ];

  return (
    <header className="site-header sticky-top" ref={headerRef}>
      <div className="header-row">
        <div className="masthead-btn">
          <h1 className="logo">
            <a
              href={router.href({ name: "home" })}
              aria-current={route.name === "home" ? "page" : undefined}
              // Already on the front page: the link has nowhere to go, so it takes you to the top.
              onClick={() => {
                if (router.get().name === "home") window.scrollTo({ top: 0 });
              }}
            >
              <span className="mark">AI</span> DRUDGE
            </a>
          </h1>
          <Tagline />
        </div>
        <button ref={menuButtonRef} type="button" className="tool-btn menu-btn" aria-expanded={menuOpen} aria-controls={TOOLBAR_ID} onClick={() => setMenuOpen((open) => !open)}>
          Menu
        </button>
        <nav id={TOOLBAR_ID} className="toolbar" aria-label="Pages" data-open={menuOpen}>
          {links.map((link) => {
            const current = link.current(route);
            const preload = onPreload ? () => onPreload(link.route.name) : undefined;
            return (
              <a
                key={link.label}
                className={current ? "tool-btn active" : "tool-btn"}
                href={router.href(link.route)}
                aria-current={current ? "page" : undefined}
                onPointerEnter={preload}
                onFocus={preload}
              >
                {link.label}
                {link.count !== undefined && link.count > 0 && (
                  <span className="tool-count">
                    {link.count}
                    <span className="visually-hidden"> {link.countLabel}</span>
                  </span>
                )}
              </a>
            );
          })}
          <button
            type="button"
            className="tool-btn"
            aria-haspopup="dialog"
            aria-busy={briefing.load === "loading" && !BriefingDialog ? true : undefined}
            title="Copy or download a briefing of this edition"
            onPointerEnter={briefing.preload}
            onFocus={briefing.preload}
            onClick={briefing.show}
          >
            Briefing
          </button>
          {briefing.load === "error" && (
            <span className="tool-note" role="alert">
              Briefing could not be loaded. Try again.
            </span>
          )}
          <button type="button" className="tool-btn" aria-pressed={dark} title="Switch between the light and dark theme" onClick={() => settings.set("theme", dark ? "light" : "dark")}>
            Dark
          </button>
        </nav>
        {/* Outside the toolbar: the phone menu hides the toolbar (display:none), and a dialog must not go with it. */}
        {BriefingDialog && <BriefingDialog open={briefing.open} onClose={briefing.close} />}
      </div>
    </header>
  );
}
