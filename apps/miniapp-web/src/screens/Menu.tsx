export type Screen = "menu" | "logistics" | "roadTimesheet" | "materials" | "stats" | "tools" | "approval";

type Accent = "blue" | "green" | "orange" | "purple" | "teal" | "gray";

const ITEMS: { screen: Screen; icon: string; title: string; ready: boolean; accent: Accent }[] = [
  { screen: "logistics", icon: "🚚", title: "Логістика", ready: true, accent: "blue" },
  { screen: "roadTimesheet", icon: "🚗", title: "Дорожній табель", ready: true, accent: "green" },
  { screen: "materials", icon: "🧱", title: "Матеріали", ready: true, accent: "orange" },
  { screen: "stats", icon: "📊", title: "Статистика", ready: true, accent: "purple" },
  { screen: "tools", icon: "🧰", title: "Інструменти", ready: false, accent: "teal" },
  { screen: "approval", icon: "✅", title: "Затвердження", ready: false, accent: "gray" },
];

// A bit of warmth on the one screen every user sees every single time --
// doesn't need real data, just the time of day already known client-side.
function greeting(): { emoji: string; text: string } {
  const hour = new Date().getHours();
  if (hour < 6) return { emoji: "🌙", text: "Доброї ночі" };
  if (hour < 12) return { emoji: "🌅", text: "Доброго ранку" };
  if (hour < 18) return { emoji: "☀️", text: "Доброго дня" };
  return { emoji: "🌆", text: "Доброго вечора" };
}

export function Menu({
  userName,
  isAdmin,
  onNavigate,
}: {
  userName?: string;
  isAdmin?: boolean;
  onNavigate: (s: Screen) => void;
}) {
  const { emoji, text } = greeting();
  // "Затвердження" is admin-only real functionality -- hidden for brigadiers
  // entirely (a "Скоро" tile that never turns real for them would just be
  // noise), shown as ready for admins instead of the static placeholder.
  const items = ITEMS.filter((item) => item.screen !== "approval" || isAdmin).map((item) =>
    item.screen === "approval" ? { ...item, ready: true } : item,
  );
  return (
    <div>
      <div className="menu-header">
        <div className="menu-greeting-emoji">{emoji}</div>
        <h1>
          {text}
          {userName ? `, ${userName}` : ""}
        </h1>
        <div className="hint">Оберіть розділ</div>
      </div>

      <div className="menu-grid">
        {items.map((item) => (
          <button key={item.screen} className="menu-card" onClick={() => onNavigate(item.screen)}>
            {!item.ready && <span className="badge menu-card-badge">Скоро</span>}
            <span className={`menu-card-icon accent-${item.accent}`}>{item.icon}</span>
            <span className="menu-card-title">{item.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
