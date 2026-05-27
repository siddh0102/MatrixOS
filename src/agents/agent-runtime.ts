import type {
  AgentConfig,
  AgentInstance,
  CallContext,
  ILLMProvider,
  LLMContentBlock,
  LLMMessage,
  LLMToolDefinition,
  Message,
  MessageContent,
} from "@/types";
import { composeSystemPrompt } from "@/agents/prompt-composer";
import { nanoid } from "nanoid";
import { isoNow } from "@/lib/utils";
import { transition } from "@/kernel/lifecycle";
import { getMessages, getActiveSummary, saveMessage } from "@/memory/conversation-store";
import { budgetVerdict } from "@/agents/context-budget";
import { compactConversation } from "@/agents/compactor";
import { saveLLMRequest, saveLLMCall } from "@/memory/telemetry-store";
import { retrieveForAgent, recordEpisodicForAgent } from "@/memory/agent-memory";
import { TELEMETRY_BLOB_CAP } from "@/lib/constants";
import { ProviderError } from "@/lib/errors";
import { approvalGate } from "@/tools/tool-approval";
import { executeTool } from "@/tools/tool-executor";
import { toolRegistry } from "@/tools/tool-registry";
import { eventBus } from "@/orchestration/event-bus";

// Hard cap on tool-use rounds within a single agent turn. Orchestrator
// agents drive a multi-step pipeline in one turn (e.g. COBOL migration:
// verify input → delegate reverse → verify spec → delegate coder → verify
// code → delegate tester → read report ≈ 7 rounds, plus up to two
// coder-revision iterations ≈ 8 more). A cap of 10 truncated such agents
// mid-pipeline; 20 covers the worst case with headroom while still bounding
// a runaway loop.
const MAX_TOOL_TURNS = 20;

export interface StreamCallbacks {
  onMessageStart: () => void;
  onTextDelta: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onThinkingEnd?: () => void;
  onToolCallStart: (toolCallId: string, toolName: string) => void;
  onToolCallDelta: (toolCallId: string, partialJson: string) => void;
  onToolCallEnd: (
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
  ) => void;
  onMessageEnd: (usage: {
    inputTokens: number;
    outputTokens: number;
  }) => void;
  onError: (error: Error) => void;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argsJson: string;
  /** Parsed once on tool_use_end. parseError is set when the model emitted
   *  malformed JSON for the arguments — handled as a retryable tool error
   *  instead of crashing the whole turn. */
  parsedArgs?: Record<string, unknown>;
  parseError?: string;
}

/** Tolerant parse of accumulated tool-call argument JSON. A model (esp. a
 *  small one with a large argument like a big write_file body) sometimes emits
 *  invalid JSON; that must NOT kill the turn. */
