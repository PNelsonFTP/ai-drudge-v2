// No-flash theme bootstrap. Dependency-free and DOM-type-free ON PURPOSE: the build (vite.config.ts,
// node project) may import THEME_BOOTSTRAP_SCRIPT to inline it into index.html's <head>, where it
// must run before first paint. The storage keys are spelled out here and pinned to
// src/app/services.ts by settings.test.ts.
//
// The script only READS storage: the V2 settings envelope, or - before the one-time migration has
// run - V1's theme key. It sets the same attributes applyAppearance() in settings.ts maintains:
//   <html class="dark|light" data-theme="dark|light" data-density="compact|comfortable">

export type ResolvedTheme = "light" | "dark";

export const SETTINGS_STORAGE_KEY = "aid2:settings";
export const V1_THEME_STORAGE_KEY = "ai-drudge:theme-ft";
export const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

/** "system" follows the OS; anything unknown is light (the site default). */
export function resolveTheme(theme: string | null | undefined, prefersDark: boolean): ResolvedTheme {
  if (theme === "dark") return "dark";
  if (theme === "system") return prefersDark ? "dark" : "light";
  return "light";
}

/**
 * Inline <script> body (ES5, no dependencies, swallows every error). Usage in index.html:
 *   <script>(the string)</script>   placed in <head> before the stylesheet link.
 */
export const THEME_BOOTSTRAP_SCRIPT: string = [
  "(function(){try{",
  "var d=document.documentElement,t=null,n=null,r=null;",
  `try{r=localStorage.getItem(${JSON.stringify(SETTINGS_STORAGE_KEY)});}catch(e){}`,
  "if(r){try{var s=JSON.parse(r);if(s&&s.data){t=s.data.theme;n=s.data.density;}}catch(e){}}",
  `else{try{t=localStorage.getItem(${JSON.stringify(V1_THEME_STORAGE_KEY)});}catch(e){}}`,
  `if(t==='system'){t=window.matchMedia&&window.matchMedia(${JSON.stringify(DARK_MEDIA_QUERY)}).matches?'dark':'light';}`,
  "if(t!=='dark'){t='light';}",
  "d.classList.remove(t==='dark'?'light':'dark');d.classList.add(t);",
  "d.setAttribute('data-theme',t);",
  "d.setAttribute('data-density',n==='comfortable'?'comfortable':'compact');",
  "}catch(e){}})();",
].join("");
