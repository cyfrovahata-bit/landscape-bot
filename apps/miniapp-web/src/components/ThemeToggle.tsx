import { useState } from "react";

type Theme = "light" | "dark";
const STORAGE_KEY = "greenhand:theme";

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* Storage is optional. */ }
  return window.Telegram?.WebApp.colorScheme === "dark" ? "dark" : "light";
}

// Apply before rendering to avoid a flash when reopening a saved dark theme.
if (window.Telegram?.WebApp.colorScheme !== "dark") {
  const style = getComputedStyle(document.documentElement);
  for (const name of ["bg-color", "secondary-bg-color", "text-color", "hint-color", "link-color", "button-color", "button-text-color"]) {
    const value = style.getPropertyValue(`--tg-theme-${name}`).trim();
    if (value) document.documentElement.style.setProperty(`--greenhand-light-${name}`, value);
  }
}
const startingTheme = initialTheme();
document.documentElement.dataset.theme = startingTheme;

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(startingTheme);
  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Keep the session choice. */ }
  }
  return (
    <div className="theme-toolbar">
      <button className="theme-toggle theme-icon-button" type="button" role="switch"
        aria-label="Темна тема" title={theme === "dark" ? "Увімкнути світлу тему" : "Увімкнути темну тему"} aria-checked={theme === "dark"} onClick={toggleTheme}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {theme === "dark" ? <path d="M20.7 13A9 9 0 0 1 11 3.3 9 9 0 1 0 20.7 13Z" /> : <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
          </>}
        </svg>
      </button>
    </div>
  );
}
