// On-screen numeric keypad matching the road timesheet mockup (odometer entry,
// work volume entry) -- used instead of the native number input keyboard.
export function NumericKeypad({
  value,
  onChange,
  maxLength = 7,
  max,
  onRejected,
}: {
  value: string;
  onChange: (next: string) => void;
  maxLength?: number;
  // Upper bound enforced digit-by-digit (e.g. odometer start can't exceed
  // the car's last known reading) -- unlike a lower bound, this is safe to
  // block on every keystroke since appending more digits only grows the
  // number further past the limit, never back under it. onRejected fires
  // (haptic feedback, etc.) whenever a keystroke would cross max.
  max?: number;
  onRejected?: () => void;
}) {
  function press(key: string) {
    if (key === "back") {
      onChange(value.slice(0, -1));
      return;
    }
    if (key === "clear") {
      onChange("");
      return;
    }
    if (key === ".") {
      if (value.includes(".")) return;
      onChange(value + key);
      return;
    }
    // No leading zero -- "0" then "5" replaces to "5" instead of growing "05".
    if (value === "0") {
      if (max !== undefined && Number(key) > max) {
        onRejected?.();
        return;
      }
      onChange(key);
      return;
    }
    if (value.replace(".", "").length >= maxLength) return;
    const next = value + key;
    if (max !== undefined && Number(next) > max) {
      onRejected?.();
      return;
    }
    onChange(next);
  }

  const rows = [
    ["1", "2", "3"],
    ["4", "5", "6"],
    ["7", "8", "9"],
    ["clear", "0", "back"],
  ];

  return (
    <div className="keypad">
      {rows.map((row, i) => (
        <div className="keypad-row" key={i}>
          {row.map((key) => (
            <button
              key={key}
              className="keypad-key"
              style={key === "clear" ? { fontSize: 14 } : undefined}
              onClick={() => press(key)}
            >
              {key === "back" ? "⌫" : key === "clear" ? "Очистити" : key}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
