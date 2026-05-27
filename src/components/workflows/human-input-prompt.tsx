import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { eventBus } from "@/orchestration/event-bus";
import { workflowExecutor } from "@/orchestration/workflow-executor";

interface PendingRequest {
  runId: string;
  stepId: string;
  requestId: string;
  prompt: string;
  inputType: "text" | "choice" | "confirm";
  choices?: string[];
}

// Trim whitespace and strip a single layer of surrounding quotes.
// Handles the common "Copy as Path" paste pattern on Windows
// (`"C:\Users\siddh\..."`) and shell-style single-quoted paths.
function normalizeTextInput(raw: string): string {
  let v = raw.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      v = v.slice(1, -1).trim();
    }
  }
  return v;
}

// Heuristic: does this prompt look like it wants a filesystem path?
// Used to decide whether to render a "Browse…" button. Conservative —
// only triggers on explicit path-vocabulary so non-path text prompts
// stay untouched.
function looksLikePathPrompt(prompt: string): boolean {
  return /\b(path|file|directory|folder|filename|filepath)\b/i.test(prompt);
}

function looksLikeDirectoryPrompt(prompt: string): boolean {
  return /\b(directory|folder)\b/i.test(prompt);
}

/**
 * Global listener for workflow human-input requests. Subscribes once at
 * app mount, queues incoming requests, and presents a modal for the
 * head-of-queue. Without this component, any workflow containing a
 * `human_input` step will hang forever because the executor's
 * `waitForHumanInput` promise never resolves.
 */
export function HumanInputPrompt() {
  const [queue, setQueue] = useState<PendingRequest[]>([]);
  const [textValue, setTextValue] = useState("");
  const [choiceValue, setChoiceValue] = useState("");

  useEffect(() => {
    const sub = eventBus.on<PendingRequest>(
      "workflow:human_input_required",
      (event) => {
        setQueue((q) => [...q, event.payload]);
      },
    );
    return () => sub.unsubscribe();
  }, []);

  const current = queue[0] ?? null;
  const isPathPrompt = current ? looksLikePathPrompt(current.prompt) : false;
  const isDirectoryPrompt = current
    ? looksLikeDirectoryPrompt(current.prompt)
    : false;

  // When the head-of-queue changes, reset the input controls.
  useEffect(() => {
    if (!current) return;
    setTextValue("");
    setChoiceValue(current.choices?.[0] ?? "");
  }, [current?.requestId]);

  function submit(value: unknown) {
    if (!current) return;
    const normalized =
      typeof value === "string" ? normalizeTextInput(value) : value;
    workflowExecutor.provideHumanInput(current.runId, current.stepId, normalized);
    setQueue((q) => q.slice(1));
  }

  function cancel() {
    if (!current) return;
    // Cancel the whole run — there's no way to "skip" a human-input step.
    workflowExecutor.cancel(current.runId);
    setQueue((q) => q.slice(1));
  }

  async function browse() {
    if (!current) return;
    const { open } = await import("@tauri-apps/plugin-dialog");
    const chosen = await open({
      directory: isDirectoryPrompt,
      multiple: false,
      title: "Select " + (isDirectoryPrompt ? "directory" : "file"),
    });
    if (typeof chosen === "string" && chosen.length > 0) {
      setTextValue(chosen);
    }
  }

  if (!current) return null;

  return (
    <Dialog open onClose={cancel} title="Workflow needs input">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-foreground whitespace-pre-wrap">
          {current.prompt}
        </p>

        {current.inputType === "text" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <input
                type="text"
                autoFocus
                value={textValue}
                onChange={(e) => setTextValue(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    normalizeTextInput(textValue).length > 0
                  ) {
                    submit(textValue);
                  }
                }}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                placeholder={
                  isPathPrompt
                    ? "Paste a path or click Browse…"
                    : "Type your answer..."
                }
              />
              {isPathPrompt && (
                <Button variant="ghost" size="sm" onClick={browse}>
                  Browse…
                </Button>
              )}
            </div>
            {isPathPrompt && textValue.length > 0 && (
              <p className="text-xs text-muted-foreground break-all">
                Will submit as: <code>{normalizeTextInput(textValue)}</code>
              </p>
            )}
          </div>
        )}

        {current.inputType === "choice" && (
          <div className="flex flex-col gap-1.5">
            {(current.choices ?? []).map((choice) => (
              <label
                key={choice}
                className="flex cursor-pointer items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent"
              >
                <input
                  type="radio"
                  name="choice"
                  value={choice}
                  checked={choiceValue === choice}
                  onChange={() => setChoiceValue(choice)}
                />
                <span>{choice}</span>
              </label>
            ))}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={cancel}>
            Cancel run
          </Button>

          {current.inputType === "confirm" ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => submit(false)}>
                No
              </Button>
              <Button size="sm" onClick={() => submit(true)}>
                Yes
              </Button>
            </>
          ) : current.inputType === "choice" ? (
            <Button
              size="sm"
              disabled={!choiceValue}
              onClick={() => submit(choiceValue)}
            >
              Submit
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={normalizeTextInput(textValue).length === 0}
              onClick={() => submit(textValue)}
            >
              Submit
            </Button>
          )}
        </div>

        {queue.length > 1 && (
          <p className="text-xs text-muted-foreground">
            {queue.length - 1} more pending after this.
          </p>
        )}
      </div>
    </Dialog>
  );
}
