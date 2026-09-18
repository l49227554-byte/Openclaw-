"use strict";

// Native Node module identity is deliberate: source hosts and built SDK chunks must
// share one private owner. Only the standalone worker bundles its own isolated copy.
// Do not publish this module through the SDK.
// Native plugins are not a process sandbox; private imports/cache tampering are outside
// this boundary. Neither scope objects nor globalThis expose these records or writers.
const leases = new WeakMap();

module.exports = Object.freeze({
  mint(scope, authenticated) {
    const lease = { authenticated, active: true };
    leases.set(scope, lease);
    return () => {
      lease.active = false;
    };
  },
  inherit(from, to) {
    const lease = from ? leases.get(from) : undefined;
    if (lease) {
      leases.set(to, lease);
    }
  },
  has(scope) {
    const lease = scope ? leases.get(scope) : undefined;
    return lease?.active === true && lease.authenticated === true;
  },
});
