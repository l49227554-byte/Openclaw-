// Matrix tests cover poll and typing sends (split from send.test.ts for the line-cap ratchet).
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../../runtime-api.js";
import { setMatrixRuntime } from "../runtime.js";
import { voteMatrixPoll } from "./actions/polls.js";
import { sendPollMatrix, sendTypingMatrix } from "./send.js";

const loadOutboundMediaFromUrlMock = vi.hoisted(() => vi.fn());
const loadWebMediaMock = vi.fn().mockResolvedValue({
  buffer: Buffer.from("media"),
  fileName: "photo.png",
  contentType: "image/png",
  kind: "image",
});
const loadConfigMock = vi.fn(() => ({}));
const withResolvedRuntimeMatrixClientMock = vi.hoisted(() => vi.fn());
const getImageMetadataMock = vi.fn().mockResolvedValue(null);
const resizeToJpegMock = vi.fn();
const mediaKindFromMimeMock = vi.fn((_mime: string | null | undefined) => "image");
const isVoiceCompatibleAudioMock = vi.fn(
  (_options: { contentType?: string | null; fileName?: string | null }) => false,
);
const resolveTextChunkLimitMock = vi.fn<
  (cfg: unknown, channel: unknown, accountId?: unknown) => number
>(() => 4000);
const resolveMarkdownTableModeMock = vi.fn((_params?: unknown) => "code");
const chunkMarkdownTextWithModeMock = vi.fn<
  (text: string, limit?: number, mode?: unknown) => string[]
>((text) => (text ? [text] : []));

vi.mock("openclaw/plugin-sdk/plugin-config-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/plugin-config-runtime")>(
    "openclaw/plugin-sdk/plugin-config-runtime",
  );
  return {
    ...actual,
    requireRuntimeConfig: vi.fn((cfg: unknown) => cfg ?? loadConfigMock()),
  };
});

vi.mock("./outbound-media-runtime.js", () => ({
  loadOutboundMediaFromUrl: loadOutboundMediaFromUrlMock,
}));

vi.mock("./client-bootstrap.js", () => ({
  withResolvedRuntimeMatrixClient: withResolvedRuntimeMatrixClientMock,
}));

const runtimeStub = {
  config: {
    current: () => loadConfigMock(),
  },
  media: {
    loadWebMedia: (...args: unknown[]) => loadWebMediaMock(...args),
    mediaKindFromMime: (mime?: string | null) => mediaKindFromMimeMock(mime),
    isVoiceCompatibleAudio: (opts: { contentType?: string | null; fileName?: string | null }) =>
      isVoiceCompatibleAudioMock(opts),
    getImageMetadata: (...args: unknown[]) => getImageMetadataMock(...args),
    resizeToJpeg: (...args: unknown[]) => resizeToJpegMock(...args),
  },
  channel: {
    text: {
      resolveTextChunkLimit: (cfg: unknown, channel: unknown, accountId?: unknown) =>
        resolveTextChunkLimitMock(cfg, channel, accountId),
      resolveChunkMode: () => "length",
      chunkMarkdownText: (text: string) => (text ? [text] : []),
      chunkMarkdownTextWithMode: (text: string, limit: number, mode: unknown) =>
        chunkMarkdownTextWithModeMock(text, limit, mode),
      resolveMarkdownTableMode: (params: unknown) => resolveMarkdownTableModeMock(params),
      convertMarkdownTables: (text: string) => text,
    },
  },
} as unknown as PluginRuntime;

function applyMatrixSendRuntimeStub() {
  setMatrixRuntime(runtimeStub);
}

