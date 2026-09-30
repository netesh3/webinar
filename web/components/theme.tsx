"use client";

import {
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  createContext,
  type ReactNode,
} from "react";
import { MaterialIcon } from "./icons";
import {
  THEME_CHANGE_EVENT,
  applyTheme,
  persistTheme,
  resolveTheme,
  type ThemeChoice,
} from "@/lib/theme";

const ThemeContext = createContext<{
  theme: ThemeChoice;
  setTheme: (next: ThemeChoice) => void;
  toggle: () => void;
} | null>(null);

function subscribe(onStoreChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => onStoreChange();
  media.addEventListener("change", onChange);
  window.addEventListener(THEME_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    media.removeEventListener("change", onChange);
    window.removeEventListener(THEME_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const serverTheme = (): ThemeChoice => "light";

export function ThemeProvider({ children }: { children: ReactNode }) {
  const theme = useSyncExternalStore(subscribe, resolveTheme, serverTheme);

  // resolveTheme(), not the hook value: the first client render still reports
  // the server snapshot ("light") so hydration matches, and writing that onto
  // <html> would flash the light page over a dark boot script.
  useLayoutEffect(() => {
    applyTheme(resolveTheme());
  }, [theme]);

  const setTheme = useCallback((next: ThemeChoice) => {
    persistTheme(next);
  }, []);

  const toggle = useCallback(() => {
    persistTheme(resolveTheme() === "dark" ? "light" : "dark");
  }, []);

  const value = useMemo(
    () => ({ theme, setTheme, toggle }),
    [theme, setTheme, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return value;
}

/** Icon button for the top bar. Sun while dark is on (switch to light), moon
 *  while light is on. The choice is stored and then beats the OS. */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Light" : "Dark"}
      className={`grid size-8 place-items-center rounded-lg text-ink-2 outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-brand/40 ${className}`}
    >
      <MaterialIcon
        name={dark ? "light_mode" : "dark_mode"}
        className="!text-[20px]"
      />
    </button>
  );
}
