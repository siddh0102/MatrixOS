import { useNavigate } from "@tanstack/react-router";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAgentStore } from "@/stores/agent-store";
import { useAgentEditorDraftStore } from "@/stores/agent-editor-draft-store";
import { useLibraryStore } from "@/stores/library-store";
import { useUIStore } from "@/stores/ui-store";
import { saveAgentConfig } from "@/memory/agent-store-sql";
import { isoNow } from "@/lib/utils";
import type { AgentConfig } from "@/types";

interface AttachToAgentsDialogProps {
  open: boolean;
  onClose: () => void;
  skillId: string | null;
}

export function AttachToAgentsDialog({ open, onClose, skillId }: AttachToAgentsDialogProps) {
  const navigate = useNavigate();
  const configs = useAgentStore((s) => s.configs);
  const updateConfig = useAgentStore((s) => s.updateConfig);
  const patchAgentDraft = useAgentEditorDraftStore((s) => s.patchDraft);
  const importedSkills = useLibraryStore((s) => s.importedSkills);
  const addToast = useUIStore((s) => s.addToast);

  const skill = skillId ? importedSkills.find((s) => s.id === skillId) ?? null : null;

  async function handleToggle(agent: AgentConfig, attach: boolean) {
    if (!skillId || !skill) return;
    const nextSkillIds = attach
      ? [...agent.skillIds, skillId]
      : agent.skillIds.filter((id) => id !== skillId);
    const next: AgentConfig = { ...agent, skillIds: nextSkillIds, updatedAt: isoNow() };
    try {
      await saveAgentConfig(next);
      updateConfig(agent.id, { skillIds: nextSkillIds, updatedAt: next.updatedAt });
      patchAgentDraft(`edit:${agent.id}`, { selectedSkillIds: nextSkillIds });
      addToast({
        type: "info",
        message: `${attach ? "Attached" : "Detached"} "${skill.name}" ${attach ? "to" : "from"} "${agent.name}"`,
        duration: 2500,
      });
    } catch (err) {
      addToast({
        type: "error",
        message: `Failed to ${attach ? "attach" : "detach"} skill: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={skill ? `Attach "${skill.name}" to agents` : "Attach to agents"}
    >
      <div className="flex flex-col gap-4">
        {configs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-6 text-center">
            <p className="text-sm text-muted-foreground">No agents yet — create one first.</p>
            <Button
              onClick={() => {
                onClose();
                navigate({ to: "/agents/new", search: {} });
              }}
            >
              Create Agent
            </Button>
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto rounded-lg border border-border divide-y divide-border">
            {configs.map((agent) => {
              const checked = agent.skillIds.includes(skillId ?? "");
              return (
                <label
                  key={agent.id}
                  className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-muted/30"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => handleToggle(agent, e.target.checked)}
                    className="mt-0.5 h-4 w-4 cursor-pointer"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{agent.name}</div>
                    {agent.description && (
                      <div className="truncate text-xs text-muted-foreground">
                        {agent.description}
                      </div>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
