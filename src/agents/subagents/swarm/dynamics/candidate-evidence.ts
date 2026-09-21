import { createHash } from "node:crypto";

export type CandidateManifest = {
  version: 1;
  candidateDigest: string;
  sourceDigest: string;
  recipeDigest: string;
  policyDigest: string;
};

export type MeasurementKind =
  | "test" | "static-analysis" | "replay" | "performance" | "security" | "formal" | "human";

/** Receipts must come from a trusted execution owner; this module cannot attest their truth. */
export type MeasurementReceipt = {
  version: 1;
  measurementId: string;
  candidateDigest: string;
  candidateIdentity: string;
  contractDigest: string;
  requirementId: string;
  producerRunId: string;
  producerReplicaId: string;
  kind: MeasurementKind;
  resultDigest: string;
  evidenceDigest: string;
  passed: boolean;
  independenceKey: string;
};

export type VerificationRequirement = {
  id: string;
  kind: MeasurementKind;
  minIndependentConfirmations: number;
};

export type VerificationContract = {
  version: 1;
  requirements: readonly VerificationRequirement[];
};

type VerificationBinding = {
  candidateDigest: string;
  candidateIdentity: string;
  contractDigest: string;
};

export type VerificationResult = VerificationBinding & (
  | { status: "verified"; evidenceDigest: string; satisfiedRequirementIds: readonly string[] }
  | {
      status: "incomplete" | "rejected";
      missingRequirementIds: readonly string[];
      failedMeasurementIds: readonly string[];
    }
);

export type EffectRequest = {
  version: 1;
  candidate: CandidateManifest;
  candidateDigest: string;
  candidateIdentity: string;
  contractDigest: string;
  evidenceDigest: string;
  requestedEffect: string;
  authority: "request-only";
};

const MEASUREMENT_KINDS = new Set<MeasurementKind>([
  "test",
  "static-analysis",
  "replay",
  "performance",
  "security",
  "formal",
  "human",
]);

function requireText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

