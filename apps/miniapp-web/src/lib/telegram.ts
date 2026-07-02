// Thin wrapper around the Telegram Mini App JS SDK (window.Telegram.WebApp).
// Falls back to no-ops when running in a plain browser during development.
import { useEffect } from "react";

type WebAppUser = { id: number; first_name?: string; username?: string };
type ImpactStyle = "light" | "medium" | "heavy" | "rigid" | "soft";
type NotificationType = "error" | "success" | "warning";

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
  HapticFeedback?: {
    impactOccurred(style: ImpactStyle): void;
    notificationOccurred(type: NotificationType): void;
    selectionChanged(): void;
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

// Small tactile feedback on toggles/confirmations -- no-ops outside Telegram
// (plain browser dev, or old client versions without HapticFeedback).
export function haptic(kind: ImpactStyle | NotificationType | "selection" = "light") {
  const feedback = getWebApp()?.HapticFeedback;
  if (!feedback) return;
  if (kind === "selection") feedback.selectionChanged();
  else if (kind === "error" || kind === "success" || kind === "warning") feedback.notificationOccurred(kind);
  else feedback.impactOccurred(kind);
}

// Wires Telegram's native hardware/gesture back button to the same handler
// used by the in-app "‹ Назад" row, so swiping back doesn't accidentally
// exit the whole mini app instead of going up one menu level. Pass null to
// hide the button (e.g. on the top-level screen).
export function useTelegramBackButton(onBack: (() => void) | null) {
  useEffect(() => {
    const webApp = getWebApp();
    if (!webApp) return;
    if (!onBack) {
      webApp.BackButton.hide();
      return;
    }
    webApp.BackButton.show();
    webApp.BackButton.onClick(onBack);
    return () => {
      webApp.BackButton.offClick(onBack);
      webApp.BackButton.hide();
    };
  }, [onBack]);
}
