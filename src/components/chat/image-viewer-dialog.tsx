import { useEffect } from "react";
import type { ImageContent } from "@/types";

interface ImageViewerDialogProps {
  image: ImageContent | null;
  onClose: () => void;
}

export function ImageViewerDialog({ image, onClose }: ImageViewerDialogProps) {
  useEffect(() => {
    if (!image) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [image, onClose]);

  if (!image) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] max-w-[90vw]"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={`data:${image.mimeType};base64,${image.base64}`}
          alt={image.altText ?? "Image"}
          className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
        />
        <button
          onClick={onClose}
          className="absolute -top-3 -right-3 flex h-6 w-6 items-center justify-center rounded-full bg-card text-foreground shadow-md text-xs hover:bg-muted"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
