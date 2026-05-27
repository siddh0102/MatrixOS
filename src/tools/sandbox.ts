import { ToolError } from "@/lib/errors";

export function validatePath(
  requestedPath: string,
  allowedPaths: string[],
): void {
  const normalized = normalizePath(requestedPath);

  const segments = normalized.split("/");
  if (segments.some((s) => s === "..")) {
    throw new ToolError(
      `Path traversal blocked: ${requestedPath}`,
      "PERMISSION_DENIED",
      false,
    );
  }

  const allowed = allowedPaths.some((dir) => {
    const normalizedDir = normalizePath(dir);
    return normalized.startsWith(normalizedDir + "/") || normalized === normalizedDir;
  });

  if (!allowed) {
    throw new ToolError(
      `Sandbox: access denied. "${requestedPath}" is outside the allowed directories.`,
      "PERMISSION_DENIED",
      false,
    );
  }
}

function normalizePath(p: string): string {
  let result = p.replace(/\\/g, "/");
  result = result.replace(/\/+/g, "/");
  result = result.replace(/\/$/, "");
  if (typeof navigator !== "undefined" && navigator.platform?.startsWith("Win")) {
    result = result.toLowerCase();
  }
  return result;
}
