import { type InputHTMLAttributes, forwardRef, useState } from "react";
import { cn } from "@/lib/utils";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: string;
  label?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, error, label, id, ...props }, ref) => {
    const [showPassword, setShowPassword] = useState(false);
    const isPassword = type === "password";
    const inputType = isPassword && showPassword ? "text" : type;

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label htmlFor={id} className="text-xs font-semibold text-foreground tracking-wide uppercase">
            {label}
          </label>
        )}
        <div className="relative">
          <input
            ref={ref}
            id={id}
            type={inputType}
            className={cn(
              "flex h-9 w-full rounded-lg border border-input bg-background px-3 py-1.5 text-sm",
              "placeholder:text-muted-foreground/60",
              "transition-colors duration-150",
              "focus-visible:outline-none focus-visible:border-input-focus focus-visible:ring-2 focus-visible:ring-ring-subtle",
              "disabled:cursor-not-allowed disabled:opacity-40",
              error && "border-destructive/60 focus-visible:border-destructive focus-visible:ring-destructive/30",
              isPassword && "pr-10",
              className,
            )}
            {...props}
          />
          {isPassword && (
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors px-1 py-0.5 rounded"
              tabIndex={-1}
            >
              {showPassword ? "Hide" : "Show"}
            </button>
          )}
        </div>
        {error && <p className="text-xs text-destructive font-medium">{error}</p>}
      </div>
    );
  },
);
Input.displayName = "Input";
