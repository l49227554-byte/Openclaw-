import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  GatewayAccessGrantRef,
  PluginGatewayAccessAuthority,
} from "../plugins/gateway-access-policy.types.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import { readUserProfileVersion } from "../state/user-profile-events.js";
import { getUserProfileListItem } from "../state/user-profiles.js";
import { resolveOperatorRolePolicyForAssignment } from "./operator-role-policy.js";

export const GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE =
  "Gateway access is no longer active; ask a Gateway administrator to restore it.";

export class GatewayOperatorAccessDeniedError extends Error {
  constructor() {
    super(GATEWAY_OPERATOR_ACCESS_DENIED_MESSAGE);
    this.name = "GatewayOperatorAccessDeniedError";
  }
}

export class GatewayOperatorAccessUnavailableError extends Error {
  constructor() {
    super("Gateway access policy is unavailable; retry after its plugin is ready.");
    this.name = "GatewayOperatorAccessUnavailableError";
  }
}

export type GatewayOperatorAccessAuthority = PluginGatewayAccessAuthority & {
  readonly gatewayAccessGrant?: GatewayAccessGrantRef;
};

function currentAccessPolicies() {
  const registry = getPluginRegistryState()?.activeRegistry;
  return (
    registry?.gatewayAccessPolicies?.filter((registration) =>
      registry.plugins.some(
        (plugin) =>
          plugin.id === registration.pluginId && plugin.enabled && plugin.status === "loaded",
      ),
    ) ?? []
  );
}

export function hasGatewayOperatorAccessPolicies(config: OpenClawConfig): boolean {
  return (
    currentAccessPolicies().length > 0 ||
    Object.values(config.gateway?.roles?.definitions ?? {}).some((role) => role.accessPolicyPlugin)
  );
}

/** Bind additional access to this exact authenticated person and the original policy lifetimes. */
export function resolveGatewayOperatorAccessAuthority(
  profileId: string,
  config: OpenClawConfig,
): GatewayOperatorAccessAuthority | null {
  if (profileId === GATEWAY_OWNER_PROFILE_ID) {
    return null;
  }
  const policies = currentAccessPolicies();
  if (policies.length === 0 && !hasGatewayOperatorAccessPolicies(config)) {
    return null;
  }
  const profile = getUserProfileListItem(profileId);
  const requiredPlugin = resolveOperatorRolePolicyForAssignment(
    profile.id,
    profile.role ?? null,
    config,
  )?.accessPolicyPlugin;
  if (requiredPlugin && !policies.some((entry) => entry.pluginId === requiredPlugin)) {
    throw new GatewayOperatorAccessDeniedError();
  }
  const emails = [...profile.emails];
  let authorities: Array<{ pluginId: string; authority: PluginGatewayAccessAuthority }>;
  try {
    let requiredPolicyConfirmed = !requiredPlugin;
    authorities = policies.flatMap(({ pluginId, policy }) => {
      const authority = policy.authorize({
        config,
        profile: { profileId: profile.id, emails: [...emails], assignedRole: profile.role ?? null },
      });
      if (authority && pluginId === requiredPlugin) {
        requiredPolicyConfirmed = true;
      }
      return authority ? [{ pluginId, authority }] : [];
    });
    if (!requiredPolicyConfirmed) {
      throw new GatewayOperatorAccessDeniedError();
    }
  } catch {
    // Policy errors can contain private configuration; only the generic denial crosses ingress.
    throw new GatewayOperatorAccessDeniedError();
  }
  if (authorities.length === 0) {
    return null;
  }
  const invalidated = new AbortController();
  const signal = AbortSignal.any([
    invalidated.signal,
    ...authorities.map(({ authority }) => authority.signal),
  ]);
  let profileVersion = readUserProfileVersion();
  let denial: GatewayOperatorAccessDeniedError | undefined;
  const assertCurrent = () => {
    try {
      signal.throwIfAborted();
      if (profile.id !== profileId) {
        throw new GatewayOperatorAccessDeniedError();
      }
      const currentVersion = readUserProfileVersion();
      if (currentVersion !== profileVersion) {
        const current = getUserProfileListItem(profileId);
        const currentEmails = new Set(current.emails);
        // A merge or alias replacement cannot transfer a captured grant to its successor.
        // Display/avatar changes leave these facts unchanged and preserve admitted work.
        if (current.id !== profileId || emails.some((email) => !currentEmails.has(email))) {
          throw new GatewayOperatorAccessDeniedError();
        }
        profileVersion = currentVersion;
      }
      for (const { authority } of authorities) {
        authority.assertCurrent();
      }
    } catch {
      // Once closed, a later invitation, profile repair or renewal cannot revive this capture.
      denial ??= new GatewayOperatorAccessDeniedError();
      invalidated.abort(denial);
      throw denial;
    }
  };
  assertCurrent();
  const original = authorities.length === 1 ? authorities[0] : undefined;
  return {
    assertCurrent,
    signal,
    gatewayAccessGrant: original?.authority.grantId
      ? Object.freeze({ pluginId: original.pluginId, grantId: original.authority.grantId })
      : undefined,
  };
}

/** Revalidate the recorded basis without adopting a new invitation or a role exemption. */
export function resumeGatewayOperatorAccessGrant(
  profileId: string,
  config: OpenClawConfig,
  grant: GatewayAccessGrantRef | null,
): void {
  const policies = currentAccessPolicies();
  const profile = getUserProfileListItem(profileId);
  if (profile.id !== profileId) {
    throw new GatewayOperatorAccessDeniedError();
  }
  const requiredPlugin = resolveOperatorRolePolicyForAssignment(
    profile.id,
    profile.role ?? null,
    config,
  )?.accessPolicyPlugin;
  if (requiredPlugin && requiredPlugin !== grant?.pluginId) {
    // A newly required policy cannot replace the original request's recorded basis.
    throw new GatewayOperatorAccessDeniedError();
  }
  const context = {
    config,
    profile: {
      profileId,
      emails: profile.emails,
      assignedRole: profile.role ?? null,
    },
  };
  if (grant) {
    const policy = policies.find(({ pluginId }) => pluginId === grant.pluginId)?.policy;
    if (!policy?.resume) {
      throw new GatewayOperatorAccessUnavailableError();
    }
    let authority: PluginGatewayAccessAuthority | undefined;
    try {
      authority = policy.resume({ ...context, grantId: grant.grantId });
      authority?.signal.throwIfAborted();
      authority?.assertCurrent();
    } catch {
      // Startup and unavailable observations are not evidence that a grant ended.
      throw new GatewayOperatorAccessUnavailableError();
    }
    if (!authority || authority.grantId !== grant.grantId) {
      throw new GatewayOperatorAccessDeniedError();
    }
  }
  for (const { pluginId, policy } of policies) {
    if (pluginId === grant?.pluginId) {
      continue;
    }
    let authority: PluginGatewayAccessAuthority | undefined;
    try {
      authority = policy.authorize(context);
    } catch {
      throw new GatewayOperatorAccessUnavailableError();
    }
    if (authority) {
      // A newly applicable policy needs a fresh request bound to that dependency.
      throw new GatewayOperatorAccessDeniedError();
    }
  }
}

export function hasCurrentGatewayOperatorAccess(
  authority: PluginGatewayAccessAuthority | null | undefined,
): boolean {
  try {
    authority?.signal.throwIfAborted();
    authority?.assertCurrent();
    return true;
  } catch {
    return false;
  }
}
