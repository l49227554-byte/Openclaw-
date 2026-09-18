// Telegram tests cover request timeouts plugin behavior.
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import {
  getTelegramUploadBytes,
  recordTelegramUploadBytes,
  resolveTelegramLongPollTimeoutSeconds,
  resolveTelegramRequestTimeoutMs,
  resolveTelegramStartupProbeTimeoutMs,
  telegramUploadTimeoutTransformer,
} from "./request-timeouts.js";

const MIB = 1024 * 1024;

describe("resolveTelegramRequestTimeoutMs", () => {
  it("bounds Telegram startup control-plane methods", () => {
    expect(resolveTelegramRequestTimeoutMs("deletemycommands")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("deletewebhook")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("getme")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("setmycommands")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("setwebhook")).toBe(15_000);
  });

  it("keeps the longer polling timeout for getUpdates", () => {
    expect(resolveTelegramRequestTimeoutMs("getupdates")).toBe(45_000);
  });

  it("bounds outbound delivery methods", () => {
    expect(resolveTelegramRequestTimeoutMs("sendmessage")).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("sendchataction")).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("sendmessagedraft")).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("editmessagetext")).toBe(15_000);
    expect(resolveTelegramRequestTimeoutMs("sendphoto")).toBe(30_000);
  });

  it("honors higher configured timeoutSeconds except for long polling", () => {
    expect(resolveTelegramRequestTimeoutMs("sendmessage", 90)).toBe(90_000);
    expect(resolveTelegramRequestTimeoutMs("sendchataction", 90)).toBe(90_000);
    expect(resolveTelegramRequestTimeoutMs("editmessagetext", 90)).toBe(90_000);
    expect(resolveTelegramRequestTimeoutMs("getupdates", 90)).toBe(45_000);
  });

  it("caps oversized configured timeoutSeconds before outbound timers use them", () => {
    expect(resolveTelegramRequestTimeoutMs("sendmessage", Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
    expect(resolveTelegramRequestTimeoutMs("sendmessage", Number.MAX_VALUE)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
  });

  it("does not let low timeoutSeconds shorten method guards", () => {
    expect(resolveTelegramRequestTimeoutMs("sendmessage", 10)).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("getme", 10)).toBe(15_000);
  });

  it("uses the outbound guard for unlisted Telegram methods", () => {
    expect(resolveTelegramRequestTimeoutMs("answercallbackquery")).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("answercallbackquery", 10)).toBe(60_000);
    expect(resolveTelegramRequestTimeoutMs("answercallbackquery", 90)).toBe(90_000);
  });

  it("does not assign a timeout when no Telegram method can be identified", () => {
    expect(resolveTelegramRequestTimeoutMs(null)).toBeUndefined();
  });

  it("keeps table guards for uploads that fit inside them", () => {
    expect(resolveTelegramRequestTimeoutMs("sendphoto", undefined, MIB)).toBe(30_000);
    // 30 MiB moves in 15s at 2 MiB/s; with the 15s margin that is the table value.
    expect(resolveTelegramRequestTimeoutMs("senddocument", undefined, 30 * MIB)).toBe(30_000);
  });

  it("adds transfer time for uploads that outgrow their table guard", () => {
    expect(resolveTelegramRequestTimeoutMs("senddocument", undefined, 30 * MIB + 1)).toBe(31_000);
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, 100 * MIB)).toBe(65_000);
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, 900 * MIB)).toBe(465_000);
    expect(resolveTelegramRequestTimeoutMs("sendmediagroup", undefined, 200 * MIB)).toBe(115_000);
  });

  it("caps upload guards at 30 minutes", () => {
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, 8 * 1024 * MIB)).toBe(1_800_000);
  });

  it("ignores upload size for getUpdates and unusable sizes", () => {
    expect(resolveTelegramRequestTimeoutMs("getupdates", undefined, 100 * MIB)).toBe(45_000);
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, Number.NaN)).toBe(30_000);
    expect(resolveTelegramRequestTimeoutMs("sendvideo", undefined, -1)).toBe(30_000);
  });
});

describe("telegramUploadTimeoutTransformer", () => {
  it("exposes recorded upload bytes only to the request that carries the file", async () => {
    const transform = telegramUploadTimeoutTransformer as unknown as (
      prev: () => Promise<unknown>,
      method: string,
      payload: Record<string, unknown>,
    ) => Promise<unknown>;
    const video = recordTelegramUploadBytes({}, 100 * MIB);
    const photo = recordTelegramUploadBytes({}, MIB);
    const seen: Array<number | undefined> = [];
    const prev = async () => {
      seen.push(getTelegramUploadBytes());
      return { ok: true, result: true };
    };

    await transform(prev, "sendVideo", { chat_id: 1, video });
    await transform(prev, "sendMediaGroup", {
      chat_id: 1,
      media: [
        { type: "video", media: video },
        { type: "photo", media: photo },
      ],
    });
    await transform(prev, "sendMessage", { chat_id: 1, text: "done" });

    expect(seen).toEqual([100 * MIB, 101 * MIB, undefined]);
    expect(getTelegramUploadBytes()).toBeUndefined();
  });
});

describe("resolveTelegramLongPollTimeoutSeconds", () => {
  it("uses Telegram's default long-poll duration when no client timeout is configured", () => {
    expect(resolveTelegramLongPollTimeoutSeconds(undefined)).toBe(30);
  });

  it("keeps isolated long polling below the getUpdates request abort guard", () => {
    expect(resolveTelegramLongPollTimeoutSeconds(90)).toBe(40);
  });

  it("honors lower configured long-poll durations", () => {
    expect(resolveTelegramLongPollTimeoutSeconds(10)).toBe(10);
  });
});

describe("resolveTelegramStartupProbeTimeoutMs", () => {
  it("uses the getMe request guard by default", () => {
    expect(resolveTelegramStartupProbeTimeoutMs(undefined)).toBe(15_000);
  });

  it("does not let low client timeoutSeconds shorten startup getMe", () => {
    expect(resolveTelegramStartupProbeTimeoutMs(2)).toBe(15_000);
  });

  it("honors higher configured timeoutSeconds", () => {
    expect(resolveTelegramStartupProbeTimeoutMs(60)).toBe(60_000);
  });

  it("caps oversized configured timeoutSeconds before startup probe timers use them", () => {
    expect(resolveTelegramStartupProbeTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      MAX_TIMER_TIMEOUT_MS,
    );
    expect(resolveTelegramStartupProbeTimeoutMs(Number.MAX_VALUE)).toBe(MAX_TIMER_TIMEOUT_MS);
  });
});
