// Pure view-models of the chrome (no React, no DOM): everything the header, ticker, banners and
// footer decide is decided here, so it is unit-tested without rendering.

import type { EditionCounts, StocksFile } from "../../../shared/contract";
import { SECTIONS, isSectionId, type SectionDef, type SectionId } from "../../../shared/sections";
import { parseMs, shortAge, TIME_FILTERS, type TimeFilter } from "../../../shared/time";
import { STALE_BANNER_HOURS, type EditionState, type Route, type Settings, type Theme } from "../../app/services";
import type { EditionStateExtras } from "../../data/editionStore";

// ---- Sections --------------------------------------------------------------------------------------

/**
 * Sections in the reader's order: Settings.sectionOrder first (unknown / duplicate ids dropped),
 * then every unlisted section in default order; minus hidden and muted sections.
 */
export function orderedSections(
  settings: Pick<Settings, "sectionOrder" | "hiddenSections">,
  mutedSections: ReadonlySet<SectionId> = new Set(),
): SectionDef[] {
  const byId = new Map<SectionId, SectionDef>(SECTIONS.map((s) => [s.id, s]));
  const seen = new Set<SectionId>();
  const out: SectionDef[] = [];
  const push = (id: SectionId): void => {
    const def = byId.get(id);
    if (!def || seen.has(id)) return;
    seen.add(id);
    out.push(def);
  };
  for (const id of settings.sectionOrder ?? []) if (isSectionId(id)) push(id);
  for (const s of SECTIONS) push(s.id);
  const hidden = new Set<string>(settings.hiddenSections);
  return out.filter((s) => !hidden.has(s.id) && !mutedSections.has(s.id));
}

// ---- Time chips ------------------------------------------------------------------------------------

export const TIME_CHIP_LABELS: Readonly<Record<TimeFilter, string>> = { new: "NEW", "6h": "6H", "24h": "24H", "3d": "3D", all: "ALL" };

/** The chips that are buttons bound to Settings.timeFilter (NEW is a link to #/new). */
export const TIME_FILTER_BUTTONS: readonly Exclude<TimeFilter, "new">[] = TIME_FILTERS.filter((f): f is Exclude<TimeFilter, "new"> => f !== "new");

/**
 * Does the shell show its time chips on this route? Only where they act: the front page (they
 * filter it) and #/new (NEW is the current chip; the others lead back to the filtered front page).
 * A section page has its own group, with that section's story count per window - a second, global
 * group above it said the same thing twice. Search, Watchlist, Saved, Sources, Settings and About
 * do not read the time window at all, so the chips were controls that changed nothing in view.
 */
export function showsTimeChips(route: Pick<Route, "name">): boolean {
  return route.name === "home" || route.name === "new";
}

// ---- Theme -----------------------------------------------------------------------------------------

