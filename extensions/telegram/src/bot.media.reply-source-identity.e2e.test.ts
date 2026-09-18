// Telegram tests cover reply media source identity from ingress to the provider image payload.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectAndLoadAgentHarnessPromptImages } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { readRemoteMediaBufferSpy, setNextSavedMediaPath } from "./bot.media.e2e.test-harness.js";
import { createBotHandlerWithOptions, mockTelegramPngDownload } from "./bot.media.test-utils.js";

// A decodable 1x1 PNG, so the prompt image loader treats both staged copies as real images.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function stageInboundPng(id: string): string {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("media harness state dir is not set");
  }
  const inboundDir = path.join(stateDir, "media", "inbound");
  mkdirSync(inboundDir, { recursive: true });
  const filePath = path.join(inboundDir, id);
  writeFileSync(filePath, PNG_BYTES);
  return filePath;
}

async function loadProviderImages(ctx: MsgContext) {
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
  // The same SDK loader agent harnesses use to build provider image input.
  const { images } = await detectAndLoadAgentHarnessPromptImages({
    prompt: "",
    workspaceDir: stateDir,
    model: { input: ["text", "image"] },
    media: ctx.media,
    localRoots: [stateDir],
  });
  const unique = new Set(
    images.map((image) => createHash("sha256").update(image.data).digest("hex")),
  );
  return { payloads: images.length, unique: unique.size };
}

const originalMessage = {
  message_id: 1101,
  chat: { id: 1234, type: "private" as const },
  from: { id: 777, is_bot: false, first_name: "Ada" },
  photo: [{ file_id: "original-file", file_unique_id: "shared-telegram-source" }],
  date: 1736380800,
};
const me = { id: 999, username: "openclaw_bot" };

describe("telegram reply media source identity", () => {
  // Parallel vitest shards can make this suite slower than the standalone run.
  const TEST_TIMEOUT_MS = process.platform === "win32" ? 120_000 : 90_000;

  it(
    "sends one provider image when the current and replied messages stage one source at different paths",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      const originalPath = stageInboundPng("original-source.png");
      const currentPath = stageInboundPng("current-source.png");

      try {
        setNextSavedMediaPath({ path: originalPath, id: "original-source.png" });
        await handler({
          message: originalMessage,
          me,
          getFile: async () => ({ file_path: "photos/original.png" }),
        });

        replySpy.mockClear();
        setNextSavedMediaPath({ path: currentPath, id: "current-source.png" });
        await handler({
          message: {
            message_id: 1102,
            chat: originalMessage.chat,
            from: originalMessage.from,
            photo: [{ file_id: "current-file", file_unique_id: "shared-telegram-source" }],
            reply_to_message: originalMessage,
            date: 1736380801,
          },
          me,
          getFile: async () => ({ file_path: "photos/current.png" }),
        });

        expect(runtimeError).not.toHaveBeenCalled();
        expect(replySpy).toHaveBeenCalledTimes(1);
        const ctx = replySpy.mock.calls[0]?.[0] as MsgContext | undefined;
        if (!ctx) {
          throw new Error("expected one reply call");
        }
        expect(await loadProviderImages(ctx)).toEqual({ payloads: 1, unique: 1 });
        expect(ctx).toMatchObject({ MediaPaths: [currentPath] });
      } finally {
        fetchSpy.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps the unavailable-media notice and the replied copy when the current download fails",
    async () => {
      const runtimeError = vi.fn();
      const { handler, replySpy } = await createBotHandlerWithOptions({ runtimeError });
      const fetchSpy = mockTelegramPngDownload();
      const originalPath = stageInboundPng("original-source.png");

      try {
        setNextSavedMediaPath({ path: originalPath, id: "original-source.png" });
        await handler({
          message: originalMessage,
          me,
          getFile: async () => ({ file_path: "photos/original.png" }),
        });

        replySpy.mockClear();
        readRemoteMediaBufferSpy.mockRejectedValueOnce(new Error("permanent download failure"));
        await handler({
          message: {
            message_id: 1102,
            chat: originalMessage.chat,
            from: originalMessage.from,
            caption: "same picture",
            photo: [{ file_id: "current-file", file_unique_id: "shared-telegram-source" }],
            reply_to_message: originalMessage,
            date: 1736380801,
          },
          me,
          getFile: async () => ({ file_path: "photos/current.png" }),
        });

        expect(replySpy).toHaveBeenCalledTimes(1);
        const ctx = replySpy.mock.calls[0]?.[0] as MsgContext | undefined;
        if (!ctx) {
          throw new Error("expected one reply call");
        }
        expect(ctx.BodyForAgent).toContain("[media unavailable: download failed]");
        // The failed current attachment claims no source, so the replied copy is the one image.
        expect(await loadProviderImages(ctx)).toEqual({ payloads: 1, unique: 1 });
      } finally {
        fetchSpy.mockRestore();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
