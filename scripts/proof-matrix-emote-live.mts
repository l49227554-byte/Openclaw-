import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { matrixPlugin } from "../extensions/matrix/src/channel.ts";
import type { MatrixClient } from "../extensions/matrix/src/matrix/sdk.ts";
import { sendMessageMatrix } from "../extensions/matrix/src/matrix/send.ts";
import { setMatrixRuntime } from "../extensions/matrix/src/runtime.ts";
import { provisionMatrixQaRoom } from "../extensions/qa-lab/src/live-transports/matrix/substrate/client.ts";
import { startMatrixQaHarness } from "../extensions/qa-lab/src/live-transports/matrix/substrate/harness.runtime.ts";
import { executeMessageSend } from "../src/infra/outbound/message-action-send.ts";
import { pluginInstanceInvocation } from "../src/plugins/plugin-instance-invocation.ts";

type RecordValue = Record<string, unknown>;

function requireRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} was not a non-empty string`);
  }
  return value;
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readMatrixEvent(params: {
  accessToken: string;
  baseUrl: string;
  eventId: string;
  roomId: string;
}) {
  const response = await fetch(
    `${params.baseUrl}_matrix/client/v3/rooms/${encodeURIComponent(params.roomId)}/event/${encodeURIComponent(params.eventId)}`,
    {
      headers: { authorization: `Bearer ${params.accessToken}` },
    },
  );
  if (!response.ok) {
    throw new Error(`Matrix event readback failed with HTTP ${response.status}`);
  }
  return requireRecord(await response.json(), "Matrix event readback");
}

const proofStateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-matrix-emote-proof-"));
const harness = await startMatrixQaHarness({
  outputDir: proofStateDir,
  repoRoot: process.cwd(),
});
console.error("proof: homeserver healthy");

try {
  const suffix = randomUUID().slice(0, 8);
  const provisioning = await provisionMatrixQaRoom({
    baseUrl: harness.baseUrl,
    driverLocalpart: `proof-driver-${suffix}`,
    observerLocalpart: `proof-observer-${suffix}`,
    registrationToken: harness.registrationToken,
    roomName: `OpenClaw emote proof ${suffix}`,
    sutLocalpart: `proof-sut-${suffix}`,
  });
  console.error("proof: accounts and room provisioned");
  const roomId = provisioning.roomId;
  setMatrixRuntime({
    config: { current: () => ({}) },
    state: { resolveStateDir: () => proofStateDir },
    channel: {
      text: {
        resolveTextChunkLimit: () => 4000,
        resolveChunkMode: () => "length",
        chunkMarkdownText: (text: string) => (text ? [text] : []),
        chunkMarkdownTextWithMode: (text: string) => (text ? [text] : []),
        resolveMarkdownTableMode: () => "code",
        convertMarkdownTables: (text: string) => text,
      },
    },
  } as never);
  console.error("proof: Matrix runtime configured");

  const cfg = {
    channels: {
      matrix: {
        enabled: true,
        homeserver: harness.upstreamBaseUrl,
        userId: provisioning.sut.userId,
        accessToken: provisioning.sut.accessToken,
        encryption: false,
      },
    },
  };
  let wireSendCount = 0;
  let lastWireEventId = "";
  const proofTransport = {
    async prepareRoomForMessageSend() {
      return "m.room.message" as const;
    },
    async sendMessage(targetRoomId: string, content: RecordValue, transactionId?: string) {
      wireSendCount += 1;
      const txnId = transactionId || randomUUID();
      const response = await fetch(
        `${harness.upstreamBaseUrl}_matrix/client/v3/rooms/${encodeURIComponent(targetRoomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
        {
          method: "PUT",
          headers: {
            authorization: `Bearer ${provisioning.sut.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(content),
        },
      );
      if (!response.ok) {
        throw new Error(`Matrix event send failed with HTTP ${response.status}`);
      }
      const eventId = requireString(
        requireRecord(await response.json(), "Matrix event send response").event_id,
        "event_id",
      );
      lastWireEventId = eventId;
      return eventId;
    },
  } as unknown as MatrixClient;
  console.error("proof: production Matrix sender configured with real homeserver transport");
  const matrix = async (to: string, message: string | undefined, options: RecordValue) => {
    const result = await pluginInstanceInvocation.exit(() =>
      sendMessageMatrix(to, message, {
        ...options,
        client: proofTransport,
      } as never),
    );
    return result;
  };

  async function runSharedSend(params: { emote?: boolean; mediaUrls?: string[]; message: string }) {
    const actionParams: RecordValue = {
      to: `room:${roomId}`,
      message: params.message,
      ...(params.emote === true ? { emote: true } : {}),
      ...(params.mediaUrls ? { mediaUrls: params.mediaUrls } : {}),
    };
    return await executeMessageSend({
      cfg,
      params: actionParams,
      channelPlugin: matrixPlugin,
      channel: "matrix",
      mediaAccess: {} as never,
      accountId: "default",
      dryRun: false,
      input: {
        cfg,
        action: "send",
        params: actionParams,
        actionOrigin: "message-tool",
        deps: { matrix },
        skipQueue: true,
      },
    } as never);
  }

  console.error("proof: sending emote");
  await withTimeout(runSharedSend({ emote: true, message: "waves" }), "shared emote send");
  const emoteEventId = requireString(lastWireEventId, "emote event_id");
  console.error("proof: emote accepted; reading event");
  const emoteEvent = await readMatrixEvent({
    accessToken: provisioning.observer.accessToken,
    baseUrl: harness.upstreamBaseUrl,
    eventId: emoteEventId,
    roomId,
  });
  const emoteContent = requireRecord(emoteEvent.content, "emote event content");
  if (emoteContent.msgtype !== "m.emote" || emoteContent.body !== "waves") {
    throw new Error(`unexpected Matrix emote content: ${JSON.stringify(emoteContent)}`);
  }

  console.error("proof: sending normal text");
  await runSharedSend({ message: "OpenClaw proof normal" });
  const normalEventId = requireString(lastWireEventId, "normal event_id");
  console.error("proof: normal accepted; reading event");
  const normalEvent = await readMatrixEvent({
    accessToken: provisioning.observer.accessToken,
    baseUrl: harness.upstreamBaseUrl,
    eventId: normalEventId,
    roomId,
  });
  const normalContent = requireRecord(normalEvent.content, "normal event content");
  if (normalContent.msgtype !== "m.text" || normalContent.body !== "OpenClaw proof normal") {
    throw new Error(`unexpected Matrix normal content: ${JSON.stringify(normalContent)}`);
  }

  console.error("proof: sending media negative control");
  let negativeControlError = "";
  const sendsBeforeNegativeControl = wireSendCount;
  try {
    await runSharedSend({
      emote: true,
      mediaUrls: ["https://example.invalid/proof.png"],
      message: "should reject",
    });
  } catch (error) {
    negativeControlError = error instanceof Error ? error.message : String(error);
  }
  if (!negativeControlError.includes("Matrix emote sends cannot include media")) {
    throw new Error(`unexpected media rejection: ${negativeControlError}`);
  }
  if (wireSendCount !== sendsBeforeNegativeControl) {
    throw new Error("media rejection reached the Matrix homeserver");
  }

  console.log("homeserver: disposable Tuwunel v1.8.3 via Docker; server_name=matrix-qa.test");
  console.log(
    "transport: shared message action -> production Matrix outbound sender -> Matrix Client-Server API -> Tuwunel",
  );
  console.log("emote: homeserver readback type=m.room.message msgtype=m.emote body=waves");
  console.log(
    "normal-control: homeserver readback type=m.room.message msgtype=m.text body=OpenClaw proof normal",
  );
  console.log(`negative-control: ${negativeControlError}; rejected before Matrix transport`);
} finally {
  await harness.stop();
  await rm(proofStateDir, { force: true, recursive: true });
}
