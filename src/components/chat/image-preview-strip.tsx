import type { ImageContent } from "@/types";
import { estimateImageTokens } from "@/lib/image-utils";

interface ImagePreviewStripProps {
  images: ImageContent[];
  onRemove: (index: number) => void;
}

export function ImagePreviewStrip({ images, onRemove }: ImagePreviewStripProps) {
  if (images.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-1 pb-1">
      {images.map((img, i) => {
        const tokens = img.widthPx && img.heightPx
          ? estimateImageTokens(img.widthPx, img.heightPx)
          : null;

        return (
          <div key={i} className="relative group">
            <img
              src={`data:${img.mimeType};base64,${img.base64}`}
              alt={img.altText ?? `Image ${i + 1}`}
              className="h-16 w-16 rounded-lg border border-border object-cover"
            />
            <button
              onClick={() => onRemove(i)}
              className="absolute -top-1.5 -right-1.5 hidden group-hover:flex h-4 w-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-[10px]"
              title="Remove image"
            >
              ✕
            </button>
            {tokens !== null && (
              <span className="absolute bottom-0 left-0 right-0 rounded-b-lg bg-black/50 text-center text-[10px] text-white">
                ~{tokens}t
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
