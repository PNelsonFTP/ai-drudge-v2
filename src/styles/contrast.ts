// WCAG 2.x contrast maths + a tiny reader for the token file (src/styles/tokens.css).
// Pure string/number code (no node:, no DOM) so it can also back a dev overlay later.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  /** 0..1 */
  a: number;
}

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i;

/** Parse #rgb / #rgba / #rrggbb / #rrggbbaa / rgb() / rgba(); null for anything else. */
export function parseColor(value: string): Rgba | null {
  const v = value.trim();
  const hex = HEX_RE.exec(v);
  if (hex) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    const n = (i: number): number => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  const rgb = RGB_RE.exec(v);
  if (rgb) {
    const alpha = rgb[4] === undefined ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]), a: alpha };
  }
  return null;
}

/** Source-over compositing of `top` on an opaque `base`. */
export function composite(top: Rgba, base: Rgba): Rgba {
  const mix = (t: number, b: number): number => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, base.r), g: mix(top.g, base.g), b: mix(top.b, base.b), a: 1 };
}

/** WCAG relative luminance of an opaque colour. */
export function luminance(c: Rgba): number {
  const lin = (channel: number): number => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio (1..21) of two opaque colours. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export type TokenMap = Readonly<Record<string, string>>;

/** Custom properties declared in the first rule whose selector is exactly `selector`. */
export function readTokenBlock(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`(?:^|[\\s{};])${escaped}\\s*\\{([^}]*)\\}`).exec(stripComments(css));
  const out: Record<string, string> = {};
  if (!block) return out;
  for (const m of block[1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].replace(/\s+/g, " ").trim();
  return out;
}

export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Light and dark token maps of tokens.css (dark = light overridden by the html.dark block). */
export function readThemes(css: string): { light: TokenMap; dark: TokenMap } {
  const light = readTokenBlock(css, ":root");
  return { light, dark: { ...light, ...readTokenBlock(css, "html.dark") } };
}

/** Follow var(--x) references (with optional fallbacks) to a literal value; null when undefined. */
export function resolveToken(tokens: TokenMap, name: string, depth = 0): string | null {
  const raw = tokens[name];
  if (raw === undefined || depth > 8) return null;
  const ref = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(raw);
  if (!ref) return raw;
  return resolveToken(tokens, ref[1], depth + 1) ?? ref[2]?.trim() ?? null;
}

export function tokenColor(tokens: TokenMap, name: string): Rgba | null {
  const v = resolveToken(tokens, name);
  return v === null ? null : parseColor(v);
}

export type ContrastKind = "text" | "large" | "ui";

export const CONTRAST_MIN: Readonly<Record<ContrastKind, number>> = { text: 4.5, large: 3, ui: 3 };

export interface ContrastRule {
  kind: ContrastKind;
  fg: string;
  on: string[];
  /** Opaque colours a translucent background is composited on (empty when the backgrounds are opaque). */
  over: string[];
}

/** The "@contrast <kind> <fg> on <bg...> [over <base...>]" lines of tokens.css. */
export function readContrastRules(css: string): ContrastRule[] {
  const rules: ContrastRule[] = [];
  for (const m of css.matchAll(/@contrast\s+(text|large|ui)\s+(--[\w-]+)\s+on\s+([^\n]*)/g)) {
    const [bgPart, overPart = ""] = m[3].split(/\sover\s/);
    const names = (s: string): string[] => s.match(/--[\w-]+/g) ?? [];
    rules.push({ kind: m[1] as ContrastKind, fg: m[2], on: names(bgPart), over: names(overPart) });
  }
  return rules;
}

export function readContrastExempt(css: string): string[] {
  const out: string[] = [];
  for (const m of css.matchAll(/@contrast-exempt\s+([^\n]*)/g)) out.push(...(m[1].match(/--[\w-]+/g) ?? []));
  return out;
}

export interface ContrastResult {
  theme: "light" | "dark";
  rule: ContrastRule;
  bg: string;
  base: string | null;
  ratio: number;
  min: number;
  pass: boolean;
}

/** Evaluate one rule in one theme: every background (x every base) is one result. Throws on an undefined token. */
export function evaluateRule(tokens: TokenMap, rule: ContrastRule, theme: "light" | "dark"): ContrastResult[] {
  const need = (name: string): Rgba => {
    const c = tokenColor(tokens, name);
    if (!c) throw new Error(`${theme}: token ${name} is undefined or not a colour`);
    return c;
  };
  const fg = need(rule.fg);
  const results: ContrastResult[] = [];
  for (const bgName of rule.on) {
    const bg = need(bgName);
    const bases: (string | null)[] = bg.a < 1 ? rule.over : [null];
    if (bg.a < 1 && rule.over.length === 0) throw new Error(`${theme}: ${bgName} is translucent - add "over <base tokens>"`);
    for (const baseName of bases) {
      const solidBg = baseName === null ? bg : composite(bg, need(baseName));
      const solidFg = fg.a < 1 ? composite(fg, solidBg) : fg;
      const ratio = contrastRatio(solidFg, solidBg);
      const min = CONTRAST_MIN[rule.kind];
      results.push({ theme, rule, bg: bgName, base: baseName, ratio, min, pass: ratio >= min });
    }
  }
  return results;
}
