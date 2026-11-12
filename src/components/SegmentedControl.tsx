import { useId } from "react";

interface Option<T extends string> { value: T; label: string; }

export default function SegmentedControl<T extends string>({ value, options, onChange, label }: { value: T; options: readonly Option<T>[]; onChange: (value: T) => void; label: string }) {
  const id = useId();
  return (
    <div className="segmented-control" role="tablist" aria-label={label}>
      {options.map((option, index) => (
        <button key={option.value} type="button" role="tab" id={`${id}-${option.value}`} aria-selected={option.value === value} tabIndex={option.value === value ? 0 : -1} data-active={option.value === value} className="segmented-item" onClick={() => onChange(option.value)} onKeyDown={(event) => {
          const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!direction && event.key !== "Home" && event.key !== "End") return;
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + direction + options.length) % options.length;
          onChange(options[next].value);
          document.getElementById(`${id}-${options[next].value}`)?.focus();
        }}>{option.label}</button>
      ))}
    </div>
  );
}
