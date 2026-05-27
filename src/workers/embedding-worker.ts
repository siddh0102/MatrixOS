import { pipeline, env } from "@huggingface/transformers";
import type { Tensor } from "@huggingface/transformers";

// Bundled-model mode: files live under public/models/<modelName>/.
// Vite serves them at the webview origin /models/... in both dev and prod.
// Set allowRemoteModels=false so a missing/mistyped model name surfaces as a
// clear error instead of silently triggering a multi-hundred-MB HuggingFace
// download. If you need to load an unbundled model (e.g. Xenova/all-MiniLM-L6-v2
// for legacy 384-dim configs), set allowRemoteModels=true here.
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = "/models/";

console.log("[embed-worker] boot — transformers.js loaded; localModelPath=", env.localModelPath);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embedder: any = null;
let loadInFlight: Promise<unknown> | null = null;

async function getEmbedder(model: string) {
  if (embedder) return embedder;
  if (loadInFlight) return loadInFlight;
  console.log(`[embed-worker] pipeline(feature-extraction, ${model}, fp32) START`);
  // dtype="q8" loads model_quantized.onnx (~140 MB, ~3-4× faster than fp32 on CPU,
  // ~0.3-0.7 MTEB point accuracy drop). Switch back to "fp32" to use model.onnx
  // (~547 MB) if you need maximum quality.
  loadInFlight = pipeline("feature-extraction", model, {
    dtype: "q8",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    progress_callback: (p: any) => {
      const status = p?.status ?? "?";
      const file = p?.file ?? "?";
      const pct = p?.progress != null ? Math.round(p.progress) + "%" : "";
      console.log(`[embed-worker] load ${status} ${file} ${pct}`);
    },
  }).then((e) => {
    console.log(`[embed-worker] pipeline ${model} READY`);
    embedder = e;
    return e;
  }).catch((err) => {
    console.error(`[embed-worker] pipeline ${model} FAILED:`, err);
    loadInFlight = null;
    throw err;
  });
  return loadInFlight;
}

self.onmessage = async (e: MessageEvent) => {
  const { id, type, model, texts } = e.data as {
    id: string;
    type: "embed" | "embedBatch";
    model: string;
    texts: string[];
  };
  console.log(`[embed-worker] msg id=${id} type=${type} model=${model} texts=${texts.length}`);

  try {
    const pipe = await getEmbedder(model);
    console.log(`[embed-worker] embedder ready — starting ${type}`);

    if (type === "embed") {
      const output = await pipe(texts[0], { pooling: "mean", normalize: true }) as Tensor;
      console.log(`[embed-worker] embed done, dim=${(output.data as Float32Array).length}`);
      self.postMessage({ id, result: Array.from(output.data as Float32Array) });
    } else {
      const results: number[][] = [];
      for (let i = 0; i < texts.length; i++) {
        const out = await pipe(texts[i], { pooling: "mean", normalize: true }) as Tensor;
        results.push(Array.from(out.data as Float32Array));
      }
      console.log(`[embed-worker] embedBatch done (${texts.length} texts)`);
      self.postMessage({ id, result: results });
    }
  } catch (err) {
    console.error(`[embed-worker] error:`, err);
    self.postMessage({ id, error: String(err) });
  }
};
