import fs from "node:fs/promises";

const JSONL_STREAM_THRESHOLD_BYTES = 4 * 1024 * 1024;
const JSONL_READ_CHUNK_BYTES = 1024 * 1024;

/** Complete JSONL lines from a bounded byte window, plus whether that window covered the file. */
export type JsonlWindow = {
  lines: string[];
  /** True when the window spanned the whole file, so counts derived from it are exact. */
  complete: boolean;
};

export async function visitJsonlLines(
  file: string,
  visitor: (line: string) => boolean | void,
  chunkBytes = JSONL_READ_CHUNK_BYTES,
): Promise<{ ok: boolean; lineCount: number }> {
  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return { ok: false, lineCount: 0 };
  }
  if (size <= JSONL_STREAM_THRESHOLD_BYTES) {
    let content: string;
    try {
      content = await fs.readFile(file, "utf8");
    } catch {
      return { ok: false, lineCount: 0 };
    }
    if (content.length === 0) {
      return { ok: true, lineCount: 0 };
    }
    let lineCount = 0;
    for (const line of content.split(/\r?\n/u)) {
      lineCount += 1;
      if (visitor(line) === false) {
        break;
      }
    }
    return { ok: true, lineCount };
  }

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return { ok: false, lineCount: 0 };
  }
  const buffer = Buffer.allocUnsafe(chunkBytes);
  const decoder = new TextDecoder();
  let pendingFragments: string[] = [];
  let lineCount = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      const content = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      let lineStart = 0;
      while (true) {
        const newline = content.indexOf("\n", lineStart);
        if (newline === -1) {
          break;
        }
        let rawLine = content.slice(lineStart, newline);
        if (pendingFragments.length > 0) {
          pendingFragments.push(rawLine);
          rawLine = pendingFragments.join("");
          pendingFragments = [];
        }
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        lineCount += 1;
        if (visitor(line) === false) {
          return { ok: true, lineCount };
        }
        lineStart = newline + 1;
      }
      if (lineStart < content.length) {
        pendingFragments.push(content.slice(lineStart));
      }
    }
    const decoderTail = decoder.decode();
    if (decoderTail.length > 0) {
      pendingFragments.push(decoderTail);
    }
    if (pendingFragments.length > 0) {
      const rawLine = pendingFragments.join("");
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      lineCount += 1;
      visitor(line);
    }
    return { ok: true, lineCount };
  } catch {
    return { ok: false, lineCount: 0 };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Read at most `maxBytes` from the start of a JSONL file. A trailing partial line is dropped
 * unless the window reached EOF, so every returned line is a complete record.
 */
export async function readJsonlHead(file: string, maxBytes: number): Promise<JsonlWindow | null> {
  const size = await readFileSize(file);
  if (size === undefined) {
    return null;
  }
  const window = await readFileWindow(file, 0, Math.min(maxBytes, size));
  if (!window) {
    return null;
  }
  const complete = window.bytesRead >= size;
  return {
    lines: splitWindowLines(window.text, { dropLeading: false, dropTrailing: !complete }),
    complete,
  };
}

/**
 * Read at most `maxBytes` from the end of a JSONL file. A leading partial line is dropped unless
 * the window started at byte 0, so every returned line is a complete record. Any UTF-8 sequence
 * split by the window boundary falls inside that dropped fragment.
 */
export async function readJsonlTail(file: string, maxBytes: number): Promise<JsonlWindow | null> {
  const size = await readFileSize(file);
  if (size === undefined) {
    return null;
  }
  const start = Math.max(0, size - maxBytes);
  const window = await readFileWindow(file, start, size - start);
  if (!window) {
    return null;
  }
  const complete = start === 0 && window.bytesRead >= size;
  return {
    lines: splitWindowLines(window.text, { dropLeading: start > 0, dropTrailing: false }),
    complete,
  };
}

async function readFileSize(file: string): Promise<number | undefined> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return undefined;
  }
}

async function readFileWindow(
  file: string,
  position: number,
  maxBytes: number,
): Promise<{ text: string; bytesRead: number } | null> {
  if (maxBytes <= 0) {
    return { text: "", bytesRead: 0 };
  }
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "r");
  } catch {
    return null;
  }
  const buffer = Buffer.allocUnsafe(maxBytes);
  let total = 0;
  try {
    // A single read(2) may return a short count on a regular file, so fill the window explicitly.
    while (total < maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, maxBytes - total, position + total);
      if (bytesRead === 0) {
        break;
      }
      total += bytesRead;
    }
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { text: new TextDecoder().decode(buffer.subarray(0, total)), bytesRead: total };
}

function splitWindowLines(
  text: string,
  options: { dropLeading: boolean; dropTrailing: boolean },
): string[] {
  if (text.length === 0) {
    return [];
  }
  const lines = text.split(/\r?\n/u);
  if (options.dropTrailing) {
    lines.pop();
  }
  if (options.dropLeading) {
    lines.shift();
  }
  return lines;
}
