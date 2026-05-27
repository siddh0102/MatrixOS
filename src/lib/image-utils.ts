const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // 4MB
const MAX_DIMENSION = 2048;

export interface ImageData {
  base64: string;
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  width: number;
  height: number;
}

export function isImageMimeType(mime: string): mime is ImageData["mimeType"] {
  return ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime);
}

export function validateImageSize(base64: string): boolean {
  return base64.length * 0.75 <= MAX_IMAGE_BYTES;
}

export function estimateImageTokens(width: number, height: number): number {
  return Math.ceil(width / 32) * Math.ceil(height / 32) * 2;
}

export async function resizeImageIfNeeded(
  base64: string,
  mimeType: ImageData["mimeType"],
): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const needsResize = width > MAX_DIMENSION || height > MAX_DIMENSION;
      if (!needsResize && validateImageSize(base64)) {
        resolve({ base64, mimeType, width, height });
        return;
      }

      if (needsResize) {
        const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, width, height);

      const outputMime = mimeType === "image/gif" ? "image/png" : mimeType;
      const dataUrl = canvas.toDataURL(outputMime, 0.85);
      const newBase64 = dataUrl.split(",")[1];

      if (!validateImageSize(newBase64)) {
        reject(new Error("Image exceeds 4MB limit even after resizing. Please use a smaller image."));
        return;
      }
      resolve({
        base64: newBase64,
        mimeType: outputMime as ImageData["mimeType"],
        width,
        height,
      });
    };
    img.onerror = () => reject(new Error("Failed to load image for resizing"));
    img.src = `data:${mimeType};base64,${base64}`;
  });
}

export async function fileToBase64(file: File): Promise<ImageData> {
  if (!isImageMimeType(file.type)) {
    throw new Error(`Unsupported image type: ${file.type}`);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(",")[1];
      try {
        const result = await resizeImageIfNeeded(base64, file.type as ImageData["mimeType"]);
        resolve(result);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

export async function clipboardImageToBase64(): Promise<ImageData | null> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const type of item.types) {
        if (isImageMimeType(type)) {
          const blob = await item.getType(type);
          const arrayBuffer = await blob.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          const base64 = btoa(binary);
          return resizeImageIfNeeded(base64, type as ImageData["mimeType"]);
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}
