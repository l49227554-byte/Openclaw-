import { describe, expect, it } from "vitest";
import { assessMemoryEvidence } from "./memory-consolidation.js";
import { evaluateShadowPolicy } from "./shadow-evaluation.js";

const memory = { recurrence: 0.95, independentConfirmations: 3, contradictions: 0, evidenceStrength: 0.95, freshness: 0.9 };

describe("consolidation input regressions", () => {
  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid evidence count %s",
    (count) => {
      expect(() => assessMemoryEvidence({ ...memory, independentConfirmations: count })).toThrow();
      expect(() => assessMemoryEvidence({ ...memory, contradictions: count })).toThrow();
    },
  );
  it("rejects duplicate metrics and overflowing comparisons", () => {
    const base = { experimentId: "e", baselinePolicyDigest: "b", candidatePolicyDigest: "c" };
    const metric = { name: "outcomes", baseline: 0.5, candidate: 0.7, higherIsBetter: true, weight: 1 };
    expect(() => evaluateShadowPolicy({ ...base, metrics: [metric, metric] })).toThrow();
    expect(() => evaluateShadowPolicy({
      ...base, metrics: [{ ...metric, baseline: -Number.MAX_VALUE, candidate: Number.MAX_VALUE }],
    })).toThrow("overflowed");
  });
});
