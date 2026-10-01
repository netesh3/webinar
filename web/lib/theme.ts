/* Light / dark for the portal.
 *
 * Light is the palette in @theme and the look when nothing has been chosen and
 * the OS is not asking for dark. A stored "light" or "dark" wins over
 * prefers-color-scheme from then on — including if the OS changes later.
 *
 * The root layout inlines themeBootScript() so the attribute is set before
 * first paint. This module is the same rule, for toggles after that. */

export const THEME_STORAGE_KEY = "webinar.theme";
export const THEME_CHANGE_EVENT = "webinar-theme";

export type ThemeChoice = "light" | "dark";

export function isThemeChoice(value: string | null): value is ThemeChoice {
  return value === "light" || value === "dark";
}

export function readStoredTheme(): ThemeChoice | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function systemTheme(): ThemeChoice {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Stored choice, otherwise the OS. Light when neither says dark. */
export function resolveTheme(): ThemeChoice {
  return readStoredTheme() ?? systemTheme();
}

export function applyTheme(theme: ThemeChoice) {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
}

export function persistTheme(theme: ThemeChoice) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode can refuse storage. The attribute still updates for this view.
  }
  applyTheme(theme);
  window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
}

/** Blocking script for the root layout. Keep the key and the rule in sync with
 *  resolveTheme — this string cannot import the module. */
export function themeBootScript(): string {
  const key = JSON.stringify(THEME_STORAGE_KEY);
  return `(function(){try{var k=${key};var s=localStorage.getItem(k);var d=window.matchMedia("(prefers-color-scheme: dark)").matches;var t=(s==="light"||s==="dark")?s:(d?"dark":"light");var e=document.documentElement;e.setAttribute("data-theme",t);e.style.colorScheme=t;}catch(e){}})();`;
}
