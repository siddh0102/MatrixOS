import { invoke } from "@tauri-apps/api/core";
import type { LibraryAgentTemplate, SkillTemplate } from "@/types";

async function loadJsonResource<T>(relativePath: string): Promise<T> {
  const raw = await invoke<string>("load_bundled_resource", { name: relativePath });
  return JSON.parse(raw) as T;
}

export function loadBundledAgentTemplates(): Promise<LibraryAgentTemplate[]> {
  return loadJsonResource<LibraryAgentTemplate[]>("resources/library/agent-templates.json");
}

export function loadBundledSkills(): Promise<SkillTemplate[]> {
  return loadJsonResource<SkillTemplate[]>("resources/library/skills.json");
}
