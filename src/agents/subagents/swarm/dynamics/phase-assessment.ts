import type {
  CognitivePhase,
  LocalDynamicsObservation,
  LocalPhaseAssessment,
  PhaseMixture,
} from "./population-types.js";

export function validateDynamicsObservation(observation: LocalDynamicsObservation): void {
  if (typeof observation.replicaId !== "string" || !observation.replicaId.trim()) {
    throw new Error("replicaId must be non-empty");
  }
  for (const key of [
    "candidateEntropy", "coherence", "mobility", "evidenceCompleteness",
    "verifierDisagreement", "resourcePressure", "contextPressure", "debtPressure",
    "progressRate",
  ] as const) {
    const value = observation[key];
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${key} must be finite and in [0, 1]`);
    }
  }
  if (!Number.isFinite(observation.branchingRatio) || observation.branchingRatio < 0) {
    throw new Error("branchingRatio must be finite and non-negative");
  }
}

export function assessLocalPhase(observation: LocalDynamicsObservation): LocalPhaseAssessment {
  validateDynamicsObservation(observation);
  const {
    candidateEntropy, coherence, mobility, evidenceCompleteness,
    verifierDisagreement, resourcePressure, contextPressure, debtPressure, progressRate,
  } = observation;
  const pressure = Math.max(resourcePressure, contextPressure, debtPressure);
  let phase: CognitivePhase = "unknown";
  let confidence = 0;
  let reason = "insufficiently distinctive observation";

  if (pressure >= 0.85) {
    phase = "jammed";
    confidence = pressure;
    reason = "resource/context/debt pressure dominates";
  } else if (verifierDisagreement >= 0.55) {
    // Disagreement must remain visible even when a trajectory has stopped moving.
    phase = "critical";
    confidence = verifierDisagreement;
    reason = "verifier disagreement requires measurement before perturbation";
  } else if (mobility <= 0.2 && evidenceCompleteness < 0.75 && progressRate <= 0.2) {
    phase = "glass";
    confidence = (1 - mobility + (1 - progressRate)) / 2;
    reason = "low mobility and low progress without sufficient evidence";
  } else if (candidateEntropy >= 0.45 && candidateEntropy <= 0.65) {
    phase = "critical";
    confidence = 1 - Math.abs(candidateEntropy - 0.55);
    reason = "candidate entropy is in the experimental transition band";
  } else if (
    candidateEntropy <= 0.2 && coherence >= 0.8 && evidenceCompleteness >= 0.8 &&
    verifierDisagreement <= 0.15
  ) {
    phase = "crystal";
    confidence = (coherence + evidenceCompleteness + (1 - candidateEntropy)) / 3;
    reason = "low candidate entropy with high coherence and evidence completeness";
  } else if (candidateEntropy >= 0.7 && coherence <= 0.45) {
    phase = "gas";
    confidence = (candidateEntropy + (1 - coherence)) / 2;
    reason = "high candidate entropy with low coherence";
  } else if (mobility >= 0.35 && coherence >= 0.45) {
    phase = "liquid";
    confidence = (mobility + coherence) / 2;
    reason = "productive mobility with moderate coherence";
  }

  // This score is a heuristic, not calibrated statistical confidence.
  return { replicaId: observation.replicaId, phase, confidence, reason };
}

export function phaseMixture(assessments: readonly LocalPhaseAssessment[]): PhaseMixture {
  const phases: CognitivePhase[] = [
    "gas", "liquid", "critical", "crystal", "glass", "jammed", "unknown",
  ];
  const counts = Object.fromEntries(phases.map((phase) => [phase, 0])) as PhaseMixture;
  if (assessments.length === 0) {
    counts.unknown = 1;
    return counts;
  }
  const seen = new Set<string>();
  for (const assessment of assessments) {
    if (!phases.includes(assessment.phase) || seen.has(assessment.replicaId)) {
      throw new Error("phase mixture requires one valid assessment per replica");
    }
    seen.add(assessment.replicaId);
    counts[assessment.phase] += 1;
  }
  for (const phase of phases) {
    counts[phase] /= assessments.length;
  }
  return counts;
}
