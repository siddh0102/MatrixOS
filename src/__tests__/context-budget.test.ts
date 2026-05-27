import { describe, it, expect } from "vitest";
import {
  budgetVerdict,
  estimatePromptTokens,
  estimateMessageTokens,
  COMPACTION_THRESHOLD,
  TOKEN_SAFETY_MARGIN,
} from "@/agents/context-budget";
import type { LLMMessage, LLMToolDefinition } from "@/types";

function userMsg(text: string): LLMMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("context-budget", () => {
  it("counts text content + per-message overhead", () => {
    // 40 chars ≈ 10 tokens by the 4-char heuristic, +10 message overhead = ~20.
    const msg = userMsg("a".repeat(40));
    const t = estimateMessageTokens(msg);
    expect(t).toBeGreaterThanOrEqual(18);
    expect(t).toBeLessThanOrEqual(25);
  });

  it("estimatePromptTokens sums system + messages + tools", () => {
    const sysOnly = estimatePromptTokens("a".repeat(40), [], undefined);
    expect(sysOnly).toBeGreaterThanOrEqual(8);
    expect(sysOnly).toBeLessThanOrEqual(15);

    const withMessages = estimatePromptTokens("a".repeat(40), [userMsg("b".repeat(40))], undefined);
    expect(withMessages).toBeGreaterThan(sysOnly);

    const tools: LLMToolDefinition[] = [
      { name: "x", description: "y".repeat(100), inputSchema: { type: "object" } },
    ];
    const withTools = estimatePromptTokens("", [], tools);
    expect(withTools).toBeGreaterThan(20);
  });

  it("shouldCompact fires at the 80% threshold", () => {
    const ctx = 1000;
    // Make a prompt whose estimate lands well above 800 (= 80% * 1000).
    const bigSystem = "a".repeat(4000); // ~1000 tokens
    const v = budgetVerdict(bigSystem, [], undefined, 200, ctx);
    expect(v.shouldCompact).toBe(true);
    expect(v.threshold).toBe(Math.floor(ctx * COMPACTION_THRESHOLD));
  });

  it("shouldCompact does NOT fire well under threshold", () => {
    const ctx = 8192;
    const v = budgetVerdict("short prompt", [userMsg("hi")], undefined, 1024, ctx);
    expect(v.shouldCompact).toBe(false);
  });

  it("safeMaxTokens never exceeds remaining headroom", () => {
    const ctx = 8192;
    const bigSystem = "a".repeat(20000); // ~5000 tokens
    const v = budgetVerdict(bigSystem, [], undefined, 8192, ctx);
    // headroom = 8192 - ~5000 - 256 ≈ 2900-ish; safeMaxTokens must be ≤ that
    expect(v.safeMaxTokens).toBeLessThan(ctx - v.promptTokens);
    expect(v.safeMaxTokens).toBeLessThanOrEqual(ctx - TOKEN_SAFETY_MARGIN);
  });

  it("safeMaxTokens never drops below 256 (the floor)", () => {
    const ctx = 1000;
    // Prompt larger than context — degenerate, but the cap must not return 0.
    const huge = "x".repeat(8000);
    const v = budgetVerdict(huge, [], undefined, 4096, ctx);
    expect(v.safeMaxTokens).toBeGreaterThanOrEqual(256);
  });

  it("respects the user's requested max_tokens when it already fits", () => {
    const ctx = 32_000;
    const v = budgetVerdict("short", [userMsg("hi")], undefined, 1024, ctx);
    expect(v.safeMaxTokens).toBe(1024);
  });
});
