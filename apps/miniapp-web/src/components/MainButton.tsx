type Props = {
  text: string;
  onClick: () => void;
  disabled?: boolean;
};

export function MainButton({ text, onClick, disabled }: Props) {
  return (
    <div className="main-button">
      <button onClick={onClick} disabled={disabled}>
        {text}
      </button>
    </div>
  );
}
