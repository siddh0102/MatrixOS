export function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "untitled";
}

function yamlScalar(value: string | number | boolean): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === "" || /[:#{}\[\]&*!|>'"%@`,\n]|^\s|\s$|^[-?]\s/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function yamlValue(value: unknown, indent: number): string {
  const pad = " ".repeat(indent);
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return yamlScalar(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return "\n" + value
      .map((item) => {
        if (item !== null && typeof item === "object" && !Array.isArray(item)) {
          const inner = yamlObject(item as Record<string, unknown>, indent + 2);
          return `${pad}-\n${inner}`;
        }
        return `${pad}- ${yamlValue(item, indent + 2)}`;
      })
      .join("\n");
  }
  if (typeof value === "object") {
    return "\n" + yamlObject(value as Record<string, unknown>, indent + 2);
  }
  return JSON.stringify(value);
}

function yamlObject(obj: Record<string, unknown>, indent: number): string {
  const pad = " ".repeat(indent);
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    const rendered = yamlValue(value, indent);
    if (rendered.startsWith("\n")) {
      lines.push(`${pad}${key}:${rendered}`);
    } else {
      lines.push(`${pad}${key}: ${rendered}`);
    }
  }
  return lines.join("\n");
}

export function toFrontmatter(record: Record<string, unknown>): string {
  const body = yamlObject(record, 0);
  return `---\n${body}\n---\n`;
}
