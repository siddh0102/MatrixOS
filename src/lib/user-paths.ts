import { invoke } from "@tauri-apps/api/core";
import type { CallContext } from "@/types";

const USER_CTX: CallContext = { type: "User" };

export async function registerUserPath(path: string): Promise<void> {
  await invoke("fs_register_user_path", { ctx: USER_CTX, path });
}
