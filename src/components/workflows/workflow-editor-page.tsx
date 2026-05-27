import { useState, useCallback, useRef, useMemo, useEffect } from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
  type NodeTypes,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import dagre from "@dagrejs/dagre";
import { nanoid } from "nanoid";
import { useWorkflowStore } from "@/stores/workflow-store";
import { useWorkflow } from "@/hooks/use-workflow";
import { useWorkflowHistory, type HistoryEntry } from "./use-workflow-history";
import { StepInspector } from "./step-inspector";
import { TriggerConfigPanel } from "./trigger-config-panel";
import { VariablesPanel } from "./variables-panel";
import { Button } from "@/components/ui/button";
import { AgentTaskNode } from "./nodes/agent-task-node";
import { ConditionNode } from "./nodes/condition-node";
import { ParallelNode } from "./nodes/parallel-node";
import { HumanInputNode } from "./nodes/human-input-node";
import { TransformNode } from "./nodes/transform-node";
import { ToolCallNode } from "./nodes/tool-call-node";
import { SubWorkflowNode } from "./nodes/sub-workflow-node";
import { DelegatedAgentNode } from "./nodes/delegated-agent-node";
import { listAgentConfigs } from "@/memory/agent-store-sql";
import type { WorkflowStep, WorkflowEdge as WfEdge, StepType, StepConfig, WorkflowTrigger, WorkflowVariable, AgentTaskConfig } from "@/types";

const NODE_TYPES: NodeTypes = {
  agent_task: AgentTaskNode,
  condition: ConditionNode,
  parallel: ParallelNode,
  human_input: HumanInputNode,
  transform: TransformNode,
  tool_call: ToolCallNode,
  sub_workflow: SubWorkflowNode,
  delegated_agent: DelegatedAgentNode,
};

/** Minimal agent shape the editor needs to draw the delegation fan-out. */
interface AgentMeta {
  name: string;
  delegationEnabled: boolean;
  allowedAgentIds: string[];
}

/**
 * Build read-only ghost nodes + edges for the agents an `agent_task` step
 * reaches via delegation. These are NOT workflow steps — they're a visual
 * overlay so the graph shows every agent that participates in a run (e.g. an
 * orchestrator and the sub-agents it delegates to). They are excluded from
 * the editable step/edge state, so they are never saved, dragged, or deleted.
 */
function delegationOverlay(
  steps: WorkflowStep[],
  agents: Map<string, AgentMeta>,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const step of steps) {
    if (step.config.type !== "agent_task") continue;
    const agentId = (step.config as AgentTaskConfig).agentId;
    const meta = agentId ? agents.get(agentId) : undefined;
    if (!meta?.delegationEnabled || meta.allowedAgentIds.length === 0) continue;

    meta.allowedAgentIds.forEach((subId, i) => {
      const sub = agents.get(subId);
      const ghostId = `ghost:${step.id}:${subId}`;
      nodes.push({
        id: ghostId,
        type: "delegated_agent",
        position: { x: step.position.x + 300, y: step.position.y + i * 90 },
        data: { name: sub?.name ?? subId, delegatedBy: step.id },
        draggable: false,
        selectable: false,
        deletable: false,
      });
      edges.push({
        id: `ghostedge:${step.id}:${subId}`,
        source: step.id,
        target: ghostId,
        label: "delegates",
        animated: false,
        selectable: false,
        deletable: false,
        style: { strokeWidth: 1.5, strokeDasharray: "5 5", stroke: "#a855f7" },
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: "#a855f7" },
      });
    });
  }
  return { nodes, edges };
}

const STEP_PALETTE: Array<{ type: StepType; label: string }> = [
  { type: "agent_task", label: "Agent Task" },
  { type: "condition", label: "Condition" },
  { type: "parallel", label: "Parallel" },
  { type: "human_input", label: "Human Input" },
  { type: "transform", label: "Transform" },
  { type: "tool_call", label: "Tool Call" },
  { type: "sub_workflow", label: "Sub-Workflow" },
];

function defaultConfigForType(type: StepType): StepConfig {
  switch (type) {
    case "agent_task": return { type: "agent_task", agentId: "", prompt: "" };
    case "condition": return { type: "condition", expression: "", ifTrueStepId: "", ifFalseStepId: "" };
    case "parallel": return { type: "parallel", branchStepIds: [], waitPolicy: "all" };
    case "human_input": return { type: "human_input", prompt: "", inputType: "text" };
    case "transform": return { type: "transform", expression: "", outputVariable: "" };
    case "tool_call": return { type: "tool_call", toolName: "", serverId: "", arguments: {} };
    case "sub_workflow": return { type: "sub_workflow", workflowId: "", inputMapping: {}, outputMapping: {} };
  }
}

function stepsToNodes(steps: WorkflowStep[], selectedId: string | null): Node[] {
  return steps.map((step) => ({
    id: step.id,
    type: step.type,
    position: step.position,
    data: { step, isSelected: step.id === selectedId },
  }));
}

