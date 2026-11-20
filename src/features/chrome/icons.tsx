// Inline SVG icons (currentColor, decorative). V1 used Unicode glyphs that are missing from Arial
// and fall back to whatever font - or emoji - the OS picks.

interface IconProps {
  className?: string;
}

const base = { viewBox: "0 0 10 10", "aria-hidden": true, focusable: false as const, fill: "currentColor" };

export function ArrowUpIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M5 1 9.5 9h-9z" />
    </svg>
  );
}

export function ArrowDownIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M5 9 .5 1h9z" />
    </svg>
  );
}

export function FlatIcon({ className }: IconProps) {
  return (
    <svg {...base} className={className}>
      <path d="M1 4h8v2H1z" />
    </svg>
  );
}
