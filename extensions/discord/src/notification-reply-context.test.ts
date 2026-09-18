// Discord tests cover persisted host notification reply context.
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";

const openKeyedStore = vi.hoisted(() => vi.fn((_options: OpenKeyedStoreOptions): unknown => ({})));
const warn = vi.hoisted(() => vi.fn());

vi.mock("./runtime.js", () => ({
  getOptionalDiscordRuntime: () => ({
    state: { openKeyedStore },
    logging: { getChildLogger: () => ({ warn }) },
  }),
}));

import {
  isDiscordNotificationReplyTarget,
  recordDiscordNotificationReplyContext,
} from "./notification-reply-context.js";

afterEach(() => {
  resetPluginStateStoreForTests();
  openKeyedStore.mockReset().mockReturnValue({});
  warn.mockReset();
});

describe("Discord notification reply context", () => {
  it("keeps recorded notification ids across a gateway restart", async () => {
    await withOpenClawTestState({ label: "discord-notification-reply-context" }, async () => {
      openKeyedStore.mockImplementation((options) =>
        createPluginStateKeyedStoreForTests<true>("discord", options),
      );

      await recordDiscordNotificationReplyContext({
        cfg: {},
        accountId: "work",
        results: [
          {
            channel: "discord",
            messageId: "chunk-2",
            receipt: { platformMessageIds: ["chunk-1", "chunk-2"], parts: [], sentAt: 1 },
          },
        ],
      });
      resetPluginStateStoreForTests();

      await expect(
        isDiscordNotificationReplyTarget({ accountId: "work", messageId: "chunk-1" }),
      ).resolves.toBe(true);
      await expect(
        isDiscordNotificationReplyTarget({ accountId: "work", messageId: "chunk-2" }),
      ).resolves.toBe(true);
      await expect(
        isDiscordNotificationReplyTarget({ accountId: "default", messageId: "chunk-1" }),
      ).resolves.toBe(false);
      await expect(
        isDiscordNotificationReplyTarget({ accountId: "work", messageId: "unrelated" }),
      ).resolves.toBe(false);
    });
  });

  it("bounds the store by evicting the oldest notifications", async () => {
    const register = vi.fn(async () => {});
    openKeyedStore.mockReturnValue({ register });

    await recordDiscordNotificationReplyContext({
      cfg: {},
      results: [{ channel: "discord", messageId: "msg-1" }],
    });

    expect(openKeyedStore).toHaveBeenCalledWith({
      namespace: "notification-reply-context",
      maxEntries: 10_000,
      overflowPolicy: "evict-oldest",
    });
    expect(register).toHaveBeenCalledWith("default:msg-1", true);
  });

  it("skips results that did not reach Discord", async () => {
    const register = vi.fn(async () => {});
    openKeyedStore.mockReturnValue({ register });

    await recordDiscordNotificationReplyContext({
      cfg: {},
      results: [
        { channel: "discord", messageId: "msg-1", outcome: "not_sent" },
        { channel: "slack", messageId: "msg-2" },
      ],
    });

    expect(openKeyedStore).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("falls back to hiding the quote when the store is unavailable", async () => {
    openKeyedStore.mockImplementation(() => {
      throw new Error("sqlite unavailable");
    });

    await expect(
      recordDiscordNotificationReplyContext({
        cfg: {},
        results: [{ channel: "discord", messageId: "msg-1" }],
      }),
    ).resolves.toBeUndefined();
    await expect(
      isDiscordNotificationReplyTarget({ accountId: "default", messageId: "msg-1" }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
