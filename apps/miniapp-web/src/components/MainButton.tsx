import { useState } from "react";

type Props = {
  text: string;
  onClick: () => void | Promise<void>;
  disabled?: boolean;
};

export function MainButton({ text, onClick, disabled }: Props) {
  // Guards against a fast double-tap firing the handler twice while the
  // first call's request is still in flight (e.g. two POSTs for the same
  // submit, or two /reserve calls racing each other).
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    try {
      await onClick();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="main-button">
      <button onClick={handleClick} disabled={disabled || busy}>
        {text}
      </button>
    </div>
  );
}
