import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Sidebar } from "@/components/layout/sidebar";
import { StatusBar } from "@/components/layout/status-bar";
import { ErrorBoundary } from "@/components/layout/error-boundary";
import { Toaster } from "@/components/ui/toast";
import { HumanInputPrompt } from "@/components/workflows/human-input-prompt";
import { ToolApprovalPrompt } from "@/components/tools/tool-approval-prompt";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";

export const Route = createRootRoute({ component: RootLayout });

function RootLayout() {
  useKeyboardShortcuts();

  return (
    <ErrorBoundary>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main className="flex flex-1 flex-col overflow-hidden min-w-0">
            <Outlet />
          </main>
        </div>
        <StatusBar />
      </div>
      <Toaster />
      <HumanInputPrompt />
      <ToolApprovalPrompt />
    </ErrorBoundary>
  );
}
