import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ask } from "@tauri-apps/plugin-dialog";
import { useMCPStore } from "@/stores/mcp-store";
import { mcpManager } from "@/tools/mcp-manager";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { nanoid } from "nanoid";
import type { MCPServerConfig } from "@/types";
import { eventBus } from "@/orchestration/event-bus";
import { useUIStore } from "@/stores/ui-store";

export function MCPSettings() {
  const servers = useMCPStore((s) => s.servers);
  const connections = useMCPStore((s) => s.connections);
  const discoveredTools = useMCPStore((s) => s.discoveredTools);
  const addServer = useMCPStore((s) => s.addServer);
  const removeServer = useMCPStore((s) => s.removeServer);

  const [showAdd, setShowAdd] = useState(false);
  const [formName, setFormName] = useState("");
  const [transportType, setTransportType] = useState<"stdio" | "http">(
    "stdio",
  );
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [httpUrl, setHttpUrl] = useState("");

  // Subscribe to crash events and surface as toasts
  useEffect(() => {
    const sub = eventBus.on<{ serverId: string; exitCode: number | null }>(
      "mcp:server_crashed",
      (event) => {
        const { serverId, exitCode } = event.payload;
        const srv = servers.find((s) => s.id === serverId);
        const name = srv?.name ?? serverId;
        useUIStore.getState().addToast({
          type: "error",
          message: `MCP server "${name}" crashed (exit code: ${exitCode ?? "unknown"})`,
        });
      },
    );
    return () => sub.unsubscribe();
  }, [servers]);

  async function handleAdd() {
    try {
      if (transportType === "stdio") {
        const parsedArgs = args
          .split(" ")
          .map((a) => a.trim())
          .filter(Boolean);
        const argsPreview = parsedArgs.join(" ");
        const ok = await ask(
          `Allow MatrixOS to run:\n\n  ${command} ${argsPreview}\n\nEnvironment keys: (none)\n\nThis grants the binary the same access as MatrixOS itself.`,
          { title: "Confirm MCP server command", kind: "warning" },
        );
        if (!ok) return;
      }

      const id = nanoid();

    const config: MCPServerConfig =
      transportType === "stdio"
        ? {
            transport: "stdio",
            id,
            name: formName,
            command,
            args: args
              .split(" ")
              .map((a) => a.trim())
              .filter(Boolean),
            env: {},
            enabled: true,
          }
        : {
            transport: "http",
            id,
            name: formName,
            baseUrl: httpUrl,
            enabled: true,
          };

    try {
      await invoke("mcp_set_server_config", { config, ctx: { type: "User" } });
    } catch (err) {
      console.error("Failed to save MCP server config:", err);
      return;
    }

    addServer(config);

      // Dismiss the form immediately. The spawn + handshake happen in the
      // background; the row already exists in the list and the user can watch
      // its status badge transition. If the server crashes mid-handshake (a
      // common case while debugging command/args), keeping the form open
      // would block the UI for the full timeout.
      setShowAdd(false);
      resetForm();

      mcpManager.addServer(config).catch((e) => {
        console.error("mcpManager.addServer failed:", e);
        useUIStore.getState().addToast({
          type: "error",
          message: `MCP connect failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      });
    } catch (err) {
      console.error("MCP add failed:", err);
      useUIStore.getState().addToast({
        type: "error",
        message: `Failed to add MCP server: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  async function handleDelete(id: string) {
    await mcpManager.removeServer(id);
    try {
      await invoke("mcp_remove_server_config", { serverId: id, ctx: { type: "User" } });
    } catch (err) {
      console.error("Failed to delete MCP server config:", err);
    }
    removeServer(id);
  }

  async function handleRestart(id: string) {
    try {
      await mcpManager.restartServer(id);
    } catch (err) {
      console.error(`MCP restart failed for ${id}:`, err);
      useUIStore.getState().addToast({
        type: "error",
        message: `Restart failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  function resetForm() {
    setFormName("");
    setCommand("");
    setArgs("");
    setHttpUrl("");
    setTransportType("stdio");
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto p-6">
      <div className="mb-6 flex items-center justify-end">
        <Button onClick={() => setShowAdd(true)}>+ Add Server</Button>
      </div>

      <div className="flex flex-col gap-3">
        {servers.map((srv) => {
          const conn = connections.get(srv.id);
          const tools = discoveredTools.get(srv.id) ?? [];
          const state = conn?.state ?? "saved";

          return (
            <div
              key={srv.id}
              className="flex items-center justify-between rounded-lg border border-border bg-card p-4"
            >
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{srv.name}</span>
                  <Badge
                    variant={
                      state === "ready"
                        ? "success"
                        : state === "error"
                          ? "error"
                          : state === "connecting"
                            ? "warning"
                            : "muted"
                    }
                  >
                    {state}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {srv.transport}
                  </span>
                </div>
                {tools.length > 0 && (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {tools.length} tool{tools.length !== 1 ? "s" : ""}{" "}
                    discovered
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRestart(srv.id)}
                >
                  Restart
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(srv.id)}
                >
                  Delete
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {servers.length === 0 && (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          No MCP servers configured.
        </div>
      )}

      <Dialog
        open={showAdd}
        onClose={() => {
          setShowAdd(false);
          resetForm();
        }}
        title="Add MCP Server"
      >
        <div className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">
              Name
            </label>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="Server name"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-muted-foreground">
              Transport
            </label>
            <Select
              value={transportType}
              onChange={(e) =>
                setTransportType(
                  e.target.value as "stdio" | "http",
                )
              }
            >
              <option value="stdio">stdio</option>
              <option value="http">HTTP</option>
            </Select>
          </div>
          {transportType === "stdio" ? (
            <>
              <div>
                <label className="mb-1 block text-sm text-muted-foreground">
                  Command
                </label>
                <Input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx -y @modelcontextprotocol/..."
                />
              </div>
              <div>
                <label className="mb-1 block text-sm text-muted-foreground">
                  Arguments
                </label>
                <Input
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder="space-separated args"
                />
              </div>
            </>
          ) : (
            <div>
              <label className="mb-1 block text-sm text-muted-foreground">
                URL
              </label>
              <Input
                value={httpUrl}
                onChange={(e) => setHttpUrl(e.target.value)}
                placeholder="http://localhost:8080/mcp"
              />
            </div>
          )}
          <div className="mt-2 flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setShowAdd(false);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={!formName}>
              Add
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
