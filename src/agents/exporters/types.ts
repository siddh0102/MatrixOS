export type ExportTarget = "claude" | "copilot" | "both";

export interface ExportPlanFile {
  relPath: string;
  contents: string;
}

export interface ExportPlan {
  files: ExportPlanFile[];
  warnings: string[];
}
