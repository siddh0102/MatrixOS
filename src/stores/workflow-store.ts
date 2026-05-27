import { create } from "zustand";
import type { WorkflowDefinition, WorkflowRun } from "@/types";

interface WorkflowState {
  workflows: WorkflowDefinition[];
  runs: WorkflowRun[];
  activeWorkflowId: string | null;
  activeRunId: string | null;

  setWorkflows: (workflows: WorkflowDefinition[]) => void;
  addWorkflow: (workflow: WorkflowDefinition) => void;
  updateWorkflow: (id: string, updates: Partial<WorkflowDefinition>) => void;
  removeWorkflow: (id: string) => void;

  setRuns: (runs: WorkflowRun[]) => void;
  addRun: (run: WorkflowRun) => void;
  updateRun: (id: string, updates: Partial<WorkflowRun>) => void;

  setActiveWorkflow: (id: string | null) => void;
  setActiveRun: (id: string | null) => void;
}

export const useWorkflowStore = create<WorkflowState>((set) => ({
  workflows: [],
  runs: [],
  activeWorkflowId: null,
  activeRunId: null,

  setWorkflows: (workflows) => set({ workflows }),
  addWorkflow: (workflow) => set((s) => ({ workflows: [...s.workflows, workflow] })),
  updateWorkflow: (id, updates) =>
    set((s) => ({
      workflows: s.workflows.map((w) => (w.id === id ? { ...w, ...updates } : w)),
    })),
  removeWorkflow: (id) =>
    set((s) => ({ workflows: s.workflows.filter((w) => w.id !== id) })),

  setRuns: (runs) => set({ runs }),
  addRun: (run) => set((s) => ({ runs: [run, ...s.runs].slice(0, 100) })),
  updateRun: (id, updates) =>
    set((s) => ({
      runs: s.runs.map((r) => (r.id === id ? { ...r, ...updates } : r)),
    })),

  setActiveWorkflow: (id) => set({ activeWorkflowId: id }),
  setActiveRun: (id) => set({ activeRunId: id }),
}));
