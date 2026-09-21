import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { resolveArchiveKind } from "../infra/archive.js";
import { formatErrorMessage } from "../infra/errors.js";
import { writeFileWindowFully } from "../infra/file-descriptor.js";
import { withResponseBodyTimeout } from "../infra/http-response-body-timeout.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { isPathInside } from "../infra/path-guards.js";

const DEFAULT_MARKETPLACE_DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_MARKETPLACE_ARCHIVE_BYTES = 256 * 1024 * 1024;

function resolveSafeMarketplaceDownloadFileName(url: string, fallback: string): string {
  const pathname = new URL(url).pathname;
  const fileName = path.basename(pathname).trim() || fallback;
  if (
    fileName === "." ||
    fileName === ".." ||
    /^[a-zA-Z]:/.test(fileName) ||
    path.isAbsolute(fileName) ||
    fileName.includes("/") ||
    fileName.includes("\\")
  ) {
    throw new Error("invalid download filename");
  }
  return fileName;
}

function resolveMarketplaceDownloadTimeoutMs(timeoutMs?: number): number {
  const resolvedTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? timeoutMs
      : DEFAULT_MARKETPLACE_DOWNLOAD_TIMEOUT_MS;
  return Math.max(1_000, Math.floor(resolvedTimeoutMs));
}

function formatMarketplaceDownloadError(url: string, detail: string): string {
  return (
    `failed to download ${sanitizeForLog(redactSensitiveUrlLikeString(url))}: ` +
    sanitizeForLog(detail)
  );
}

function hasStreamingResponseBody(
  response: Response,
): response is Response & { body: ReadableStream<Uint8Array> } {
  return Boolean(response.body && typeof response.body.getReader === "function");
}

async function cancelUnreadMarketplaceResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function parseMarketplaceContentLength(raw: string): number {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`invalid content-length header: ${raw}`);
  }
  const size = Number(trimmed);
  if (!Number.isSafeInteger(size)) {
    throw new Error(`invalid content-length header: ${raw}`);
  }
  return size;
}

async function streamMarketplaceResponseToFile(params: {
  response: Response & { body: ReadableStream<Uint8Array> };
  targetPath: string;
  maxBytes: number;
  chunkTimeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const reader = params.response.body.getReader();
  const fileHandle = await fs.open(params.targetPath, "wx");
  let total = 0;

  try {
    while (true) {
      const { done, value } = await withResponseBodyTimeout({
        timeoutMs: params.chunkTimeoutMs,
        onTimeout: ({ timeoutMs }) => new Error(`download timed out after ${timeoutMs}ms`),
        signal: params.signal,
        cancel: async (error) => await reader.cancel(error),
        read: () => reader.read(),
      });
      if (done) {
        return;
      }
      if (!value?.length) {
        continue;
      }

      const nextTotal = total + value.length;
      if (nextTotal > params.maxBytes) {
        throw new Error(`download too large: ${nextTotal} bytes (limit: ${params.maxBytes} bytes)`);
      }

      await writeFileWindowFully(fileHandle, value, null);
      total = nextTotal;
    }
  } catch (error) {
    if (typeof reader.cancel === "function") {
      await reader.cancel().catch(() => undefined);
    }
    throw error;
  } finally {
    await fileHandle.close().catch(() => undefined);
    try {
      reader.releaseLock();
    } catch {}
  }
}

export async function downloadUrlToTempFile(
  url: string,
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<
  | {
      ok: true;
      path: string;
      cleanup: () => Promise<void>;
    }
  | {
      ok: false;
      error: string;
    }
> {
  let sourceFileName = "plugin.tgz";
  let tmpDir: string | undefined;
  try {
    sourceFileName = resolveSafeMarketplaceDownloadFileName(url, sourceFileName);
    const downloadTimeoutMs = resolveMarketplaceDownloadTimeoutMs(timeoutMs);
    const { response, finalUrl, release } = await fetchWithSsrFGuard({
      url,
      timeoutMs: downloadTimeoutMs,
      ...(signal ? { signal } : {}),
      auditContext: "marketplace-plugin-download",
    });
    try {
      if (!response.ok) {
        await cancelUnreadMarketplaceResponseBody(response);
        return {
          ok: false,
          error: formatMarketplaceDownloadError(url, `HTTP ${response.status}`),
        };
      }
      if (!response.body) {
        return {
          ok: false,
          error: formatMarketplaceDownloadError(url, "empty response body"),
        };
      }
      // Fail closed unless we can stream and enforce the archive size bound incrementally.
      if (!hasStreamingResponseBody(response)) {
        await cancelUnreadMarketplaceResponseBody(response);
        return {
          ok: false,
          error: formatMarketplaceDownloadError(url, "streaming response body unavailable"),
        };
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength) {
        let size: number;
        try {
          size = parseMarketplaceContentLength(contentLength);
        } catch (error) {
          await cancelUnreadMarketplaceResponseBody(response);
          throw error;
        }
        if (size > MAX_MARKETPLACE_ARCHIVE_BYTES) {
          await cancelUnreadMarketplaceResponseBody(response);
          throw new Error(
            `download too large: ${size} bytes (limit: ${MAX_MARKETPLACE_ARCHIVE_BYTES} bytes)`,
          );
        }
      }

      const finalFileName = resolveSafeMarketplaceDownloadFileName(finalUrl, sourceFileName);
      const fileName = resolveArchiveKind(finalFileName) ? finalFileName : sourceFileName;
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-marketplace-download-"));
      const createdTmpDir = tmpDir;
      const targetPath = path.resolve(createdTmpDir, fileName);
      if (!isPathInside(createdTmpDir, targetPath)) {
        throw new Error("invalid download filename");
      }
      await streamMarketplaceResponseToFile({
        response,
        targetPath,
        maxBytes: MAX_MARKETPLACE_ARCHIVE_BYTES,
        chunkTimeoutMs: downloadTimeoutMs,
        ...(signal ? { signal } : {}),
      });
      return {
        ok: true,
        path: targetPath,
        cleanup: async () => {
          await fs.rm(createdTmpDir, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    } finally {
      await release().catch(() => undefined);
    }
  } catch (error) {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
    return {
      ok: false,
      error: formatMarketplaceDownloadError(url, formatErrorMessage(error)),
    };
  }
}
