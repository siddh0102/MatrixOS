import { useState, useEffect } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { approvalGate } from "@/tools/tool-approval";
import type { ApprovalRequest } from "@/types";

interface ToolApprovalModalProps {
  request: ApprovalRequest;
  onClose: () => void;
  agentName?: string;
}

export function ToolApprovalModal({
  request,
  onClose,
  agentName,
}: ToolApprovalModalProps) {
  const [countdown, setCountdown] = useState(
    Math.ceil(request.timeoutMs / 1000),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  function handleApprove() {
    approvalGate.approve(request.id);
    onClose();
  }

  function handleReject() {
    approvalGate.reject(request.id);
    onClose();
  }

  return (
    <Dialog open onClose={handleReject} title="Tool Approval Required">
      <div className="flex flex-col gap-3">
        {agentName && (
          <div className="text-xs text-muted-foreground">
            Agent: <span className="font-medium text-foreground">{agentName}</span>
          </div>
        )}
        <div className="rounded-lg bg-accent/50 p-3">
          <div className="mb-1 text-sm font-medium">
            {request.toolName}
          </div>
          <div className="text-xs text-muted-foreground">
            Server: {request.serverName}
          </div>
        </div>

        <div>
          <div className="mb-1 text-xs text-muted-foreground">
            Arguments:
          </div>
          <pre className="max-h-40 overflow-auto rounded-lg bg-background p-2 text-xs">
            {JSON.stringify(request.args, null, 2)}
          </pre>
        </div>

        <div className="text-xs text-muted-foreground">
          Auto-reject in {countdown}s
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={handleReject}>
            Reject
          </Button>
          <Button onClick={handleApprove}>Approve</Button>
        </div>
      </div>
    </Dialog>
  );
}
