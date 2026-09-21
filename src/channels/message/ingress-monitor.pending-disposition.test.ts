import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressMonitor } from "./ingress-monitor.js";
import { createChannelIngressQueue } from "./ingress-queue.js";

type RawEvent = { id: string; lane: string; text: string };
type StoredEvent = { version: 1; rawEvent: string };

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("channel ingress monitor pending dispositions", () => {
  it("fails stale pending backlog before it can repopulate after reset", async () => {
    const queue = createChannelIngressQueue<StoredEvent>({
      channelId: "test",
      accountId: "a",
      stateDir: tempDirs.make("openclaw-ingress-pending-disposition-"),
    });
    let currentTime = 1_000_000;
    const monitor = createChannelIngressMonitor<RawEvent, string, StoredEvent>({
      queue,
      inspect: (raw) => ({ eventId: raw.id, laneKey: `lane:${raw.lane}` }),
      payload: {
        storage: "raw-event",
        version: 1,
        serialize: (raw) => JSON.stringify(raw),
        deserialize: (body) => JSON.parse(body),
        createClaimError: (kind) => new Error(kind),
      },
      deliver: vi.fn(),
      pollIntervalMs: 10,
      retention: { pruneIntervalMs: 60_000 },
      now: () => currentTime,
      resolvePendingDisposition: (record) =>
        record.receivedAt < currentTime
          ? {
              kind: "fail",
              reason: "stale-backlog",
              message: "stale backlog row was excluded before claim",
            }
          : null,
    });

    await expect(
      queue.enqueue(
        "stale-backlog",
        {
          version: 1,
          rawEvent: JSON.stringify({ id: "stale-backlog", lane: "a", text: "hello" }),
        },
        { receivedAt: 10 },
      ),
    ).resolves.toMatchObject({ kind: "accepted" });
    currentTime = 1_100_000;
    monitor.start();
    await monitor.waitForIdle();

    await expect(queue.listFailed?.({ limit: "all" })).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "stale-backlog",
          message: expect.stringContaining("excluded before claim"),
        }),
      ]),
    );
    await expect(
      queue.enqueue("stale-backlog", {
        version: 1,
        rawEvent: JSON.stringify({ id: "stale-backlog", lane: "a", text: "hello" }),
      }),
    ).resolves.toMatchObject({ kind: "failed", duplicate: true });

    await monitor.stop();
  });
});
