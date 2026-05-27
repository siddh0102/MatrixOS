import React from "react";
import ReactDOM from "react-dom/client";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import "./index.css";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

import { toolRegistry } from "@/tools/tool-registry";
import { registerBuiltInHandler } from "@/tools/tool-executor";
import { READ_FILE_DEFINITION, readFileHandler } from "@/tools/built-in/read-file";
import { WRITE_FILE_DEFINITION, writeFileHandler } from "@/tools/built-in/write-file";
import { EDIT_FILE_DEFINITION, editFileHandler } from "@/tools/built-in/edit-file";
import { RUN_SHELL_DEFINITION, runShellHandler } from "@/tools/built-in/run-shell";
import { LIST_DIRECTORY_DEFINITION, listDirectoryHandler } from "@/tools/built-in/list-directory";
import { GLOB_DEFINITION, globHandler } from "@/tools/built-in/glob";
import { GREP_DEFINITION, grepHandler } from "@/tools/built-in/grep";
import { WEB_FETCH_DEFINITION, webFetchHandler } from "@/tools/built-in/web-fetch";
import { WEB_SEARCH_DEFINITION, webSearchHandler } from "@/tools/built-in/web-search";
import { GET_DIAGNOSTICS_DEFINITION, getDiagnosticsHandler } from "@/tools/built-in/get-diagnostics";
import { CURRENT_DATETIME_DEFINITION, currentDatetimeHandler } from "@/tools/built-in/current-datetime";
import { REPORT_ARTIFACT_DEFINITION, reportArtifactHandler } from "@/tools/built-in/report-artifact";
import { listProviderConfigs, saveProviderConfig } from "@/memory/provider-store";
import { listAgentConfigs } from "@/memory/agent-store-sql";
import { listConversations } from "@/memory/conversation-store";
import { mcpManager } from "@/tools/mcp-manager";
import { useMCPStore } from "@/stores/mcp-store";
import { loadBundledAgentTemplates, loadBundledSkills } from "@/library/loader";
import { listSkills, seedBundledSkills } from "@/memory/skill-store-sql";
import {
  listAgentTemplates,
  seedBundledAgentTemplates,
} from "@/memory/agent-template-store-sql";
import { useLibraryStore } from "@/stores/library-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useAgentStore } from "@/stores/agent-store";
import { useConversationStore } from "@/stores/conversation-store";
import { useTabStore } from "@/stores/tab-store";
import { createInstance } from "@/agents/agent-factory";
import type { MCPServerConfig, ProviderConfig } from "@/types";
import { isoNow } from "@/lib/utils";
import { dbSelect } from "@/kernel/ipc-bridge";
import { listDocuments } from "@/memory/semantic-store";
import { listProceduralTemplates } from "@/memory/procedural-store";
import { pruneOldEpisodicEntries } from "@/memory/episodic-store";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import { listScheduledJobs } from "@/memory/schedule-store";
import { useScheduleStore } from "@/stores/schedule-store";
import { eventBus } from "@/orchestration/event-bus";
import { useUIStore } from "@/stores/ui-store";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

async function detectOllamaRunning(): Promise<boolean> {
  // Lightweight liveness probe for the embedding-config fallback below.
  // LLM provider discovery happens via the Connection Settings UI.
  //
  // The probe runs through a Rust IPC (`probe_ollama`) instead of a
  // browser-side fetch on purpose: failed fetches in the WebView log a
  // permanent `ERR_CONNECTION_REFUSED` line to devtools every startup
  // even when JS catches the rejection. Routing through Rust keeps that
  // noise out of the browser console.
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("probe_ollama");
  } catch {
    return false;
  }
}