export function resolveTheme(theme: Theme, prefersDark: boolean): "light" | "dark" {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

// ---- Stale threshold -------------------------------------------------------------------------------

/** Bounds of a believable status.json `staleAfterMinutes`: one build cadence to one day. */
export const STALE_AFTER_MINUTES_RANGE = { min: 30, max: 24 * 60 } as const;

/**
 * Hours after which the edition on screen counts as delayed (tagline flag, "Headlines may be
 * delayed" banner). The pipeline declares it in status.json (`staleAfterMinutes`, 120 as of
 * 2026-11-20) and the edition store publishes it as `staleAfterMinutes` on its state once that
 * file has loaded; until then - or when the number is missing or outside 30 min .. 24 h - the
 * constant STALE_BANNER_HOURS applies. Read structurally: the field is additive on EditionState.
 */
export function staleThresholdHours(state: object | null | undefined): number {
  const minutes = (state as { staleAfterMinutes?: unknown } | null | undefined)?.staleAfterMinutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return STALE_BANNER_HOURS;
  if (minutes < STALE_AFTER_MINUTES_RANGE.min || minutes > STALE_AFTER_MINUTES_RANGE.max) return STALE_BANNER_HOURS;
  return minutes / 60;
}

// ---- Still trying -----------------------------------------------------------------------------------

/**
 * Is the first load being retried? The edition store raises `retrying` on its state when an attempt
 * to load front.json failed with nothing on screen and another attempt follows (up to three, each
 * up to 25 s). Read structurally: the field is additive on EditionState, and absent means no.
 */
export function isRetrying(state: object | null | undefined): boolean {
  return (state as { retrying?: unknown } | null | undefined)?.retrying === true;
}

// ---- Tagline ("237 stories · updated 20m ago") -----------------------------------------------------

export interface TaglineModel {
  /** "237 stories" or null while there is no edition. */
  stories: string | null;
  /** "updated 20m ago", "updated just now", "loading…", "still trying…", "could not load". */
  updated: string;
  /** Older than the stale threshold: rendered in the stale colour with "delayed". */
  stale: boolean;
}

export function taglineModel(state: Pick<EditionState, "status" | "edition"> & EditionStateExtras, nowMs: number, staleHours: number | null): TaglineModel {
  const edition = state.edition;
  if (!edition) return { stories: null, updated: state.status === "error" ? "could not load" : isRetrying(state) ? "still trying…" : "loading…", stale: false };
  const n = edition.counts.stories;
  const age = shortAge(edition.meta.generatedAt, nowMs);
  const updated = age === "" ? "updated —" : age === "now" ? "updated just now" : `updated ${age} ago`;
  return { stories: `${n} ${n === 1 ? "story" : "stories"}`, updated, stale: staleHours !== null && staleHours > staleThresholdHours(state) };
}

// ---- Banners ---------------------------------------------------------------------------------------

export interface BannerModel {
  id: "outdated" | "offline" | "error" | "retrying" | "refresh-failed" | "stale" | "storage";
  tone: "alert" | "info";
  text: string;
  /** What the banner's button does. null: no button - the banner goes away by itself. */
  action: "reload" | "retry" | "dismiss" | null;
  /** "" when there is no button. */
  actionLabel: string;
}

function hoursLabel(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  if (hours < 48) return `${Math.floor(hours)} h`;
  return `${Math.floor(hours / 24)} days`;
}

export interface BannerInput {
  state: Pick<EditionState, "status" | "edition" | "error" | "fetchedAtMs" | "outdatedClient"> & EditionStateExtras;
  /** edition.staleHours(now). */
  staleHours: number | null;
  online: boolean;
  /** The browser is not keeping the reader's changes (services.persistence.writeRefused). Default false. */
  storageRefused?: boolean;
}

/**
 * Banners in display order. At most one data banner (offline > error > still trying > refresh
 * failed > stale) so a dead connection does not stack three warnings; "new version" and "changes
 * are not being saved" are independent of those.
 */
export function bannerModels({ state, staleHours, online, storageRefused = false }: BannerInput): BannerModel[] {
  const out: BannerModel[] = [];
  if (state.outdatedClient) {
    out.push({ id: "outdated", tone: "info", text: "A new version of AI DRUDGE is available.", action: "reload", actionLabel: "Reload" });
  }
  const has = state.edition !== null;
  const age = staleHours === null ? null : hoursLabel(staleHours);
  if (!online) {
    const text = has ? `You are offline — showing the headlines loaded${age ? ` ${age} ago` : " earlier"}.` : "You are offline — headlines cannot be loaded.";
    out.push({ id: "offline", tone: "alert", text, action: "retry", actionLabel: "Retry" });
  } else if (!has && state.status === "error") {
    out.push({ id: "error", tone: "alert", text: state.error?.trim() || "Headlines could not be loaded.", action: "retry", actionLabel: "Retry" });
  } else if (!has && isRetrying(state)) {
    // Between the attempts of the first load: "loading…" alone would sit unchanged for up to 80 s.
    out.push({ id: "retrying", tone: "info", text: "Still trying to load the headlines — the first attempt failed.", action: null, actionLabel: "" });
  } else if (has && state.error) {
    out.push({ id: "refresh-failed", tone: "alert", text: `Could not refresh — showing headlines from ${age ?? "earlier"}${age ? " ago" : ""}.`, action: "retry", actionLabel: "Retry" });
  } else if (has && staleHours !== null && staleHours > staleThresholdHours(state) && state.fetchedAtMs !== null) {
    // fetchedAtMs === null means only the cache is on screen and the first revalidation is still
    // running: warning then would flash on every reload (V1 did).
    out.push({ id: "stale", tone: "alert", text: `Headlines may be delayed — the last edition is ${age} old.`, action: "retry", actionLabel: "Check again" });
  }
  if (storageRefused) {
    out.push({
      id: "storage",
      tone: "alert",
      text: "This browser is not saving your changes (its storage is full or blocked). Bookmarks, mutes and settings you change now last until this tab is closed.",
      action: "dismiss",
      actionLabel: "Dismiss",
    });
  }
  return out;
}

// ---- Auto refresh ----------------------------------------------------------------------------------

/** Is a background refresh due? `lastAttemptMs` stops a failing refresh from retrying every tick. */
export function refreshDue(nowMs: number, fetchedAtMs: number | null, lastAttemptMs: number, intervalMs: number): boolean {
  return nowMs - Math.max(fetchedAtMs ?? 0, lastAttemptMs) >= intervalMs;
}

// ---- Stock ticker ----------------------------------------------------------------------------------

export interface TickerQuote {
  symbol: string;
  dir: "up" | "down" | "flat";
  /** "$147.25" or "—". */
  price: string;
  /** "-2.46%", "+0.80%" or "—". */
  change: string;
  /** One sentence for screen readers. */
  spoken: string;
}

export interface TickerModel {
  quotes: TickerQuote[];
  /** "Closed · as of Thu 4:00 PM ET" when the market is closed; null while it is open. */
  note: string | null;
}

/** "Thu 4:00 PM ET" (New York time: these are US-listed symbols); "" when it cannot be formatted. */
export function formatMarketTime(iso: string | null | undefined): string {
  const ms = parseMs(iso);
  if (ms === null) return "";
  try {
    const text = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
    // Some ICU versions separate the time and "PM" with U+202F; keep the label plain ASCII-spaced.
    return `${text.replace(/[  ]/g, " ")} ET`;
  } catch {
    return "";
  }
}

/** Ticker contents in stocks.json `order`; null when there is nothing worth showing (ticker hidden). */
export function tickerModel(stocks: StocksFile | null): TickerModel | null {
  if (!stocks) return null;
  const quotes: TickerQuote[] = [];
  for (const symbol of stocks.order) {
    const q = stocks.quotes[symbol];
    if (!q) continue;
    const pct = q.changePct;
    const dir: TickerQuote["dir"] = pct === null || pct === 0 ? "flat" : pct > 0 ? "up" : "down";
    const price = q.price === null ? "—" : `$${q.price.toFixed(2)}`;
    const change = pct === null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    const spokenChange = pct === null ? "change unavailable" : pct === 0 ? "unchanged" : `${dir} ${Math.abs(pct).toFixed(2)} percent`;
    quotes.push({ symbol, dir, price, change, spoken: `${symbol}: ${q.price === null ? "price unavailable" : price}, ${spokenChange}` });
  }
  if (!quotes.some((q) => q.price !== "—")) return null;
  let note: string | null = null;
  if (stocks.marketState === "closed") {
    const at = formatMarketTime(stocks.asOf);
    note = at ? `Closed · as of ${at}` : "Market closed";
  }
  return { quotes, note };
}

/**
 * Does a one-line scroller actually scroll? (content wider than its box; one pixel of tolerance for
 * fractional layout widths). A scroller that does must be reachable from the keyboard.
 */
export function scrollsSideways(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth - clientWidth > 1;
}

// ---- Footer ----------------------------------------------------------------------------------------

/** "185/207 feeds OK"; null when the counts are missing or empty. */
export function feedsLabel(counts: EditionCounts | null | undefined): string | null {
  if (!counts || counts.feedsTotal <= 0) return null;
  return `${counts.feedsOk}/${counts.feedsTotal} feeds OK`;
}

/** baseUrl + path with exactly one slash between them ("/ai-drudge-v2/" + "feed.xml"). */
export function siteUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

// ---- Settings: single-key shortcuts ----------------------------------------------------------------

/**
 * Are single-key shortcuts on? Reads the `shortcuts` setting (the reader's off switch, WCAG 2.1.4;
 * Settings > Appearance). Only an explicit false turns them off: a settings object built before
 * the field existed still means "on".
 */
export function shortcutsEnabled(settings: Settings): boolean {
  return settings.shortcuts !== false;
}

// ---- Section chips ---------------------------------------------------------------------------------

/**
 * scrollLeft that centres a chip in its one-line scroller (phones), clamped to what can scroll.
 * `chipLeft` is the chip's offset from the scroller's left CONTENT edge (independent of the
 * current scroll position).
 */
export function centeredScrollLeft(chipLeft: number, chipWidth: number, listClientWidth: number, listScrollWidth: number): number {
  const max = Math.max(0, listScrollWidth - listClientWidth);
  return Math.min(max, Math.max(0, Math.round(chipLeft - (listClientWidth - chipWidth) / 2)));
}

// ---- Search box ------------------------------------------------------------------------------------

/** The slice of a keydown event the search box needs (structural, so it is tested under node). */
export interface SearchKeyEvent {
  key: string;
  nativeEvent: { isComposing?: boolean };
  preventDefault(): void;
  currentTarget: { blur(): void };
}

/**
 * Escape in the search box LEAVES it: the query and the results stay, and j/k work again.
 * Chromium and WebKit clear a type=search field on Escape as its default action - which, through
 * search-as-you-type, replaced the results page with the front page - so the default is stopped.
 * The document-level key handler ignores default-prevented events, hence the blur here. Escape
 * during an IME composition belongs to the composition.
 */
export function handleSearchKeyDown(event: SearchKeyEvent): boolean {
  if (event.key !== "Escape" || event.nativeEvent.isComposing) return false;
  event.preventDefault();
  event.currentTarget.blur();
  return true;
}

// ---- Lazy chunks -----------------------------------------------------------------------------------

/**
 * Single-flight loader for a code chunk that can be RETRIED: every caller shares one download, and
 * a failed one (offline, a deploy replaced the hashed file) is forgotten so the next call tries
 * again. (React.lazy remembers a rejection for good and throws it into the nearest boundary.)
 */
export function retryableLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    pending ??= load().catch((err: unknown) => {
      pending = null;
      throw err;
    });
    return pending;
  };
}
