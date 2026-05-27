import { useState, useRef, useEffect, type ReactNode } from "react";
import { cn } from "@/lib/utils";

interface DropdownOption {
  value: string;
  label: string;
}

interface DropdownProps {
  options: DropdownOption[];
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  trigger?: ReactNode;
}

export function Dropdown({
  options,
  value,
  onChange,
  placeholder = "Select...",
  className,
  trigger,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setFocusIdx((i) => Math.min(i + 1, options.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setFocusIdx((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (focusIdx >= 0) {
          onChange(options[focusIdx].value);
          setOpen(false);
        }
        break;
      case "Escape":
        setOpen(false);
        break;
    }
  }

  const selected = options.find((o) => o.value === value);

  return (
    <div ref={ref} className={cn("relative", className)} onKeyDown={handleKeyDown}>
      {trigger ? (
        <div onClick={() => setOpen(!open)}>{trigger}</div>
      ) : (
        <button
          onClick={() => setOpen(!open)}
          className="flex w-full items-center justify-between rounded-lg border border-border bg-background px-3 py-2 text-sm hover:border-primary/40"
        >
          <span className={selected ? "text-foreground" : "text-muted-foreground"}>
            {selected?.label ?? placeholder}
          </span>
          <span className="text-muted-foreground">&#9662;</span>
        </button>
      )}
      {open && (
        <ul className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-card py-1 shadow-lg">
          {options.map((opt, i) => (
            <li
              key={opt.value}
              onClick={() => {
                onChange(opt.value);
                setOpen(false);
              }}
              className={cn(
                "cursor-pointer px-3 py-1.5 text-sm",
                i === focusIdx && "bg-accent",
                opt.value === value
                  ? "text-primary font-medium"
                  : "text-foreground hover:bg-accent",
              )}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
