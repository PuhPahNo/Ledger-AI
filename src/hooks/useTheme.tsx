import { createContext, useCallback, useContext, useState } from 'react';
import type { ReactNode } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'ledger-theme';

interface ThemeContextValue {
  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Read the theme the no-flash script (in index.html) already applied to <html>. */
function initialTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(initialTheme);

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    applyTheme(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // localStorage unavailable (private mode / SSR) — theme still applies for this session.
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggleTheme }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}

/**
 * Resolve a theme-aware CSS color variable to an `hsl(...)` string for use in
 * places that need a JS color value (e.g. SVG charts that can't use CSS classes).
 * Re-reads on every theme change. `cssVar` is the channel-only custom property
 * (e.g. `--color-ink`); `fallback` is returned when the DOM is unavailable.
 */
export function useResolvedColor(cssVar: string, fallback: string): string {
  // Subscribe to theme so the value recomputes when the user toggles.
  useTheme();
  if (typeof document === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
  return value ? `hsl(${value})` : fallback;
}
