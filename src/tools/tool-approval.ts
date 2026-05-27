import type { ApprovalConfig, ApprovalRequest } from "@/types";
import { eventBus } from "@/orchestration/event-bus";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import { appendAudit } from "@/memory/audit-store";

export type ApprovalResult =
  | { status: "approved" }
  | { status: "rejected" }
  | { status: "timed_out" };

interface PendingApproval {
  request: ApprovalRequest;
  resolve: (result: ApprovalResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

class ToolApprovalGate {
  private pending = new Map<string, PendingApproval>();

  requestApproval(
    toolCallId: string,
    toolName: string,
    serverName: string,
    args: Record<string, unknown>,
    inputSchema: Record<string, unknown>,
    config: ApprovalConfig,
    timeoutMs: number = 60_000,
  ): Promise<ApprovalResult> {
    const overrideKey = `${serverName}:${toolName}`;
    const toolOverride = config.perToolOverrides?.[overrideKey];

    if (toolOverride === "auto") {
      return Promise.resolve({ status: "approved" });
    }
    if (toolOverride === "deny") {
      return Promise.resolve({ status: "rejected" });
    }
    if (toolOverride === "prompt") {
      return this.createPendingApproval(toolCallId, toolName, serverName, args, inputSchema, timeoutMs);
    }

    // No per-tool override — fall through to global mode + trusted server check
    if (config.mode === "auto-approve") {
      return Promise.resolve({ status: "approved" });
    }

    if (config.mode === "auto-reject") {
      return Promise.resolve({ status: "rejected" });
    }

    if (
      config.mode === "always-ask" &&
      config.trustedServers.includes(serverName)
    ) {
      return Promise.resolve({ status: "approved" });
    }

    return this.createPendingApproval(toolCallId, toolName, serverName, args, inputSchema, timeoutMs);
  }

  private createPendingApproval(
    toolCallId: string,
    toolName: string,
    serverName: string,
    args: Record<string, unknown>,
    inputSchema: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<ApprovalResult> {
    return new Promise<ApprovalResult>((resolve) => {
      const request: ApprovalRequest = {
        id: nanoid(),
        toolCallId,
        toolName,
        serverName,
        args,
        inputSchema,
        status: "pending",
        createdAt: isoNow(),
        resolvedAt: null,
        timeoutMs,
      };

      const timer = setTimeout(() => {
        this.resolveRequest(request.id, "timed_out");
      }, timeoutMs);

      this.pending.set(request.id, { request, resolve, timer });

      eventBus.emit(
        "tool:approval_requested",
        { request },
        "tool-approval",
      );
    });
  }

  approve(requestId: string): void {
    this.resolveRequest(requestId, "approved");
  }

  reject(requestId: string): void {
    this.resolveRequest(requestId, "rejected");
  }

  getPendingRequests(): ApprovalRequest[] {
    return [...this.pending.values()].map((p) => p.request);
  }

  getRequest(id: string): ApprovalRequest | undefined {
    return this.pending.get(id)?.request;
  }

  private resolveRequest(
    requestId: string,
    status: "approved" | "rejected" | "timed_out",
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    clearTimeout(entry.timer);
    entry.request.status = status;
    entry.request.resolvedAt = isoNow();
    this.pending.delete(requestId);

    entry.resolve({ status });

    eventBus.emit(
      "tool:approval_resolved",
      { requestId, status },
      "tool-approval",
    );

    if (status === "approved") {
      eventBus.emit(
        "tool:execution_approved",
        { requestId, toolName: entry.request.toolName },
        "tool-approval",
      );
    } else {
      eventBus.emit(
        "tool:execution_rejected",
        { requestId, toolName: entry.request.toolName, reason: status },
        "tool-approval",
      );
    }

    const eventType =
      status === "approved" ? "tool.approved"
      : status === "rejected" ? "tool.rejected"
      : "tool.timed_out";

    appendAudit({
      eventType,
      actor: status === "timed_out" ? "system" : "user",
      targetType: "tool",
      targetId: entry.request.toolName,
      details: {
        toolCallId: requestId,
        serverName: entry.request.serverName,
      },
    }).catch(() => {});
  }
}

export const approvalGate = new ToolApprovalGate();
