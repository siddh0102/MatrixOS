import {
  type FormEvent,
  type KeyboardEvent,
  useRef,
  useEffect,
  useState,
} from "react";
import { cn } from "@/lib/utils";
import { fileToBase64, clipboardImageToBase64, isImageMimeType } from "@/lib/image-utils";
import { ImagePreviewStrip } from "./image-preview-strip";
import type { ImageContent } from "@/types";
import { useAgentStore } from "@/stores/agent-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTabStore } from "@/stores/tab-store";

interface ChatInputProps {
  onSend: (text: string, images?: ImageContent[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

function SendIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
    </svg>
  );
}

function ImageIcon() {
  return (
    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z" />
    </svg>
  );
}

export function ChatInput({
  onSend,
  disabled = false,
  placeholder = "Message MatrixOS…",
}: ChatInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachedImages, setAttachedImages] = useState<ImageContent[]>([]);
  const [addToast] = [
    (msg: string) => {
      import("@/stores/ui-store").then(({ useUIStore }) => {
        useUIStore.getState().addToast({ type: "error", message: msg });
      });
    },
  ];

  // Determine if vision is supported for active agent model
  const configs = useAgentStore((s) => s.configs);
  const providers = useSettingsStore((s) => s.providers);
  const activeTabAgentId = useTabStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.agentId ?? null,
  );
  const activeConfig = configs.find((c) => c.id === activeTabAgentId);
  const activeProvider = providers.find((p) => p.id === activeConfig?.providerId);
  const activeModel = activeProvider?.models.find((m) => m.id === activeConfig?.modelId);
  const supportsVision = activeModel?.supportsVision ?? false;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 400)}px`;
  });

  async function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!supportsVision) return;
    const hasImage = Array.from(e.clipboardData.items).some(
      (item) => item.type.startsWith("image/"),
    );
    if (!hasImage) return;
    e.preventDefault();
    try {
      const img = await clipboardImageToBase64();
      if (img) {
        setAttachedImages((prev) => [
          ...prev,
          {
            type: "image",
            mimeType: img.mimeType,
            base64: img.base64,
            widthPx: img.width,
            heightPx: img.height,
          },
        ]);
      }
    } catch (err) {
      addToast(err instanceof Error ? err.message : "Failed to paste image");
    }
  }

  async function handleDrop(e: React.DragEvent<HTMLTextAreaElement>) {
    if (!supportsVision) return;
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      isImageMimeType(f.type),
    );
    if (files.length === 0) return;
    e.preventDefault();
    for (const file of files) {
      try {
        const img = await fileToBase64(file);
        setAttachedImages((prev) => [
          ...prev,
          {
            type: "image",
            mimeType: img.mimeType,
            base64: img.base64,
            widthPx: img.width,
            heightPx: img.height,
          },
        ]);
      } catch (err) {
        addToast(err instanceof Error ? err.message : "Failed to attach image");
      }
    }
  }

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    for (const file of files) {
      try {
        const img = await fileToBase64(file);
        setAttachedImages((prev) => [
          ...prev,
          {
            type: "image",
            mimeType: img.mimeType,
            base64: img.base64,
            widthPx: img.width,
            heightPx: img.height,
          },
        ]);
      } catch (err) {
        addToast(err instanceof Error ? err.message : "Failed to attach image");
      }
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const el = textareaRef.current;
    if (!el) return;
    const text = el.value.trim();
    if (!text && attachedImages.length === 0) return;
    if (disabled) return;
    el.value = "";
    el.style.height = "auto";
    const imgs = [...attachedImages];
    setAttachedImages([]);
    onSend(text, imgs.length > 0 ? imgs : undefined);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    submit();
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col border-t border-primary/10 bg-[#0a1628]/60 px-4 py-3 gap-2 backdrop-blur-sm"
    >
      <ImagePreviewStrip
        images={attachedImages}
        onRemove={(i) => setAttachedImages((prev) => prev.filter((_, idx) => idx !== i))}
      />

      <div className="flex items-end gap-2">
        {supportsVision && (
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border",
                "text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
              )}
              title="Attach image"
              disabled={disabled}
            >
              <ImageIcon />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={handleFileSelect}
            />
          </>
        )}

        <div className="relative flex-1 flex items-end">
          <textarea
            ref={textareaRef}
            rows={3}
            disabled={disabled}
            placeholder={placeholder}
            data-chat-input
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={(e) => supportsVision && e.preventDefault()}
            className={cn(
              "flex-1 resize-none rounded-xl border border-input bg-background/80 px-4 py-3.5 pr-12 text-[15px] leading-relaxed",
              "placeholder:text-muted-foreground/50",
              "transition-colors duration-150",
              "focus-visible:outline-none focus-visible:border-input-focus focus-visible:ring-2 focus-visible:ring-ring-subtle",
              "disabled:cursor-not-allowed disabled:opacity-40",
              "max-h-[400px] overflow-y-auto",
            )}
          />
          <button
            type="submit"
            disabled={disabled}
            className={cn(
              "absolute right-1.5 bottom-1.5 h-8 w-8 rounded-lg bg-primary text-primary-foreground",
              "flex items-center justify-center",
              "hover:bg-primary-hover active:scale-[0.92] disabled:opacity-40 disabled:pointer-events-none",
              "transition-all duration-150 shadow-[0_0_12px_rgba(79,195,247,0.4)]",
            )}
            title="Send (Enter)"
          >
            <SendIcon />
          </button>
        </div>
      </div>
    </form>
  );
}
