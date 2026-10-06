import { BACKDATED_ENTRY_ENABLED } from "./lib/features";
import { useEffect, useState } from "react";
import { initTelegramApp, getInitDataUser } from "./lib/telegram";
import { api, type Me } from "./lib/api";
import { Menu, type Screen } from "./screens/Menu";
import { Logistics } from "./screens/Logistics";
import { Materials } from "./screens/Materials";
import { Stats } from "./screens/Stats";
import { AdminOverview } from "./screens/AdminOverview";
import { RoadTimesheet } from "./screens/RoadTimesheet";
import { RetroEntry } from "./screens/RetroEntry";
import { Approval } from "./screens/Approval";
import { ComingSoon } from "./screens/ComingSoon";
import { ActionLog } from "./screens/ActionLog";
import { SyncStatusPill } from "./components/SyncStatusPill";
import { startTracking, setTrackContext } from "./lib/track";

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

  // Журнал дій. Тимчасово, на час обкатки: один слухач на весь застосунок
  // замість виклику в кожній кнопці.
  useEffect(() => {
    startTracking();
  }, []);

  useEffect(() => {
    setTrackContext({ screen });
  }, [screen]);

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
        } else if (new URLSearchParams(window.location.search).get("openPlans")) {
          // From the "вам заплановано виїзд" notification: land on the road
          // timesheet index, where the planned trips are listed.
          setScreen("roadTimesheet");
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
      {screen === "roadTimesheet" && (
        <RoadTimesheet
          onBack={goMenu}
          onSaved={showSavedToast}
          onOpenRetro={() => { if (BACKDATED_ENTRY_ENABLED) setScreen("roadTimesheetRetro"); }}
          isAdmin={me?.role === "ADMIN"}
          myPib={me?.pib ?? ""}
        />
      )}
      {BACKDATED_ENTRY_ENABLED && screen === "roadTimesheetRetro" && <RetroEntry onBack={() => setScreen("roadTimesheet")} onSaved={showSavedToast} />}
      {screen === "stats" && <Stats onBack={goMenu} isAdmin={me?.role === "ADMIN"} />}
      {screen === "adminOverview" && <AdminOverview onBack={goMenu} />}
      {screen === "actionLog" && <ActionLog onBack={goMenu} />}
      {screen === "tools" && <ComingSoon title="🧰 Інструменти" onBack={goMenu} />}
      {screen === "approval" && (
        <Approval
          onBack={goMenu}
          focusDate={approvalFocus?.date}
          focusForeman={approvalFocus?.foremanTgId}
          isAdmin={me?.role === "ADMIN"}
        />
      )}
    </>
  );
}
