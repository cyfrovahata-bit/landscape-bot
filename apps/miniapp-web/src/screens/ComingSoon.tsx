import { useTelegramBackButton } from "../lib/telegram";
import { BackRow } from "../components/BackRow";

export function ComingSoon({ title, onBack }: { title: string; onBack: () => void }) {
  // Otherwise Telegram's native back gesture/button exits the whole mini app
  // instead of stepping back to the menu, same as the in-app "‹ Назад" row.
  useTelegramBackButton(onBack);
  return (
    <div>
      <BackRow onBack={onBack} />
      <div className="header">
        <h1>{title}</h1>
      </div>
      <div className="empty-state">
        <div style={{ fontSize: 40, marginBottom: 8 }}>🚧</div>
        Цей розділ ще в розробці.
      </div>
    </div>
  );
}
