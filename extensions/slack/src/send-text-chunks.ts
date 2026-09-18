// Outbound text chunking for Slack sends.
//
// Extracted from send.ts so the grapheme-safe cut has a coherent owner and so send.ts
// stops growing against the repository line-cap ratchet.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { resolveTextChunksWithFallback } from "openclaw/plugin-sdk/reply-payload";
import { avoidTrailingGraphemeBreak } from "openclaw/plugin-sdk/text-chunking";
import { sliceUtf16Safe, truncateCodePoints } from "openclaw/plugin-sdk/text-utility-runtime";
import { chunkSlackMrkdwnText, markdownToSlackMrkdwnChunks } from "./format.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";

export function resolveSlackTextChunkLimit(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  textLimit?: number;
}): number {
  const configuredLimit =
    params.textLimit ??
    resolveTextChunkLimit(params.cfg, "slack", params.accountId, {
      fallbackLimit: SLACK_TEXT_LIMIT,
    });
  return Math.min(configuredLimit, SLACK_TEXT_LIMIT);
}

export function resolveSlackTextChunks(params: {
  cfg: OpenClawConfig;
  accountId?: string;
  text: string;
  textLimit?: number;
  textIsSlackMrkdwn?: boolean;
  preservePlainText?: boolean;
}): string[] {
  const text = params.preservePlainText ? params.text : params.text.trim();
  const chunkLimit = resolveSlackTextChunkLimit(params);
  if (params.preservePlainText) {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining) {
      // Grapheme-aware: a ZWJ sequence, flag or combining mark must not be divided
      // across two Slack messages.
      const cut = avoidTrailingGraphemeBreak(remaining, 0, chunkLimit);
      const chunk = sliceUtf16Safe(remaining, 0, cut) || truncateCodePoints(remaining, 1);
      chunks.push(chunk);
      remaining = remaining.slice(chunk.length);
    }
    return chunks;
  }
  if (params.textIsSlackMrkdwn) {
    return resolveTextChunksWithFallback(text, chunkSlackMrkdwnText(text, chunkLimit));
  }
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "slack",
    ...(params.accountId ? { accountId: params.accountId } : {}),
  });
  const chunkMode = resolveChunkMode(params.cfg, "slack", params.accountId);
  const markdownChunks =
    chunkMode === "newline" ? chunkMarkdownTextWithMode(text, chunkLimit, chunkMode) : [text];
  const chunks = markdownChunks.flatMap((markdown) =>
    markdownToSlackMrkdwnChunks(markdown, chunkLimit, { tableMode }),
  );
  return resolveTextChunksWithFallback(text, chunks);
}
