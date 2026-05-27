import type { BuiltInToolHandler, Tool } from "@/types";

/**
 * Structured artifact handoff. Sub-agents call this AFTER write_file instead
 * of ending their reply with a fragile text anchor ("CODE WRITTEN: <path>").
 * The delegating caller captures the tool-call args, so the path comes from
 * typed arguments — it can't be lost to truncation, a missing anchor line, or
 * an empty completion the way a trailing prose line could.
 */
export const REPORT_ARTIFACT_DEFINITION: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "report_artifact",
  description:
    "Hand off a file you produced to the orchestrator. Call this AFTER write_file " +
    "succeeds — do NOT rely on a text anchor line. Provide the absolute path, the " +
    "artifact kind, and a status. The orchestrator reads the path from this " +
    "structured call, so a missing/truncated prose line can no longer lose your output.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the file you just wrote." },
      kind: {
        type: "string",
        enum: ["spec", "code", "report"],
        description: "Which pipeline artifact this is.",
      },
      status: {
        type: "string",
        enum: ["ok", "needs_fixes", "failed"],
        description: "Outcome of your work. Defaults to 'ok'.",
      },
      summary: { type: "string", description: "Optional one-line summary for the orchestrator." },
    },
    required: ["path", "kind"],
  },
  tags: ["built-in", "handoff"],
};

export const reportArtifactHandler: BuiltInToolHandler = async (args) => {
  const path = typeof args.path === "string" ? args.path.trim() : "";
  const kind = typeof args.kind === "string" ? args.kind : "";
  const status = typeof args.status === "string" ? args.status : "ok";
  if (!path) {
    return { reported: false, error: "path is required and must be a non-empty absolute path" };
  }
  if (!["spec", "code", "report"].includes(kind)) {
    return { reported: false, error: "kind must be one of: spec | code | report" };
  }
  return {
    reported: true,
    path,
    kind,
    status,
    summary: typeof args.summary === "string" ? args.summary : null,
  };
};