async function bootstrap() {
  // Granular step markers so a fatal error in any stage points directly at
  // the failing line, both in the dev terminal (eslint-disable-next-line
  // no-console; we *want* this in stdout) and on the in-app error screen
  // (read from window.__BOOTSTRAP_LAST_STEP__).
  const mark = (step: string) => {
    (globalThis as { __BOOTSTRAP_LAST_STEP__?: string }).__BOOTSTRAP_LAST_STEP__ = step;
    // eslint-disable-next-line no-console
    console.log(`[bootstrap] ${step}`);
  };

  // Audit log retention is deferred to Phase F (table rotation; see
  // docs/superpowers/specs/2026-05-18-phase-c-audit-sql-writes-design.md §4.4).
  // Migration 012 blocks DELETE on audit_log unconditionally.

  mark("1a. detect ollama");
  // 1a. Detect whether Ollama is running for the embedding-config fallback.
  const ollama = { running: await detectOllamaRunning() };

  mark("1. register built-in tools");
  // 1. Register built-in tools.
  // Clear first so any double-bootstrap (HMR or otherwise) replaces rather
  // than duplicates. register() is now idempotent on (serverId, name) too,
  // but the clear keeps semantics dead simple.
  toolRegistry.clear();
  toolRegistry.register(READ_FILE_DEFINITION);
  registerBuiltInHandler("read_file", readFileHandler);

  toolRegistry.register(WRITE_FILE_DEFINITION);
  registerBuiltInHandler("write_file", writeFileHandler);

  toolRegistry.register(EDIT_FILE_DEFINITION);
  registerBuiltInHandler("edit_file", editFileHandler);

  toolRegistry.register(LIST_DIRECTORY_DEFINITION);
  registerBuiltInHandler("list_directory", listDirectoryHandler);

  toolRegistry.register(GLOB_DEFINITION);
  registerBuiltInHandler("glob", globHandler);

  toolRegistry.register(GREP_DEFINITION);
  registerBuiltInHandler("grep", grepHandler);

  toolRegistry.register(WEB_FETCH_DEFINITION);
  registerBuiltInHandler("web_fetch", webFetchHandler);

  toolRegistry.register(WEB_SEARCH_DEFINITION);
  registerBuiltInHandler("web_search", webSearchHandler);

  toolRegistry.register(CURRENT_DATETIME_DEFINITION);
  registerBuiltInHandler("current_datetime", currentDatetimeHandler);

  toolRegistry.register(RUN_SHELL_DEFINITION);
  registerBuiltInHandler("run_shell", runShellHandler);

  toolRegistry.register(GET_DIAGNOSTICS_DEFINITION);
  registerBuiltInHandler("get_diagnostics", getDiagnosticsHandler);

  toolRegistry.register(REPORT_ARTIFACT_DEFINITION);
  registerBuiltInHandler("report_artifact", reportArtifactHandler);

  mark("2. listProviderConfigs");
  // 2. Load persisted provider configs (no auto-seeding; users add via
  //    Connection Settings → Add Provider).
  let providers = await listProviderConfigs();

  // One-time keychain key-name migration (legacy AgentOS → MatrixOS).
  const { hasProviderApiKey } = await import("@/kernel/secure-store");
  const { invoke } = await import("@tauri-apps/api/core");
  for (const p of providers) {
    if (p.type === "claude" || p.type === "openai-compatible") {
      await invoke("keychain_migrate", { key: `provider.${p.id}.apiKey` }).catch(() => {});
    }
  }
  // Auto-enable providers whose key is present in the keychain but whose
  // persisted config was left disabled (e.g., after a clean restart).
  const restored: ProviderConfig[] = [];
  for (const p of providers) {
    if ((p.type === "claude" || p.type === "openai-compatible") && !p.enabled) {
      const hasKey = await hasProviderApiKey(p.id);
      if (hasKey) {
        const updated = { ...p, enabled: true, updatedAt: isoNow() };
        await saveProviderConfig(updated);
        restored.push(updated);
        continue;
      }
    }
    restored.push(p);
  }
  providers = restored;

  mark("2b. keychain migrate done; setProviders");
  useSettingsStore.getState().setProviders(providers);

  mark("3. pick active provider");
  // 3. Active provider — pick the first enabled provider if any exists.
  //    With no providers configured, leave activeProviderId null; the chat
  //    page surfaces a "configure a provider" prompt.
  const firstEnabled = providers.find((p) => p.enabled);
  if (firstEnabled) {
    useSettingsStore.getState().setActiveProvider(firstEnabled.id);
  }

  mark("4. listAgentConfigs");
  // 4. Agents — load whatever exists. No default agent is auto-created;
  //    a user without a configured provider has nothing to bind an agent to.
  const agents = await listAgentConfigs();

  useAgentStore.getState().setConfigs(agents);
  for (const config of agents) {
    useAgentStore.getState().setInstance(config.id + "-inst", createInstance(config));
  }

  const firstAgent = agents[0];

  mark(`4b. agents loaded (n=${agents.length}); first=${firstAgent?.id ?? "none"}`);
  if (firstAgent) {
    mark("5. listConversations");
    const convs = await listConversations(firstAgent.id);
    useConversationStore.getState().setConversations(convs);
    if (convs.length > 0) {
      useConversationStore.getState().setActiveConversation(convs[0].id);
    }

    // Restore persisted tabs, or open initial tab if none exist
    const tabStore = useTabStore.getState();
    tabStore.restoreTabs();
    if (tabStore.tabs.length === 0) {
      if (convs.length > 0) {
        tabStore.openTab(firstAgent.id, convs[0].id, convs[0].title);
      } else {
        tabStore.openTab(firstAgent.id, null, firstAgent.name);
      }
    }
  } else {
    // No agents — restore any persisted tabs but don't open a default tab.
    useTabStore.getState().restoreTabs();
  }

  mark("6. load MCP servers");
  // 6. Load MCP servers (read directly from DB — mcp-store-sql.ts deleted in Phase D task 11)
  try {
    const mcpRows = await dbSelect<{ id: string; name: string; transport_json: string; enabled: number }>(
      "SELECT id, name, transport_json, enabled FROM mcp_servers ORDER BY created_at ASC",
    );
    // transport_json contains the full McpServerConfig JSON written by mcp_set_server_config.
    // Override id/name/enabled from the canonical columns.
    const mcpConfigs: MCPServerConfig[] = mcpRows.map((r) =>
      ({
        ...(JSON.parse(r.transport_json) as MCPServerConfig),
        id: r.id,
        name: r.name,
        enabled: r.enabled === 1,
      }) as MCPServerConfig,
    );
    const mcpStore = useMCPStore.getState();
    for (const cfg of mcpConfigs) {
      mcpStore.addServer(cfg);
    }
    // Hydrate Rust-side McpRegistry from SQL before any mcp_spawn fires.
    // The registry is in-memory only; without this, every startup would hit
    // MCP_SERVER_UNKNOWN for persisted servers.
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke<number>("mcp_hydrate_from_db");
    } catch (e) {
      console.error("mcp_hydrate_from_db failed:", e);
    }
    await mcpManager.loadAndStartAll(mcpConfigs);
  } catch {
    // MCP load failures are non-fatal
  }

  mark("7. library: load + seed bundled resources");
  // 7. Library bootstrap.
  //    Bundled agent-templates and skills ship as JSON resource files
  //    (src-tauri/resources/library/) — NOT in TypeScript source code —
  //    and get seeded into their respective SQLite tables on first sighting.
  //    Tracking via per-install seen-set preferences ensures user deletions
  //    are not silently re-added by subsequent launches. The UI renders
  //    from DB-backed in-memory caches in `useLibraryStore`.
  try {
    const [bundledAgents, bundledSkills] = await Promise.all([
      loadBundledAgentTemplates(),
      loadBundledSkills(),
    ]);
    useLibraryStore.getState().setBundledSkills(bundledSkills);

    const [agentSeed, skillSeed] = await Promise.all([
      seedBundledAgentTemplates(bundledAgents),
      seedBundledSkills(bundledSkills),
    ]);
    if (agentSeed.seeded > 0) {
      console.info(`[library] seeded ${agentSeed.seeded} new bundled agent template(s)`);
    }
    if (skillSeed.seeded > 0) {
      console.info(`[library] seeded ${skillSeed.seeded} new bundled skill(s)`);
    }
  } catch (err) {
    console.warn("Failed to load/seed bundled library data:", err);
  }

  mark("8. load DB-backed library state");
  // 8. Load DB-backed library state (agent templates + imported skills).
  try {
    const [agentTemplates, importedSkills] = await Promise.all([
      listAgentTemplates(),
      listSkills(),
    ]);
    useLibraryStore.getState().setAgentTemplates(agentTemplates);
    useLibraryStore.getState().setImportedSkills(importedSkills);
  } catch (err) {
    console.warn("Failed to load library state from database:", err);
  }

  mark("9. load knowledge base");
  // 9. Load knowledge base data (non-fatal)
  try {
    const [docs, templates] = await Promise.all([
      listDocuments(),
      listProceduralTemplates(),
    ]);
    useKnowledgeStore.getState().setDocuments(docs);
    useKnowledgeStore.getState().setProceduralTemplates(templates);
  } catch (err) {
    console.warn("Failed to load knowledge base:", err);
  }

  mark("10. load embedding config");
  // 10. Load embedding configuration
  try {
    const rows = await dbSelect<{
      provider: string;
      model: string;
      dimensions: number;
      base_url: string | null;
    }>("SELECT * FROM embedding_config WHERE id = 'default'");
    if (rows.length > 0) {
      const row = rows[0];
      const config = {
        provider: row.provider as "local" | "ollama" | "openai-compatible",
        model: row.model,
        dimensions: row.dimensions,
        baseUrl: row.base_url,
      };

      // "local" provider always works (WASM, no external deps).
      // Ollama provider falls back to local when Ollama is not running.
      if (config.provider === "ollama" && !ollama.running) {
        console.warn("Embedding config uses Ollama but Ollama is not running — falling back to local");
        config.provider = "local";
        config.model = "Xenova/all-MiniLM-L6-v2";
        config.dimensions = 384;
      }
      useKnowledgeStore.getState().setEmbeddingConfig(config);

      // Check if vec DB dimensions match config — rebuild tables if mismatched
      try {
        const { vecGetDimensions, vecRecreate } = await import("@/kernel/vector-bridge");
        const currentDims = await vecGetDimensions();
        if (currentDims !== config.dimensions) {
          console.warn(`Vec DB dimensions (${currentDims}) != config (${config.dimensions}), rebuilding`);
          await vecRecreate(config.dimensions);
        }
      } catch {
        // Vec dimension check failure is non-fatal
      }
    }
  } catch {
    // Embedding config load failure is non-fatal
  }

  mark("11. prune episodic");
  // 11. Prune old episodic memories (fire-and-forget, 90-day TTL)
  pruneOldEpisodicEntries(90).catch(() => {});

  mark("12. init scheduler");
  // 12. Initialize scheduler (non-fatal)
  try {
    const scheduledJobs = await listScheduledJobs();
    useScheduleStore.getState().setJobs(scheduledJobs);
  } catch (e) {
    console.warn("Scheduler init failed (non-fatal):", e);
  }

  // Wire up schedule toast notifications
  eventBus.on("schedule:job_completed", (event) => {
    const { jobName } = event.payload as { jobName: string };
    useUIStore.getState().addToast({
      type: "success",
      message: `Scheduled agent "${jobName}" completed`,
    });
  });
  eventBus.on("schedule:job_failed", (event) => {
    const { jobName, error } = event.payload as { jobName: string; error: string };
    useUIStore.getState().addToast({
      type: "error",
      message: `Scheduled agent "${jobName}" failed: ${error}`,
    });
  });

  mark("13. init process manager + workflows");
  // 13. Initialize process manager + workflow engine (non-fatal)
  try {
    const { processManager } = await import("@/orchestration/process-manager");
    const { triggerManager } = await import("@/orchestration/workflow-triggers");
    const { listWorkflows, cleanWorkflowConversations, reapOrphanedRuns } = await import("@/memory/workflow-store");
    const { useWorkflowStore } = await import("@/stores/workflow-store");

    const processConfig = useSettingsStore.getState().processConfig;
    if (processConfig) processManager.setConfig(processConfig);

    // Reap orphans BEFORE the History view subscribes — otherwise a
    // user-visible "running" row will flicker for a beat before flipping
    // to failed.
    const reaped = await reapOrphanedRuns();
    if (reaped > 0) {
      console.warn(`[bootstrap] reaped ${reaped} orphaned workflow run(s)`);
    }

    const workflows = await listWorkflows();
    useWorkflowStore.getState().setWorkflows(workflows);
    await triggerManager.start(workflows);

    await cleanWorkflowConversations(30);
  } catch (e) {
    console.warn("Phase 5 bootstrap failed (non-fatal):", e);
  }

  mark("14. start observability bridges");
  // 14. Alert engine (event-bus rules) + OTel export bridge (inactive unless an
  // endpoint is configured). Both non-fatal.
  try {
    const { initAlertEngine } = await import("@/orchestration/alert-engine");
    const { initOtelBridge } = await import("@/orchestration/otel-bridge");
    await Promise.all([initAlertEngine(), initOtelBridge()]);
  } catch (e) {
    console.warn("Observability bridges init failed (non-fatal):", e);
  }

  mark("DONE");
}

