// The library module is intentionally code-only. Bundled agent templates
// and skills live in `src-tauri/resources/library/*.json` and are loaded
// at runtime via `loader.ts`. The catalog data is owned by the DB once
// seeded (`agent_templates` and `skills` tables).
export { loadBundledAgentTemplates, loadBundledSkills } from "./loader";
