import { buildPopulationSnapshot } from "./population-controller.js";
import type { PopulationDecision, PopulationSnapshot } from "./population-types.js";

export type DynamicsDiagnostic = {
  campaignId: string;
  groupId: string;
  /** Declared or observed replicas, not a claim about which runs are still active. */
  replicaCount: number;
  phaseMixture: PopulationSnapshot["phaseMixture"];
  evidenceCompleteness: number | null;
  candidateEntropy: number | null;
  systemPressure: number | null;
  decisionKinds: readonly string[];
  unresolved: readonly string[];
};

export function buildDynamicsDiagnostic(
  input: PopulationSnapshot,
  decision: PopulationDecision,
): DynamicsDiagnostic {
  const snapshot = buildPopulationSnapshot(input);
  const pressures = [snapshot.resourcePressure, snapshot.contextPressure, snapshot.debtPressure]
    .filter((value): value is number => value !== null);
  const unresolved: string[] = [];
  if (snapshot.evidenceCompleteness === null) {
    unresolved.push("evidence-unknown");
  } else if (snapshot.evidenceCompleteness < 1) {
    unresolved.push("evidence-incomplete");
  }
  if (snapshot.phaseMixture.critical > 0) {
    unresolved.push("critical-disagreement");
  }
  if (snapshot.phaseMixture.jammed > 0) {
    unresolved.push("jammed-pressure");
  }
  if (snapshot.phaseMixture.unknown > 0) {
    unresolved.push("unknown-phase");
  }
  const replicaIds = new Set([
    ...snapshot.replicas.map((replica) => replica.replicaId),
    ...snapshot.observations.map((observation) => observation.replicaId),
  ]);
  return {
    campaignId: snapshot.campaignId,
    groupId: snapshot.groupId,
    replicaCount: replicaIds.size,
    phaseMixture: snapshot.phaseMixture,
    evidenceCompleteness: snapshot.evidenceCompleteness,
    candidateEntropy: snapshot.candidateEntropy,
    systemPressure: pressures.length > 0 ? Math.max(...pressures) : null,
    decisionKinds: decision.actions.map((action) => action.kind),
    unresolved,
  };
}
