import { describe, expect, it } from "vitest";
import {
  buildEffectRequest,
  candidateIdentity,
  stableDigest,
  verifyCandidate,
  verificationContractDigest,
  type CandidateManifest,
  type MeasurementReceipt,
  type VerificationContract,
} from "./candidate-evidence.js";

const candidate: CandidateManifest = {
  version: 1,
  candidateDigest: "candidate:a",
  sourceDigest: "source:a",
  recipeDigest: "recipe:a",
  policyDigest: "policy:a",
};
const contract: VerificationContract = {
  version: 1,
  requirements: [
    { id: "tests", kind: "test", minIndependentConfirmations: 1 },
    { id: "review", kind: "security", minIndependentConfirmations: 2 },
  ],
};
function measurement(
  overrides: Partial<MeasurementReceipt> & Pick<MeasurementReceipt, "measurementId" | "kind" | "independenceKey">,
): MeasurementReceipt {
  return {
    version: 1,
    candidateDigest: candidate.candidateDigest,
    candidateIdentity: candidateIdentity(candidate),
    contractDigest: verificationContractDigest(contract),
    requirementId: overrides.kind === "security" ? "review" : "tests",
    producerRunId: `run:${overrides.measurementId}`,
    producerReplicaId: `replica:${overrides.measurementId}`,
    resultDigest: `result:${overrides.measurementId}`,
    evidenceDigest: `evidence:${overrides.measurementId}`,
    passed: true,
    ...overrides,
  };
}
const complete = [
  measurement({ measurementId: "t1", kind: "test", independenceKey: "test-a" }),
  measurement({ measurementId: "s1", kind: "security", independenceKey: "sec-a" }),
  measurement({ measurementId: "s2", kind: "security", independenceKey: "sec-b" }),
];

describe("evidence-bound convergence", () => {
  it("requires every declared requirement", () => {
    expect(verifyCandidate({ candidate, contract, measurements: [complete[0]!] })).toMatchObject({
      status: "incomplete", missingRequirementIds: ["review"],
    });
  });
  it("does not double count duplicate independence keys", () => {
    expect(verifyCandidate({
      candidate, contract,
      measurements: complete.map((item) => ({ ...item, independenceKey: "same-reviewer" })),
    }).status).toBe("incomplete");
  });
  it("rejects a bound failure rather than averaging it away", () => {
    expect(verifyCandidate({
      candidate, contract,
      measurements: [complete[0]!, { ...complete[1]!, passed: false }],
    })).toMatchObject({ status: "rejected", failedMeasurementIds: ["s1"] });
  });
  it("creates only a request and retains the full manifest", () => {
    const verification = verifyCandidate({ candidate, contract, measurements: complete });
    expect(verification.status).toBe("verified");
    if (verification.status !== "verified") {
      throw new Error("expected verified");
    }
    expect(buildEffectRequest({ candidate, verification, requestedEffect: "inspect candidate" })).toMatchObject({
      candidate, candidateIdentity: candidateIdentity(candidate), authority: "request-only",
    });
    expect(() => buildEffectRequest({
      candidate: { ...candidate, policyDigest: "policy:changed" }, verification, requestedEffect: "inspect",
    })).toThrow("complete candidate manifest");
  });
  it.each(["candidateDigest", "sourceDigest", "recipeDigest", "policyDigest"] as const)(
    "invalidates old receipts when %s changes",
    (field) => {
      expect(verifyCandidate({
        candidate: { ...candidate, [field]: "changed" }, contract, measurements: complete,
      }).status).toBe("incomplete");
    },
  );
  it("does not reuse one receipt for two requirements of the same kind", () => {
    const sameKind: VerificationContract = {
      version: 1,
      requirements: [
        { id: "unit", kind: "test", minIndependentConfirmations: 1 },
        { id: "integration", kind: "test", minIndependentConfirmations: 1 },
      ],
    };
    expect(verifyCandidate({
      candidate, contract: sameKind,
      measurements: [{ ...complete[0]!, requirementId: "unit", contractDigest: verificationContractDigest(sameKind) }],
    })).toMatchObject({ status: "incomplete", missingRequirementIds: ["integration"] });
  });
  it("rejects vacuous, duplicate, and malformed contracts", () => {
    expect(() => verificationContractDigest({ version: 1, requirements: [] })).toThrow();
    expect(() => verificationContractDigest({ version: 1, requirements: [contract.requirements[0]!, contract.requirements[0]!] })).toThrow();
    for (const count of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => verificationContractDigest({
        version: 1, requirements: [{ id: "tests", kind: "test", minIndependentConfirmations: count }],
      })).toThrow();
    }
  });
  it("deduplicates identical receipts and rejects conflicting receipt ids", () => {
    const result = verifyCandidate({ candidate, contract, measurements: complete });
    expect(verifyCandidate({ candidate, contract, measurements: complete.toReversed() })).toEqual(result);
    expect(verifyCandidate({ candidate, contract, measurements: [...complete, complete[0]!] })).toEqual(result);
    expect(() => verifyCandidate({ candidate, contract, measurements: [...complete, { ...complete[0]!, passed: false }] })).toThrow("conflicting receipts");
  });
  it("rejects malformed digest input rather than hashing dropped values", () => {
    expect(stableDigest({ a: 1, b: 2 })).toBe(stableDigest({ b: 2, a: 1 }));
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, { a: undefined }]) {
      expect(() => stableDigest(value)).toThrow();
    }
  });
});