// Accept only JSON data. Reject values JSON.stringify would omit or turn into null.
function canonical(value: unknown, parents = new Set<object>()): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || parents.has(value)) {
    throw new Error("digest input must be finite, acyclic JSON data");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("digest input must contain only plain objects and arrays");
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error("digest input must not contain symbol keys");
  }
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${Array.from(value, (item) => canonical(item, parents)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).toSorted().map(
      (key) => `${JSON.stringify(key)}:${canonical(record[key], parents)}`,
    ).join(",")}}`;
  } finally {
    parents.delete(value);
  }
}

export function stableDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

export function verificationContractDigest(contract: VerificationContract): string {
  if (contract.version !== 1 || !Array.isArray(contract.requirements) || !contract.requirements.length) {
    throw new Error("verification requires a non-empty version-1 contract");
  }
  const ids = new Set<string>();
  for (const requirement of contract.requirements) {
    requireText(requirement.id, "requirement id");
    if (ids.has(requirement.id) || !MEASUREMENT_KINDS.has(requirement.kind)) {
      throw new Error("verification requirements must have unique ids and valid kinds");
    }
    if (!Number.isSafeInteger(requirement.minIndependentConfirmations) || requirement.minIndependentConfirmations < 1) {
      throw new Error("required confirmations must be positive safe integers");
    }
    ids.add(requirement.id);
  }
  return stableDigest(contract);
}

export function candidateIdentity(manifest: CandidateManifest): string {
  if (manifest.version !== 1) {
    throw new Error("unsupported candidate manifest version");
  }
  for (const key of ["candidateDigest", "sourceDigest", "recipeDigest", "policyDigest"] as const) {
    requireText(manifest[key], key);
  }
  return stableDigest({
    candidateDigest: manifest.candidateDigest,
    sourceDigest: manifest.sourceDigest,
    recipeDigest: manifest.recipeDigest,
    policyDigest: manifest.policyDigest,
    version: manifest.version,
  });
}

function validateMeasurement(measurement: MeasurementReceipt): void {
  if (measurement.version !== 1 || typeof measurement.passed !== "boolean" || !MEASUREMENT_KINDS.has(measurement.kind)) {
    throw new Error("invalid measurement version, status, or kind");
  }
  for (const key of [
    "measurementId", "candidateDigest", "candidateIdentity", "contractDigest", "requirementId",
    "producerRunId", "producerReplicaId", "resultDigest", "evidenceDigest", "independenceKey",
  ] as const) {
    requireText(measurement[key], key);
  }
}

export function verifyCandidate(params: {
  candidate: CandidateManifest;
  contract: VerificationContract;
  measurements: readonly MeasurementReceipt[];
}): VerificationResult {
  const binding: VerificationBinding = {
    candidateDigest: params.candidate.candidateDigest,
    candidateIdentity: candidateIdentity(params.candidate),
    contractDigest: verificationContractDigest(params.contract),
  };
  const requirements = new Map(params.contract.requirements.map((item) => [item.id, item]));
  const byId = new Map<string, MeasurementReceipt>();
  for (const measurement of params.measurements) {
    validateMeasurement(measurement);
    if (measurement.candidateDigest !== binding.candidateDigest ||
        measurement.candidateIdentity !== binding.candidateIdentity ||
        measurement.contractDigest !== binding.contractDigest) {
      continue;
    }
    const requirement = requirements.get(measurement.requirementId);
    if (!requirement || requirement.kind !== measurement.kind) {
      throw new Error("measurement does not match its declared verification requirement");
    }
    const previous = byId.get(measurement.measurementId);
    if (previous && stableDigest(previous) !== stableDigest(measurement)) {
      throw new Error("conflicting receipts for one measurement id");
    }
    byId.set(measurement.measurementId, measurement);
  }
  const relevant = [...byId.keys()].toSorted().map((id) => byId.get(id)!);
  const failedMeasurementIds = relevant.filter((item) => !item.passed).map((item) => item.measurementId);
  if (failedMeasurementIds.length > 0) {
    return { ...binding, status: "rejected", missingRequirementIds: [], failedMeasurementIds };
  }

  const satisfiedRequirementIds: string[] = [];
  const missingRequirementIds: string[] = [];
  for (const requirement of params.contract.requirements) {
    const keys = new Set(relevant.filter(
      (item) => item.passed && item.requirementId === requirement.id,
    ).map((item) => item.independenceKey));
    if (keys.size >= requirement.minIndependentConfirmations) {
      satisfiedRequirementIds.push(requirement.id);
    } else {
      missingRequirementIds.push(requirement.id);
    }
  }
  if (missingRequirementIds.length > 0) {
    return { ...binding, status: "incomplete", missingRequirementIds, failedMeasurementIds: [] };
  }
  return {
    ...binding,
    status: "verified",
    evidenceDigest: stableDigest({ ...binding, measurements: relevant }),
    satisfiedRequirementIds,
  };
}

/** Builds a request, not authorization; the effect owner must revalidate live state. */
export function buildEffectRequest(params: {
  candidate: CandidateManifest;
  verification: Extract<VerificationResult, { status: "verified" }>;
  requestedEffect: string;
}): EffectRequest {
  const identity = candidateIdentity(params.candidate);
  if (params.verification.status !== "verified" ||
      params.verification.candidateIdentity !== identity ||
      params.verification.candidateDigest !== params.candidate.candidateDigest) {
    throw new Error("verification no longer matches the complete candidate manifest");
  }
  requireText(params.verification.contractDigest, "contract digest");
  requireText(params.verification.evidenceDigest, "evidence digest");
  requireText(params.requestedEffect, "requested effect");
  return {
    version: 1,
    candidate: { ...params.candidate },
    candidateDigest: params.candidate.candidateDigest,
    candidateIdentity: identity,
    contractDigest: params.verification.contractDigest,
    evidenceDigest: params.verification.evidenceDigest,
    requestedEffect: params.requestedEffect.trim(),
    authority: "request-only",
  };
}