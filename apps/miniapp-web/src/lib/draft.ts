// Client-side autosave for the road timesheet: the whole in-progress day
// lives only in React state, so if Telegram evicts the mini-app webview from
// memory (common on Android when the phone is low on RAM), a foreman could
// lose an entire morning of planning. Every meaningful change is mirrored
// into localStorage so it survives the app being killed and reopened on the
// same device; there's no cross-device sync (that would mean writing every
// keystroke to Google Sheets, which isn't practical).
import { getInitDataUser } from "./telegram";

const MAX_AGE_MS = 20 * 60 * 60 * 1000; // stale after ~20h, so it never resurrects a truly old, abandoned day

// Keyed by Telegram user id -- localStorage is scoped to this origin, not to
// whoever's logged into Telegram, so two different accounts opening the Mini
// App from the same device/webview (common when testing an admin and a
// foreman account side by side) would otherwise silently read and overwrite
// each other's in-progress draft.
function draftKey(): string {
  return `roadTimesheetDraft:v1:${getInitDataUser()?.id ?? "anon"}`;
}

export function saveDraft<T>(data: T) {
  try {
    localStorage.setItem(draftKey(), JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // localStorage unavailable/full -- autosave is best-effort, not critical path
  }
}

export function loadDraft<T>(): T | null {
  try {
    const raw = localStorage.getItem(draftKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { savedAt: number; data: T };
    if (Date.now() - parsed.savedAt > MAX_AGE_MS) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function clearDraft() {
  try {
    localStorage.removeItem(draftKey());
  } catch {
    // ignore
  }
}
