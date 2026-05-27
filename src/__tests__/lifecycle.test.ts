import { describe, it, expect } from "vitest";
import {
  canTransition,
  transition,
  getValidTransitions,
} from "@/kernel/lifecycle";
import type { AgentStatus } from "@/types";

describe("lifecycle", () => {
  describe("canTransition", () => {
    it("allows idle → running", () => {
      expect(canTransition("idle", "running")).toBe(true);
    });
    it("allows idle → stopped", () => {
      expect(canTransition("idle", "stopped")).toBe(true);
    });
    it("allows running → idle", () => {
      expect(canTransition("running", "idle")).toBe(true);
    });
    it("allows running → paused", () => {
      expect(canTransition("running", "paused")).toBe(true);
    });
    it("allows running → error", () => {
      expect(canTransition("running", "error")).toBe(true);
    });
    it("allows running → stopped", () => {
      expect(canTransition("running", "stopped")).toBe(true);
    });
    it("allows paused → running", () => {
      expect(canTransition("paused", "running")).toBe(true);
    });
    it("allows paused → stopped", () => {
      expect(canTransition("paused", "stopped")).toBe(true);
    });
    it("allows error → running", () => {
      expect(canTransition("error", "running")).toBe(true);
    });
    it("allows error → stopped", () => {
      expect(canTransition("error", "stopped")).toBe(true);
    });
    it("allows stopped → idle", () => {
      expect(canTransition("stopped", "idle")).toBe(true);
    });
    it("rejects idle → paused", () => {
      expect(canTransition("idle", "paused")).toBe(false);
    });
    it("rejects idle → error", () => {
      expect(canTransition("idle", "error")).toBe(false);
    });
    it("rejects stopped → running", () => {
      expect(canTransition("stopped", "running")).toBe(false);
    });
    it("rejects paused → idle", () => {
      expect(canTransition("paused", "idle")).toBe(false);
    });
    it("rejects error → idle", () => {
      expect(canTransition("error", "idle")).toBe(false);
    });
    it("rejects same-state transitions", () => {
      const statuses: AgentStatus[] = [
        "idle", "running", "paused", "error", "stopped",
      ];
      for (const s of statuses) {
        expect(canTransition(s, s)).toBe(false);
      }
    });
  });

  describe("transition", () => {
    it("returns new state on valid transition", () => {
      expect(transition("idle", "running")).toBe("running");
    });
    it("throws on invalid transition", () => {
      expect(() => transition("idle", "paused")).toThrow(
        "Invalid agent state transition",
      );
    });
  });

  describe("getValidTransitions", () => {
    it("returns all valid targets for idle", () => {
      expect(getValidTransitions("idle")).toEqual(
        expect.arrayContaining(["running", "stopped"]),
      );
    });
    it("returns all valid targets for running", () => {
      const targets = getValidTransitions("running");
      expect(targets).toContain("idle");
      expect(targets).toContain("paused");
      expect(targets).toContain("error");
      expect(targets).toContain("stopped");
    });
  });
});
