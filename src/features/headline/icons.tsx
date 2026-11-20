// Inline SVG icons (currentColor, decorative). V1 used Unicode glyphs whose coverage and metrics
// depend on the reader's fonts; these do not.

import type { ReactNode } from "react";

function Icon({ children, size = 14 }: { children: ReactNode; size?: number }) {
  return (
    <svg className="hl-icon" width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const STAR = "M8 1.6l1.95 4.02 4.4.6-3.2 3.08.78 4.38L8 11.58 4.07 13.68l.78-4.38-3.2-3.08 4.4-.6z";

export function StarIcon({ filled }: { filled: boolean }) {
  return (
    <Icon>
      <path d={STAR} fill={filled ? "currentColor" : "none"} />
    </Icon>
  );
}

export function ClockIcon({ filled }: { filled: boolean }) {
  return (
    <Icon>
      <circle cx="8" cy="8" r="6.2" fill={filled ? "currentColor" : "none"} />
      <path d="M8 4.6V8l2.3 1.5" stroke={filled ? "var(--color-bg, #fff)" : "currentColor"} />
    </Icon>
  );
}

export function MuteIcon() {
  return (
    <Icon>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M3.7 12.3l8.6-8.6" />
    </Icon>
  );
}

export function LinkIcon() {
  return (
    <Icon>
      <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" />
      <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />
    </Icon>
  );
}

export function CheckIcon() {
  return (
    <Icon>
      <path d="M3 8.5l3.2 3.2L13 4.6" />
    </Icon>
  );
}

export function DotsIcon() {
  return (
    <Icon>
      <circle cx="3.2" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.8" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function CloseIcon() {
  return (
    <Icon>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Icon>
  );
}

export function ChevronIcon({ open }: { open: boolean }) {
  return <Icon>{open ? <path d="M3.5 6l4.5 4.5L12.5 6" /> : <path d="M6 3.5L10.5 8 6 12.5" />}</Icon>;
}
