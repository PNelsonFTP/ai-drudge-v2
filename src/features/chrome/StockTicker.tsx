// Stock ticker: symbols in the order stocks.json gives, an "as of" note when the market is closed,
// nothing at all when there are no quotes. Keyboard-scrollable where the quotes do not fit.

import { useRef } from "react";
import { useServices, useStore } from "../../app/services";
import { useScrollsSideways } from "./hooks";
import { ArrowDownIcon, ArrowUpIcon, FlatIcon } from "./icons";
import { tickerModel, type TickerQuote } from "./model";

const ICONS = { up: ArrowUpIcon, down: ArrowDownIcon, flat: FlatIcon } as const;

function Quote({ quote }: { quote: TickerQuote }) {
  const Icon = ICONS[quote.dir];
  const tone = `ticker-${quote.dir}`;
  return (
    <li className="ticker-item">
      {/* One sentence for screen readers; the visual parts are hidden from them so nothing is read twice. */}
      <span className="visually-hidden">{quote.spoken}</span>
      <span aria-hidden="true" className="ticker-sym">
        {quote.symbol}
      </span>
      <span aria-hidden="true" className={tone}>
        {quote.price}
      </span>
      <span aria-hidden="true" className={`ticker-item ${tone}`}>
        <Icon className="ticker-arrow" />
        {quote.change}
      </span>
    </li>
  );
}

export function StockTicker() {
  const { edition } = useServices();
  const stocks = useStore(edition, (s) => s.stocks);
  const model = tickerModel(stocks);
  const listRef = useRef<HTMLUListElement>(null);
  // About 1,100 px of quotes in one line with a hidden scrollbar: where they do not fit, the list is
  // a scroller with nothing focusable inside, so a keyboard could not reach the quotes cut off at
  // the right (WCAG 2.1.1). While it overflows it is a tab stop and the arrow keys scroll it; where
  // everything fits it stays out of the tab order.
  const scrolls = useScrollsSideways(listRef, stocks);
  if (!model) return null;
  return (
    <section className="ticker-bar" aria-label="AI-related stocks">
      <ul className="ticker-list" ref={listRef} tabIndex={scrolls ? 0 : undefined} aria-label={scrolls ? "Stock quotes (scrolls sideways with the arrow keys)" : undefined}>
        {model.note && <li className="ticker-note">{model.note}</li>}
        {model.quotes.map((quote) => (
          <Quote key={quote.symbol} quote={quote} />
        ))}
      </ul>
    </section>
  );
}
