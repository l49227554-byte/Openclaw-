export type ShadowMetric = {
  name: string;
  baseline: number;
  candidate: number;
  higherIsBetter: boolean;
  weight: number;
};
export type ShadowEvaluation = {
  experimentId: string;
  baselinePolicyDigest: string;
  candidatePolicyDigest: string;
  metrics: readonly ShadowMetric[];
  weightedDelta: number;
  disposition: "insufficient-evidence" | "candidate-improvement" | "candidate-regression";
  authority: "proposal-only";
};

/** A descriptive comparison of caller-normalized metrics, not a significance test. */
export function evaluateShadowPolicy(params: {
  experimentId: string;
  baselinePolicyDigest: string;
  candidatePolicyDigest: string;
  metrics: readonly ShadowMetric[];
}): ShadowEvaluation {
  for (const value of [params.experimentId, params.baselinePolicyDigest, params.candidatePolicyDigest]) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("shadow experiment and policy identities must be non-empty");
    }
  }
  if (params.metrics.length === 0) {
    return {
      ...params,
      weightedDelta: 0,
      disposition: "insufficient-evidence",
      authority: "proposal-only",
    };
  }
  const names = new Set<string>();
  let totalWeight = 0;
  for (const metric of params.metrics) {
    if (typeof metric.name !== "string" || !metric.name.trim() || names.has(metric.name) ||
        typeof metric.higherIsBetter !== "boolean" || !Number.isFinite(metric.baseline) ||
        !Number.isFinite(metric.candidate) || !Number.isFinite(metric.weight) || metric.weight <= 0) {
      throw new Error("shadow metrics require unique names, finite values, and positive weight");
    }
    names.add(metric.name);
    totalWeight += metric.weight;
  }
  if (!Number.isFinite(totalWeight)) {
    throw new Error("shadow metric weight sum overflowed");
  }
  let weightedDelta = 0;
  for (const metric of params.metrics) {
    const delta = metric.candidate - metric.baseline;
    if (!Number.isFinite(delta)) {
      throw new Error("shadow metric delta overflowed");
    }
    weightedDelta += (metric.higherIsBetter ? delta : -delta) * (metric.weight / totalWeight);
  }
  if (!Number.isFinite(weightedDelta)) {
    throw new Error("shadow metric aggregate overflowed");
  }
  return {
    ...params,
    weightedDelta,
    disposition: weightedDelta > 0 ? "candidate-improvement" :
      weightedDelta < 0 ? "candidate-regression" : "insufficient-evidence",
    authority: "proposal-only",
  };
}
