-- Phase E follow-up: switch the in-built embedding model from
-- Xenova/all-MiniLM-L6-v2 (384d, 256-token context, MTEB ~56) to the bundled
-- nomic-embed-text-v1.5 (768d, 8192-token context, MTEB ~62). The ONNX model
-- plus tokenizer files live under public/models/nomic-embed-text-v1.5/ and
-- are loaded by src/workers/embedding-worker.ts via transformers.js's local
-- model path. No HuggingFace download required.
--
-- This migration ONLY touches the row if it is still at the original built-in
-- default. Users who have customized to ollama / openai-compatible / another
-- local model keep their settings untouched.
--
-- Update the column default for fresh installs:

UPDATE embedding_config
   SET provider = 'local',
       model = 'nomic-embed-text-v1.5',
       dimensions = 768,
       base_url = NULL,
       updated_at = datetime('now')
 WHERE id = 'default'
   AND provider = 'local'
   AND model = 'Xenova/all-MiniLM-L6-v2';
