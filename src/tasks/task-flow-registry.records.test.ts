import { describe, expect, it } from "vitest";
import {
  CONTINUATION_DELEGATE_CONTROLLER_ID,
  CONTINUATION_POST_COMPACTION_CONTROLLER_ID,
} from "./task-flow-continuation-state.js";
import { applyFlowPatch, buildFlowRecord } from "./task-flow-registry.records.js";

function privateState() {
  return {
    phase: "queued",
    attachments: [{ name: "brief.md", content: "PRIVATE_CONTINUATION_INPUT" }],
    attachAs: { mountPath: "handoff" },
  };
}

function createFlow(controllerId: string) {
  return buildFlowRecord({
    ownerKey: "agent:main:main",
    controllerId,
    goal: "Continue work",
    stateJson: privateState(),
  });
}

describe.each([CONTINUATION_DELEGATE_CONTROLLER_ID, CONTINUATION_POST_COMPACTION_CONTROLLER_ID])(
  "continuation state for %s",
  (controllerId) => {
    it("scrubs creation after normalizing the controller", () => {
      const record = createFlow(` ${controllerId} `);
      expect(record.controllerId).toBe(controllerId);
      expect(record.stateJson).toEqual({ phase: "queued" });
      expect(record.revision).toBe(0);
    });

    it("scrubs retained legacy state in the same cancellation revision", () => {
      const current = { ...createFlow(controllerId), stateJson: privateState() };
      const next = applyFlowPatch(current, { cancelRequestedAt: 60, updatedAt: 60 });
      expect(next).toMatchObject({
        flowId: current.flowId,
        ownerKey: current.ownerKey,
        status: current.status,
        revision: current.revision + 1,
        cancelRequestedAt: 60,
        stateJson: { phase: "queued" },
      });
      expect(current.stateJson).toEqual(privateState());
    });

    it("scrubs replacement state without mutating the input", () => {
      const stateJson = { ...privateState(), phase: "waiting" };
      const next = applyFlowPatch(createFlow(controllerId), { stateJson, status: "waiting" });
      expect(next.stateJson).toEqual({ phase: "waiting" });
      expect(stateJson.attachments[0]?.content).toBe("PRIVATE_CONTINUATION_INPUT");
    });

    it("preserves absent state and explicit null", () => {
      const current = buildFlowRecord({
        ownerKey: "agent:main:main",
        controllerId,
        goal: "No input",
      });
      expect(current).not.toHaveProperty("stateJson");
      expect(applyFlowPatch(current, {}).stateJson).toBeUndefined();
      expect(applyFlowPatch(current, { stateJson: null }).stateJson).toBeNull();
      expect(buildFlowRecord({ ...current, stateJson: null }).stateJson).toBeNull();
    });
  },
);

it("preserves attachment-shaped state for unrelated controllers and task-mirrored flows", () => {
  const unrelated = createFlow("tests/custom-controller");
  const mirrored = buildFlowRecord({
    ownerKey: "agent:main:main",
    syncMode: "task_mirrored",
    controllerId: CONTINUATION_DELEGATE_CONTROLLER_ID,
    goal: "Mirrored task",
    stateJson: privateState(),
  });
  for (const current of [unrelated, mirrored]) {
    expect(current.stateJson).toEqual(privateState());
    expect(applyFlowPatch(current, { cancelRequestedAt: 60 }).stateJson).toEqual(privateState());
    expect(applyFlowPatch(current, { stateJson: privateState() }).stateJson).toEqual(
      privateState(),
    );
  }
});
