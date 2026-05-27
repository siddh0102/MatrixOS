import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useScheduleStore } from "@/stores/schedule-store";
import { getRunHistory, listScheduledJobs } from "@/memory/schedule-store";
import { scheduler } from "@/scheduling/scheduler";
import type { ScheduledJob, ScheduleRunResult } from "@/types";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";

interface CreateJobParams {
  agentId: string;
  cronExpression: string;
  timezone: string;
  prompt: string;
  targetConversationId: string | null;
}

export function useSchedule() {
  const jobs = useScheduleStore((s) => s.jobs);
  const runningJobIds = useScheduleStore((s) => s.runningJobIds);

  // Subscribe to Rust scheduler updates and refetch job list
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    listen("scheduler:job_updated", () => {
      listScheduledJobs()
        .then((updated) => useScheduleStore.getState().setJobs(updated))
        .catch(() => {});
    }).then((fn) => {
      unlistenFn = fn;
    });
    return () => {
      unlistenFn?.();
    };
  }, []);

  async function createJob(params: CreateJobParams): Promise<ScheduledJob> {
    const now = isoNow();
    const job: ScheduledJob = {
      id: nanoid(),
      agentId: params.agentId,
      cronExpression: params.cronExpression,
      timezone: params.timezone,
      enabled: true,
      prompt: params.prompt,
      targetConversationId: params.targetConversationId,
      lastRunAt: null,
      nextRunAt: null, // Rust scheduler computes nextRunAt on save
      lastRunStatus: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    await scheduler.saveJob({ type: "User" }, job);
    useScheduleStore.getState().addJob(job);
    return job;
  }

  async function updateJob(id: string, updates: Partial<ScheduledJob>): Promise<void> {
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    const updated: ScheduledJob = { ...job, ...updates, updatedAt: isoNow() };
    await scheduler.saveJob({ type: "User" }, updated);
    useScheduleStore.getState().updateJob(id, updated);
  }

  async function deleteJob(id: string): Promise<void> {
    await scheduler.deleteJob({ type: "User" }, id);
    useScheduleStore.getState().removeJob(id);
    await scheduler.cancelJob(id).catch(() => {});
  }

  async function toggleJob(id: string, enabled: boolean): Promise<void> {
    const job = jobs.find((j) => j.id === id);
    if (!job) return;
    const updated = { ...job, enabled, updatedAt: isoNow() };
    await scheduler.saveJob({ type: "User" }, updated);
    useScheduleStore.getState().updateJob(id, { enabled });
    if (!enabled) await scheduler.cancelJob(id).catch(() => {});
  }

  async function runNow(id: string): Promise<void> {
    await scheduler.runJobNow({ type: "User" }, id);
  }

  async function getJobHistory(id: string): Promise<ScheduleRunResult[]> {
    return getRunHistory(id, 20);
  }

  return {
    jobs,
    runningJobIds,
    createJob,
    updateJob,
    deleteJob,
    toggleJob,
    runNow,
    getJobHistory,
  };
}
