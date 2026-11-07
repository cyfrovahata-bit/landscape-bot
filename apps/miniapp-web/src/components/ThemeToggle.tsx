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
      <button className="theme-toggle" type="button" role="switch"
        aria-label="Темна тема" aria-checked={theme === "dark"} onClick={toggleTheme}>
        <span aria-hidden="true">{theme === "dark" ? "🌙" : "☀️"}</span>
        <span>Темна тема</span>
        <span className="theme-toggle-track" aria-hidden="true"><span /></span>
      </button>
    </div>
  );
}
