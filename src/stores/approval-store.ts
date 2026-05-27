import { create } from "zustand";
import type { ApprovalRequest } from "@/types";

interface ApprovalState {
  pendingRequests: ApprovalRequest[];
  addPending: (request: ApprovalRequest) => void;
  resolve: (
    requestId: string,
    status: "approved" | "rejected" | "timed_out",
  ) => void;
  clearAll: () => void;
}

export const useApprovalStore = create<ApprovalState>((set) => ({
  pendingRequests: [],

  addPending: (request) =>
    set((s) => ({
      pendingRequests: [...s.pendingRequests, request],
    })),

  resolve: (requestId, status) =>
    set((s) => ({
      pendingRequests: s.pendingRequests.map((r) =>
        r.id === requestId ? { ...r, status, resolvedAt: new Date().toISOString() } : r,
      ).filter((r) => r.status === "pending"),
    })),

  clearAll: () => set({ pendingRequests: [] }),
}));
