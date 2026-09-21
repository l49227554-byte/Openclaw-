/** Map installed managed Gateway services to profile-scoped inspection bindings. */
import fs from "node:fs/promises";
import { isRecord, readStringField } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveGatewayLaunchAgentLabel, resolveGatewayWindowsTaskName } from "./constants.js";
import {
  listManagedOpenClawGatewayServices,
  type ExtraGatewayService,
  type ListManagedOpenClawGatewayServicesOptions,
} from "./inspect.js";
import { decodeLaunchdPlistMetadata } from "./launchd-plist.js";
import type { GatewayServiceEnv, SystemdServiceReadTarget } from "./service-types.js";
import { resolveSystemdRunnableUnitName } from "./systemd-scope.js";
import { parseSystemdEnvAssignments, splitSystemdLogicalLines } from "./systemd-unit.js";

export type ManagedGatewayBinding = {
  readonly profile: string;
  readonly env: GatewayServiceEnv;
  readonly scope?: "user" | "system";
  readonly systemdReadTarget?: SystemdServiceReadTarget;
};

function bindingSelectorKey(binding: ManagedGatewayBinding): string {
  return [
    binding.profile,
    binding.scope ?? binding.systemdReadTarget?.scope ?? "",
    binding.systemdReadTarget?.unitPath ?? "",
    binding.env.OPENCLAW_SYSTEMD_UNIT ?? "",
    binding.env.OPENCLAW_LAUNCHD_LABEL ?? "",
    binding.env.OPENCLAW_WINDOWS_TASK_NAME ?? "",
  ].join("\0");
}

function normalizeDiscoveredProfile(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || normalizeLowercaseStringOrEmpty(trimmed) === "default") {
    return "default";
  }
  return trimmed;
}

function hostBindingEnv(
  env: Record<string, string | undefined>,
  extras: GatewayServiceEnv,
): GatewayServiceEnv {
  return {
    ...(env.HOME !== undefined ? { HOME: env.HOME } : {}),
    ...(env.USERPROFILE !== undefined ? { USERPROFILE: env.USERPROFILE } : {}),
    ...extras,
  };
}

function profileEnvFields(profile: string): GatewayServiceEnv {
  return profile === "default" ? {} : { OPENCLAW_PROFILE: profile };
}

function inferProfileFromSystemdUnitName(label: string): string | undefined {
  const name = label.endsWith(".service") ? label.slice(0, -".service".length) : label;
  if (name === "openclaw-gateway") {
    return "default";
  }
  const prefix = "openclaw-gateway-";
  if (name.startsWith(prefix) && name.length > prefix.length) {
    return name.slice(prefix.length);
  }
  return undefined;
}

function inferProfileFromLaunchdLabel(label: string): string | undefined {
  if (label === resolveGatewayLaunchAgentLabel()) {
    return "default";
  }
  const prefix = "ai.openclaw.";
  if (label.startsWith(prefix)) {
    const rest = label.slice(prefix.length);
    if (rest && rest !== "node") {
      return rest;
    }
  }
  return undefined;
}

function inferProfileFromWindowsTaskName(name: string): string | undefined {
  const stripped = name.replace(/^\\+/, "").trim();
  const defaultName = resolveGatewayWindowsTaskName();
  if (normalizeLowercaseStringOrEmpty(stripped) === normalizeLowercaseStringOrEmpty(defaultName)) {
    return "default";
  }
  const match = stripped.match(/^OpenClaw Gateway \((.+)\)$/i);
  return match?.[1]?.trim() || undefined;
}

function readOpenClawProfileFromSystemdUnit(contents: string): string | undefined {
  for (const line of splitSystemdLogicalLines(contents)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }
    if (!trimmed.toLowerCase().startsWith("environment=")) {
      continue;
    }
    for (const { key, value } of parseSystemdEnvAssignments(trimmed.slice("Environment=".length))) {
      if (key === "OPENCLAW_PROFILE" && value.trim()) {
        return value.trim();
      }
    }
  }
  return undefined;
}

