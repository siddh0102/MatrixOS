import type { BuiltInToolHandler, Tool } from "@/types";

interface ShellRunResult {
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  duration_ms: number;
  timed_out: boolean;
}

export const RUN_SHELL_DEFINITION: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "run_shell",
  description:
    "Execute an allowlisted local command in a specified working directory. " +
    "Allowlist: python, python3, py, pip, pip3, pytest, node, npm, npx, git, ls, cat, mkdir, mv, rm, cp, find, rg. " +
    "No shell interpretation: arguments are passed as a list to the OS, so metacharacters like ';', '&&', backticks, pipes, redirects have no effect. " +
    "On Windows, the POSIX file commands (ls/cat/mv/rm/cp/find) require Git-for-Windows usr/bin or equivalent on PATH. " +
    "Returns stdout, stderr, exit_code, and timing. Output is capped at 64KB per stream; commands are killed after `timeoutMs` (default 60s, max 300s).",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "Bare executable name. Must be one of: python, python3, py, pip, pip3, pytest, node, npm, npx, git, ls, cat, mkdir, mv, rm, cp, find, rg.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "List of arguments. Pass each token as a separate string; do NOT combine with spaces.",
      },
      cwd: {
        type: "string",
        description: "Absolute path to the working directory. Must exist and be a directory.",
      },
      timeoutMs: {
        type: "number",
        description: "Optional timeout in milliseconds. Defaults to 60000 (60s); clamped to 300000 (5 min).",
      },
      stdin: {
        type: "string",
        description: "Optional string to pipe to the process's stdin.",
      },
    },
    required: ["command", "args", "cwd"],
  },
  tags: ["built-in", "shell", "exec"],
};

export const runShellHandler: BuiltInToolHandler = async (args) => {
  const command = args["command"];
  const argsList = args["args"];
  const cwd = args["cwd"];
  const timeoutMs = args["timeoutMs"];
  const stdin = args["stdin"];

  if (typeof command !== "string" || !command) {
    throw new Error("Missing required argument: command (string)");
  }
  if (!Array.isArray(argsList) || !argsList.every((a) => typeof a === "string")) {
    throw new Error("Missing or invalid argument: args (string[])");
  }
  if (typeof cwd !== "string" || !cwd) {
    throw new Error("Missing required argument: cwd (string)");
  }
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
    throw new Error("Invalid argument: timeoutMs (number, optional)");
  }
  if (stdin !== undefined && typeof stdin !== "string") {
    throw new Error("Invalid argument: stdin (string, optional)");
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<ShellRunResult>("shell_run", {
    args: { command, args: argsList, cwd, timeoutMs, stdin },
  });
  // Return a compact, model-friendly string. The model rarely needs the full
  // ShellResult struct — exit code, truncated flags, and the two streams are
  // what matters for verification.
  const header =
    result.timed_out
      ? `[TIMEOUT after ${result.duration_ms}ms]`
      : `[exit=${result.exit_code ?? "killed"} duration=${result.duration_ms}ms]`;
  const lines = [header];
  if (result.stdout) {
    lines.push("--- stdout" + (result.stdout_truncated ? " (truncated)" : "") + " ---");
    lines.push(result.stdout);
  }
  if (result.stderr) {
    lines.push("--- stderr" + (result.stderr_truncated ? " (truncated)" : "") + " ---");
    lines.push(result.stderr);
  }
  return lines.join("\n");
};
