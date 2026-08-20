// Bounded streaming probes for Desktop metadata files that JSON admission
// rejected, so exclusions and minimal validated records survive the rejection.
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import { normalizeBoundedOptionalString as readBoundedString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { DesktopSessionMetadata } from "./session-catalog-desktop.js";
import { MAX_STRING_LENGTH } from "./session-catalog-shared.js";

// A JSON string token's encoded form can cost up to six raw characters per
// decoded character ("\uXXXX"). Streaming probes collect encoded tokens up to
// this bound so every string the admitted reader accepts within a decoded cap
// still decodes; the decoded caps stay the effective limits.
const MAX_PROBE_ENCODED_STRING_CHARS = MAX_STRING_LENGTH * 6;

const DESKTOP_ARCHIVE_SCAN_CHUNK_BYTES = 16 * 1024;

type DesktopArchiveProbeState = {
  phase:
    | "start"
    | "key-or-end"
    | "key"
    | "colon"
    | "value-start"
    | "string"
    | "primitive"
    | "composite"
    | "after-value"
    | "done"
    | "invalid";
  key?: string;
  stringKind?: "key" | "cli" | "other";
  stringRaw: string;
  stringEscaped: boolean;
  stringTooLong: boolean;
  compositeDepth: number;
  compositeInString: boolean;
  compositeEscaped: boolean;
  primitive: string;
  cliSessionId?: string;
  isArchived: boolean;
  // Minimal validated record fields recovered for active sessions from files
  // the admission budgets rejected, so desktop-only rows keep their visibility.
  sessionId?: string;
  title?: string;
  cwd?: string;
  originCwd?: string;
  createdAt?: string;
  lastActivityAt?: string;
};

function createDesktopArchiveProbeState(): DesktopArchiveProbeState {
  return {
    phase: "start",
    stringRaw: "",
    stringEscaped: false,
    stringTooLong: false,
    compositeDepth: 0,
    compositeInString: false,
    compositeEscaped: false,
    primitive: "",
    isArchived: false,
  };
}

function appendDesktopArchiveProbeString(state: DesktopArchiveProbeState, value: string): void {
  if (state.stringTooLong) {
    return;
  }
  if (state.stringRaw.length + value.length > MAX_PROBE_ENCODED_STRING_CHARS) {
    state.stringTooLong = true;
    state.stringRaw = "";
    return;
  }
  state.stringRaw += value;
}

function finishDesktopArchiveProbeString(state: DesktopArchiveProbeState): void {
  let value: unknown;
  if (!state.stringTooLong) {
    try {
      value = JSON.parse(`"${state.stringRaw}"`) as unknown; // SAFETY: the scanner collected one JSON string token's contents.
    } catch {
      state.phase = "invalid";
      return;
    }
  }
  if (state.stringKind === "key") {
    state.key = typeof value === "string" ? value : undefined;
    state.phase = "colon";
  } else {
    if (typeof value === "string") {
      if (state.stringKind === "cli") {
        state.cliSessionId = readBoundedString(value, 256);
      } else {
        // Recover the minimal validated record fields the admitted reader keeps.
        switch (state.key) {
          case "sessionId":
            state.sessionId = readBoundedString(value, 256);
            break;
          case "title":
            state.title = readBoundedString(value, 500);
            break;
          case "cwd":
            state.cwd = readBoundedString(value, MAX_STRING_LENGTH);
            break;
          case "originCwd":
            state.originCwd = readBoundedString(value, MAX_STRING_LENGTH);
            break;
          case "createdAt":
          case "lastActivityAt":
            state[state.key] = readBoundedString(value, 64);
            break;
          default:
            break;
        }
      }
    }
    state.phase = "after-value";
  }
  state.stringKind = undefined;
  state.stringRaw = "";
  state.stringEscaped = false;
  state.stringTooLong = false;
}

function finishDesktopArchiveProbePrimitive(state: DesktopArchiveProbeState): void {
  if (state.key === "isArchived" && state.primitive === "true") {
    state.isArchived = true;
  } else if (
    (state.key === "createdAt" || state.key === "lastActivityAt") &&
    state.primitive.length > 0
  ) {
    state[state.key] = state.primitive;
  }
  state.primitive = "";
  state.phase = "after-value";
}

function consumeDesktopArchiveProbeText(state: DesktopArchiveProbeState, text: string): void {
  let index = 0;
  while (index < text.length && state.phase !== "done" && state.phase !== "invalid") {
    const character = text[index];
    if (character === undefined) {
      break;
    }
    if (
      state.phase === "primitive" &&
      (character === "," || character === "}" || /\s/.test(character))
    ) {
      finishDesktopArchiveProbePrimitive(state);
      continue;
    }
    if (state.phase === "start") {
      state.phase = /\s/.test(character) ? "start" : character === "{" ? "key-or-end" : "invalid";
    } else if (state.phase === "key-or-end") {
      if (/\s/.test(character)) {
        // Keep waiting for the next object key or the closing brace.
      } else if (character === "}") {
        state.phase = "done";
      } else if (character === '"') {
        state.phase = "key";
        state.stringKind = "key";
        state.stringRaw = "";
        state.stringEscaped = false;
        state.stringTooLong = false;
      } else {
        state.phase = "invalid";
      }
    } else if (state.phase === "key") {
      if (state.stringEscaped) {
        appendDesktopArchiveProbeString(state, character);
        state.stringEscaped = false;
      } else if (character === "\\") {
        state.stringEscaped = true;
        appendDesktopArchiveProbeString(state, character);
      } else if (character === '"') {
        finishDesktopArchiveProbeString(state);
      } else {
        appendDesktopArchiveProbeString(state, character);
      }
    } else if (state.phase === "colon") {
      state.phase = /\s/.test(character) ? "colon" : character === ":" ? "value-start" : "invalid";
    } else if (state.phase === "value-start") {
      if (/\s/.test(character)) {
        // Keep waiting for the value token.
      } else if (character === '"') {
        state.phase = "string";
        state.stringKind = state.key === "cliSessionId" ? "cli" : "other";
        state.stringRaw = "";
        state.stringEscaped = false;
        state.stringTooLong = false;
      } else if (character === "{" || character === "[") {
        state.phase = "composite";
        state.compositeDepth = 1;
        state.compositeInString = false;
        state.compositeEscaped = false;
      } else {
        state.phase = "primitive";
        state.primitive = character;
      }
    } else if (state.phase === "string") {
      if (state.stringEscaped) {
        appendDesktopArchiveProbeString(state, character);
        state.stringEscaped = false;
      } else if (character === "\\") {
        state.stringEscaped = true;
        appendDesktopArchiveProbeString(state, character);
      } else if (character === '"') {
        finishDesktopArchiveProbeString(state);
      } else {
        appendDesktopArchiveProbeString(state, character);
      }
    } else if (state.phase === "primitive") {
      if (state.primitive.length >= 64) {
        state.phase = "invalid";
      } else {
        state.primitive += character;
      }
    } else if (state.phase === "composite") {
      if (state.compositeInString) {
        if (state.compositeEscaped) {
          state.compositeEscaped = false;
        } else if (character === "\\") {
          state.compositeEscaped = true;
        } else if (character === '"') {
          state.compositeInString = false;
        }
      } else if (character === '"') {
        state.compositeInString = true;
      } else if (character === "{" || character === "[") {
        state.compositeDepth += 1;
      } else if (character === "}" || character === "]") {
        state.compositeDepth -= 1;
        if (state.compositeDepth === 0) {
          state.phase = "after-value";
        }
      }
    } else if (state.phase === "after-value") {
      if (/\s/.test(character)) {
        // Keep waiting for the next property or the closing brace.
      } else if (character === ",") {
        state.phase = "key-or-end";
      } else if (character === "}") {
        state.phase = "done";
      } else {
        state.phase = "invalid";
      }
    }
    index += 1;
  }
}

export async function probeDesktopArchiveStatus(
  filePath: string,
  onIoFailure: () => void,
): Promise<
  { cliSessionId: string; isArchived: boolean; metadata?: DesktopSessionMetadata } | undefined
> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0) {
      return undefined;
    }
    const buffer = Buffer.allocUnsafe(DESKTOP_ARCHIVE_SCAN_CHUNK_BYTES);
    const decoder = new TextDecoder();
    const probe = createDesktopArchiveProbeState();
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        Math.min(buffer.length, stat.size - offset),
        offset,
      );
      if (bytesRead === 0) {
        onIoFailure();
        return undefined;
      }
      offset += bytesRead;
      consumeDesktopArchiveProbeText(
        probe,
        decoder.decode(buffer.subarray(0, bytesRead), { stream: offset < stat.size }),
      );
      if (probe.isArchived && probe.cliSessionId) {
        return { cliSessionId: probe.cliSessionId, isArchived: true };
      }
    }
    consumeDesktopArchiveProbeText(probe, decoder.decode());
    if (probe.cliSessionId) {
      if (probe.isArchived) {
        return { cliSessionId: probe.cliSessionId, isArchived: true };
      }
      // Recover the minimal validated record so desktop-only sessions keep their
      // row when the admitted read was rejected; unbounded fields stay absent.
      const metadata: DesktopSessionMetadata = {
        cliSessionId: probe.cliSessionId,
        ...(probe.sessionId !== undefined ? { sessionId: probe.sessionId } : {}),
        ...(probe.title !== undefined ? { title: probe.title } : {}),
        ...(probe.cwd !== undefined ? { cwd: probe.cwd } : {}),
        ...(probe.originCwd !== undefined ? { originCwd: probe.originCwd } : {}),
        ...(probe.createdAt !== undefined ? { createdAt: probe.createdAt } : {}),
        ...(probe.lastActivityAt !== undefined ? { lastActivityAt: probe.lastActivityAt } : {}),
      };
      return { cliSessionId: probe.cliSessionId, isArchived: false, metadata };
    }
    return undefined;
  } catch {
    onIoFailure();
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
