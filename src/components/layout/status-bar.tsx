import { useState } from "react";
import { useAgentStore } from "@/stores/agent-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTabStore, useCurrentAgentId } from "@/stores/tab-store";
import { useProcessStore } from "@/stores/process-store";
import { APP_NAME, APP_VERSION } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { ProcessMonitor } from "@/components/processes/process-monitor";

export function StatusBar() {
  const currentAgentId = useCurrentAgentId();
  const configs = useAgentStore((s) => s.configs);
  const activeProviderId = useSettingsStore((s) => s.activeProviderId);
  const providers = useSettingsStore((s) => s.providers);
  const [monitorOpen, setMonitorOpen] = useState(false);

  const processRunning = useProcessStore((s) => s.processes.filter((p) => p.status === "running").length);
  const processQueued = useProcessStore((s) => s.processes.filter((p) => p.status === "queued").length);

  const streamingCount = useTabStore((s) => {
    let count = 0;
    for (const tabId of Object.keys(s.tabStates)) {
      if (s.tabStates[tabId].isStreaming) count++;
    }
    return count;
  });

  const activeAgent = configs.find((c) => c.id === currentAgentId);
  const activeProvider = providers.find((p) => p.id === activeProviderId);

  const isRunning = streamingCount > 0;

  return (
    <footer className="flex h-6 shrink-0 items-center border-t border-sidebar-border bg-sidebar px-4 text-[11px] text-sidebar-muted">
      <span className="flex items-center gap-1.5">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            isRunning
              ? "bg-success shadow-sm shadow-success/50 animate-pulse"
              : "bg-sidebar-border",
          )}
        />
        <span className={cn(isRunning && "text-sidebar-foreground")}>
          {streamingCount > 1
            ? `${streamingCount} agents running`
            : activeAgent?.name ?? "No agent selected"}
        </span>
      </span>

      {activeProvider && (
        <>
          <span className="mx-2 text-sidebar-border">|</span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-3.5 w-3.5 rounded bg-primary/20 flex items-center justify-center text-[9px] text-primary font-bold">
              {activeProvider.name.charAt(0)}
            </span>
            {activeProvider.name}
            <span className="text-sidebar-border mx-0.5">·</span>
            <span className="font-mono">{activeAgent?.modelId ?? activeProvider.defaultModelId}</span>
          </span>
        </>
      )}

      {processRunning > 0 && (
        <>
          <span className="mx-2 text-sidebar-border">|</span>
          <button
            onClick={() => setMonitorOpen(true)}
            className="text-sidebar-muted hover:text-sidebar-foreground transition-colors"
          >
            {processRunning} running{processQueued > 0 ? ` + ${processQueued} queued` : ""}
          </button>
        </>
      )}

      <span className="ml-auto">
        {APP_NAME} v{APP_VERSION}
      </span>

      <ProcessMonitor open={monitorOpen} onClose={() => setMonitorOpen(false)} />
    </footer>
  );
}
