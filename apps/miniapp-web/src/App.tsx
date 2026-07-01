import { useEffect, useState } from "react";
import { initTelegramApp, getInitDataUser } from "./lib/telegram";
import { Menu, type Screen } from "./screens/Menu";
import { Logistics } from "./screens/Logistics";
import { Materials } from "./screens/Materials";
import { Stats } from "./screens/Stats";
import { RoadTimesheet } from "./screens/RoadTimesheet";
import { ComingSoon } from "./screens/ComingSoon";

export default function App() {
  const [screen, setScreen] = useState<Screen>("menu");
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    initTelegramApp();
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
      {toast && <div className="toast">{toast}</div>}

      {screen === "menu" && <Menu userName={user?.first_name} onNavigate={setScreen} />}
      {screen === "logistics" && <Logistics onBack={goMenu} onSaved={showSavedToast} />}
      {screen === "materials" && <Materials onBack={goMenu} onSaved={showSavedToast} />}
      {screen === "roadTimesheet" && <RoadTimesheet onBack={goMenu} onSaved={showSavedToast} />}
      {screen === "stats" && <Stats onBack={goMenu} />}
      {screen === "tools" && <ComingSoon title="🧰 Інструменти" onBack={goMenu} />}
      {screen === "approval" && <ComingSoon title="✅ Затвердження" onBack={goMenu} />}
    </>
  );
}
