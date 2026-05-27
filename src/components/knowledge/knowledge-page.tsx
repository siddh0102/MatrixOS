import { useState } from "react";
import { useKnowledgeStore } from "@/stores/knowledge-store";
import { Tabs } from "@/components/ui/tabs";
import { EpisodicTab } from "./episodic-tab";
import { SemanticTab } from "./semantic-tab";
import { ProceduralTab } from "./procedural-tab";
import { KnowledgeBasesTab } from "./knowledge-bases-tab";

const KNOWLEDGE_TABS = [
  { id: "episodic", label: "Past Conversations" },
  { id: "semantic", label: "Documents" },
  { id: "procedural", label: "Templates" },
  { id: "bases", label: "Knowledge Bases" },
];

type KnowledgeTabId = "episodic" | "semantic" | "procedural" | "bases";

export function KnowledgePage() {
  const activeTab = useKnowledgeStore((s) => s.activeTab);
  const setActiveTab = useKnowledgeStore((s) => s.setActiveTab);
  const [localTab, setLocalTab] = useState<KnowledgeTabId>(activeTab as KnowledgeTabId);

  function handleTabChange(id: string) {
    if (id === "bases") {
      setLocalTab("bases");
    } else {
      setLocalTab(id as KnowledgeTabId);
      setActiveTab(id as "episodic" | "semantic" | "procedural");
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-auto p-6">
      <h1 className="mb-6 text-xl font-semibold">Knowledge Base</h1>

      <Tabs
        tabs={KNOWLEDGE_TABS}
        activeTab={localTab}
        onTabChange={handleTabChange}
        className="flex-1"
      >
        {localTab === "episodic" && <EpisodicTab />}
        {localTab === "semantic" && <SemanticTab />}
        {localTab === "procedural" && <ProceduralTab />}
        {localTab === "bases" && <KnowledgeBasesTab />}
      </Tabs>
    </div>
  );
}
