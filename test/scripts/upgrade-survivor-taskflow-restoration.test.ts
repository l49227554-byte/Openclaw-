import { describe, expect, it } from "vitest";
import {
  assertTaskflowSnapshot,
  createTaskflowFixture,
  normalizeTaskflowSnapshot,
} from "../../scripts/e2e/lib/upgrade-survivor/taskflow-restoration-fixture.mjs";
import { resolveWorkerCellExport } from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";

describe("taskflow survivor evidence", () => {
  it("compares complete persisted records regardless of owner Map insertion order", () => {
    const fixture = createTaskflowFixture(1_800_000_000_000);
    const snapshot = {
      tasks: new Map(fixture.tasks.toReversed().map((task) => [task.taskId, task])),
      flows: new Map(fixture.flows.toReversed().map((flow) => [flow.flowId, flow])),
      deliveryStates: new Map(fixture.deliveryStates.map((row) => [row.taskId, row])),
    };
    expect(() => assertTaskflowSnapshot(snapshot, fixture)).not.toThrow();
    expect(normalizeTaskflowSnapshot(snapshot)).toEqual(fixture);
    const changed = structuredClone(fixture);
    for (const task of changed.tasks) {
      task.detail.payload.enabled = false;
    }
    expect(() => assertTaskflowSnapshot(changed, fixture)).toThrow();
    const missing = structuredClone(fixture);
    missing.deliveryStates.pop();
    expect(() => assertTaskflowSnapshot(missing, fixture)).toThrow();
    const revision = structuredClone(fixture);
    for (const flow of revision.flows) {
      flow.revision += 1;
    }
    expect(() => assertTaskflowSnapshot(revision, fixture)).toThrow();
  });

  it("seeds only settled tasks with existing parent flows and no execution owner", () => {
    const now = 1_800_000_000_000;
    const fixture = createTaskflowFixture(now);
    expect(fixture.tasks).toHaveLength(3);
    for (const task of fixture.tasks) {
      expect(task.status).toBe("succeeded");
      expect(task.notifyPolicy).toBe("silent");
      expect(task.deliveryStatus).toBe("not_applicable");
      expect(task.endedAt).toBeLessThan(now);
      expect(task.cleanupAfter).toBeGreaterThan(now);
      expect(task).not.toHaveProperty("executionOwner");
      expect(task).not.toHaveProperty("childSessionKey");
      expect(fixture.flows.some((flow) => flow.flowId === task.parentFlowId)).toBe(true);
    }
  });

  it("resolves named or minified owner exports without substituting another symbol", () => {
    expect(resolveWorkerCellExport("export { loadSnapshot, other as a };", "loadSnapshot")).toBe(
      "loadSnapshot",
    );
    expect(
      resolveWorkerCellExport("export { loadSnapshot as c, close as r };", "loadSnapshot"),
    ).toBe("c");
    expect(
      resolveWorkerCellExport("export { other as loadSnapshot };", "loadSnapshot"),
    ).toBeUndefined();
    expect(
      resolveWorkerCellExport("export { loadSnapshot } from './different.mjs';", "loadSnapshot"),
    ).toBeUndefined();
    expect(() =>
      resolveWorkerCellExport("export { loadSnapshot as a, loadSnapshot as b };", "loadSnapshot"),
    ).toThrow("Ambiguous");
  });
});