function parseToolArgs(json: string): { args: Record<string, unknown>; error?: string } {
  const raw = json.trim() || "{}";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
    return { args: {}, error: "Tool arguments must be a JSON object." };
  } catch (e) {
    return { args: {}, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function executeAgentTurn(
  config: AgentConfig,
  instance: AgentInstance,
  content: MessageContent[],
  provider: ILLMProvider,
  conversationId: string,
  callbacks: StreamCallbacks,
  fallbackProviders?: ILLMProvider[],
  skillPrompts?: string[],
  memoryContext?: string,
  delegationDepth?: number,
  /**
   * Structured form of the retrieval results behind `memoryContext`.
   * Attached to the final assistant message (after any tool-call loops)
   * so the chat UI can render the "🔍 N sources used" badge. Pass [] or
   * undefined when retrieval didn't run or returned no matches.
   */
  memorySources?: import("@/types").MessageSource[],
  /**
   * Abort signal for the whole turn. Used by delegation to enforce
   * `maxDelegationTimeoutMs`: when it fires we abort the in-flight stream
   * (via req.signal → llm_cancel) AND stop the tool-call loop between
   * rounds. Without this a slow/looping sub-agent hangs the caller forever.
   */
  abortSignal?: AbortSignal,
  /**
   * Orchestration linkage for telemetry (migration 020). The workflow runner
   * passes { runId, stepId }; delegation passes { parentRequestId } = the
   * caller turn's telemetryId so delegated turns nest under their orchestrator.
   * Omitted on the plain chat path (linkage columns stay NULL).
   */
  telemetryContext?: {
    runId?: string | null;
    stepId?: string | null;
    parentRequestId?: string | null;
  },
): Promise<Message> {
  const traceEnabled = (() => {
    try { return localStorage.getItem("MATRIXOS_NO_TRACE") !== "1"; }
    catch { return true; }
  })();
  const t0 = performance.now();
  const trace = (label: string, extra?: Record<string, unknown>) => {
    if (!traceEnabled) return;
    const ms = (performance.now() - t0).toFixed(0).padStart(6);
    // eslint-disable-next-line no-console
    console.log(`[turn +${ms}ms] ${label}`, extra ?? "");
  };
  trace("executeAgentTurn:enter", { agentId: config.id, providerType: provider.type });

  instance.status = transition(instance.status, "running");
  eventBus.emit(
    "agent:status_changed",
    { instanceId: instance.instanceId, status: "running" },
    "agent-runtime",
  );

  const callContext: CallContext = {
    type: "Agent",
    agentId: config.id,
    processId: instance.instanceId ?? null,
  };

  const telemetryId = nanoid();
  const startTime = Date.now();
  const { runId = null, stepId = null, parentRequestId = null } =
    telemetryContext ?? {};
  // Hoisted out of the try so the error path can record the prompt too. Without
  // this, failed turns stored "[]" — the rows most worth inspecting were blank
  // (docs/observability-lld.md H1). Set once the initial messages are built.
  let promptForTelemetry = "[]";

  try {
    // 1. Save user message
    const userMessage: Message = {
      id: nanoid(),
      conversationId,
      role: "user",
      content: content,
      tokenCount: null,
      model: null,
      telemetryId: null,
      createdAt: isoNow(),
    };
    trace("saveMessage:start");
    await saveMessage(userMessage);
    trace("saveMessage:done");
    eventBus.emit(
      "conversation:message_added",
      { conversationId, messageId: userMessage.id, role: "user" },
      "agent-runtime",
    );

    // 2. Build initial LLM messages from history (compacted rows are filtered
    //    by getMessages so the LLM only sees live turns + we'll inject the
    //    summary text into the system prompt separately below).
    trace("getMessages:start");
    const history = await getMessages(conversationId);
    trace("getMessages:done", { count: history.length });
    let llmMessages = buildLLMMessages(
      history,
      config.maxConversationHistory,
    );
    let activeSummary = await getActiveSummary(conversationId);

    // 3. Resolve tools for LLMRequest.
    //
    // The local provider stores `models: []` and uses `modelId = "auto"`
    // as a sentinel that means "use whatever llama.cpp has loaded".
    // For that case the static lookup returns undefined, which would
    // silently disable tool calling. Treat the local provider as
    // tool-capable by default — its `list_models()` already returns
    // supports_tools=true for whatever model is live.
    const selectedModel = provider.config.models.find(
      (m) => m.id === config.modelId,
    );
    const supportsTools =
      selectedModel?.supportsTools ??
      (provider.config.type === "local" || config.modelId === "auto");
    let tools: LLMToolDefinition[] | undefined =
      supportsTools && config.toolIds.length > 0
        ? config.toolIds
            .map((id) => toolRegistry.get(id))
            .filter(Boolean)
            .map((t) => ({
              name: t!.name,
              description: t!.description,
              inputSchema: t!.inputSchema,
            }))
        : undefined;

    // Inject delegation tool if enabled
    if (
      supportsTools &&
      config.delegationConfig?.enabled &&
      config.delegationConfig.allowedAgentIds.length > 0
    ) {
      const { DELEGATE_TOOL_DEFINITION } = await import("@/tools/built-in/delegate-tool");
      tools = [...(tools ?? []), DELEGATE_TOOL_DEFINITION];
    }

    // 4. Resolve fallback candidates
    // Rate limiting is enforced by the Rust backend (Phase A) — providers
    // surface `RATE_LIMITED` via `ProviderError` when exceeded.
    const candidates = [provider, ...(fallbackProviders ?? [])];

    // Memory — single shared path for ALL execution paths (chat, workflow,
    // delegation, scheduled). Retrieve once per turn when the agent has memory
    // enabled; this overrides any caller-passed context, so callers no longer
    // need to retrieve themselves. Fail-soft inside retrieveForAgent.
    const queryText = content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    let resolvedMemoryContext = memoryContext;
    let resolvedMemorySources = memorySources;
    if (config.memoryConfig?.enabled) {
      const mem = await retrieveForAgent(config, queryText);
      if (mem.contextText) resolvedMemoryContext = mem.contextText;
      if (mem.sources) resolvedMemorySources = mem.sources;
    }

    let composedPrompt = composeSystemPrompt(
      config.systemPrompt,
      skillPrompts ?? [],
      resolvedMemoryContext,
      activeSummary?.text,
    );

    // 5b. Budget check: if the prompt is at or above 80% of the model's
    //     context window, compact older turns into a summary before
    //     sending. Without this, long conversations either silently stall
    //     on the LLM (Groq under context overflow) or fail with a 400
    //     once the request leaves the app.
    const contextWindow = selectedModel?.contextWindow ?? 8192;
    let verdict = budgetVerdict(
      composedPrompt,
      llmMessages,
      tools,
      config.maxTokens,
      contextWindow,
    );
    trace("budget pre-compact", {
      promptTokens: verdict.promptTokens,
      contextWindow,
      threshold: verdict.threshold,
      shouldCompact: verdict.shouldCompact,
    });
    if (verdict.shouldCompact) {
      try {
        const result = await compactConversation(
          conversationId,
          provider,
          config.modelId,
        );
        if (result) {
          trace("compaction:done", {
            compactedCount: result.compactedCount,
            replacedPrior: result.replacedPriorSummary,
          });
          // The compactor itself emits "conversation:compacted" so the
          // chat UI hears about it whether the trigger was auto (here)
          // or manual (/compact). Do not double-fire from agent-runtime.
          // Rebuild context now that the DB has changed.
          const newHistory = await getMessages(conversationId);
          llmMessages = buildLLMMessages(newHistory, config.maxConversationHistory);
          activeSummary = await getActiveSummary(conversationId);
          composedPrompt = composeSystemPrompt(
            config.systemPrompt,
            skillPrompts ?? [],
            memoryContext,
            activeSummary?.text,
          );
          verdict = budgetVerdict(
            composedPrompt,
            llmMessages,
            tools,
            config.maxTokens,
            contextWindow,
          );
          trace("budget post-compact", {
            promptTokens: verdict.promptTokens,
            safeMaxTokens: verdict.safeMaxTokens,
          });
        } else {
          trace("compaction:skipped", { reason: "not enough messages" });
        }
      } catch (err) {
        // Compaction is best-effort. If the LLM call fails (rate limit,
        // network), proceed with the original prompt — the safeMaxTokens
        // cap below + the openai_compatible idle-stream timeout still
        // protect against silent stalls.
        trace("compaction:err", { msg: err instanceof Error ? err.message : String(err) });
      }
    }

    // 6. Tool-use continuation loop
    trace("composedPrompt built", {
      systemPromptChars: composedPrompt.length,
      llmMessages: llmMessages.length,
      tools: tools?.length ?? 0,
      safeMaxTokens: verdict.safeMaxTokens,
      hasActiveSummary: activeSummary !== null,
    });
    callbacks.onMessageStart();
    let totalUsage = { inputTokens: 0, outputTokens: 0 };
    let finalMessage: Message | null = null;
    let activeProvider: ILLMProvider = provider;

    const initialPromptJson = JSON.stringify(llmMessages);
    promptForTelemetry = initialPromptJson;
    let toolRounds = 0;

    for (let toolTurn = 0; toolTurn <= MAX_TOOL_TURNS; toolTurn++) {
      // Stop between rounds if aborted (delegation timeout / cancel) — the
      // in-stream cancel below only covers an active stream, not the gap
      // during tool execution.
      if (abortSignal?.aborted) {
        throw new Error("Agent turn aborted (delegation timeout or cancellation)");
      }
      let turnText = "";
      let thinkingText = "";
      let turnUsage = { inputTokens: 0, outputTokens: 0 };
      // Per-round telemetry (migration 020). Captured from the message_end chunk
      // and the round's wall-clock; written to llm_calls after the round.
      const roundStart = Date.now();
      let finishReason: string | null = null;
      let ttftMs: number | null = null;
      const toolCalls: ToolCallAccumulator[] = [];
      const activeToolCalls = new Map<string, ToolCallAccumulator>();

      const providersForThisTurn =
        toolTurn === 0 ? candidates : [activeProvider];
      let streamSucceeded = false;

      for (const candidate of providersForThisTurn) {
        try {
          trace("streamMessage:open", { provider: candidate.type, toolTurn });
          const thinkingEnabled = config.thinkingConfig?.enabled ?? false;
          // The literal "auto" is a sentinel used by the local provider to
          // mean "discover the loaded model at request time". Non-local
          // providers don't honor it and respond with `model_not_found`,
          // which silently breaks fallbacks from a local primary to a
          // remote backup. Substitute the candidate's default model here so
          // the fallback path actually works.
          const candidateModelId =
            candidate.type !== "local" && config.modelId === "auto"
              ? (candidate.config.defaultModelId ||
                  candidate.config.models?.[0]?.id ||
                  config.modelId)
              : config.modelId;
          if (candidateModelId !== config.modelId) {
            trace("model-substitute", {
              candidate: candidate.type,
              from: config.modelId,
              to: candidateModelId,
            });
          }
          const stream = candidate.streamMessage({
            model: candidateModelId,
            systemPrompt: composedPrompt,
            messages: llmMessages,
            // Honored by rust-proxy → llm_cancel; lets a delegation timeout
            // actually abort a hung/slow sub-agent stream.
            signal: abortSignal,
            // safeMaxTokens leaves at least 256 tokens of headroom in the
            // context window for prompt growth. Without this, an agent
            // configured with maxTokens=8192 on an 8k Groq model hangs
            // silently once history grows.
            maxTokens: verdict.safeMaxTokens,
            temperature: thinkingEnabled ? 1 : config.temperature,
            tools,
            thinking: thinkingEnabled
              ? {
                  enabled: true,
                  budgetTokens: config.thinkingConfig.budgetTokens || undefined,
                }
              : undefined,
          });

          let firstChunkSeen = false;
          for await (const chunk of stream) {
            if (!firstChunkSeen) {
              trace("streamMessage:firstChunk", { type: chunk.type });
              firstChunkSeen = true;
            }
            switch (chunk.type) {
              case "text_delta":
                turnText += chunk.text;
                callbacks.onTextDelta(chunk.text);
                break;

              case "thinking_delta":
                callbacks.onThinkingDelta?.(chunk.text);
                thinkingText += chunk.text;
                break;

              case "thinking_end":
                callbacks.onThinkingEnd?.();
                break;

              case "tool_use_start":
                activeToolCalls.set(chunk.id, {
                  id: chunk.id,
                  name: chunk.name,
                  argsJson: "",
                });
                callbacks.onToolCallStart(chunk.id, chunk.name);
                break;

              case "tool_use_delta": {
                const tc = activeToolCalls.get(
                  chunk.toolCallId ?? "",
                );
                if (tc) {
                  tc.argsJson += chunk.partialJson;
                  callbacks.onToolCallDelta(
                    tc.id,
                    chunk.partialJson,
                  );
                }
                break;
              }

              case "tool_use_end": {
                const tc = activeToolCalls.get(
                  chunk.toolCallId ?? "",
                );
                if (tc) {
                  toolCalls.push(tc);
                  activeToolCalls.delete(tc.id);
                  const parsed = parseToolArgs(tc.argsJson);
                  tc.parsedArgs = parsed.args;
                  tc.parseError = parsed.error;
                  callbacks.onToolCallEnd(tc.id, tc.name, parsed.args);
                }
                break;
              }

              case "message_end":
                turnUsage = chunk.usage;
                finishReason = chunk.finishReason ?? null;
                ttftMs = chunk.ttftMs ?? null;
                break;
            }
          }

          streamSucceeded = true;
          activeProvider = candidate;
          break;
        } catch (err) {
          const error =
            err instanceof Error ? err : new Error(String(err));
          if (
            toolTurn === 0 &&
            isFallbackEligible(error) &&
            candidate !== providersForThisTurn[providersForThisTurn.length - 1]
          ) {
            turnText = "";
            toolCalls.length = 0;
            activeToolCalls.clear();
            continue;
          }
          throw error;
        }
      }

      if (!streamSucceeded) {
        throw new Error("All provider candidates failed");
      }

      totalUsage.inputTokens += turnUsage.inputTokens;
      totalUsage.outputTokens += turnUsage.outputTokens;

      // Per-round telemetry → llm_calls (migration 020). Fire-and-forget, never
      // blocks the turn. prompt_json is kept only for rounds worth inspecting
      // (the model hit its output cap), capped to bound DB growth.
      const keepPrompt = finishReason === "length";
      saveLLMCall({
        id: nanoid(),
        requestId: telemetryId,
        turnIndex: toolTurn,
        inputTokens: turnUsage.inputTokens,
        outputTokens: turnUsage.outputTokens,
        ttftMs,
        latencyMs: Date.now() - roundStart,
        finishReason,
        responseText: turnText ? turnText.slice(0, TELEMETRY_BLOB_CAP) : null,
        promptJson: keepPrompt
          ? JSON.stringify(llmMessages).slice(0, TELEMETRY_BLOB_CAP)
          : null,
        createdAt: isoNow(),
      }).catch(() => {});

      // No tool calls → final response
      if (toolCalls.length === 0) {
        const finalContent: MessageContent[] = [];
        if (thinkingText) {
          finalContent.push({ type: "thinking", text: thinkingText });
        }
        finalContent.push({ type: "text", text: turnText });
        finalMessage = {
          id: nanoid(),
          conversationId,
          role: "assistant",
          content: finalContent,
          tokenCount: turnUsage.inputTokens + turnUsage.outputTokens,
          model: config.modelId,
          telemetryId: telemetryId,
          createdAt: isoNow(),
          sources: resolvedMemorySources && resolvedMemorySources.length > 0 ? resolvedMemorySources : undefined,
        };
        await saveMessage(finalMessage);
        eventBus.emit(
          "conversation:message_added",
          {
            conversationId,
            messageId: finalMessage.id,
            role: "assistant",
          },
          "agent-runtime",
        );
        break;
      }

      // Tool calls present → execute, save intermediate messages, loop
      toolRounds++;

      const assistantContent: MessageContent[] = [
        ...(turnText
          ? [{ type: "text" as const, text: turnText }]
          : []),
        ...toolCalls.map((tc) => ({
          type: "tool_call" as const,
          toolCallId: tc.id,
          toolName: tc.name,
          arguments: tc.parsedArgs ?? {},
        })),
      ];
      const assistantMsg: Message = {
        id: nanoid(),
        conversationId,
        role: "assistant",
        content: assistantContent,
        tokenCount: turnUsage.inputTokens + turnUsage.outputTokens,
        model: config.modelId,
        telemetryId: null,
        createdAt: isoNow(),
      };
      await saveMessage(assistantMsg);

      // Execute each tool call
      const toolResults: MessageContent[] = [];
      for (const tc of toolCalls) {
        // Malformed argument JSON from the model: don't crash the turn — return
        // a corrective tool error so the model re-issues the call with valid
        // JSON on the next round (this is the "kept failing with malformed JSON"
        // loop that was killing turns at round 0).
        if (tc.parseError) {
          toolResults.push({
            type: "tool_result",
            toolCallId: tc.id,
            result: JSON.stringify({
              error: `Invalid JSON in arguments for ${tc.name}: ${tc.parseError}. Re-issue the tool call with valid, properly-escaped JSON arguments.`,
            }),
            isError: true,
          });
          continue;
        }
        const args = tc.parsedArgs ?? {};

        // Special handling for delegation tool
        if (tc.name === "delegate_to_agent") {
          try {
            const { executeDelegation } = await import("@/tools/built-in/delegate-tool");
            const result = await executeDelegation(
              args as { agentId: string; task: string; context?: string },
              config,
              delegationDepth ?? 0,
              telemetryId,
              { runId, stepId },
            );
            toolResults.push({
              type: "tool_result",
              toolCallId: tc.id,
              result,
              isError: false,
            });
          } catch (err) {
            toolResults.push({
              type: "tool_result",
              toolCallId: tc.id,
              result: JSON.stringify({ error: (err as Error).message }),
              isError: true,
            });
          }
          continue;
        }

        const tool = toolRegistry.getByName(tc.name);

        if (tool) {
          const approvalResult =
            await approvalGate.requestApproval(
              tc.id,
              tool.name,
              tool.serverId,
              args,
              tool.inputSchema,
              config.approvalConfig,
            );

          if (approvalResult.status === "approved") {
            const execution = await executeTool(tool, tc.id, args, callContext, config.sandboxConfig, undefined, { requestId: telemetryId });
            toolResults.push({
              type: "tool_result",
              toolCallId: tc.id,
              result: JSON.stringify(execution.result),
              isError: execution.status === "failed",
            });
          } else {
            toolResults.push({
              type: "tool_result",
              toolCallId: tc.id,
              result: JSON.stringify({
                error: `Tool ${tc.name} was ${approvalResult.status}`,
              }),
              isError: true,
            });
          }
        } else {
          toolResults.push({
            type: "tool_result",
            toolCallId: tc.id,
            result: JSON.stringify({
              error: `Unknown tool: ${tc.name}`,
            }),
            isError: true,
          });
        }
      }

      // Save tool results as user message
      const toolResultMsg: Message = {
        id: nanoid(),
        conversationId,
        role: "user",
        content: toolResults,
        tokenCount: null,
        model: null,
        telemetryId: null,
        createdAt: isoNow(),
      };
      await saveMessage(toolResultMsg);

      // Rebuild LLM messages for next round
      const updatedHistory = await getMessages(conversationId);
      llmMessages = buildLLMMessages(
        updatedHistory,
        config.maxConversationHistory,
      );
      // Re-budget after the tool result rows landed: the prompt grew,
      // so safeMaxTokens must shrink to stay within context. Compaction
      // is deliberately NOT triggered mid-tool-loop — splitting a tool
      // sequence across a summary would be very confusing for the model.
      verdict = budgetVerdict(
        composedPrompt,
        llmMessages,
        tools,
        config.maxTokens,
        contextWindow,
      );
      trace("budget post-tool-turn", {
        promptTokens: verdict.promptTokens,
        safeMaxTokens: verdict.safeMaxTokens,
      });

      if (toolTurn === MAX_TOOL_TURNS) {
        finalMessage = assistantMsg;
      }
    }

    if (!finalMessage) {
      throw new Error("Agent turn produced no response");
    }

    // 7. Record telemetry (fire-and-forget — never block the turn on DB write)
    const latencyMs = Date.now() - startTime;
    saveLLMRequest({
      id: telemetryId,
      conversationId,
      agentId: config.id,
      providerId: activeProvider.config.id,
      modelId: config.modelId,
      promptJson: initialPromptJson,
      responseText: finalMessage.content
        .filter(
          (c): c is { type: "text"; text: string } =>
            c.type === "text",
        )
        .map((c) => c.text)
        .join("\n"),
      inputTokens: totalUsage.inputTokens,
      outputTokens: totalUsage.outputTokens,
      toolRounds,
      latencyMs,
      status: "success",
      errorCode: null,
      createdAt: isoNow(),
      runId,
      stepId,
      parentRequestId,
    }).catch(() => {});

    // 7b. Episodic memory write (smart distillation) — shared path, runs on
    // every execution path, fire-and-forget. Gated by the agent's memoryConfig.
    if (config.memoryConfig?.enabled && config.memoryConfig.episodicEnabled) {
      const responseText = finalMessage.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      void recordEpisodicForAgent(
        config,
        activeProvider,
        conversationId,
        userMessage.id,
        finalMessage.id,
        queryText,
        responseText,
      );
    }

    // 8. Update instance
    instance.tokenUsage.totalInputTokens += totalUsage.inputTokens;
    instance.tokenUsage.totalOutputTokens += totalUsage.outputTokens;
    instance.tokenUsage.turnCount += 1;
    instance.status = transition(instance.status, "idle");
    callbacks.onMessageEnd(totalUsage);

    eventBus.emit(
      "agent:status_changed",
      { instanceId: instance.instanceId, status: "idle" },
      "agent-runtime",
    );

    return finalMessage;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));

    const latencyMs = Date.now() - startTime;
    await saveLLMRequest({
      id: telemetryId,
      conversationId,
      agentId: config.id,
      providerId: provider.config.id,
      modelId: config.modelId,
      promptJson: promptForTelemetry,
      responseText: null,
      inputTokens: 0,
      outputTokens: 0,
      toolRounds: 0,
      latencyMs,
      status: "error",
      errorCode:
        error instanceof ProviderError ? error.code : "RUNTIME_ERROR",
      createdAt: isoNow(),
      runId,
      stepId,
      parentRequestId,
    }).catch(() => {});

    instance.status = transition(instance.status, "error");
    instance.error = {
      message: error.message,
      code: "RUNTIME_ERROR",
      timestamp: isoNow(),
      recoverable: true,
    };
    callbacks.onError(error);
    eventBus.emit(
      "agent:error",
      { instanceId: instance.instanceId, error: instance.error },
      "agent-runtime",
    );
    throw error;
  }
}

