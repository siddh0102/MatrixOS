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

interface Diagnostic {
  file: string;
  line: number;
  column: number | null;
  code: string | null;
  severity: "error" | "warning" | "info";
  message: string;
}

type DiagnosticKind =
  | "typescript"
  | "python-typecheck"
  | "python-lint"
  | "eslint";

export const GET_DIAGNOSTICS_DEFINITION: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "get_diagnostics",
  description:
    "Run a project's typecheck or lint and return parsed diagnostics. " +
    "Supported kinds:\n" +
    "  • `typescript`        — runs `npx tsc --noEmit` (needs tsconfig.json in cwd).\n" +
    "  • `python-typecheck`  — runs `python -m mypy .` (mypy must be installed).\n" +
    "  • `python-lint`       — runs `python -m ruff check .` (ruff must be installed).\n" +
    "  • `eslint`            — runs `npx eslint .`.\n" +
    "Returns a parsed `[{file, line, column, code, severity, message}]` list plus an excerpt of raw output for diagnostics the parser couldn't extract.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["typescript", "python-typecheck", "python-lint", "eslint"],
        description: "Which diagnostic tool to run.",
      },
      cwd: {
        type: "string",
        description:
          "Absolute path to the project root (where tsconfig.json / pyproject.toml / etc. live).",
      },
      timeout_ms: {
        type: "number",
        description: "Per-command timeout. Default 120000 (2 min), max 300000 (5 min).",
      },
    },
    required: ["kind", "cwd"],
  },
  tags: ["built-in", "diagnostics"],
};

export const getDiagnosticsHandler: BuiltInToolHandler = async (args) => {
  const kind = args["kind"] as DiagnosticKind | undefined;
  const cwd = args["cwd"];
  const timeoutMs = args["timeout_ms"];

  if (!kind || !["typescript", "python-typecheck", "python-lint", "eslint"].includes(kind)) {
    throw new Error(
      "Missing or invalid argument: kind (one of typescript, python-typecheck, python-lint, eslint)",
    );
  }
  if (typeof cwd !== "string" || !cwd) {
    throw new Error("Missing required argument: cwd (string)");
  }
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
    throw new Error("Invalid argument: timeout_ms (number, optional)");
  }
  const effectiveTimeout = Math.min(
    typeof timeoutMs === "number" ? timeoutMs : 120_000,
    300_000,
  );

  const { command, cmdArgs } = commandFor(kind);

  const { invoke } = await import("@tauri-apps/api/core");
  const result = await invoke<ShellRunResult>("shell_run", {
    args: {
      command,
      args: cmdArgs,
      cwd,
      timeoutMs: effectiveTimeout,
    },
  });

  if (result.timed_out) {
    return `[get_diagnostics ${kind}] TIMEOUT after ${result.duration_ms}ms. No diagnostics collected.`;
  }

  // Some tools write to stdout, some to stderr. Concat both and parse.
  const combined = `${result.stdout}\n${result.stderr}`;
  const diagnostics = parseDiagnostics(kind, combined);

  const status = `[get_diagnostics ${kind}] exit=${result.exit_code ?? "killed"} duration=${result.duration_ms}ms found=${diagnostics.length}`;
  if (diagnostics.length === 0) {
    // Include the raw output excerpt so the agent can see what actually
    // happened (e.g. "mypy: command not found").
    return (
      status +
      "\n--- raw output (head) ---\n" +
      combined.slice(0, 2000).trimEnd()
    );
  }
  const body = diagnostics
    .map((d) => formatDiagnostic(d))
    .join("\n");
  return status + "\n" + body;
};

function commandFor(kind: DiagnosticKind): {
  command: string;
  cmdArgs: string[];
} {
  switch (kind) {
    case "typescript":
      return { command: "npx", cmdArgs: ["tsc", "--noEmit", "--pretty", "false"] };
    case "python-typecheck":
      return {
        command: "python",
        cmdArgs: ["-m", "mypy", "--no-color-output", "--no-error-summary", "."],
      };
    case "python-lint":
      return {
        command: "python",
        cmdArgs: ["-m", "ruff", "check", "--no-cache", "--output-format=concise", "."],
      };
    case "eslint":
      return {
        command: "npx",
        cmdArgs: ["eslint", ".", "--format=unix"],
      };
  }
}

function parseDiagnostics(kind: DiagnosticKind, output: string): Diagnostic[] {
  switch (kind) {
    case "typescript":
      return parseTsc(output);
    case "python-typecheck":
      return parseMypy(output);
    case "python-lint":
      return parseRuff(output);
    case "eslint":
      return parseEslintUnix(output);
  }
}

// tsc --pretty false:  path/to/file.ts(10,5): error TS2322: Type 'string' is ...
const TSC_RE =
  /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+):\s+(.+)$/;
function parseTsc(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = TSC_RE.exec(line);
    if (!m) continue;
    out.push({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: m[4] as Diagnostic["severity"],
      code: m[5],
      message: m[6].trim(),
    });
  }
  return out;
}

// mypy:                  path/to/file.py:10: error: message  [code]
const MYPY_RE =
  /^(.+?):(\d+):(?:(\d+):)?\s+(error|warning|note):\s+(.+?)(?:\s+\[([\w-]+)\])?$/;
function parseMypy(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = MYPY_RE.exec(line);
    if (!m) continue;
    const sev: Diagnostic["severity"] =
      m[4] === "error" ? "error" : m[4] === "warning" ? "warning" : "info";
    out.push({
      file: m[1],
      line: Number(m[2]),
      column: m[3] ? Number(m[3]) : null,
      severity: sev,
      code: m[6] ?? null,
      message: m[5].trim(),
    });
  }
  return out;
}

// ruff --output-format=concise:  path/to/file.py:10:5: F401 [*] message
const RUFF_RE = /^(.+?):(\d+):(\d+):\s+([A-Z]+\d+)\s+(.+)$/;
function parseRuff(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = RUFF_RE.exec(line);
    if (!m) continue;
    out.push({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: "warning",
      code: m[4],
      message: m[5].trim(),
    });
  }
  return out;
}

// eslint --format=unix:   path/to/file:10:5: message [rule] [Error]
const ESLINT_RE =
  /^(.+?):(\d+):(\d+):\s+(.+?)(?:\s+\[([\w/-]+)\])?(?:\s+\[(Error|Warning)\])?$/;
function parseEslintUnix(output: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = ESLINT_RE.exec(line);
    if (!m) continue;
    const sev: Diagnostic["severity"] =
      (m[6] ?? "Error").toLowerCase() === "warning" ? "warning" : "error";
    out.push({
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
      severity: sev,
      code: m[5] ?? null,
      message: m[4].trim(),
    });
  }
  return out;
}

function formatDiagnostic(d: Diagnostic): string {
  const loc =
    d.column != null ? `${d.file}:${d.line}:${d.column}` : `${d.file}:${d.line}`;
  const code = d.code ? ` [${d.code}]` : "";
  return `${loc}  ${d.severity}${code}  ${d.message}`;
}
