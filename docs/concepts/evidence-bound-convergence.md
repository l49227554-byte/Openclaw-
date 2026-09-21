---
summary: "Exact candidate identity and verification contracts for Swarm convergence"
title: "Evidence-bound convergence"
status: experimental
---

# Evidence-bound convergence

This experimental library checks consistency between an exact candidate manifest,
a non-empty verification contract, and supplied measurement receipts. It does not
authenticate the producer or establish that a claimed measurement really happened.

A candidate identity binds candidate content, source, execution recipe, policy, and
manifest version. A receipt must match that complete identity and the contract
digest. Changing any bound manifest component makes old receipts inapplicable.

Each mandatory requirement has a unique id and a positive integer confirmation
count. Receipts name the requirement they measured; one test receipt cannot satisfy
a different test requirement merely because both have kind `test`. Conflicting
receipts with the same measurement id are rejected. Identical duplicate receipts
are idempotent, and receipt arrival order does not change the evidence digest.
Any applicable failed receipt rejects the candidate instead of being averaged away.

## Trust boundary

The caller must obtain receipts and independence keys from an appropriate trusted
execution owner. An agent can fabricate JSON containing `passed: true` and different
keys; this module cannot turn those claims into authentic evidence. Independent
confirmation counts are meaningful only after provenance and isolation have been
established outside this pure assessment function.

A `verified` result means that the supplied trusted receipts satisfy the specified
contract for the complete manifest. It does not mean universal correctness or
permission to publish, merge, deploy, or send anything.

`buildEffectRequest` retains the full manifest and rejects a mismatched verification
binding. It creates only a request. It does not invoke a tool or mint an approval.
The actual effect owner must still revalidate live identity, source state, policy,
and existing OpenClaw permission and approval requirements before dispatch.

## Integration status

The native profile spawn path is supplied by the preceding PR. Automatic trusted
measurement capture and attaching evidence to every effect owner are not implemented
by this assessment library. Full repository CI and a live native Swarm proof remain
required before claiming end-to-end qualification.
