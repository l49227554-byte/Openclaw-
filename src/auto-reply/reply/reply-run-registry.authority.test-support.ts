import { expect, it, vi } from "vitest";
import { createQueueTestRun } from "./queue.test-helpers.js";
import type { ReplyToolAuthorityOverlay } from "./reply-run-registry.contracts.js";
import type { createReplyOperation } from "./reply-run-registry.js";
import {
  prepareReplyToolAuthority,
  resolveFollowupRunToolAuthorityFingerprint,
} from "./reply-tool-authority.js";

export function defineReplyRouteAuthorityTests(
  createTestReplyOperation: (
    params: Partial<Parameters<typeof createReplyOperation>[0]>,
  ) => ReturnType<typeof createReplyOperation>,
  toolAuthorityOverlay: (run: ReturnType<typeof createQueueTestRun>) => ReplyToolAuthorityOverlay,
) {
  it("keeps the initial policy snapshot while tracking concrete fallback authority", () => {
    const run = createQueueTestRun({ prompt: "route authority" });
    const operation = createTestReplyOperation({ sessionId: "session-route" });
    const snapshot = prepareReplyToolAuthority(run);
    const selected = { provider: run.run.provider, model: run.run.model };
    const primary = { provider: "openai", model: "gpt-primary" };
    const fallback = { provider: "anthropic", model: "claude-fallback" };
    const primaryFingerprint = resolveFollowupRunToolAuthorityFingerprint(run, primary);
    const fallbackFingerprint = resolveFollowupRunToolAuthorityFingerprint(run, fallback);
    const overlay = toolAuthorityOverlay(run);
    operation.bindToolAuthoritySnapshot(snapshot);

    expect(operation.requestedToolAuthorityRoute).toEqual(selected);
    expect(Object.isFrozen(operation.requestedToolAuthorityRoute)).toBe(true);
    expect(operation.bindToolAuthorityRoute(primary)).toBe(primaryFingerprint);
    expect(operation.toolAuthorityRoute).toEqual(primary);
    expect(operation.toolAuthorityFingerprint).toBe(primaryFingerprint);

    run.run.execOverrides = { security: "deny" };
    run.run.provider = "changed-selection";
    run.run.model = "changed-model";
    expect(operation.requestedToolAuthorityRoute).toEqual(selected);
    expect(() => operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(run))).toThrow(
      "Reply operation cannot change tool authority after admission",
    );
    expect(operation.toolAuthorityFingerprint).toBe(primaryFingerprint);
    expect(operation.bindToolAuthorityRoute(fallback)).toBe(fallbackFingerprint);
    expect(operation.toolAuthorityRoute).toEqual(fallback);
    expect(operation.requestedToolAuthorityRoute).toEqual(selected);
    expect(operation.toolAuthorityFingerprint).toBe(fallbackFingerprint);
    expect(operation.projectToolAuthorityFingerprint(overlay)).toBe(fallbackFingerprint);

    operation.bindToolAuthoritySnapshot(snapshot);
    expect(operation.toolAuthorityRoute).toEqual(fallback);
    expect(operation.toolAuthorityFingerprint).toBe(fallbackFingerprint);
    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      toolAuthorityFingerprint: "backend-exact-authority",
    });
    operation.bindToolAuthoritySnapshot(snapshot);
    expect(operation.toolAuthorityRoute).toEqual(fallback);
    expect(operation.toolAuthorityFingerprint).toBe("backend-exact-authority");
    operation.complete();
  });
}
