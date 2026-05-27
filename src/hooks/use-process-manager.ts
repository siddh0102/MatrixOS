import { useProcessStore } from "@/stores/process-store";
import { processManager } from "@/orchestration/process-manager";

export function useProcessManager() {
  const processes = useProcessStore((s) => s.processes);
  const runningProcesses = processes.filter((p) => p.status === "running");
  const queuedProcesses = processes.filter((p) => p.status === "queued");

  return {
    processes,
    runningProcesses,
    queuedProcesses,
    runningCount: runningProcesses.length,
    queuedCount: queuedProcesses.length,
    kill: (id: string) => processManager.kill(id),
    pause: (id: string) => processManager.pause(id),
    resume: (id: string) => processManager.resume(id),
    getConfig: () => processManager.getConfig(),
    setConfig: (config: Parameters<typeof processManager.setConfig>[0]) => processManager.setConfig(config),
  };
}