const windowLabel = getCurrentWebviewWindow().label;

if (windowLabel === "background") {
  // Background window: run the agent-runtime listener only — do not mount React.
  import("@/scheduling/background-runtime").then((m) => m.start()).catch((err) => {
    console.error("[background-runtime] failed to start:", err);
  });
} else {
  // Main window: full bootstrap + React tree.
  bootstrap()
    .then(() => {
      ReactDOM.createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
          <RouterProvider router={router} />
        </React.StrictMode>,
      );
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[bootstrap] FATAL", err);
      const stack = err instanceof Error ? (err.stack ?? err.message) : String(err);
      const lastStep = (globalThis as { __BOOTSTRAP_LAST_STEP__?: string }).__BOOTSTRAP_LAST_STEP__ ?? "(none)";
      document.getElementById("root")!.innerHTML = `
        <div style="display:flex;height:100vh;align-items:center;justify-content:center;color:#f9fafb;background:#0f0f0f;font-family:sans-serif;">
          <div style="text-align:center;padding:2rem;max-width:80%">
            <h2 style="margin-bottom:1rem">Failed to start MatrixOS</h2>
            <p style="color:#fbbf24;font-size:0.875rem;margin-bottom:0.5rem">Last completed step: ${lastStep}</p>
            <pre style="color:#ef4444;font-size:0.75rem;white-space:pre-wrap;text-align:left;background:#1a1a1a;padding:1rem;border-radius:0.5rem;overflow:auto;max-height:60vh">${stack}</pre>
          </div>
        </div>`;
    });
}
