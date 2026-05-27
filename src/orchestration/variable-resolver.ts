export function resolveTemplate(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, path: string) => {
    const value = resolvePath(path.trim(), variables);
    if (value === undefined || value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function resolvePath(path: string, context: Record<string, unknown>): unknown {
  const parts = path.split(".");
  let current: unknown = context;

  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
