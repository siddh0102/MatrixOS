import { invoke, Channel } from "@tauri-apps/api/core";
import type { MCPJSONRPCRequest, MCPJSONRPCResponse, CallContext } from "@/types";

type McpInboundMessage =
  | { type: "rpc"; message: string }
  | { type: "stderr"; line: string }
  | { type: "closed"; exitCode: number | null; signal: string | null }
  | { type: "error"; message: string };

export class McpConnection {
  private channel = new Channel<McpInboundMessage>();
  private subscriptionId: string | null = null;
  private pending = new Map<string | number, (r: MCPJSONRPCResponse) => void>();
  private onCrash: ((exitCode: number | null) => void) | null = null;
  private onStderr: ((line: string) => void) | null = null;
  private nextRequestId = 1;

  constructor(public readonly serverId: string) {}

  async connect(ctx: CallContext = { type: "User" }): Promise<void> {
    this.channel.onmessage = (msg) => this.handleInbound(msg);
    this.subscriptionId = await invoke<string>("mcp_subscribe", {
      serverId: this.serverId,
      onMessage: this.channel,
    });
    await invoke("mcp_spawn", { serverId: this.serverId, ctx });
  }

  async disconnect(ctx: CallContext = { type: "User" }): Promise<void> {
    if (this.subscriptionId) {
      await invoke("mcp_unsubscribe", {
        serverId: this.serverId,
        subscriptionId: this.subscriptionId,
      });
      this.subscriptionId = null;
    }
    await invoke("mcp_disconnect", { serverId: this.serverId, ctx });
  }

  async sendRequest(req: MCPJSONRPCRequest, timeoutMs: number = 30_000): Promise<MCPJSONRPCResponse> {
    return new Promise((resolve, reject) => {
      const id = req.id;
      if (id === undefined) {
        reject(new Error("MCP request missing id"));
        return;
      }
      const requestId = String(id);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request ${requestId} timed out`));
      }, timeoutMs);
      this.pending.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });

      invoke<string | null>("mcp_send", {
        serverId: this.serverId,
        message: JSON.stringify(req),
        requestId,
      })
        .then((body) => {
          // HTTP path returns the body directly; resolve locally.
          if (body !== null && body !== undefined) {
            try {
              const parsed = JSON.parse(body) as MCPJSONRPCResponse;
              this.pending.delete(id);
              clearTimeout(timer);
              resolve(parsed);
            } catch (e) {
              this.pending.delete(id);
              clearTimeout(timer);
              reject(e);
            }
          }
          // null → stdio; broadcast will arrive via handleInbound.
        })
        .catch((e) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(e);
        });
    });
  }

  /// Convenience wrapper — callers no longer craft raw JSON-RPC envelopes.
  async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const req: MCPJSONRPCRequest = {
      jsonrpc: "2.0",
      id: this.nextRequestId++,
      method: "tools/call",
      params: { name, arguments: args },
    };
    const resp = await this.sendRequest(req);
    if (resp.error) {
      throw new Error(`MCP tool error: ${resp.error.message}`);
    }
    return resp.result;
  }

  onServerCrash(handler: (exitCode: number | null) => void): void { this.onCrash = handler; }
  onServerStderr(handler: (line: string) => void): void { this.onStderr = handler; }

  async cancel(requestId: string): Promise<void> {
    await invoke("mcp_cancel", { requestId });
  }

  /// Fire-and-forget JSON-RPC notification (no `id`, no response expected).
  /// Used for `notifications/initialized` and similar MCP signaling.
  async sendNotification(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const notif = { jsonrpc: "2.0", method, params };
    await invoke<string | null>("mcp_send", {
      serverId: this.serverId,
      message: JSON.stringify(notif),
      requestId: null,
    });
  }

  private handleInbound(msg: McpInboundMessage) {
    if (msg.type === "rpc") {
      try {
        const parsed = JSON.parse(msg.message) as MCPJSONRPCResponse;
        const resolver = this.pending.get(parsed.id);
        if (resolver) {
          this.pending.delete(parsed.id);
          resolver(parsed);
        }
      } catch { /* malformed JSON-RPC; ignore */ }
    } else if (msg.type === "stderr") {
      this.onStderr?.(msg.line);
    } else if (msg.type === "closed") {
      this.onCrash?.(msg.exitCode);
    } else if (msg.type === "error") {
      console.warn(`[MCP ${this.serverId}] reader error: ${msg.message}`);
    }
  }
}
