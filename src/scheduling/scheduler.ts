import { invoke } from "@tauri-apps/api/core";
import type { ScheduledJob, ScheduleRunResult } from "@/types";
import { Cron } from "croner";

// describeCron is still used by the UI to render a human-readable cadence label.
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [minute, hour, dom, , dow] = parts;

  if (dom === "*" && dow === "*") {
    if (minute === "*" && hour === "*") return "Every minute";
    if (minute.startsWith("*/")) return `Every ${minute.slice(2)} minutes`;
    if (hour === "*") return `At minute ${minute} of every hour`;
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    if (!isNaN(h) && !isNaN(m)) {
      const ampm = h >= 12 ? "PM" : "AM";
      const displayH = h % 12 || 12;
      const displayM = m.toString().padStart(2, "0");
      return `Every day at ${displayH}:${displayM} ${ampm}`;
    }
  }
  return expr;
}

export function isValidCron(expr: string): boolean {
  try {
    new Cron(expr);
    return true;
  } catch {
    return false;
  }
}

export const scheduler = {
  async saveJob(ctx: { type: "User" } | { type: "Agent"; agentId: string }, job: ScheduledJob): Promise<void> {
    await invoke("sched_save_job", { ctx, job });
  },
  async deleteJob(ctx: { type: "User" }, jobId: string): Promise<void> {
    await invoke("sched_delete_job", { ctx, jobId });
  },
  async runJobNow(ctx: { type: "User" }, jobId: string): Promise<void> {
    await invoke("sched_run_now", { ctx, jobId });
  },
  async cancelJob(jobId: string): Promise<void> {
    await invoke("sched_cancel_run", { jobId });
  },
  async listRuns(jobId: string, limit = 50): Promise<ScheduleRunResult[]> {
    return invoke<ScheduleRunResult[]>("sched_list_runs", { jobId, limit });
  },
  start(): void { /* no-op — Rust scheduler runs from boot */ },
  stop(): void { /* no-op */ },
};
