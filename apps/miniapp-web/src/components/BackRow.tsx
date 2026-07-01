export function BackRow({ onBack, label = "‹ Назад" }: { onBack: () => void; label?: string }) {
  return (
    <div className="back-row">
      <button className="back-btn" onClick={onBack}>
        {label}
      </button>
    </div>
  );
}
