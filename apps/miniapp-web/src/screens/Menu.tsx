export type Screen = "menu" | "logistics" | "roadTimesheet" | "materials" | "stats" | "tools" | "approval";

const ITEMS: { screen: Screen; icon: string; title: string; ready: boolean }[] = [
  { screen: "logistics", icon: "🚚", title: "Логістика", ready: true },
  { screen: "roadTimesheet", icon: "🚗", title: "Дорожній табель", ready: true },
  { screen: "materials", icon: "🧱", title: "Матеріали", ready: true },
  { screen: "stats", icon: "📊", title: "Статистика", ready: true },
  { screen: "tools", icon: "🧰", title: "Інструменти", ready: false },
  { screen: "approval", icon: "✅", title: "Затвердження", ready: false },
];

export function Menu({ userName, onNavigate }: { userName?: string; onNavigate: (s: Screen) => void }) {
  return (
    <div>
      <div className="header">
        <h1>👋 {userName ? userName : "Вітаємо"}</h1>
        <div className="hint">Оберіть розділ</div>
      </div>

      <div className="list">
        {ITEMS.map((item) => (
          <button key={item.screen} className="cell" onClick={() => onNavigate(item.screen)}>
            <span style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span className="cell-icon">{item.icon}</span>
              <span className="cell-title">{item.title}</span>
            </span>
            {!item.ready && <span className="badge">Скоро</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