function detailPath(prefix: string, detail: string): string | undefined {
  if (!detail.startsWith(prefix)) {
    return undefined;
  }
  return detail.slice(prefix.length).trim();
}

async function readServiceFile(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

async function bindingFromSystemdService(
  svc: ExtraGatewayService,
  env: Record<string, string | undefined>,
): Promise<ManagedGatewayBinding> {
  const unitPath = detailPath("unit:", svc.detail);
  let envProfile: string | undefined;
  if (unitPath) {
    const bytes = await readServiceFile(unitPath);
    if (bytes) {
      envProfile = readOpenClawProfileFromSystemdUnit(bytes.toString("utf8"));
    }
  }
  const profile = normalizeDiscoveredProfile(
    envProfile ?? inferProfileFromSystemdUnitName(svc.label) ?? "default",
  );
  const unitName = resolveSystemdRunnableUnitName(svc.label);
  const systemdReadTarget = unitPath ? { scope: svc.scope, unitName, unitPath } : undefined;
  return {
    profile,
    scope: svc.scope,
    ...(systemdReadTarget ? { systemdReadTarget } : {}),
    env: hostBindingEnv(env, {
      ...profileEnvFields(profile),
      OPENCLAW_SYSTEMD_UNIT: unitName,
    }),
  };
}

async function bindingFromLaunchdService(
  svc: ExtraGatewayService,
  env: Record<string, string | undefined>,
): Promise<ManagedGatewayBinding> {
  const plistPath = detailPath("plist:", svc.detail);
  let envProfile: string | undefined;
  if (plistPath) {
    const bytes = await readServiceFile(plistPath);
    if (bytes) {
      const plist = await decodeLaunchdPlistMetadata(bytes).catch(() => undefined);
      const vars = plist?.EnvironmentVariables;
      if (isRecord(vars)) {
        const profileValue = readStringField(vars, "OPENCLAW_PROFILE");
        if (profileValue?.trim()) {
          envProfile = profileValue.trim();
        }
      }
    }
  }
  const inferred = inferProfileFromLaunchdLabel(svc.label);
  const profile = normalizeDiscoveredProfile(envProfile ?? inferred ?? "default");
  return {
    profile,
    scope: svc.scope,
    env: hostBindingEnv(env, {
      ...profileEnvFields(profile),
      OPENCLAW_LAUNCHD_LABEL: svc.label,
    }),
  };
}

function bindingFromWindowsTask(
  name: string,
  env: Record<string, string | undefined>,
): ManagedGatewayBinding {
  const profile = normalizeDiscoveredProfile(inferProfileFromWindowsTaskName(name) ?? "default");
  return {
    profile,
    scope: "system",
    env: hostBindingEnv(env, {
      ...profileEnvFields(profile),
      OPENCLAW_WINDOWS_TASK_NAME: name.replace(/^\\+/, "").trim() || name,
    }),
  };
}

/**
 * Enumerate installed managed Gateway selectors for the live-dist fence.
 */
export async function discoverManagedGatewayBindings(
  env: Record<string, string | undefined>,
  opts?: ListManagedOpenClawGatewayServicesOptions,
): Promise<ManagedGatewayBinding[]> {
  const results: ManagedGatewayBinding[] = [];
  const seen = new Set<string>();
  const push = (binding: ManagedGatewayBinding) => {
    const key = bindingSelectorKey(binding);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    results.push(binding);
  };

  try {
    for (const svc of await listManagedOpenClawGatewayServices(env, opts)) {
      if (svc.platform === "linux") {
        push(await bindingFromSystemdService(svc, env));
        continue;
      }
      if (svc.platform === "darwin") {
        push(await bindingFromLaunchdService(svc, env));
        continue;
      }
      push(bindingFromWindowsTask(svc.label, env));
    }
  } catch {
    return results;
  }

  return results;
}
