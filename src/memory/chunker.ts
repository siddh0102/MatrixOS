export interface ChunkOptions {
  maxChunkTokens: number;
  overlapTokens: number;
}

export interface TextChunk {
  text: string;
  index: number;
  tokenEstimate: number;
}

const DEFAULT_OPTIONS: ChunkOptions = {
  maxChunkTokens: 512,
  overlapTokens: 64,
};

export function chunkText(
  text: string,
  options: Partial<ChunkOptions> = {},
): TextChunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const maxChars = opts.maxChunkTokens * 4;
  const overlapChars = opts.overlapTokens * 4;

  if (text.length <= maxChars) {
    return [{
      text,
      index: 0,
      tokenEstimate: Math.ceil(text.length / 4),
    }];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);

    if (end < text.length) {
      const searchStart = Math.max(end - 200, start);
      const segment = text.slice(searchStart, end);

      const paraBreak = segment.lastIndexOf("\n\n");
      if (paraBreak > 0) {
        end = searchStart + paraBreak;
      } else {
        // Find the LAST sentence boundary in the segment (not the first).
        let lastSentenceBreak = -1;
        const sentenceRe = /[.!?]\s+(?=[A-Z])/g;
        let match: RegExpExecArray | null;
        while ((match = sentenceRe.exec(segment)) !== null) {
          lastSentenceBreak = match.index;
        }
        if (lastSentenceBreak > 0) {
          end = searchStart + lastSentenceBreak + 1;
        }
      }
    }

    const chunkText = text.slice(start, end).trim();
    if (chunkText.length > 0) {
      chunks.push({
        text: chunkText,
        index,
        tokenEstimate: Math.ceil(chunkText.length / 4),
      });
      index++;
    }

    const nextStart = end - overlapChars;
    if (nextStart >= text.length) break;
    if (nextStart <= start) {
      start = end;
    } else {
      start = nextStart;
    }
  }

  return chunks;
}

export function chunkMarkdown(
  text: string,
  options: Partial<ChunkOptions> = {},
): TextChunk[] {
  const sections = splitByHeaders(text);
  const chunks: TextChunk[] = [];
  let index = 0;

  for (const section of sections) {
    const sectionChunks = chunkText(section, options);
    for (const chunk of sectionChunks) {
      chunks.push({ ...chunk, index });
      index++;
    }
  }

  return chunks;
}

function splitByHeaders(markdown: string): string[] {
  const lines = markdown.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^#{1,3}\s/.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) {
    sections.push(current.join("\n"));
  }

  return sections;
}

export function chunkCode(
  text: string,
  options: Partial<ChunkOptions> = {},
): TextChunk[] {
  const functions = splitByFunctions(text);
  const chunks: TextChunk[] = [];
  let index = 0;

  for (const fn of functions) {
    const fnChunks = chunkText(fn, options);
    for (const chunk of fnChunks) {
      chunks.push({ ...chunk, index });
      index++;
    }
  }

  return chunks;
}

function splitByFunctions(code: string): string[] {
  const pattern = /^(?=(?:export\s+)?(?:async\s+)?(?:function|class|interface)\s|(?:export\s+)?(?:const|let)\s+\w+\s*=\s*(?:async\s+)?\(|(?:export\s+)?type\s+\w+\s*[=<{]|(?:pub\s+)?(?:fn|struct|impl|enum)\s|(?:async\s+)?def\s|func\s)/gm;
  const parts = code.split(pattern);
  return parts.filter((p) => p.trim().length > 0);
}
