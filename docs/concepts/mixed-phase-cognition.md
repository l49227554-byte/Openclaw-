---
summary: "Why OpenClaw Swarm can use different cognitive regimes at the same time"
title: "Mixed-phase cognition"
status: experimental
---

# Mixed-phase cognition

A Swarm group does not need one global cognitive phase.

Different replicas can simultaneously occupy different observed regimes:

- gas: broad, weakly coordinated alternatives
- liquid: productive coordination with continued mobility
- critical: high disagreement or sensitivity that should trigger measurement
- crystal: a low-entropy candidate with substantial evidence
- glass: stalled low-mobility search without sufficient evidence
- jammed: resource, context, or cleanup pressure dominates
- unknown: telemetry is insufficient to classify safely

The controller is deliberately **search-only**. It may propose bounded spawn, measurement, freeze,
perturb, drain, or hold actions. Existing OpenClaw admission, policy, cancellation, sandbox, and
approval owners still decide what can actually execute.

A phase is descriptive telemetry. A control action is a recommendation. Neither is authority.