// ── Helpers ──

function buildLLMMessages(
  messages: Message[],
  maxHistory: number,
): LLMMessage[] {
  return messages.slice(-maxHistory).map((msg) => ({
    role: msg.role,
    // Thinking blocks are preserved (not stripped) so reasoning models can
    // echo prior reasoning_content back to their API — DeepSeek-R1 and
    // routers like Opencode Zen reject a continuation that drops it. The
    // openai-compatible provider serializes them as reasoning_content;
    // Claude and Ollama drop them on their side (we don't capture Claude
    // thinking signatures, and Ollama is text-only).
    content: msg.content.map(contentToLLMBlock),
  }));
}

function contentToLLMBlock(content: MessageContent): LLMContentBlock {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "image":
      return { type: "image", mimeType: content.mimeType, base64: content.base64 };
    case "tool_call":
      return {
        type: "tool_use",
        id: content.toolCallId,
        name: content.toolName,
        input: content.arguments,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolCallId: content.toolCallId,
        content: content.result,
        isError: content.isError,
      };
    case "error":
      return { type: "text", text: `[Error: ${content.message}]` };
    case "thinking":
      return { type: "thinking", thinking: content.text };
  }
}

function isFallbackEligible(error: Error): boolean {
  if (error instanceof ProviderError) {
    if (error.code === "RATE_LIMITED") return true;
    const statusMatch = error.code.match(/(\d{3})$/);
    if (statusMatch) {
      const status = parseInt(statusMatch[1], 10);
      return status >= 500 || status === 429;
    }
    return (
      error.code.includes("TIMEOUT") || error.code.includes("NETWORK")
    );
  }
  return false;
}
