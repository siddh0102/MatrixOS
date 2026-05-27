import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface SliderProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label?: string;
  displayValue?: string;
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(
  ({ label, displayValue, className, ...props }, ref) => {
    return (
      <div className="flex flex-col gap-1.5">
        {(label || displayValue) && (
          <div className="flex items-center justify-between text-sm">
            {label && (
              <span className="text-muted-foreground">{label}</span>
            )}
            {displayValue && (
              <span className="font-mono text-xs">{displayValue}</span>
            )}
          </div>
        )}
        <input
          ref={ref}
          type="range"
          className={cn(
            "h-2 w-full cursor-pointer appearance-none rounded-lg bg-accent",
            className,
          )}
          {...props}
        />
      </div>
    );
  },
);

Slider.displayName = "Slider";
