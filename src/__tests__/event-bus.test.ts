import { describe, it, expect, beforeEach, vi } from "vitest";
import { eventBus } from "@/orchestration/event-bus";

beforeEach(() => {
  eventBus._reset();
});

describe("EventBus", () => {
  it("emits events to subscribers", () => {
    const handler = vi.fn();
    eventBus.on("agent:started", handler);
    eventBus.emit("agent:started", { agentId: "a1" }, "test");
    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0];
    expect(event.type).toBe("agent:started");
    expect(event.payload).toEqual({ agentId: "a1" });
    expect(event.source).toBe("test");
    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeDefined();
  });

  it("does not call handlers for different event types", () => {
    const handler = vi.fn();
    eventBus.on("agent:started", handler);
    eventBus.emit("agent:stopped", {}, "test");
    expect(handler).not.toHaveBeenCalled();
  });

  it("unsubscribes correctly", () => {
    const handler = vi.fn();
    const sub = eventBus.on("agent:started", handler);
    sub.unsubscribe();
    eventBus.emit("agent:started", {}, "test");
    expect(handler).not.toHaveBeenCalled();
  });

  it("once fires exactly once", () => {
    const handler = vi.fn();
    eventBus.once("agent:started", handler);
    eventBus.emit("agent:started", {}, "test");
    eventBus.emit("agent:started", {}, "test");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("multiple handlers on same event all fire", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    eventBus.on("agent:started", h1);
    eventBus.on("agent:started", h2);
    eventBus.emit("agent:started", {}, "test");
    expect(h1).toHaveBeenCalledOnce();
    expect(h2).toHaveBeenCalledOnce();
  });

  it("handler error does not prevent other handlers from running", () => {
    const throwing = vi.fn(() => { throw new Error("boom"); });
    const safe = vi.fn();
    eventBus.on("agent:started", throwing);
    eventBus.on("agent:started", safe);
    expect(() => eventBus.emit("agent:started", {}, "test")).not.toThrow();
    expect(safe).toHaveBeenCalledOnce();
  });

  it("off removes a specific handler", () => {
    const h1 = vi.fn();
    const h2 = vi.fn();
    eventBus.on("agent:started", h1);
    eventBus.on("agent:started", h2);
    eventBus.off("agent:started", h1);
    eventBus.emit("agent:started", {}, "test");
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledOnce();
  });
});
