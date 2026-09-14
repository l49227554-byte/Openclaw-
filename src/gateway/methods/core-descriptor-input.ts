// Leaf contract for one core method policy spec and its pure projection onto a dispatch
// descriptor; the policy table and its lookups stay owned by core-descriptors.ts.
import { isCoreGatewayMethodProfileDependent } from "./core-profile-access.js";
import type {
  GatewayMethodDescriptorInput,
  GatewayMethodHandler,
  GatewayMethodScope,
} from "./descriptor.js";

export type CoreGatewayMethodSpec = {
  name: string;
  family?: string;
  scope: GatewayMethodScope;
  since?: string;
  advertise?: false;
  startup?: true;
  controlPlaneWrite?: true;
  compatibilityRestored?: true;
  description?: string;
};

export function toCoreGatewayMethodDescriptorInput(
  spec: CoreGatewayMethodSpec,
  handler: GatewayMethodHandler,
): GatewayMethodDescriptorInput {
  return {
    name: spec.name,
    handler,
    owner: { kind: "core", area: "gateway" },
    scope: spec.scope,
    profileAccess: isCoreGatewayMethodProfileDependent(spec.name) ? "required" : "independent",
    ...(spec.since ? { since: spec.since } : {}),
    ...(spec.advertise === false ? { advertise: false } : {}),
    ...(spec.startup === true ? { startup: "unavailable-until-sidecars" } : {}),
    ...(spec.controlPlaneWrite === true ? { controlPlaneWrite: true } : {}),
    ...(spec.description ? { description: spec.description } : {}),
  };
}
