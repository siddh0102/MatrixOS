// src/scheduling/background-runtime.ts
// Runs inside the hidden "background" window.  Listens for scheduler:fire_job
// events from the Rust scheduler, executes the agent turn, and calls
// sched_complete_run so the Rust side can record the result.

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { ScheduledJob } from "@/types";
import { executeScheduledJob } from "@/scheduling/execute-job";

interface FireJobPayload {
  job: ScheduledJob;
  runId: string;
  startedAt: string;
}

export async function start(): Promise<void> {
  console.log("[background-runtime] started — listening for scheduler:fire_job");

  await listen<FireJobPayload>("scheduler:fire_job", async (event) => {
    const { job, runId } = event.payload;
    console.log(`[background-runtime] fire_job received: job=${job.id} run=${runId}`);

    let conversationId = job.targetConversationId ?? "";
    let messageId: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    let status = "success";
    let error: string | undefined;

    try {
      const result = await executeScheduledJob(job, runId);
      conversationId = result.conversationId;
      messageId = result.messageId;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
    } catch (err) {
      status = "error";
      error = err instanceof Error ? err.message : String(err);
      console.error(`[background-runtime] job ${job.id} failed:`, err);
    }

    // Always call back — on both success AND error paths.
    try {
      await invoke("sched_complete_run", {
        runId,
        jobId: job.id,
        conversationId,
        messageId,
        status,
        error: error ?? null,
        rendererClaimedInput: inputTokens,
        rendererClaimedOutput: outputTokens,
      });
    } catch (callbackErr) {
      console.error(
        `[background-runtime] sched_complete_run failed for run ${runId}:`,
        callbackErr,
      );
    }
  });
}
