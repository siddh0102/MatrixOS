const CITATION_INSTRUCTION = [
  "## Source Citations",
  "When you use information from any `### Relevant Knowledge` section above, cite the source by appending `[filename]` at the end of the sentence that uses that information (e.g. `…as outlined in the patterns book [monolith-to-microservices.pdf].`).",
  "- Cite each sentence that directly draws on a `### Relevant Knowledge` chunk.",
  "- Use the exact filename shown in brackets in the chunk header (e.g. `[doc.pdf]`).",
  "- Do NOT cite when you are answering from your own training rather than the retrieved chunks.",
  "- Do NOT cite from `### Relevant Past Conversations` or `### Reference Patterns` sections.",
].join("\n");

export function composeSystemPrompt(
  basePrompt: string,
  skillPrompts: string[],
  memoryContext?: string,
  /**
   * The active compaction summary text for this conversation, if any.
   * Injected as its own labeled section so the model treats it as
   * "what happened earlier" rather than appended noise.
   */
  compactionSummary?: string,
): string {
  let result = basePrompt;

  if (skillPrompts.length > 0) {
    result = [result, "---", "## Additional Skills", ...skillPrompts].join("\n\n");
  }

  if (compactionSummary && compactionSummary.trim()) {
    result = [
      result,
      "---",
      "## Earlier Conversation (Compacted)",
      "The following is a summary of earlier turns in this conversation that were compacted to keep the context within the model's window. Treat it as established context — facts, names, and decisions stated here are real prior history, not hypotheticals.",
      "",
      compactionSummary.trim(),
    ].join("\n\n");
  }

  if (memoryContext) {
    result = [result, "---", "## Retrieved Context", memoryContext].join("\n\n");
    // Citation directive is appended only when retrieval actually produced
    // context — emitting it on an empty context would confuse the model
    // ("cite from what?").
    if (memoryContext.includes("### Relevant Knowledge")) {
      result = [result, "---", CITATION_INSTRUCTION].join("\n\n");
    }
  }

  return result;
}
