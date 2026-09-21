import { describe, expect, it } from "vitest";
import { assessMemoryEvidence } from "./memory-consolidation.js";
import { evaluateShadowPolicy } from "./shadow-evaluation.js";

describe("evidence-aware memory consolidation", () => {
  it("blocks crystallization when contradictions remain", () => {
    expect(
      assessMemoryEvidence({
        recurrence: 0.95,
        independentConfirmations: 5,
        contradictions: 1,
        evidenceStrength: 0.95,
        freshness: 0.9,
      }),
    ).toMatchObject({
      phase: "candidate-belief",
      canCompactNarrative: false,
      authority: "knowledge-only",
    });
  });

  it("crystallizes only independently confirmed strong fresh evidence", () => {
    expect(
      assessMemoryEvidence({
        recurrence: 0.9,
        independentConfirmations: 3,
        contradictions: 0,
        evidenceStrength: 0.9,
        freshness: 0.8,
      }),
    ).toMatchObject({
      phase: "crystal",
      canCompactNarrative: true,
      authority: "knowledge-only",
    });
  });
});

describe("shadow policy evaluation", () => {
  it("can identify a candidate improvement without adopting it", () => {
    const result = evaluateShadowPolicy({
      experimentId: "exp:1",
      baselinePolicyDigest: "policy:base",
      candidatePolicyDigest: "policy:candidate",
      metrics: [
        { name: "useful-outcomes", baseline: 0.5, candidate: 0.7, higherIsBetter: true, weight: 2 },
        { name: "duplicate-work", baseline: 0.4, candidate: 0.2, higherIsBetter: false, weight: 1 },
      ],
    });
    expect(result.disposition).toBe("candidate-improvement");
    expect(result.authority).toBe("proposal-only");
    expect(result.weightedDelta).toBeGreaterThan(0);
  });

  it("does not pretend an experiment without metrics is evidence", () => {
    expect(
      evaluateShadowPolicy({
        experimentId: "exp:2",
        baselinePolicyDigest: "policy:base",
        candidatePolicyDigest: "policy:candidate",
        metrics: [],
      }),
    ).toMatchObject({
      disposition: "insufficient-evidence",
      authority: "proposal-only",
    });
  });
});
