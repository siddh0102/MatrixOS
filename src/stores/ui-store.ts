import { create } from "zustand";
import { DEFAULT_SIDEBAR_WIDTH } from "@/lib/constants";

interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  toasts: Toast[];

  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarWidth: (width: number) => void;
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
}

export interface Toast {
  id: string;
  message: string;
  type: "success" | "error" | "info";
  duration?: number;
  /**
   * Optional free-text source tag included in the terminal log line,
   * useful when the same error message could come from multiple call
   * sites. e.g. "chat-page:handleSend", "compactor", "memory-retrieval".
   */
  source?: string;
}

/**
 * Fire-and-forget mirror of every toast to:
 *   - the JS devtools console (immediately visible while devtools is open)
 *   - the Rust terminal via `invoke("log_toast", …)` (survives a missed
 *     popup; greppable in the `npm run tauri dev` terminal)
 *
 * Both are best-effort — the toast is added to state regardless of
 * whether the mirror succeeds. The IPC call is guarded with `.catch(() => {})`
 * so a Rust hang here can never block the UI.
 */
function mirrorToastToLogs(toast: Omit<Toast, "id">): void {
  const prefix = `[toast:${toast.type}]`;
  const suffix = toast.source ? `   [source=${toast.source}]` : "";
  /* eslint-disable no-console */
  switch (toast.type) {
    case "error": console.error(`${prefix} ${toast.message}${suffix}`); break;
    case "info": console.info(`${prefix} ${toast.message}${suffix}`); break;
    case "success": console.log(`${prefix} ${toast.message}${suffix}`); break;
  }
  /* eslint-enable no-console */
  // Lazy-import so this module stays UI-pure for tests that don't have
  // the Tauri IPC bridge available.
  import("@tauri-apps/api/core")
    .then(({ invoke }) =>
      invoke("log_toast", { level: toast.type, message: toast.message, source: toast.source ?? null }),
    )
    .catch(() => { /* not in Tauri context (vitest) — silent */ });
}

export const useUIStore = create<UIState>((set) => ({
  sidebarOpen: true,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  toasts: [],

  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  addToast: (toast) => {
    mirrorToastToLogs(toast);
    set((s) => ({
      toasts: [
        ...s.toasts,
        { ...toast, id: Math.random().toString(36).slice(2) },
      ],
    }));
  },
  removeToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
