// Host notification provenance must reach channel after-delivery hooks, including restored sends.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.public.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { matrixOutboundForQueueTest } from "./deliver.queue-integration.test-support.js";
import { enqueueDeliveryOnce } from "./delivery-queue-storage.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "./delivery-queue.test-helpers.js";

let runOutboundDeliveryInternal: typeof import("./deliver-queue.js").runOutboundDeliveryInternal;

function installAfterDeliverPayloadSpy() {
  const afterDeliverPayload = vi.fn<NonNullable<ChannelOutboundAdapter["afterDeliverPayload"]>>();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: createOutboundTestPlugin({
          id: "matrix",
          outbound: { ...matrixOutboundForQueueTest, afterDeliverPayload },
        }),
      },
    ]),
  );
  return afterDeliverPayload;
}

function deliveredPayloads(
  afterDeliverPayload: ReturnType<typeof installAfterDeliverPayloadSpy>,
): ReplyPayload[] {
  return afterDeliverPayload.mock.calls.map(([params]) => params.payload);
}

describe("host notification delivery provenance", () => {
  const fixtures = installDeliveryQueueTmpDirHooks();

  beforeAll(async () => {
    ({ runOutboundDeliveryInternal } = await import("./deliver-queue.js"));
  });

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", fixtures.tmpDir());
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  it.each([
    { delivery: "queued", skipQueue: false },
    { delivery: "direct", skipQueue: true },
  ])("hands the marker to after-delivery hooks for $delivery sends", async ({ skipQueue }) => {
    const afterDeliverPayload = installAfterDeliverPayloadSpy();
    const sendMatrix = vi
      .fn(async () => ({ messageId: "reply-message" }))
      .mockResolvedValueOnce({ messageId: "notification-message" });

    await runOutboundDeliveryInternal({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "Daily digest", isHostNotification: true }, { text: "Assistant reply" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
      skipQueue,
    });

    expect(
      deliveredPayloads(afterDeliverPayload).map((payload) => payload.isHostNotification),
    ).toEqual([true, undefined]);
    expect(afterDeliverPayload.mock.calls[0]?.[0].results).toMatchObject([
      { messageId: "notification-message" },
    ]);
  });

  it("keeps the marker on a notification restored from the durable queue", async () => {
    const afterDeliverPayload = installAfterDeliverPayloadSpy();
    const deliveryId = "host-notification-restored";
    const sendMatrix = vi.fn(async () => ({ messageId: "restored-message" }));
    await expect(
      enqueueDeliveryOnce(
        {
          channel: "matrix",
          to: "!room:example",
          payloads: [{ text: "Daily digest", isHostNotification: true }],
          queuePolicy: "required",
        },
        deliveryId,
        fixtures.tmpDir(),
      ),
    ).resolves.toEqual({ id: deliveryId, created: true });

    // The retry carries an unmarked payload; only the persisted intent can supply the marker.
    await runOutboundDeliveryInternal({
      cfg: {},
      channel: "matrix",
      to: "!room:example",
      payloads: [{ text: "Replacement text" }],
      deps: { matrix: sendMatrix },
      queuePolicy: "required",
      deliveryIntentId: deliveryId,
      reusePendingDeliveryIntent: true,
    });

    expect(sendMatrix).toHaveBeenCalledExactlyOnceWith(
      "!room:example",
      "Daily digest",
      expect.any(Object),
    );
    expect(deliveredPayloads(afterDeliverPayload)).toMatchObject([
      { text: "Daily digest", isHostNotification: true },
    ]);
    expect(await loadPendingDeliveries(fixtures.tmpDir())).toHaveLength(0);
  });
});
