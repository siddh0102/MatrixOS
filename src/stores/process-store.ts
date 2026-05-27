import { create } from "zustand";
import type { AgentProcess } from "@/types";

interface ProcessState {
  processes: AgentProcess[];
  processMap: Map<string, AgentProcess>;

  setProcesses: (processes: AgentProcess[]) => void;
  addProcess: (process: AgentProcess) => void;
  updateProcess: (id: string, updates: Partial<AgentProcess>) => void;
  removeProcess: (id: string) => void;
  clearCompleted: () => void;
  getProcess: (id: string) => AgentProcess | undefined;
}

export const useProcessStore = create<ProcessState>((set, get) => ({
  processes: [],
  processMap: new Map(),

  setProcesses: (processes) => {
    const processMap = new Map(processes.map((p) => [p.id, p]));
    set({ processes, processMap });
  },
  addProcess: (process) =>
    set((s) => {
      const processes = [...s.processes, process];
      const processMap = new Map(s.processMap);
      processMap.set(process.id, process);
      return { processes, processMap };
    }),
  updateProcess: (id, updates) =>
    set((s) => {
      const processMap = new Map(s.processMap);
      const existing = processMap.get(id);
      if (!existing) return s;
      const updated = { ...existing, ...updates };
      processMap.set(id, updated);
      const processes = s.processes.map((p) => (p.id === id ? updated : p));
      return { processes, processMap };
    }),
  removeProcess: (id) =>
    set((s) => {
      const processMap = new Map(s.processMap);
      processMap.delete(id);
      return { processes: s.processes.filter((p) => p.id !== id), processMap };
    }),
  clearCompleted: () =>
    set((s) => {
      const processes = s.processes.filter((p) => p.status === "running" || p.status === "queued");
      const processMap = new Map(processes.map((p) => [p.id, p]));
      return { processes, processMap };
    }),
  getProcess: (id) => get().processMap.get(id),
}));
