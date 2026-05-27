import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeTool, registerBuiltInHandler } from "@/tools/tool-executor";
import { toolRegistry } from "@/tools/tool-registry";
import { eventBus } from "@/orchestration/event-bus";

beforeEach(() => {
  toolRegistry.clear();
  eventBus._reset();
  vi.restoreAllMocks();
});

describe("executeTool", () => {
  it("executes a built-in tool and returns a completed execution", async () => {
    const tool = toolRegistry.register({
      serverId: "built-in",
      name: "echo",
      description: "Echo",
      inputSchema: {},
      tags: [],
    });
    registerBuiltInHandler("echo", async (args) => args["text"]);

    const result = await executeTool(tool, "call-1", { text: "hello" }, { type: "User" });

    expect(result.status).toBe("completed");
    expect(result.result).toBe("hello");
    expect(result.error).toBeNull();
    expect(result.startedAt).toBeDefined();
    expect(result.completedAt).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns failed execution when handler throws", async () => {
    const tool = toolRegistry.register({
      serverId: "built-in",
      name: "thrower",
      description: "Throws",
      inputSchema: {},
      tags: [],
    });
    registerBuiltInHandler("thrower", async () => {
      throw new Error("Tool error!");
    });

    const result = await executeTool(tool, "call-2", {}, { type: "User" });
    expect(result.status).toBe("failed");
    expect(result.error).toBe("Tool error!");
    expect(result.result).toBeNull();
  });

  it("returns timed_out when handler exceeds timeout", async () => {
    const tool = toolRegistry.register({
      serverId: "built-in",
      name: "slow",
      description: "Slow",
      inputSchema: {},
      tags: [],
    });
    registerBuiltInHandler("slow", async () => {
      await new Promise((r) => setTimeout(r, 500));
    });

    const result = await executeTool(tool, "call-3", {}, { type: "User" }, undefined, 10);
    expect(result.status).toBe("timed_out");
  });

  it("fails gracefully when no handler is registered", async () => {
    const tool = toolRegistry.register({
      serverId: "built-in",
      name: "no-handler",
      description: "No handler",
      inputSchema: {},
      tags: [],
    });

    const result = await executeTool(tool, "call-4", {}, { type: "User" });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("No handler registered");
  });

  it("emits tool:execution_started and tool:execution_completed events", async () => {
    const started = vi.fn();
    const completed = vi.fn();
    eventBus.on("tool:execution_started", started);
    eventBus.on("tool:execution_completed", completed);

    const tool = toolRegistry.register({
      serverId: "built-in",
      name: "ok",
      description: "",
      inputSchema: {},
      tags: [],
    });
    registerBuiltInHandler("ok", async () => "result");
    await executeTool(tool, "call-5", {}, { type: "User" });

    expect(started).toHaveBeenCalledOnce();
    expect(completed).toHaveBeenCalledOnce();
  });
});