function edgesToFlow(edges: WfEdge[]): Edge[] {
  return edges.map((e) => ({
    id: e.id,
    source: e.sourceStepId,
    target: e.targetStepId,
    label: e.label,
    animated: true,
    style: { strokeWidth: 2 },
    markerEnd: { type: MarkerType.ArrowClosed, width: 20, height: 20 },
  }));
}

function autoLayout(steps: WorkflowStep[], edges: WfEdge[]): WorkflowStep[] {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 100 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const step of steps) {
    g.setNode(step.id, { width: 200, height: 60 });
  }
  for (const edge of edges) {
    g.setEdge(edge.sourceStepId, edge.targetStepId);
  }

  dagre.layout(g);

  return steps.map((step) => {
    const node = g.node(step.id);
    return { ...step, position: { x: node.x - 100, y: node.y - 30 } };
  });
}

type Panel = "triggers" | "variables" | null;

export function WorkflowEditorPage() {
  const { id } = useParams({ from: "/workflows/$id" });
  const navigate = useNavigate();
  const { updateWorkflow, publishWorkflow, runWorkflow } = useWorkflow();
  const workflow = useWorkflowStore((s) => s.workflows.find((w) => w.id === id));

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<Panel>(null);
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const rfInstanceRef = useRef<ReactFlowInstance | null>(null);

  const initial: HistoryEntry = useMemo(() => ({
    steps: workflow?.steps ?? [],
    edges: workflow?.edges ?? [],
    variables: workflow?.variables ?? [],
    triggers: workflow?.triggers ?? [],
  }), []);

  const { current, canUndo, canRedo, push, undo, redo } = useWorkflowHistory(initial);

  const [nodes, setNodes, onNodesChange] = useNodesState(stepsToNodes(current.steps, selectedNodeId));
  const [edges, setEdges, onEdgesChange] = useEdgesState(edgesToFlow(current.edges));

  // Agent metadata (id → name + delegation), loaded once, for the
  // delegation fan-out overlay.
  const [agentMeta, setAgentMeta] = useState<Map<string, AgentMeta>>(new Map());
  useEffect(() => {
    let cancelled = false;
    listAgentConfigs()
      .then((configs) => {
        if (cancelled) return;
        const m = new Map<string, AgentMeta>();
        for (const c of configs) {
          m.set(c.id, {
            name: c.name,
            delegationEnabled: !!c.delegationConfig?.enabled,
            allowedAgentIds: c.delegationConfig?.allowedAgentIds ?? [],
          });
        }
        setAgentMeta(m);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Merge the editable step nodes/edges with the read-only delegation
  // overlay. The overlay is derived (not stored in history/state hooks), so
  // it never leaks into save/drag/delete.
  const overlay = useMemo(
    () => delegationOverlay(current.steps, agentMeta),
    [current.steps, agentMeta],
  );
  const flowNodes = useMemo(() => [...nodes, ...overlay.nodes], [nodes, overlay.nodes]);
  const flowEdges = useMemo(() => [...edges, ...overlay.edges], [edges, overlay.edges]);

  function commitChange(newSteps: WorkflowStep[], newEdges: WfEdge[], newVars?: WorkflowVariable[], newTriggers?: WorkflowTrigger[]) {
    const entry: HistoryEntry = {
      steps: newSteps,
      edges: newEdges,
      variables: newVars ?? current.variables,
      triggers: newTriggers ?? current.triggers,
    };
    push(entry);
    setNodes(stepsToNodes(newSteps, selectedNodeId));
    setEdges(edgesToFlow(newEdges));
  }

  const onConnect = useCallback((connection: Connection) => {
    const newEdge: WfEdge = {
      id: nanoid(),
      sourceStepId: connection.source!,
      targetStepId: connection.target!,
    };
    commitChange(current.steps, [...current.edges, newEdge]);
  }, [current]);

  function handleNodeDragStop(_event: any, node: Node) {
    const newSteps = current.steps.map((s) =>
      s.id === node.id ? { ...s, position: node.position } : s
    );
    commitChange(newSteps, current.edges);
  }

  function handleAddStep(type: StepType) {
    const step: WorkflowStep = {
      id: nanoid(),
      type,
      name: type.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      config: defaultConfigForType(type),
      position: { x: 250, y: (current.steps.length + 1) * 120 },
    };
    commitChange([...current.steps, step], current.edges);
    // Wait one tick so React Flow renders the new node, then center on it.
    setTimeout(() => {
      const instance = rfInstanceRef.current;
      if (!instance) return;
      instance.setCenter(
        step.position.x + 100, // node width ~200
        step.position.y + 30,  // node height ~60
        { zoom: instance.getZoom(), duration: 400 },
      );
    }, 50);
  }

  function handleDeleteNode() {
    if (!selectedNodeId) return;
    const newSteps = current.steps.filter((s) => s.id !== selectedNodeId);
    const newEdges = current.edges.filter((e) => e.sourceStepId !== selectedNodeId && e.targetStepId !== selectedNodeId);
    setSelectedNodeId(null);
    commitChange(newSteps, newEdges);
  }

  function handleStepChange(stepId: string, updates: Partial<WorkflowStep>) {
    const newSteps = current.steps.map((s) =>
      s.id === stepId ? { ...s, ...updates } : s
    );
    commitChange(newSteps, current.edges);
  }

  function handleAutoLayout() {
    const laid = autoLayout(current.steps, current.edges);
    commitChange(laid, current.edges);
  }

  function handleUndo() {
    undo();
    // We need to get the new state after undo. Since state updates are async,
    // use a timeout to sync. In practice the hook's `current` will update on re-render.
  }

  function handleRedo() {
    redo();
  }

  async function handleSave() {
    if (!workflow) return;
    await updateWorkflow({
      ...workflow,
      steps: current.steps,
      edges: current.edges,
      variables: current.variables,
      triggers: current.triggers,
    });
  }

  async function handlePublish() {
    if (!workflow) return;
    await publishWorkflow({
      ...workflow,
      steps: current.steps,
      edges: current.edges,
      variables: current.variables,
      triggers: current.triggers,
    });
  }

  async function handleRun() {
    if (!workflow) return;
    await handleSave();
    // Fire-and-forget. Jump to history on onStarted so the user can
    // watch live step progress instead of being stranded in the editor.
    runWorkflow(workflow.id, undefined, (run) => {
      navigate({
        to: "/workflows/$id/history",
        params: { id: workflow.id },
        search: { runId: run.id },
      });
    }).catch(() => {
      // Surfaced in the trace view.
    });
  }

  if (!workflow) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Workflow not found</p>
      </div>
    );
  }

  const selectedStep = current.steps.find((s) => s.id === selectedNodeId) ?? null;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate({ to: "/workflows" })}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            &larr; Back
          </button>
          <h1 className="text-sm font-semibold">{workflow.name}</h1>
          <span className="text-xs text-muted-foreground">v{workflow.version}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={handleUndo} disabled={!canUndo}>Undo</Button>
          <Button variant="ghost" size="sm" onClick={handleRedo} disabled={!canRedo}>Redo</Button>
          <Button variant="ghost" size="sm" onClick={handleAutoLayout}>Auto Layout</Button>
          <Button variant="ghost" size="sm" onClick={() => setActivePanel(activePanel === "triggers" ? null : "triggers")}>Triggers</Button>
          <Button variant="ghost" size="sm" onClick={() => setActivePanel(activePanel === "variables" ? null : "variables")}>Variables</Button>
          <Button variant="ghost" size="sm" onClick={handleSave}>Save</Button>
          <Button variant="ghost" size="sm" onClick={handlePublish}>Publish</Button>
          <Button size="sm" onClick={handleRun}>Run</Button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-44 border-r border-border p-3 overflow-auto">
          <h3 className="mb-2 text-xs font-medium text-muted-foreground uppercase text-center">Steps</h3>
          <div className="flex flex-col gap-1.5">
            {STEP_PALETTE.map((item) => (
              <button
                key={item.type}
                onClick={() => handleAddStep(item.type)}
                className="rounded-lg border border-border px-3 py-2 text-xs text-left hover:bg-accent transition-colors text-center"
              >
                {item.label}
              </button>
            ))}
          </div>
          {selectedNodeId && (
            <button
              onClick={handleDeleteNode}
              className="mt-4 w-full rounded-lg border border-destructive px-3 py-2 text-xs text-destructive hover:bg-destructive/10 transition-colors text-center"
            >
              Delete Selected
            </button>
          )}
        </div>

        <div className="flex-1 relative" ref={reactFlowWrapper}>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => {
              // Ghost (delegation overlay) nodes aren't steps — not selectable.
              if (node.id.startsWith("ghost:")) return;
              setSelectedNodeId(node.id);
            }}
            onNodeDragStop={handleNodeDragStop}
            onPaneClick={() => setSelectedNodeId(null)}
            onInit={(instance) => { rfInstanceRef.current = instance; }}
            nodeTypes={NODE_TYPES}
            fitView
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </div>

        {activePanel === "triggers" && (
          <div className="w-72 border-l border-border overflow-auto">
            <TriggerConfigPanel
              triggers={current.triggers}
              onChange={(triggers) => commitChange(current.steps, current.edges, current.variables, triggers)}
            />
          </div>
        )}
        {activePanel === "variables" && (
          <div className="w-72 border-l border-border overflow-auto">
            <VariablesPanel
              variables={current.variables}
              onChange={(variables) => commitChange(current.steps, current.edges, variables, current.triggers)}
            />
          </div>
        )}
      </div>

      <div className="border-t border-border">
        <StepInspector step={selectedStep} onChange={handleStepChange} />
      </div>
    </div>
  );
}
