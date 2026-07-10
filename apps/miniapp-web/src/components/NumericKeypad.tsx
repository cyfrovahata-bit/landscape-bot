// On-screen numeric keypad matching the road timesheet mockup (odometer entry,
// work volume entry) -- used instead of the native number input keyboard.
export function NumericKeypad({
  value,
  onChange,
  maxLength = 7,
}: {
  value: string;
  onChange: (next: string) => void;
  maxLength?: number;
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
      onChange(key);
      return;
    }
    if (value.replace(".", "").length >= maxLength) return;
    onChange(value + key);
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
