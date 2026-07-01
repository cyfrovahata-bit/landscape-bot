// Thin wrapper around the Telegram Mini App JS SDK (window.Telegram.WebApp).
// Falls back to no-ops when running in a plain browser during development.

type WebAppUser = { id: number; first_name?: string; username?: string };

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: { user?: WebAppUser };
  ready(): void;
  expand(): void;
  colorScheme: "light" | "dark";
  MainButton: {
    text: string;
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
    setText(text: string): void;
    showProgress(leaveActive?: boolean): void;
    hideProgress(): void;
    disable(): void;
    enable(): void;
  };
  BackButton: {
    show(): void;
    hide(): void;
    onClick(cb: () => void): void;
    offClick(cb: () => void): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TelegramWebApp };
  }
}

export function getWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

export function initTelegramApp() {
  const webApp = getWebApp();
  webApp?.ready();
  webApp?.expand();
}

export function getInitData(): string {
  return getWebApp()?.initData ?? "";
}

export function getInitDataUser(): WebAppUser | null {
  return getWebApp()?.initDataUnsafe?.user ?? null;
}
