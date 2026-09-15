import { isDeepStrictEqual } from "node:util";
import {
  assertSessionBindingCleanupAvailable,
  getSessionBindingService,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { isConfiguredBindingTarget, isConfiguredCleanupStore } from "./cleanup-target.js";
import { loadSessionEntry } from "./session-accessor.js";
import type { SessionStoreTarget } from "./targets.js";

type CleanupBindingContext = {
  cfg: OpenClawConfig;
  target: SessionStoreTarget;
  bindings: ReadonlyMap<string, SessionBindingRecord[]>;
};

export function captureCleanupBindings(
  cfg: OpenClawConfig,
  target: SessionStoreTarget,
  sessionKey: string,
): SessionBindingRecord[] {
  return structuredClone(getSessionBindingService().listBySession(sessionKey)).filter((binding) =>
    isConfiguredBindingTarget(cfg, target, binding),
  );
}

export function assertCleanupBindingsAvailable(
  params: CleanupBindingContext & {
    mode: "warn" | "enforce";
    offline: boolean;
    hasMissingRemovals: boolean;
  },
): void {
  if (params.mode === "warn") {
    return;
  }
  if (
    params.hasMissingRemovals &&
    params.offline &&
    isConfiguredCleanupStore(params.cfg, params.target)
  ) {
    throw new Error(
      "Offline cleanup cannot verify persisted binding owners for this configured session store. " +
        "Use an active Gateway with --agent and omit --store; no missing-session removals were committed for this store.",
    );
  }
  for (const bindings of params.bindings.values()) {
    for (const binding of bindings) {
      assertSessionBindingCleanupAvailable(binding.conversation);
    }
  }
}

export async function unbindCommittedCleanupBindings(
  params: CleanupBindingContext & { removedSessionKeys: ReadonlySet<string> },
): Promise<void> {
  for (const [sessionKey, bindings] of params.bindings) {
    if (!params.removedSessionKeys.has(sessionKey)) {
      continue;
    }
    for (const expected of bindings) {
      await getSessionBindingService().unbind({
        bindingId: expected.bindingId,
        scope: expected.conversation,
        reason: "cleanup-missing-transcript",
        // Owners evaluate this at their synchronous mutation boundary after awaited work.
        shouldUnbind: (current) =>
          isDeepStrictEqual(current, expected) &&
          isConfiguredBindingTarget(params.cfg, params.target, current) &&
          !loadSessionEntry({ ...params.target, sessionKey }),
      });
    }
  }
}
