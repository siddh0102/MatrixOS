import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export interface SearchableSelectOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SearchableSelectOption[];
  placeholder?: string;
  label?: string;
  disabled?: boolean;
  /** Shown inside the filter box. */
  searchPlaceholder?: string;
  className?: string;
}

/**
 * A combobox: a select-like trigger that opens a filterable list. Built
 * for model pickers where a provider can expose dozens of models. No
 * external deps — keyboard nav (↑/↓/Enter/Esc), click-outside close, and
 * type-to-filter on the option label.
 */
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = "Select…",
  label,
  disabled = false,
  searchPlaceholder = "Search…",
  className,
}: SearchableSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Reset filter + focus the search box whenever we open.
  useEffect(() => {
    if (open) {
      setQuery("");
      const selIdx = filtered.findIndex((o) => o.value === value);
      setHighlight(selIdx >= 0 ? selIdx : 0);
      // Focus after the dropdown paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const el = listRef.current.children[highlight] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlight, open]);

  function commit(v: string) {
    onChange(v);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) {
      if (e.key === "Enter" || e.key === "ArrowDown" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = filtered[highlight];
      if (opt) commit(opt.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label className="text-xs font-semibold text-foreground tracking-wide uppercase">
          {label}
        </label>
      )}
      <div ref={rootRef} className={cn("relative", className)}>
        {/* Trigger */}
        <button
          type="button"
          disabled={disabled}
          onClick={() => !disabled && setOpen((o) => !o)}
          onKeyDown={onKeyDown}
          className={cn(
            "flex h-9 w-full items-center justify-between rounded-lg border border-input bg-background px-3 py-1.5 text-sm",
            "text-left transition-colors duration-150",
            "focus-visible:outline-none focus-visible:border-input-focus focus-visible:ring-2 focus-visible:ring-ring-subtle",
            "disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          <span className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? selected.label : placeholder}
          </span>
          <svg
            className="ml-2 h-4 w-4 shrink-0 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {open && (
          <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-card shadow-lg">
            <div className="border-b border-border/60 p-1.5">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(0);
                }}
                onKeyDown={onKeyDown}
                placeholder={searchPlaceholder}
                className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-sm focus:outline-none focus:border-input-focus"
              />
            </div>
            <ul ref={listRef} className="max-h-60 overflow-y-auto py-1">
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-sm text-muted-foreground">No matches</li>
              ) : (
                filtered.map((opt, i) => (
                  <li key={opt.value}>
                    <button
                      type="button"
                      onClick={() => commit(opt.value)}
                      onMouseEnter={() => setHighlight(i)}
                      className={cn(
                        "flex w-full items-center justify-between px-3 py-1.5 text-left text-sm transition-colors",
                        i === highlight ? "bg-accent" : "hover:bg-accent/50",
                        opt.value === value && "font-medium text-primary",
                      )}
                    >
                      <span className="truncate">{opt.label}</span>
                      {opt.value === value && (
                        <svg
                          className="ml-2 h-4 w-4 shrink-0"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
