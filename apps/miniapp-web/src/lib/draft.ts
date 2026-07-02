// Client-side autosave for the road timesheet: the whole in-progress day
// lives only in React state, so if Telegram evicts the mini-app webview from
// memory (common on Android when the phone is low on RAM), a foreman could
// lose an entire morning of planning. Every meaningful change is mirrored
// into localStorage so it survives the app being killed and reopened on the
// same device; there's no cross-device sync (that would mean writing every
// keystroke to Google Sheets, which isn't practical).
const DRAFT_KEY = "roadTimesheetDraft:v1";
const MAX_AGE_MS = 20 * 60 * 60 * 1000; // stale after ~20h, so it never resurrects a truly old, abandoned day

export function saveDraft<T>(data: T) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // localStorage unavailable/full -- autosave is best-effort, not critical path
  }
}

export function loadDraft<T>(): T | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
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
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // ignore
  }
}
