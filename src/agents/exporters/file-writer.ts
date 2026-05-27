import type { ExportPlan } from "./types";

export async function applyExportPlan(rootDir: string, plan: ExportPlan): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");

  const sep = rootDir.includes("\\") && !rootDir.includes("/") ? "\\" : "/";
  const trimmedRoot = rootDir.replace(/[\\/]+$/, "");

  // eslint-disable-next-line no-console
  console.log(`[export-plan] applying ${plan.files.length} files under ${rootDir}`);

  let i = 0;
  for (const file of plan.files) {
    i++;
    const relNormalized = file.relPath.replace(/^[\\/]+/, "").replace(/\\/g, "/");
    const absPath = sep === "\\"
      ? `${trimmedRoot}\\${relNormalized.replace(/\//g, "\\")}`
      : `${trimmedRoot}/${relNormalized}`;
    try {
      await invoke("fs_write", { ctx: { type: "User" }, path: absPath, contents: file.contents });
      // eslint-disable-next-line no-console
      console.log(`[export-plan] (${i}/${plan.files.length}) wrote ${absPath} (${file.contents.length} bytes)`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[export-plan] (${i}/${plan.files.length}) FAILED ${absPath}:`, err);
      throw err;
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[export-plan] complete: ${plan.files.length} files written`);
}
