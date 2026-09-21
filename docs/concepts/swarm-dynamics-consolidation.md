---
summary: "Experimental evidence assessments, shadow comparisons, and Swarm diagnostics"
title: "Swarm dynamics consolidation"
status: experimental
---

# Swarm dynamics consolidation

The consolidation functions are pure assessments. They neither write memory nor
change the live controller, tools, credentials, sandbox policy, or approvals.

## Evidence-aware memory

The caller supplies recurrence, confirmation and contradiction counts, evidence
strength, and freshness. Counts must be non-negative safe integers; normalized
scalars must be finite and in range. Contradictions prevent crystallization.

The caller must establish the supporting provenance and count genuinely independent
sources. Passing a larger integer is not proof of independent observations. A
memory-crystal assessment is a knowledge recommendation, never an authorization.
Narrative compaction must retain evidence references and unresolved obligations;
this library does not execute that compaction or migrate persistent memory.

## Shadow comparison

Shadow comparisons require distinct metric names, finite values, positive weights,
and non-empty experiment and policy identities. Arithmetic overflow fails closed.
Metrics must already be normalized to comparable units by the evaluator.

The weighted delta is descriptive, not a statistical significance test. Offline
trace comparisons cannot prove how a different live agent trajectory would behave.
A result stays proposal-only and cannot adopt its own policy.

## Diagnostics

The diagnostic projection recomputes phase and pressure from supplied observations.
It reports declared or observed replica identities, not an unverified active-run
count. Missing evidence and pressure stay null, and unknown phases remain visible.

This is a projection helper, not a completed Control UI integration. Live telemetry
collection, authenticated evidence sources, memory persistence integration, and
operator adoption flows require their existing OpenClaw owners and end-to-end
qualification before production use.
