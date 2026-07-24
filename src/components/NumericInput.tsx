import { useRef, useState, type KeyboardEvent } from "react";

interface NumericInputProps {
  value: number;
  onValueChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  disabled?: boolean;
  className?: string;
  title?: string;
}

function finiteValue(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function normalizeValue(value: number, min?: number, max?: number, integer = false): number {
  let next = integer ? Math.round(value) : value;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return next;
}

function parseDraft(value: string): number | null {
  if (!value || value === "-" || value === "." || value === "-.") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function NumericInput({
  value,
  onValueChange,
  min,
  max,
  step = 1,
  integer = false,
  disabled = false,
  className,
  title,
}: NumericInputProps) {
  const externalText = String(finiteValue(value));
  const [draft, setDraft] = useState(externalText);
  const [focused, setFocused] = useState(false);
  const cancelBlurRef = useRef(false);

  const commit = (text: string, final: boolean) => {
    const parsed = parseDraft(text);
    if (parsed === null) {
      if (final) setDraft(externalText);
      return;
    }
    const normalized = normalizeValue(parsed, min, max, integer);
    if (normalized !== finiteValue(value)) onValueChange(normalized);
    if (final) setDraft(String(normalized));
  };

  const nudge = (direction: 1 | -1) => {
    const current = parseDraft(draft) ?? finiteValue(value);
    const normalized = normalizeValue(current + Math.max(Number.EPSILON, step) * direction, min, max, integer);
    setDraft(String(normalized));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      nudge(event.key === "ArrowUp" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelBlurRef.current = true;
      setDraft(externalText);
      event.currentTarget.blur();
    }
  };

  return (
    <input
      type="text"
      role="spinbutton"
      inputMode={integer ? "numeric" : "decimal"}
      className={className}
      title={title}
      value={focused ? draft : externalText}
      disabled={disabled}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={finiteValue(value)}
      onFocus={() => {
        cancelBlurRef.current = false;
        setDraft(externalText);
        setFocused(true);
      }}
      onChange={(event) => {
        const text = event.target.value.trim();
        if (!/^-?(?:\d+(?:\.\d*)?|\.\d*)?$/.test(text)) return;
        setDraft(text);
      }}
      onBlur={(event) => {
        if (cancelBlurRef.current) {
          cancelBlurRef.current = false;
          setDraft(externalText);
        } else commit(event.currentTarget.value, true);
        setFocused(false);
      }}
      onKeyDown={onKeyDown}
    />
  );
}
