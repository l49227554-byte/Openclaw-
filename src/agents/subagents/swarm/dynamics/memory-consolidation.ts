export const MEMORY_PHASES = [
  "observation", "trace", "correlated", "candidate-belief", "crystal",
] as const;
export type MemoryPhase = (typeof MEMORY_PHASES)[number];
export type MemoryEvidence = {
  recurrence: number;
  independentConfirmations: number;
  contradictions: number;
  evidenceStrength: number;
  freshness: number;
};
export type MemoryAssessment = {
  phase: MemoryPhase;
  reason: string;
  canCompactNarrative: boolean;
  authority: "knowledge-only";
};

export function assessMemoryEvidence(evidence: MemoryEvidence): MemoryAssessment {
  for (const value of [evidence.recurrence, evidence.evidenceStrength, evidence.freshness]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error("memory evidence scalars must be finite and in [0,1]");
    }
  }
  for (const count of [evidence.independentConfirmations, evidence.contradictions]) {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("memory evidence counts must be non-negative safe integers");
    }
  }
  if (evidence.contradictions > 0) {
    return {
      phase: "candidate-belief",
      reason: "contradictions prevent evidence crystallization",
      canCompactNarrative: false,
      authority: "knowledge-only",
    };
  }
  if (evidence.independentConfirmations >= 3 && evidence.recurrence >= 0.75 &&
      evidence.evidenceStrength >= 0.85 && evidence.freshness >= 0.6) {
    return {
      phase: "crystal",
      reason: "recurring independently confirmed evidence is strong and fresh",
      canCompactNarrative: true,
      authority: "knowledge-only",
    };
  }
  if (evidence.independentConfirmations >= 2 && evidence.recurrence >= 0.5) {
    return {
      phase: "correlated",
      reason: "multiple independent observations support a recurring pattern",
      canCompactNarrative: true,
      authority: "knowledge-only",
    };
  }
  if (evidence.independentConfirmations >= 1) {
    return {
      phase: "trace",
      reason: "at least one retained evidence-bearing trace exists",
      canCompactNarrative: false,
      authority: "knowledge-only",
    };
  }
  return {
    phase: "observation",
    reason: "observation has not yet gained independent support",
    canCompactNarrative: false,
    authority: "knowledge-only",
  };
}
