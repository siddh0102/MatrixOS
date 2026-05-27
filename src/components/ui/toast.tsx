import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { useUIStore, type Toast } from "@/stores/ui-store";

const DEFAULT_DURATION = 4000;

const iconMap = {
  success: (
    <svg className="h-4 w-4 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  ),
  error: (
    <svg className="h-4 w-4 text-destructive" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
  info: (
    <svg className="h-4 w-4 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
};

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useUIStore((s) => s.removeToast);

  useEffect(() => {
    const timer = setTimeout(
      () => removeToast(toast.id),
      toast.duration ?? DEFAULT_DURATION,
    );
    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, removeToast]);

  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl px-4 py-3 text-sm shadow-xl backdrop-blur-sm",
        "animate-slide-up",
        // Without min-w-0 the flex children refuse to shrink below their
        // intrinsic content width, which lets long unbroken strings
        // (provider JSON error blobs, stack traces) push past the toast
        // box. min-w-0 enables shrinking; overflow-hidden clips anything
        // that still pokes out.
        "min-w-0 overflow-hidden",
        toast.type === "success" &&
          "bg-card/95 border border-border/80 text-foreground",
        toast.type === "error" &&
          "bg-destructive/95 border border-destructive/30 text-destructive-foreground",
        toast.type === "info" &&
          "bg-card/95 border border-border/80 text-foreground",
      )}
    >
      <span className="mt-0.5 flex-shrink-0">{iconMap[toast.type]}</span>
      <span
        className={cn(
          // min-w-0 lets the flex child actually shrink (Tailwind default
          // is min-width:auto which prevents wrapping).
          // break-words + overflow-wrap:anywhere wrap long unbreakable
          // tokens like URLs / IDs / camelCase strings.
          // whitespace-pre-wrap preserves provider-formatted newlines.
          // max-h + overflow-y-auto caps the toast height when a giant
          // error like a multi-line JSON dump arrives.
          "flex-1 min-w-0 leading-5 whitespace-pre-wrap break-words [overflow-wrap:anywhere]",
          "max-h-[40vh] overflow-y-auto",
        )}
      >
        {toast.message}
      </span>
      <button
        onClick={() => removeToast(toast.id)}
        className="flex-shrink-0 rounded-md p-0.5 opacity-50 hover:opacity-100 transition-opacity"
        aria-label="Dismiss"
      >
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

export function Toaster() {
  const toasts = useUIStore((s) => s.toasts);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2.5 w-[28rem] max-w-[calc(100vw-3rem)]">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
