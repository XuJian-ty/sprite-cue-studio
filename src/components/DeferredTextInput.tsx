import { useRef, useState, type KeyboardEvent } from "react";

interface DeferredTextInputProps {
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
  placeholder?: string;
}

export default function DeferredTextInput({
  value,
  onValueChange,
  disabled = false,
  className,
  title,
  placeholder,
}: DeferredTextInputProps) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const cancelBlurRef = useRef(false);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelBlurRef.current = true;
      setDraft(value);
      event.currentTarget.blur();
    }
  };

  return (
    <input
      type="text"
      className={className}
      title={title}
      placeholder={placeholder}
      disabled={disabled}
      value={focused ? draft : value}
      onFocus={() => {
        cancelBlurRef.current = false;
        setDraft(value);
        setFocused(true);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        if (cancelBlurRef.current) cancelBlurRef.current = false;
        else if (event.currentTarget.value !== value) onValueChange(event.currentTarget.value);
        setFocused(false);
      }}
      onKeyDown={onKeyDown}
    />
  );
}