const makeClient = () => {
  const sendMessage = vi.fn().mockResolvedValue("evt1");
  const sendEvent = vi.fn().mockResolvedValue("evt-poll-vote");
  const getEvent = vi.fn();
  const getRelations = vi.fn().mockResolvedValue({ events: [], nextBatch: null });
  const getJoinedRoomMembers = vi.fn().mockResolvedValue([]);
  const uploadContent = vi.fn().mockResolvedValue("mxc://example/file");
  const prepareRoomForMessageSend = vi.fn();
  const client = {
    sendMessage,
    sendEvent,
    getEvent,
    getRelations,
    getJoinedRoomMembers,
    uploadContent,
    prepareRoomForMessageSend,
    getTransactionScopeId: vi.fn().mockResolvedValue("scope-1"),
    getMessageWireEventType: vi.fn().mockResolvedValue("m.room.message"),
    getUserId: vi.fn().mockResolvedValue("@bot:example.org"),
    prepareForOneOff: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    stopAndPersist: vi.fn(async () => undefined),
  } as unknown as import("./sdk.js").MatrixClient;
  prepareRoomForMessageSend.mockImplementation(
    async (roomId: string, content?: import("./sdk.js").MessageEventContent) => {
      const eventType = await client.getMessageWireEventType(roomId);
      if (eventType === "m.room.encrypted" && !client.crypto) {
        throw new Error("Encrypted Matrix room: enable encryption before sending messages");
      }
      if (
        eventType === "m.room.encrypted" &&
        (typeof content?.url === "string" ||
          (content?.info &&
            "thumbnail_url" in content.info &&
            typeof content.info.thumbnail_url === "string"))
      ) {
        throw new Error("Encrypted Matrix room contains unencrypted media; retry the send");
      }
      return eventType;
    },
  );
  return {
    client,
    sendMessage,
    sendEvent,
    getEvent,
    getRelations,
    getJoinedRoomMembers,
    uploadContent,
  };
};

const requireRecord = createRequireRecord("object", "expected-label");

function mockCallArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  label: string,
  argIndex: number,
) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[argIndex];
}

function resetMatrixSendRuntimeMocks() {
  setMatrixRuntime(runtimeStub);
  loadOutboundMediaFromUrlMock.mockReset().mockImplementation(
    async (
      mediaUrl: string,
      options?: {
        maxBytes?: number;
        mediaLocalRoots?: readonly string[];
        mediaReadFile?: (filePath: string) => Promise<Buffer>;
      },
    ) =>
      await loadWebMediaMock(mediaUrl, {
        maxBytes: options?.maxBytes,
        localRoots: options?.mediaLocalRoots,
        hostReadCapability: false,
        readFile: options?.mediaReadFile,
      }),
  );
  loadWebMediaMock.mockReset().mockResolvedValue({
    buffer: Buffer.from("media"),
    fileName: "photo.png",
    contentType: "image/png",
    kind: "image",
  });
  loadConfigMock.mockReset().mockReturnValue({});
  withResolvedRuntimeMatrixClientMock
    .mockReset()
    .mockImplementation(
      async (
        opts: { client?: import("./sdk.js").MatrixClient },
        run: (resolved: import("./sdk.js").MatrixClient) => Promise<unknown>,
      ) => {
        if (!opts.client) {
          throw new Error("test Matrix client is required");
        }
        return await run(opts.client);
      },
    );
  getImageMetadataMock.mockReset().mockResolvedValue(null);
  resizeToJpegMock.mockReset();
  mediaKindFromMimeMock.mockReset().mockReturnValue("image");
  isVoiceCompatibleAudioMock.mockReset().mockReturnValue(false);
  resolveTextChunkLimitMock.mockReset().mockReturnValue(4000);
  resolveMarkdownTableModeMock.mockReset().mockReturnValue("code");
  chunkMarkdownTextWithModeMock
    .mockReset()
    .mockImplementation((text: string) => (text ? [text] : []));
  applyMatrixSendRuntimeStub();
}

describe("sendPollMatrix mentions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMatrixSendRuntimeMocks();
  });

  it("adds m.mentions for poll fallback text", async () => {
    const { client, sendEvent } = makeClient();

    await sendPollMatrix(
      "room:!room:example",
      {
        question: "@room lunch with @alice:example.org?",
        options: ["yes", "no"],
      },
      {
        client,
        cfg: {} as never,
      },
    );

    expect(mockCallArg(sendEvent, "sendEvent", 0)).toBe("!room:example");
    expect(mockCallArg(sendEvent, "sendEvent", 1)).toBe("m.poll.start");
    const content = requireRecord(mockCallArg(sendEvent, "sendEvent", 2), "poll start content");
    expect(content["m.mentions"]).toEqual({
      room: true,
      user_ids: ["@alice:example.org"],
    });
  });
});

