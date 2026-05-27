export interface Tool {
  readonly id: string;
  readonly serverId: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly tags: readonly string[];
}

export type ToolExecutionStatus =
  | "pending"
  | "executing"
  | "completed"
  | "failed"
  | "timed_out";

export interface ToolExecution {
  readonly id: string;
  readonly toolId: string;
  readonly toolCallId: string;
  readonly args: Record<string, unknown>;
  result: unknown | null;
  error: string | null;
  status: ToolExecutionStatus;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
}

// Discriminated union matching the Rust McpServerConfig serde shape.
// transport key is the discriminator; all fields are top-level (not nested).
export type MCPServerConfig =
  | {
      transport: "stdio";
      id: string;
      name: string;
      command: string;
      args: string[];
      env: Record<string, string>;
      enabled: boolean;
    }
  | {
      transport: "http";
      id: string;
      name: string;
      baseUrl: string;
      headers?: Record<string, string>;
      allowPrivate?: boolean;
      timeoutMs?: number;
      enabled: boolean;
    };

export type MCPConnectionState =
  | "saved"
  | "connecting"
  | "ready"
  | "error"
  | "disabled";

export interface MCPConnectionInfo {
  readonly serverId: string;
  state: MCPConnectionState;
  startedAt: string | null;
  discoveredToolCount: number;
  error: string | null;
}

export interface MCPJSONRPCRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface MCPJSONRPCResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPServerCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { subscribe?: boolean };
  logging?: { level?: string };
}

export interface ApprovalRequest {
  readonly id: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly serverName: string;
  readonly args: Record<string, unknown>;
  readonly inputSchema: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "timed_out";
  createdAt: string;
  resolvedAt: string | null;
  timeoutMs: number;
}

export interface ToolResultDisplay {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  result: unknown;
  error: string | null;
  status: "completed" | "failed";
  durationMs: number | null;
}

import type { CallContext } from "./provider";

export interface BuiltInToolContext {
  callContext: CallContext;
}

export type BuiltInToolHandler = (
  args: Record<string, unknown>,
  ctx: BuiltInToolContext,
) => Promise<unknown>;
