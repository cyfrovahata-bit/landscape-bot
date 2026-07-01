import { BackRow } from "../components/BackRow";

export function ComingSoon({ title, onBack }: { title: string; onBack: () => void }) {
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
