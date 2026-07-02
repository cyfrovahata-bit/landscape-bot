import { useEffect, useState } from "react";
import { subscribeSyncStatus, type SyncStatus } from "../lib/api";

// Only visible while something's actually happening -- silent "idle" is the
// normal state, so showing nothing most of the time avoids visual noise.
export function SyncStatusPill() {
  const [status, setStatus] = useState<SyncStatus>("idle");

  useEffect(() => subscribeSyncStatus(setStatus), []);

  if (status === "idle") return null;

  return (
    <div className={`sync-pill ${status}`}>{status === "syncing" ? "🟡 Синхронізація…" : "🔴 Немає звʼязку, повторюю…"}</div>
  );
}
