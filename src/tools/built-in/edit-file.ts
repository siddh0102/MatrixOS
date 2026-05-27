import type { BuiltInToolHandler, Tool } from "@/types";

export const EDIT_FILE_DEFINITION: Omit<Tool, "id"> = {
  serverId: "built-in",
  name: "edit_file",
  description:
    "Surgically replace one or more occurrences of an exact string inside a local file. " +
    "Use this instead of write_file when you want to change part of a file — it saves tokens and avoids " +
    "accidentally losing untouched content. " +
    "`old_string` must match EXACTLY (whitespace, indentation, newlines included). " +
    "By default `old_string` must occur exactly once; pass `replace_all: true` to replace every occurrence. " +
    "Errors clearly if `old_string` is missing, ambiguous (multiple matches without replace_all), or identical to `new_string`. " +
    "Returns a short summary including how many occurrences were replaced.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to edit.",
      },
      old_string: {
        type: "string",
        description:
          "Exact text to find. Must be non-empty. Include enough surrounding context to be unique " +
          "unless using replace_all.",
      },
      new_string: {
        type: "string",
        description: "Replacement text. Pass an empty string to delete the matched text.",
      },
      replace_all: {
        type: "boolean",
        description:
          "If true, replace every occurrence of old_string. If false (default), require exactly one match.",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  tags: ["built-in", "filesystem"],
};

export const editFileHandler: BuiltInToolHandler = async (args, ctx) => {
  const path = args["path"];
  const oldString = args["old_string"];
  const newString = args["new_string"];
  const replaceAll = args["replace_all"] === true;

  if (typeof path !== "string" || !path) {
    throw new Error("Missing required argument: path (string)");
  }
  if (typeof oldString !== "string" || oldString.length === 0) {
    throw new Error("Missing required argument: old_string (non-empty string)");
  }
  if (typeof newString !== "string") {
    throw new Error("Missing required argument: new_string (string)");
  }
  if (oldString === newString) {
    throw new Error(
      "old_string and new_string are identical — no edit needed.",
    );
  }

  const { invoke } = await import("@tauri-apps/api/core");
  const original = await invoke<string>("fs_read", {
    ctx: ctx.callContext,
    path,
  });

  // Count matches without doing the replacement yet so we can fail fast
  // with a useful error message.
  let matchCount = 0;
  let idx = 0;
  while ((idx = original.indexOf(oldString, idx)) !== -1) {
    matchCount++;
    idx += oldString.length;
    if (matchCount > 1 && !replaceAll) break; // early exit; we already know it's ambiguous
  }

  if (matchCount === 0) {
    throw new Error(
      `old_string not found in ${path}. Verify exact whitespace and indentation.`,
    );
  }
  if (matchCount > 1 && !replaceAll) {
    throw new Error(
      `old_string occurs more than once in ${path}. Either include more surrounding context to make it unique, or pass replace_all: true.`,
    );
  }

  const updated = replaceAll
    ? original.split(oldString).join(newString)
    : original.replace(oldString, newString);

  // Total count for the summary message. We re-count when replace_all so
  // the summary is honest even with the early-exit above.
  const replaced = replaceAll
    ? original.split(oldString).length - 1
    : 1;

  await invoke<number>("fs_write", {
    ctx: ctx.callContext,
    path,
    contents: updated,
  });

  return `Edited ${path}: replaced ${replaced} occurrence${replaced === 1 ? "" : "s"}.`;
};
