import { useEffect, useState } from "react";
import { initTelegramApp, getInitDataUser } from "./lib/telegram";
import { api, type Me } from "./lib/api";
import { Menu, type Screen } from "./screens/Menu";
import { Logistics } from "./screens/Logistics";
import { Materials } from "./screens/Materials";
import { Stats } from "./screens/Stats";
import { RoadTimesheet } from "./screens/RoadTimesheet";
import { Approval } from "./screens/Approval";
import { ComingSoon } from "./screens/ComingSoon";
import { SyncStatusPill } from "./components/SyncStatusPill";

// Set by the "📄 Відкрити звіт" button on an admin's Telegram notification
// (see notifyAdmins in the server) -- opens straight to that report inside
// the SAME app (not a standalone page), so the admin can still reach every
// other menu item afterwards via the normal back button.
function readApprovalDeepLink(): { date: string; foremanTgId: number } | null {
  const params = new URLSearchParams(window.location.search);
  const date = params.get("approveDate");
  const foremanTgId = Number(params.get("approveForeman"));
  if (!date || !foremanTgId) return null;
  return { date, foremanTgId };
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [toast, setToast] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [approvalFocus, setApprovalFocus] = useState<{ date: string; foremanTgId: number } | null>(null);

  useEffect(() => {
    initTelegramApp();
    api
      .get<Me>("/api/me")
      .then((m) => {
        setMe(m);
        const deepLink = readApprovalDeepLink();
        if (deepLink && m.role === "ADMIN") {
          setApprovalFocus(deepLink);
          setScreen("approval");
        }
        // Deep-link params only matter for this one initial open -- strip them
        // so navigating back to the menu and reopening "Затвердження" later
        // (or just reloading) starts at the plain, unfocused list.
        window.history.replaceState({}, "", window.location.pathname);
      })
      .catch(() => setMe(null));
  }, []);

  function showSavedToast() {
    setToast("✅ Збережено");
    setTimeout(() => setToast(null), 2000);
    setScreen("menu");
  }

  const user = getInitDataUser();
  const goMenu = () => setScreen("menu");

  return (
    <>
      <SyncStatusPill />
      {toast && <div className="toast">{toast}</div>}

      {screen === "menu" && <Menu userName={user?.first_name} isAdmin={me?.role === "ADMIN"} onNavigate={setScreen} />}
      {screen === "logistics" && <Logistics onBack={goMenu} onSaved={showSavedToast} />}
      {screen === "materials" && <Materials onBack={goMenu} onSaved={showSavedToast} />}
      {screen === "roadTimesheet" && <RoadTimesheet onBack={goMenu} onSaved={showSavedToast} />}
      {screen === "stats" && <Stats onBack={goMenu} isAdmin={me?.role === "ADMIN"} />}
      {screen === "tools" && <ComingSoon title="🧰 Інструменти" onBack={goMenu} />}
      {screen === "approval" && (
        <Approval onBack={goMenu} focusDate={approvalFocus?.date} focusForeman={approvalFocus?.foremanTgId} />
      )}
    </>
  );
}
