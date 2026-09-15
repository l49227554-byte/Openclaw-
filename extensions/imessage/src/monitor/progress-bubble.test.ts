// Progress bubble tests cover the narrated edit-in-place lifecycle,
// especially the dispose race: a queued update that resolves its send while
// dispose is waiting must still be retracted, not orphaned in the chat.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type SendResult = { guid?: string; messageId?: string };

const sendMessageIMessageMock = vi.hoisted(() => vi.fn<Promise<SendResult>, [string, string]>());

const rpcRequests: Array<{ method: string; params: Record<string, unknown> }> = [];

vi.mock("../send.js", () => ({
  sendMessageIMessage: (to: string, message: string, opts?: unknown) =>
    sendMessageIMessageMock(to, message, opts),
}));

vi.mock("../client.js", () => ({
  createIMessageRpcClient: async () => ({
    request: async (method: string, params: Record<string, unknown>) => {
      rpcRequests.push({ method, params });
      if (method === "message.edit" && String(params.text).includes("second")) {
        // Force the update to take the rotate-on-failure path.
        throw new Error("edit window expired");
      }
      return { ok: true };
    },
    stop: async () => {},
  }),
}));

vi.mock("../remote-host.js", () => ({
  resolveIMessageRemoteHost: async () => undefined,
}));

describe("iMessage progress bubble", () => {
  let createIMessageProgressBubble: typeof import("./progress-bubble.js").createIMessageProgressBubble;

  const cfg = {
    channels: { imessage: { accounts: { default: {} } } },
  } as unknown as OpenClawConfig;
  const runtime = { log: vi.fn() } as unknown as RuntimeEnv;
  // The turn's inbound message guid — every bubble send must thread back to
  // it, or the bubble reads as a standalone response in group chats.
  const inboundGuid = "inbound-msg-guid";

  beforeAll(async () => {
    ({ createIMessageProgressBubble } = await import("./progress-bubble.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    rpcRequests.length = 0;
    sendMessageIMessageMock.mockImplementation(async (_to, message) => ({
      guid: `guid-for:${message}`,
    }));
  });

  it("edits the bubble in place without re-sending", async () => {
    const bubble = createIMessageProgressBubble({
      cfg,
      accountId: "default",
      target: "+15043825603",
      replyToId: inboundGuid,
      runtime,
    });
    await bubble.update("starting");
    await bubble.update("halfway");
    expect(sendMessageIMessageMock).toHaveBeenCalledTimes(1);
    // The bubble must thread to the message the turn is working on.
    expect(sendMessageIMessageMock).toHaveBeenCalledWith(
      "+15043825603",
      expect.stringContaining("starting"),
      expect.objectContaining({ replyToId: inboundGuid }),
    );
    const edits = rpcRequests.filter((r) => r.method === "message.edit");
    expect(edits).toHaveLength(1);
    expect(edits[0]?.params.text).toContain("halfway");
    await bubble.dispose();
    expect(rpcRequests.some((r) => r.method === "message.unsend")).toBe(true);
  });

  it("retracts a bubble sent by a queued update that lands during dispose", async () => {
    const bubble = createIMessageProgressBubble({
      cfg,
      accountId: "default",
      target: "+15043825603",
      replyToId: inboundGuid,
      runtime,
    });
    await bubble.update("first");

    // Force the next update to rotate (edit fails, as with an expired window
    // or retracted bubble) and make the rotate-send block until dispose is
    // waiting on the chain: the rotation therefore completes its send AFTER
    // dispose has started. The rotated bubble must still be unsent.
    let releaseBlockedSend: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseBlockedSend = resolve;
    });
    rpcRequests.length = 0;
    sendMessageIMessageMock.mockImplementation(async (_to, message) => {
      await blocked;
      return { guid: `guid-for:${message}` };
    });
    const queued = bubble.update("second");

    // Let the queued update pass its stopped check and block inside the
    // rotate-send, so it is genuinely mid-flight when dispose runs.
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
    const disposePromise = bubble.dispose();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    releaseBlockedSend?.();
    await queued;
    await disposePromise;

    const unsent = rpcRequests
      .filter((r) => r.method === "message.unsend")
      .map((r) => r.params.message_id);
    // The rotated bubble's guid (guid-for:… second) must be retracted; had
    // dispose snapshotted before awaiting the chain, it would be orphaned.
    expect(unsent).toContain("guid-for:… second");
    // Rotation sends thread like the initial send — every bubble send
    // carries the reply target, not just the first one.
    expect(sendMessageIMessageMock).toHaveBeenLastCalledWith(
      "+15043825603",
      expect.stringContaining("second"),
      expect.objectContaining({ replyToId: inboundGuid }),
    );
  });
});
