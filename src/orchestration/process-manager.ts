import type { AgentProcess, ProcessPriority, TokenBudget, ProcessManagerConfig } from "@/types";
import { isoNow } from "@/lib/utils";
import { eventBus } from "@/orchestration/event-bus";
import { useProcessStore } from "@/stores/process-store";
import { getDailyTokenUsage } from "@/memory/process-store";
import { invoke } from "@tauri-apps/api/core";

/**
 * Wrap a Tauri `invoke()` with a hard timeout. Without this, a Rust-side
 * stall (lock contention, IPC stuck, etc.) leaves the JS side waiting
 * forever — which manifests as the typing-bubble freeze. With it, any
 * IPC that exceeds `timeoutMs` rejects with a typed ProcessError, the
 * caller's catch fires, and the UI clears.
 *
 * The Tauri-side handler keeps running — we just stop waiting for it.
 * For non-streaming commands that's fine (the row was either written or
 * not; idempotency is handled by callers).
 */
async function invokeWithTimeout<T>(
  cmd: string,
  args: Record<string, unknown>,
  timeoutMs: number,
  errorCode: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new ProcessError(
        `IPC '${cmd}' timed out after ${timeoutMs / 1000}s. Rust handler may be deadlocked — restart the app to recover.`,
        errorCode,
      ));
    }, timeoutMs);
  });
  try {
    return await Promise.race([invoke<T>(cmd, args), timeoutPromise]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

const DEFAULT_CONFIG: ProcessManagerConfig = {
  maxConcurrentProcesses: 5,
  maxQueueSize: 20,
  interactiveSlots: 3,
  backgroundSlots: 1,
  scheduledSlots: 1,
  defaultTokenBudget: {
    maxTokensPerTurn: 16_000,
    maxTokensPerSession: 200_000,
    maxTokensPerDay: 1_000_000,
    usedToday: 0,
    sessionUsed: 0,
  },
  preemptionEnabled: true,
};

interface QueueEntry {
  process: AgentProcess;
  resolve: (controller: AbortController) => void;
  reject: (error: Error) => void;
}

class ProcessManager {
  private config: ProcessManagerConfig = DEFAULT_CONFIG;
  private queue: QueueEntry[] = [];
  private running: Map<string, { process: AgentProcess; controller: AbortController }> = new Map();
  private stopped = false;

  setConfig(config: Partial<ProcessManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): ProcessManagerConfig {
    return { ...this.config };
  }

  async spawn(params: {
    agentId: string;
    conversationId: string;
    priority: ProcessPriority;
    tokenBudget?: Partial<TokenBudget>;
    parentWorkflowRunId?: string;
    parentStepId?: string;
  }): Promise<{ process: AgentProcess; controller: AbortController }> {
    // Micro-trace: prints where inside spawn we stall when the parent
    // `[send …] processManager.spawn:start` line never reaches `:done`.
    // Disable via `localStorage.MATRIXOS_NO_TRACE = "1"`.
    const traceEnabled = (() => {
      try { return typeof window !== "undefined" && localStorage.getItem("MATRIXOS_NO_TRACE") !== "1"; }
      catch { return false; }
    })();
    const t0 = performance.now();
    const t = (label: string, extra?: Record<string, unknown>) => {
      if (!traceEnabled) return;
      const ms = (performance.now() - t0).toFixed(0).padStart(5);
      // eslint-disable-next-line no-console
      console.log(`[spawn +${ms}ms] ${label}`, extra ?? "");
    };
    t("enter", { agentId: params.agentId, priority: params.priority });

    if (this.stopped) {
      throw new ProcessError("Process manager is stopped", "STOPPED");
    }

    const budget: TokenBudget = {
      ...this.config.defaultTokenBudget,
      ...params.tokenBudget,
    };

    t("getDailyTokenUsage:before");
    const dailyUsage = await getDailyTokenUsage(params.agentId, todayDate());
    t("getDailyTokenUsage:after", { dailyUsage });
    budget.usedToday = dailyUsage;
    if (dailyUsage >= budget.maxTokensPerDay) {
      throw new ProcessError("Daily token budget exceeded", "BUDGET_EXCEEDED");
    }

    if (this.queue.length >= this.config.maxQueueSize) {
      throw new ProcessError("Queue full", "QUEUE_FULL");
    }

    t("invoke proc_start:before");
    // Defensive timeout: if proc_start hangs (Rust-side lock contention,
    // IPC stall, whatever), throw rather than freeze the JS thread waiting.
    // 15s is generous — proc_start normally completes in <20ms.
    const pid = await invokeWithTimeout<string>(
      "proc_start",
      {
        ctx: { type: "User" },
        agentId: params.agentId,
        kind: params.priority,
        conversationId: params.conversationId,
        tokenBudget: budget,
      },
      15_000,
      "PROC_START_TIMEOUT",
    );
    t("invoke proc_start:after", { pid });

    const process: AgentProcess = {
      id: pid,
      agentId: params.agentId,
      conversationId: params.conversationId,
      priority: params.priority,
      status: "queued",
      queuePosition: null,
      tokenBudget: budget,
      tokenUsage: { inputTokens: 0, outputTokens: 0 },
      startedAt: null,
      completedAt: null,
      error: null,
      parentWorkflowRunId: params.parentWorkflowRunId ?? null,
      parentStepId: params.parentStepId ?? null,
      createdAt: isoNow(),
    };
    useProcessStore.getState().addProcess(process);

    eventBus.emit("process:queued", {
      processId: process.id,
      agentId: params.agentId,
      priority: params.priority,
      queuePosition: process.queuePosition,
    }, "process-manager");

    if (this.canAccept(params.priority)) {
      t("promote:before", { runningSize: this.running.size });
      const promoted = await this.promote(process);
      t("promote:after");
      return promoted;
    }

    t("queue:enter", {
      runningSize: this.running.size,
      runningPriorities: Array.from(this.running.values()).map((r) => r.process.priority),
      queueLength: this.queue.length,
      interactiveSlots: this.config.interactiveSlots,
      maxConcurrent: this.config.maxConcurrentProcesses,
    });
    return new Promise<{ process: AgentProcess; controller: AbortController }>((resolve, reject) => {
      const entry: QueueEntry = { process, resolve: () => {}, reject: () => {} };
      // Wrap the real resolve/reject so the queue-wait watchdog can clear
      // its timeout when the entry promotes or fails through normal paths.
      const QUEUE_WAIT_TIMEOUT_MS = 30_000;
      const watchdog = setTimeout(() => {
        const idx = this.queue.findIndex((e) => e === entry);
        if (idx >= 0) {
          this.queue.splice(idx, 1);
          this.recomputeQueuePositions();
          useProcessStore.getState().updateProcess(process.id, {
            status: "failed",
            completedAt: isoNow(),
            error: "queue wait timed out (orphan slot suspected)",
          });
          reject(new ProcessError(
            `Process queue wait timed out after ${QUEUE_WAIT_TIMEOUT_MS / 1000}s. ` +
            `${this.running.size}/${this.config.maxConcurrentProcesses} slots are stuck — ` +
            `restart the app to clear them, or wait for the per-stream idle timeout (60s) to fire.`,
            "QUEUE_WAIT_TIMEOUT",
          ));
        }
      }, QUEUE_WAIT_TIMEOUT_MS);
      entry.resolve = (ctrl) => { clearTimeout(watchdog); resolve({ process, controller: ctrl }); };
      entry.reject = (err) => { clearTimeout(watchdog); reject(err); };
      this.insertIntoQueue(entry);

      if (this.config.preemptionEnabled && params.priority === "interactive") {
        this.tryPreempt();
      }
    });
  }

  async kill(processId: string): Promise<void> {
    const running = this.running.get(processId);
    if (running) {
      running.controller.abort();
      this.running.delete(processId);
    }

    const queueIdx = this.queue.findIndex((e) => e.process.id === processId);
    if (queueIdx >= 0) {
      const entry = this.queue.splice(queueIdx, 1)[0];
      entry.reject(new ProcessError("Process cancelled", "CANCELLED"));
      this.recomputeQueuePositions();
    }

    await invoke("proc_update_status", { ctx: { type: "User" }, processId, status: "cancelled", error: null });
    useProcessStore.getState().updateProcess(processId, { status: "cancelled", completedAt: isoNow() });
    eventBus.emit("process:cancelled", { processId }, "process-manager");

    this.tryDequeue();
  }

  async pause(processId: string): Promise<void> {
    await invoke("proc_update_status", { ctx: { type: "User" }, processId, status: "paused", error: null });
    useProcessStore.getState().updateProcess(processId, { status: "paused" });
  }

  async resume(processId: string): Promise<void> {
    await invoke("proc_update_status", { ctx: { type: "User" }, processId, status: "running", error: null });
    useProcessStore.getState().updateProcess(processId, { status: "running" });
  }

  recordTokenUsage(processId: string, inputTokens: number, outputTokens: number): void {
    const store = useProcessStore.getState();
    const process = store.processMap.get(processId);
    if (!process) return;

    const newUsage = {
      inputTokens: process.tokenUsage.inputTokens + inputTokens,
      outputTokens: process.tokenUsage.outputTokens + outputTokens,
    };

    store.updateProcess(processId, { tokenUsage: newUsage });

    const totalSession = newUsage.inputTokens + newUsage.outputTokens;
    if (totalSession >= process.tokenBudget.maxTokensPerSession * 0.9) {
      eventBus.emit("process:budget_warning", {
        processId,
        budgetType: "session",
        used: totalSession,
        limit: process.tokenBudget.maxTokensPerSession,
      }, "process-manager");
    }

    invoke("proc_record_tokens", { ctx: { type: "User" }, processId, inputTokens, outputTokens }).catch(() => {});
  }

  checkBudget(processId: string, estimatedTokens: number): boolean {
    const process = useProcessStore.getState().processMap.get(processId);
    if (!process) return false;

    const sessionUsed = process.tokenUsage.inputTokens + process.tokenUsage.outputTokens;
    if (sessionUsed + estimatedTokens > process.tokenBudget.maxTokensPerSession) return false;
    if (process.tokenBudget.usedToday + estimatedTokens > process.tokenBudget.maxTokensPerDay) return false;
    return true;
  }

  async markCompleted(processId: string): Promise<void> {
    this.running.delete(processId);
    const store = useProcessStore.getState();
    const proc = store.processMap.get(processId);
    const inputTokens = proc?.tokenUsage.inputTokens ?? 0;
    const outputTokens = proc?.tokenUsage.outputTokens ?? 0;
    await invoke("proc_complete", { ctx: { type: "User" }, processId, inputTokens, outputTokens });
    store.updateProcess(processId, { status: "completed", completedAt: isoNow() });
    eventBus.emit("process:completed", { processId }, "process-manager");
    this.tryDequeue();
  }

  async markFailed(processId: string, error: string): Promise<void> {
    this.running.delete(processId);
    await invoke("proc_fail", { ctx: { type: "User" }, processId, error });
    useProcessStore.getState().updateProcess(processId, { status: "failed", completedAt: isoNow(), error });
    eventBus.emit("process:failed", { processId, error }, "process-manager");
    this.tryDequeue();
  }

  stop(): void {
    this.stopped = true;
    for (const [, { controller }] of this.running) {
      controller.abort();
    }
    this.running.clear();
    for (const entry of this.queue) {
      entry.reject(new ProcessError("Process manager stopped", "STOPPED"));
    }
    this.queue = [];
  }

  getRunningCount(): number {
    return this.running.size;
  }

  getQueuedCount(): number {
    return this.queue.length;
  }

  private async promote(process: AgentProcess): Promise<{ process: AgentProcess; controller: AbortController }> {
    const controller = new AbortController();
    process.status = "running";
    process.startedAt = isoNow();
    process.queuePosition = null;

    this.running.set(process.id, { process, controller });

    await invokeWithTimeout<void>(
      "proc_update_status",
      { ctx: { type: "User" }, processId: process.id, status: "running", error: null },
      15_000,
      "PROC_UPDATE_STATUS_TIMEOUT",
    );
    useProcessStore.getState().updateProcess(process.id, {
      status: "running",
      startedAt: process.startedAt,
      queuePosition: null,
    });

    eventBus.emit("process:started", {
      processId: process.id,
      agentId: process.agentId,
      priority: process.priority,
    }, "process-manager");

    return { process, controller };
  }

  private insertIntoQueue(entry: QueueEntry): void {
    const priorityOrder: Record<ProcessPriority, number> = {
      interactive: 0,
      background: 1,
      scheduled: 2,
    };

    const insertIdx = this.queue.findIndex(
      (e) => priorityOrder[e.process.priority] > priorityOrder[entry.process.priority]
    );

    if (insertIdx === -1) {
      this.queue.push(entry);
    } else {
      this.queue.splice(insertIdx, 0, entry);
    }

    this.recomputeQueuePositions();
  }

  private recomputeQueuePositions(): void {
    for (let i = 0; i < this.queue.length; i++) {
      this.queue[i].process.queuePosition = i + 1;
      useProcessStore.getState().updateProcess(this.queue[i].process.id, { queuePosition: i + 1 });
    }
  }

  private canAccept(priority: ProcessPriority): boolean {
    if (this.running.size >= this.config.maxConcurrentProcesses) return false;

    const counts: Record<ProcessPriority, number> = { interactive: 0, background: 0, scheduled: 0 };
    for (const [, { process }] of this.running) {
      counts[process.priority]++;
    }

    const slotLimits: Record<ProcessPriority, number> = {
      interactive: this.config.interactiveSlots,
      background: this.config.backgroundSlots,
      scheduled: this.config.scheduledSlots,
    };

    return counts[priority] < slotLimits[priority];
  }

  private tryDequeue(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!this.canAccept(next.process.priority)) break;

      this.queue.shift();
      this.recomputeQueuePositions();

      const controller = new AbortController();
      next.process.status = "running";
      next.process.startedAt = isoNow();
      next.process.queuePosition = null;

      this.running.set(next.process.id, { process: next.process, controller });

      invoke("proc_update_status", { ctx: { type: "User" }, processId: next.process.id, status: "running", error: null }).catch(() => {});
      useProcessStore.getState().updateProcess(next.process.id, {
        status: "running",
        startedAt: next.process.startedAt,
        queuePosition: null,
      });

      eventBus.emit("process:started", {
        processId: next.process.id,
        agentId: next.process.agentId,
        priority: next.process.priority,
      }, "process-manager");

      next.resolve(controller);
    }
  }

  private tryPreempt(): void {
    const priorityOrder: Record<ProcessPriority, number> = {
      interactive: 0,
      background: 1,
      scheduled: 2,
    };

    let victim: { process: AgentProcess; controller: AbortController } | null = null;
    let worstPriority = -1;

    for (const [, entry] of this.running) {
      const order = priorityOrder[entry.process.priority];
      if (order > worstPriority) {
        worstPriority = order;
        victim = entry;
      }
    }

    if (!victim || victim.process.priority === "interactive") return;

    victim.controller.abort();
    this.running.delete(victim.process.id);

    invoke("proc_update_status", { ctx: { type: "User" }, processId: victim.process.id, status: "cancelled", error: null }).catch(() => {});
    useProcessStore.getState().updateProcess(victim.process.id, { status: "cancelled", completedAt: isoNow() });
    eventBus.emit("process:preempted", { processId: victim.process.id, reason: "higher_priority" }, "process-manager");

    this.tryDequeue();
  }
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export class ProcessError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "ProcessError";
  }
}

export const processManager = new ProcessManager();
