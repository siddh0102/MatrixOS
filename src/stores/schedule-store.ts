import { create } from "zustand";
import type { ScheduledJob } from "@/types";

interface ScheduleState {
  jobs: ScheduledJob[];
  runningJobIds: string[];

  setJobs: (jobs: ScheduledJob[]) => void;
  addJob: (job: ScheduledJob) => void;
  updateJob: (id: string, updates: Partial<ScheduledJob>) => void;
  removeJob: (id: string) => void;
  setRunning: (id: string, running: boolean) => void;
}

export const useScheduleStore = create<ScheduleState>((set) => ({
  jobs: [],
  runningJobIds: [],

  setJobs: (jobs) => set({ jobs }),
  addJob: (job) => set((s) => ({ jobs: [...s.jobs, job] })),
  updateJob: (id, updates) =>
    set((s) => ({
      jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...updates } : j)),
    })),
  removeJob: (id) =>
    set((s) => ({
      jobs: s.jobs.filter((j) => j.id !== id),
      runningJobIds: s.runningJobIds.filter((r) => r !== id),
    })),
  setRunning: (id, running) =>
    set((s) => ({
      runningJobIds: running
        ? [...s.runningJobIds.filter((r) => r !== id), id]
        : s.runningJobIds.filter((r) => r !== id),
    })),
}));
