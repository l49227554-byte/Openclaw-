import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveConversationAccessAllowed,
  resolvePromptInjectionAllowed,
} from "./hook-policy-decisions.js";
import type { PluginRegistry } from "./registry-types.js";
import { isConversationHookName, isPromptInjectionHookName, type PluginHookName } from "./types.js";

/** Retain full-only execution boundaries in a matching prepared discovery generation. */
export function adoptRuntimeToolPolicyRegistrations(
  target: PluginRegistry,
  runtime: PluginRegistry,
  config?: OpenClawConfig,
): PluginRegistry {
  const matches = (pluginId: string) => {
    const owner = target.plugins.find((plugin) => plugin.id === pluginId);
    const active = runtime.plugins.find((plugin) => plugin.id === pluginId);
    return (
      owner?.status === "loaded" &&
      active?.status === "loaded" &&
      Boolean(owner.source) &&
      owner.source === active.source
    );
  };
  const permitsHook = (pluginId: string, hookName: PluginHookName) => {
    if (
      hookName === "before_tool_call" ||
      hookName === "after_tool_call" ||
      hookName === "tool_result_transform"
    )
      return true;
    if (!isConversationHookName(hookName)) return false;
    const owner = target.plugins.find((plugin) => plugin.id === pluginId);
    const policy = config?.plugins?.entries?.[pluginId]?.hooks;
    // Prepared generations replace the root hook view. Preserve the admitted
    // conversation lifecycle, but never resurrect revoked conversation or
    // prompt-injection grants from an older root registry.
    return (
      owner !== undefined &&
      resolveConversationAccessAllowed(owner.origin, policy) &&
      (!isPromptInjectionHookName(hookName) || resolvePromptInjectionAllowed(policy))
    );
  };
  const hooks = runtime.typedHooks.filter(
    (hook) =>
      permitsHook(hook.pluginId, hook.hookName) &&
      matches(hook.pluginId) &&
      !target.typedHooks.some(
        (candidate) => candidate.pluginId === hook.pluginId && candidate.hookName === hook.hookName,
      ),
  );
  const policies = runtime.trustedToolPolicies.filter(
    (entry) =>
      matches(entry.pluginId) &&
      !target.trustedToolPolicies.some(
        (candidate) =>
          candidate.pluginId === entry.pluginId && candidate.policy.id === entry.policy.id,
      ),
  );
  return hooks.length || policies.length
    ? {
        ...target,
        typedHooks: [...target.typedHooks, ...hooks],
        trustedToolPolicies: [...target.trustedToolPolicies, ...policies].toSorted(
          (a, b) => (a.origin === "bundled" ? 0 : 1) - (b.origin === "bundled" ? 0 : 1),
        ),
      }
    : target;
}
