// Host-thaw channel restart over the public ChannelManager surface.
import type { ChannelId } from "../channels/plugins/index.js";
import type { ChannelManager } from "./server-channels.js";

type ThawRestartManager = Pick<
  ChannelManager,
  "getRuntimeSnapshot" | "isManuallyStopped" | "isAccountListed" | "stopChannel" | "startChannel"
>;

export type ThawRestartTarget = { channelId: ChannelId; accountId: string };

export type ThawRestartSelection =
  | { kind: "new-thaw"; pendingTargets?: readonly ThawRestartTarget[] }
  | { kind: "deferred-retry"; targets: readonly ThawRestartTarget[] };

function snapshotRunningTargets(manager: ThawRestartManager): ThawRestartTarget[] {
  return Object.entries(
    manager.getRuntimeSnapshot({ inspectAccounts: false }).channelAccounts,
  ).flatMap(([channelId, accounts]) =>
    Object.entries(accounts ?? {})
      .filter(
        ([accountId, status]) =>
          status?.running === true && manager.isAccountListed(channelId, accountId),
      )
      .map(([accountId]) => ({ channelId, accountId })),
  );
}

function dedupeTargets(targets: readonly ThawRestartTarget[]): ThawRestartTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.channelId}:${target.accountId}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Restarts running listed, non-manually-stopped channel accounts after a host
 * thaw. Dead sockets from a freeze otherwise wait for the slow health sweep.
 */
export async function restartRunningChannelAccounts(
  manager: ThawRestartManager,
  opts: { shouldContinue: () => boolean; onError: (message: string) => void },
): Promise<void> {
  const snapshot = manager.getRuntimeSnapshot();
  for (const [channelId, accounts] of Object.entries(snapshot.channelAccounts)) {
    for (const [accountId, status] of Object.entries(accounts ?? {})) {
      const channel = channelId as ChannelId;
      const shouldRestart = status?.running === true || status?.restartPending === true;
      if (!shouldRestart || manager.isManuallyStopped(channel, accountId)) {
        continue;
      }
      await manager.stopChannel(channelId, accountId, { manual: false });
      if (!opts.shouldContinue()) {
        return [...failedTargets, target, ...targets.slice(index + 1)];
      }
      try {
        if (status?.running === true) {
          await manager.stopChannel(channel, accountId, { manual: false });
          if (!opts.shouldContinue()) {
            return;
          }
        }
        await manager.startChannel(channel, accountId, { preserveManualStop: true });
        const restarted = manager.getRuntimeSnapshot().channelAccounts[channel]?.[accountId];
        if (restarted?.restartPending === true) {
          // A timed-out stop uses a two-call recovery contract: the first call
          // requests replacement and the second discards the stale task. Recheck
          // admission because the first call may have awaited deferred teardown.
          if (!opts.shouldContinue()) {
            return;
          }
          await manager.startChannel(channel, accountId, { preserveManualStop: true });
        }
      } catch (error) {
        opts.onError(`[${channel}:${accountId}] host-thaw restart failed: ${String(error)}`);
      }
      let startOutcomes = await manager.startChannel(channelId, accountId, {
        preserveManualStop: true,
      });
      let startOutcome = startOutcomes.get(accountId);
      let restarted =
        manager.getRuntimeSnapshot(snapshotOptions).channelAccounts[channelId]?.[accountId];
      if (
        startOutcome?.status === "retry" &&
        restarted?.restartPending === true &&
        manager.isAccountListed(channelId, accountId)
      ) {
        // A timed-out stop uses a two-call recovery contract: the first call
        // requests replacement and the second discards the stale task.
        startOutcomes = await manager.startChannel(channelId, accountId, {
          preserveManualStop: true,
        });
        startOutcome = startOutcomes.get(accountId);
        restarted =
          manager.getRuntimeSnapshot(snapshotOptions).channelAccounts[channelId]?.[accountId];
      }
      // The channel manager owns all failures after handoff through its restart
      // supervisor. Intentional configuration skips are complete; only a
      // transient owner conflict remains this thaw's retry.
      if (startOutcome?.status === "retry") {
        failedTargets.push(target);
        opts.onError(
          `[${channelId}:${accountId}] host-thaw restart failed: replacement was not handed off (${startOutcome.reason})${restarted?.lastError ? `: ${restarted.lastError}` : ""}`,
        );
      }
    } catch (error) {
      failedTargets.push(target);
      opts.onError(`[${channelId}:${accountId}] host-thaw restart failed: ${String(error)}`);
    }
    if (!opts.shouldContinue()) {
      return [...failedTargets, ...targets.slice(index + 1)];
    }
  }
  return failedTargets;
}
