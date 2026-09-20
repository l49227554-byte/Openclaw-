import fs from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetInboundDedupe } from "openclaw/plugin-sdk/reply-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  defaultSlackTestConfig,
  getSlackClient,
  getSlackTestState,
  resetSlackTestState,
  runSlackMessageOnce,
} from "./monitor.test-helpers.js";
import type { SlackMessageEvent } from "./types.js";

const mediaFetchMock = vi.hoisted(() =>
  vi.fn<typeof import("./monitor/media.runtime.js").fetchWithRuntimeDispatcher>(),
);
vi.mock("./monitor/media.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor/media.runtime.js")>()),
  fetchWithRuntimeDispatcher: mediaFetchMock,
}));
const { monitorSlackProvider } = await import("./monitor/provider.js");
const slackTestState = getSlackTestState();
const { sendMock, replyMock } = slackTestState;

beforeEach(async () => {
  mediaFetchMock.mockReset().mockRejectedValue(new Error("Unexpected Slack media test request"));
  resetInboundDedupe();
  await resetSlackTestState(defaultSlackTestConfig());
});

function makeSlackMessageEvent(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    type: "message",
    user: "U1",
    text: "hello",
    ts: "123",
    channel: "C1",
    channel_type: "channel",
    ...overrides,
  };
}
function captureReplyContexts<T extends Record<string, unknown>>() {
  const contexts: T[] = [];
  replyMock.mockImplementation(async (ctx: unknown) => {
    contexts.push(ctx as T);
    return undefined;
  });
  return contexts;
}

describe("Slack native history sender policy through monitor dispatch", () => {
  it.each(["allowlist", "allowlist_quote", "all"] as const)(
    "enforces %s visibility before bot history hydration and dispatch",
    async (contextVisibility) => {
      slackTestState.config = {
        channels: {
          slack: {
            groupPolicy: "open",
            contextVisibility,
            channels: { C1: { requireMention: true, users: ["U1", "UALLOWED", "BONLY"] } },
          },
        },
      };
      const messages = [
        { ts: "102", user: "UDENIED", bot_id: "BONLY", text: "denied user identity" },
        { ts: "101", bot_id: "BDENIED", text: "denied bot identity" },
        { ts: "100", user: "UALLOWED", bot_id: "BALLOWED", text: "allowed bot user" },
        { ts: "99", bot_id: "BONLY", text: "allowed bot-only identity" },
      ].map((message) =>
        Object.assign(message, {
          files: [
            {
              id: `F${message.ts}`,
              name: `${message.ts}.png`,
              mimetype: "image/png",
              url_private: `https://files.slack.com/${message.ts}.png`,
            },
          ],
        }),
      );
      getSlackClient().conversations.history.mockResolvedValue({ messages });
      mediaFetchMock.mockImplementation(
        async () =>
          new Response(Buffer.from("image data"), {
            headers: { "content-type": "image/png" },
          }),
      );
      const captured = captureReplyContexts<{
        Body?: string;
        RawBody?: string;
        InboundHistory?: Array<{ body: string; media?: Array<{ path?: string }> }>;
      }>();
      try {
        await runSlackMessageOnce(
          monitorSlackProvider,
          {
            event: makeSlackMessageEvent({
              text: "<@bot-user> inspect prior bot discussion",
              ts: "103",
              channel_type: "channel",
            }),
          },
          { awaitDispatch: true },
        );
        expect(captured).toHaveLength(1);
        const visible = contextVisibility === "all" ? messages : messages.slice(2);
        expect(captured[0]?.InboundHistory?.map((entry) => entry.body)).toEqual(
          visible.toReversed().map((message) => message.text),
        );
        expect(captured[0]?.InboundHistory?.map((entry) => entry.media?.length)).toEqual(
          visible.map(() => 1),
        );
        expect(mediaFetchMock.mock.calls.map(([url]) => url)).toEqual(
          visible.toReversed().flatMap((message) => message.files.map((file) => file.url_private)),
        );
        expect(captured[0]?.RawBody).toContain("inspect prior bot discussion");
        expect(captured[0]?.Body).toContain("allowed bot user");
        expect(captured[0]?.Body).toContain("allowed bot-only identity");
        if (contextVisibility !== "all") {
          expect(captured[0]?.Body).not.toContain("denied");
        }
      } finally {
        for (const ctx of captured) {
          for (const entry of ctx.InboundHistory ?? []) {
            for (const media of entry.media ?? []) {
              if (media.path) {
                await fs.rm(media.path, { force: true });
              }
            }
          }
        }
      }
    },
  );

  it.each(["room", "thread"] as const)(
    "stops %s bot history media and dispatch when live policy is revoked during its native read",
    async (scope) => {
      const config: OpenClawConfig = {
        channels: {
          slack: {
            groupPolicy: "open",
            contextVisibility: "allowlist",
            channels: { C1: { requireMention: true, users: ["U1", "UALLOWED"] } },
          },
        },
      };
      const revoked: OpenClawConfig = {
        channels: { slack: { ...config.channels?.slack, enabled: false } },
      };
      slackTestState.config = config;
      setRuntimeConfigSnapshot(config, config);
      const client = getSlackClient();
      const read = scope === "thread" ? client.conversations.replies : client.conversations.history;
      read.mockImplementation(async () => {
        setRuntimeConfigSnapshot(revoked, revoked);
        return {
          messages: [
            {
              ts: "100",
              user: "UALLOWED",
              bot_id: "BALLOWED",
              text: "revoked bot context",
              files: [
                {
                  id: "FREVOKED",
                  name: "revoked.png",
                  mimetype: "image/png",
                  url_private: "https://files.slack.com/revoked.png",
                },
              ],
            },
          ],
        };
      });
      try {
        await runSlackMessageOnce(
          monitorSlackProvider,
          {
            event: makeSlackMessageEvent({
              text: "<@bot-user> inspect bot discussion",
              ts: "103",
              channel_type: "channel",
              ...(scope === "thread" ? { thread_ts: "100" } : {}),
            }),
          },
          { awaitDispatch: true },
        ).catch((error: unknown) => {
          expect(error).toBeInstanceOf(Error);
        });
        expect(read).toHaveBeenCalledOnce();
        expect(mediaFetchMock).not.toHaveBeenCalled();
        expect(replyMock).not.toHaveBeenCalled();
        expect(sendMock).not.toHaveBeenCalled();
      } finally {
        clearRuntimeConfigSnapshot();
      }
    },
  );
});
