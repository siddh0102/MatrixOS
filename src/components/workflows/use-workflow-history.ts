import { useState, useCallback } from "react";
import type { WorkflowStep, WorkflowEdge, WorkflowVariable, WorkflowTrigger } from "@/types";

export interface HistoryEntry {
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  variables: WorkflowVariable[];
  triggers: WorkflowTrigger[];
}

interface WorkflowHistoryState {
  past: HistoryEntry[];
  present: HistoryEntry;
  future: HistoryEntry[];
  maxHistory: number;
}

export function useWorkflowHistory(initial: HistoryEntry) {
  const [state, setState] = useState<WorkflowHistoryState>({
    past: [],
    present: initial,
    future: [],
    maxHistory: 50,
  });

  const push = useCallback((entry: HistoryEntry) => {
    setState((s) => ({
      past: [...s.past, s.present].slice(-s.maxHistory),
      present: entry,
      future: [],
      maxHistory: s.maxHistory,
    }));
  }, []);

  const undo = useCallback(() => {
    setState((s) => {
      if (s.past.length === 0) return s;
      const prev = s.past[s.past.length - 1];
      return {
        past: s.past.slice(0, -1),
        present: prev,
        future: [s.present, ...s.future],
        maxHistory: s.maxHistory,
      };
    });
  }, []);

  const redo = useCallback(() => {
    setState((s) => {
      if (s.future.length === 0) return s;
      const next = s.future[0];
      return {
        past: [...s.past, s.present],
        present: next,
        future: s.future.slice(1),
        maxHistory: s.maxHistory,
      };
    });
  }, []);

  return {
    current: state.present,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
    push,
    undo,
    redo,
  };
}
