// Watchlist editor (used on #/watch and in Settings) and the matching-rules explainer.

import { useId, useState, type FormEvent } from "react";
import { useServices, useStore } from "../../app/services";
import { Dialog } from "../export/kit/Dialog";
import { plural } from "../export/kit/rows";
import { checkTerm, presetMissing } from "./model";

export function WatchTermEditor() {
  const { watchlist } = useServices();
  const terms = useStore(watchlist, (w) => w.terms);
  const [text, setText] = useState("");
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const inputId = useId();
  const helpId = useId();

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const check = checkTerm(text, terms);
    if (!check.ok) {
      setMessage({ text: check.error, error: true });
      return;
    }
    watchlist.add(check.term);
    setText("");
    setMessage({ text: `Watching “${check.term}”.`, error: false });
  };

  return (
    <div>
      <form className="sp-field" onSubmit={onSubmit}>
        <label htmlFor={inputId}>Add a watch term</label>
        <input
          id={inputId}
          className="sp-input"
          value={text}
          maxLength={80}
          autoComplete="off"
          spellCheck={false}
          placeholder="prompt injection, Qwen*, quantiz*"
          aria-describedby={helpId}
          aria-invalid={message?.error ? true : undefined}
          onChange={(e) => {
            setText(e.target.value);
            if (message) setMessage(null);
          }}
        />
        <button type="submit" className="sp-btn sp-btn-primary">
          Add
        </button>
      </form>
      <p id={helpId} className={message?.error ? "sp-note sp-warn" : "sp-note"} role="status" aria-live="polite">
        {message?.text ?? "Whole words in headlines, any letter case; end a term with * to match longer words (Qwen* finds Qwen3.8). Terms are stored in this browser only."}
      </p>

      {terms.length > 0 ? (
        <ul className="sp-terms" aria-label={`Watch terms (${terms.length})`}>
          {terms.map((t) => (
            <li key={t.toLowerCase()} className="sp-term">
              <span>{t}</span>
              <button
                type="button"
                className="sp-btn"
                aria-label={`Remove watch term ${t}`}
                title={`Remove ${t}`}
                onClick={() => {
                  watchlist.remove(t);
                  setMessage({ text: `Removed “${t}”.`, error: false });
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="sp-note">No watch terms yet. Add your own above or start from a suggested set.</p>
      )}

      <div className="sp-field" role="group" aria-label="Suggested term sets">
        <span className="sp-label">Suggested sets</span>
        {watchlist.presets.map((p) => {
          const missing = presetMissing(p.terms, terms);
          return (
            <button
              key={p.id}
              type="button"
              className="sp-btn"
              aria-disabled={missing === 0}
              title={p.terms.join(", ")}
              onClick={() => {
                if (missing === 0) return;
                watchlist.addPreset(p.id);
                setMessage({ text: `Added ${plural(missing, "term")} from “${p.label}”.`, error: false });
              }}
            >
              {missing === 0 ? `${p.label} added` : `Add ${p.label} (${missing})`}
            </button>
          );
        })}
        {terms.length > 0 ? (
          <button type="button" className="sp-btn sp-btn-quiet" onClick={() => setConfirmClear(true)}>
            Remove all terms
          </button>
        ) : null}
      </div>

      <Dialog open={confirmClear} onClose={() => setConfirmClear(false)} title="Remove all watch terms?">
        <p>This removes all {plural(terms.length, "watch term")} from this browser. A backup from Settings can restore them.</p>
        <div className="sp-dialog-actions">
          <button
            type="button"
            className="sp-btn sp-btn-danger"
            onClick={() => {
              watchlist.clear();
              setConfirmClear(false);
              setMessage({ text: "All watch terms removed.", error: false });
            }}
          >
            Remove all
          </button>
          <button type="button" className="sp-btn" onClick={() => setConfirmClear(false)}>
            Cancel
          </button>
        </div>
      </Dialog>
    </div>
  );
}

/** How a watch term matches - the rules of shared/text.ts compileTerms, in plain words. */
export function MatchingRules() {
  return (
    <div className="sp-prose">
      <ul>
        <li>
          <strong>Whole words only.</strong> <code className="sp-code">EDR</code> does not match “Bedrock”; <code className="sp-code">SEC</code> does not match “security”.
        </li>
        <li>
          <strong>Wildcard *</strong> at the end or the start of a term: <code className="sp-code">quantiz*</code> matches “quantized” and “quantization”;{" "}
          <code className="sp-code">*bench</code> matches “SWE-bench”; <code className="sp-code">CVE-*</code> matches any CVE number.
        </li>
        <li>
          <strong>Phrases</strong> match as written; spaces and hyphens are interchangeable (<code className="sp-code">open source</code> matches “open-source”).
        </li>
        <li>
          Letter case does not matter, and a plural <em>s</em> or <em>es</em> is accepted (<code className="sp-code">LLM</code> matches “LLMs”).
        </li>
        <li>Only headlines are matched, over every story of the last 7 days. Muted sources and sections are left out.</li>
      </ul>
    </div>
  );
}