describe("voteMatrixPoll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMatrixSendRuntimeMocks();
  });

  it("maps 1-based option indexes to Matrix poll answer ids", async () => {
    const { client, getEvent, sendEvent } = makeClient();
    getEvent.mockResolvedValue({
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          max_selections: 1,
          answers: [
            { id: "a1", "m.text": "Pizza" },
            { id: "a2", "m.text": "Sushi" },
          ],
        },
      },
    });

    const result = await voteMatrixPoll("room:!room:example", "$poll", {
      client,
      cfg: {} as never,
      optionIndex: 2,
    });

    expect(sendEvent).toHaveBeenCalledWith("!room:example", "m.poll.response", {
      "m.poll.response": { answers: ["a2"] },
      "org.matrix.msc3381.poll.response": { answers: ["a2"] },
      "m.relates_to": {
        rel_type: "m.reference",
        event_id: "$poll",
      },
    });
    expect(result.eventId).toBe("evt-poll-vote");
    expect(result.roomId).toBe("!room:example");
    expect(result.pollId).toBe("$poll");
    expect(result.answerIds).toEqual(["a2"]);
    expect(result.labels).toEqual(["Sushi"]);
  });

  it("rejects out-of-range option indexes", async () => {
    const { client, getEvent } = makeClient();
    getEvent.mockResolvedValue({
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          max_selections: 1,
          answers: [{ id: "a1", "m.text": "Pizza" }],
        },
      },
    });

    await expect(
      voteMatrixPoll("room:!room:example", "$poll", {
        client,
        cfg: {} as never,
        optionIndex: 2,
      }),
    ).rejects.toThrow("out of range");
  });

  it("rejects votes that exceed the poll selection cap", async () => {
    const { client, getEvent } = makeClient();
    getEvent.mockResolvedValue({
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          max_selections: 1,
          answers: [
            { id: "a1", "m.text": "Pizza" },
            { id: "a2", "m.text": "Sushi" },
          ],
        },
      },
    });

    await expect(
      voteMatrixPoll("room:!room:example", "$poll", {
        client,
        cfg: {} as never,
        optionIndexes: [1, 2],
      }),
    ).rejects.toThrow("at most 1 selection");
  });

  it("rejects non-poll events before sending a response", async () => {
    const { client, getEvent, sendEvent } = makeClient();
    getEvent.mockResolvedValue({
      type: "m.room.message",
      content: { body: "hello" },
    });

    await expect(
      voteMatrixPoll("room:!room:example", "$poll", {
        client,
        cfg: {} as never,
        optionIndex: 1,
      }),
    ).rejects.toThrow("is not a Matrix poll start event");
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("accepts decrypted poll start events returned from encrypted rooms", async () => {
    const { client, getEvent, sendEvent } = makeClient();
    getEvent.mockResolvedValue({
      type: "m.poll.start",
      content: {
        "m.poll.start": {
          question: { "m.text": "Lunch?" },
          max_selections: 1,
          answers: [{ id: "a1", "m.text": "Pizza" }],
        },
      },
    });

    const result = await voteMatrixPoll("room:!room:example", "$poll", {
      client,
      cfg: {} as never,
      optionIndex: 1,
    });
    expect(result.pollId).toBe("$poll");
    expect(result.answerIds).toEqual(["a1"]);
    expect(sendEvent).toHaveBeenCalledWith("!room:example", "m.poll.response", {
      "m.poll.response": { answers: ["a1"] },
      "org.matrix.msc3381.poll.response": { answers: ["a1"] },
      "m.relates_to": {
        rel_type: "m.reference",
        event_id: "$poll",
      },
    });
  });
});

describe("sendTypingMatrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMatrixSendRuntimeMocks();
  });

  it("normalizes room-prefixed targets before sending typing state", async () => {
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const client = {
      setTyping,
      prepareForOneOff: vi.fn(async () => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(() => undefined),
      stopAndPersist: vi.fn(async () => undefined),
    } as unknown as import("./sdk.js").MatrixClient;

    await sendTypingMatrix("room:!room:example", true, undefined, client);

    expect(setTyping).toHaveBeenCalledWith("!room:example", true, 30_000);
  });

  it("passes account config through when resolving the typing client", async () => {
    const cfg = { channels: { matrix: {} } } as unknown as import("../types.js").CoreConfig;
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const client = {
      setTyping,
    } as unknown as import("./sdk.js").MatrixClient;
    withResolvedRuntimeMatrixClientMock.mockImplementation(
      async (
        opts: Record<string, unknown>,
        run: (resolved: import("./sdk.js").MatrixClient) => Promise<void>,
      ) => {
        expect(opts.cfg).toBe(cfg);
        expect(opts.accountId).toBe("work");
        expect(opts.timeoutMs).toBe(12_345);
        expect(opts.readiness).toBe("none");
        return await run(client);
      },
    );

    await sendTypingMatrix("room:!room:example", true, {
      cfg,
      accountId: "work",
      timeoutMs: 12_345,
    });

    expect(setTyping).toHaveBeenCalledWith("!room:example", true, 12_345);
  });
});
