import { type ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "destructive";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "secondary",
      size = "md",
      loading = false,
      disabled,
      className,
      children,
      ...props
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex items-center justify-center rounded-lg font-medium transition-all duration-150",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          "disabled:pointer-events-none disabled:opacity-40",
          "select-none",
          size === "sm" && "h-7 px-2.5 text-xs gap-1",
          size === "md" && "h-9 px-4 text-sm gap-1.5",
          size === "lg" && "h-10 px-5 text-sm gap-2",
          variant === "primary" &&
            "bg-primary text-primary-foreground shadow-sm shadow-primary/20 hover:bg-primary-hover active:scale-[0.97]",
          variant === "secondary" &&
            "bg-secondary text-secondary-foreground border border-border hover:bg-accent hover:text-accent-foreground active:scale-[0.97]",
          variant === "ghost" &&
            "text-secondary-foreground hover:bg-accent hover:text-accent-foreground active:scale-[0.97]",
          variant === "destructive" &&
            "bg-destructive text-destructive-foreground shadow-sm shadow-destructive/20 hover:opacity-90 active:scale-[0.97]",
          className,
        )}
        {...props}
      >
        {loading ? (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : null}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
