import { createHash } from "node:crypto";
import type JSZip from "jszip";
import { CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-error-codes.js";
import {
  buildClawHubInstallFailure,
  type ClawHubInstallFailure,
} from "./clawhub-install-errors.js";

type JSZipObjectWithSize = JSZip.JSZipObject & {
  // Internal JSZip field from loadAsync() metadata. Use it only as a best-effort
  // size hint; the streaming byte checks below are the authoritative guard.
  _data?: {
    uncompressedSize?: number;
  };
};

type ClawHubArchiveEntryLimits = {
  maxEntryBytes: number;
  addArchiveBytes: (bytes: number) => boolean;
  signal?: AbortSignal;
};

async function readLimitedClawHubArchiveEntry<T>(
  entry: JSZip.JSZipObject,
  limits: ClawHubArchiveEntryLimits,
  handlers: {
    onChunk: (buffer: Buffer) => void;
    onEnd: () => T;
  },
): Promise<T | ClawHubInstallFailure> {
  limits.signal?.throwIfAborted();
  // SAFETY: JSZip loadAsync stores a CompressedObject in _data; its optional size hint is checked below.
  const hintedSize = (entry as JSZipObjectWithSize)["_data"]?.uncompressedSize;
  if (
    typeof hintedSize === "number" &&
    Number.isFinite(hintedSize) &&
    hintedSize > limits.maxEntryBytes
  ) {
    return buildClawHubInstallFailure(
      `ClawHub archive fallback verification rejected "${entry.name}" because it exceeds the per-file size limit.`,
      CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
    );
  }
  let entryBytes = 0;
  return await new Promise<T | ClawHubInstallFailure>((resolve, reject) => {
    let settled = false;
    // SAFETY: JSZip's NodejsStreamOutputAdapter extends readable-stream.Readable, which implements destroy.
    const stream = entry.nodeStream("nodebuffer") as NodeJS.ReadableStream & {
      destroy?: (error?: Error) => void;
    };
    const removeAbortListener = () => limits.signal?.removeEventListener("abort", onAbort);
    const finish = (value: T | ClawHubInstallFailure) => {
      if (settled) {
        return;
      }
      settled = true;
      removeAbortListener();
      resolve(value);
    };
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      removeAbortListener();
      stream.destroy?.();
      const reason = limits.signal?.reason;
      reject(
        reason instanceof Error
          ? reason
          : new Error("ClawHub archive verification aborted", { cause: reason }),
      );
    };
    limits.signal?.addEventListener("abort", onAbort, { once: true });
    if (limits.signal?.aborted) {
      onAbort();
      return;
    }
    stream.on("data", (chunk: Buffer | Uint8Array | string) => {
      if (settled) {
        return;
      }
      if (limits.signal?.aborted) {
        onAbort();
        return;
      }
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      entryBytes += buffer.byteLength;
      if (entryBytes > limits.maxEntryBytes) {
        stream.destroy?.();
        finish(
          buildClawHubInstallFailure(
            `ClawHub archive fallback verification rejected "${entry.name}" because it exceeds the per-file size limit.`,
            CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
          ),
        );
        return;
      }
      if (!limits.addArchiveBytes(buffer.byteLength)) {
        stream.destroy?.();
        finish(
          buildClawHubInstallFailure(
            "ClawHub archive fallback verification exceeded the total extracted-size limit.",
            CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
          ),
        );
        return;
      }
      handlers.onChunk(buffer);
    });
    stream.once("end", () => {
      finish(handlers.onEnd());
    });
    stream.once("error", (error: unknown) => {
      if (settled) {
        return;
      }
      finish(
        buildClawHubInstallFailure(
          error instanceof Error ? error.message : String(error),
          CLAWHUB_INSTALL_ERROR_CODE.ARCHIVE_INTEGRITY_MISMATCH,
        ),
      );
    });
  });
}

export async function readClawHubArchiveEntryBuffer(
  entry: JSZip.JSZipObject,
  limits: ClawHubArchiveEntryLimits,
): Promise<Buffer | ClawHubInstallFailure> {
  const chunks: Buffer[] = [];
  return await readLimitedClawHubArchiveEntry(entry, limits, {
    onChunk(buffer) {
      chunks.push(buffer);
    },
    onEnd() {
      return Buffer.concat(chunks);
    },
  });
}

export async function hashClawHubArchiveEntry(
  entry: JSZip.JSZipObject,
  limits: ClawHubArchiveEntryLimits,
): Promise<string | ClawHubInstallFailure> {
  const digest = createHash("sha256");
  return await readLimitedClawHubArchiveEntry(entry, limits, {
    onChunk(buffer) {
      digest.update(buffer);
    },
    onEnd() {
      return digest.digest("hex");
    },
  });
}
