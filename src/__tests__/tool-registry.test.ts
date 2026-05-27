import { describe, it, expect, beforeEach } from "vitest";
import { toolRegistry } from "@/tools/tool-registry";
import type { Tool } from "@/types";

const TOOL_DEF: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "read_file",
  description: "Read a file",
  inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  tags: ["built-in"],
};

beforeEach(() => {
  toolRegistry.clear();
});

describe("ToolRegistry", () => {
  it("registers a tool and returns it with an id", () => {
    const tool = toolRegistry.register(TOOL_DEF);
    expect(tool.id).toBeDefined();
    expect(tool.name).toBe("read_file");
  });

  it("get returns the tool by id", () => {
    const tool = toolRegistry.register(TOOL_DEF);
    expect(toolRegistry.get(tool.id)).toEqual(tool);
  });

  it("get returns undefined for unknown id", () => {
    expect(toolRegistry.get("nonexistent")).toBeUndefined();
  });

  it("getByName returns the tool", () => {
    const tool = toolRegistry.register(TOOL_DEF);
    expect(toolRegistry.getByName("read_file")).toEqual(tool);
  });

  it("getByName returns undefined for unknown name", () => {
    expect(toolRegistry.getByName("unknown")).toBeUndefined();
  });

  it("list returns all registered tools", () => {
    toolRegistry.register(TOOL_DEF);
    toolRegistry.register({ ...TOOL_DEF, name: "write_file" });
    expect(toolRegistry.list()).toHaveLength(2);
  });

  it("unregister removes the tool", () => {
    const tool = toolRegistry.register(TOOL_DEF);
    expect(toolRegistry.unregister(tool.id)).toBe(true);
    expect(toolRegistry.get(tool.id)).toBeUndefined();
  });

  it("unregister returns false for unknown id", () => {
    expect(toolRegistry.unregister("nonexistent")).toBe(false);
  });

  it("clear removes all tools", () => {
    toolRegistry.register(TOOL_DEF);
    toolRegistry.clear();
    expect(toolRegistry.list()).toHaveLength(0);
  });
});
