import { cn } from "@/lib/utils";

interface ChipProps {
  label: string;
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
  size?: "sm" | "md";
}

export function Chip({
  label,
  selected,
  onToggle,
  disabled = false,
  size = "md",
}: ChipProps) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        "rounded-full border font-medium transition-colors",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm",
        selected
          ? "border-primary bg-primary/10 text-primary"
          : "border-border bg-background text-muted-foreground hover:border-primary/40",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {label}
    </button>
  );
}
