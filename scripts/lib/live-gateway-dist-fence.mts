import fs from "node:fs/promises";
import path from "node:path";
import type { ManagedGatewayBinding } from "../../src/daemon/managed-gateway-bindings.ts";
import type { GatewayServiceEnv, GatewayServiceState } from "../../src/daemon/service-types.ts";

export type LiveGatewayDistFenceDeps = {
  env?: NodeJS.ProcessEnv;
  listBindings?: (env: GatewayServiceEnv) => Promise<readonly ManagedGatewayBinding[]>;
  readState?: (binding?: ManagedGatewayBinding) => Promise<GatewayServiceState>;
  matchesRoot?: (root: string, command: GatewayServiceState["command"]) => Promise<boolean | null>;
  isPidAlive?: (pid: number) => boolean;
};

export type LiveGatewayDistFenceResult = { refuse: true; message: string } | { refuse: false };

const ALLOW_ENV = "OPENCLAW_ALLOW_LIVE_DIST_BUILD";

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** True when the managed service still holds a live process on this checkout's dist. */
export function isLiveManagedGatewayHoldingDist(
  state: GatewayServiceState,
  options: { isPidAlive?: (pid: number) => boolean } = {},
): boolean {
  if (state.running) {
    return true;
  }
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const pid = state.runtime?.pid;
  if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1 && isPidAlive(pid)) {
    return true;
  }
  const status = state.runtime?.status?.toLowerCase() ?? "";
  const subState = state.runtime?.subState?.toLowerCase() ?? "";
  // systemd stop/restart drains keep MainPID alive under deactivating states.
  return (
    status === "deactivating" ||
    subState === "stop-sigterm" ||
    subState === "stop-sigkill" ||
    subState === "final-sigterm"
  );
}

function normalizeFenceProfile(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.toLowerCase() === "default") {
    return "default";
  }
  return trimmed;
}

function bindingFromProcessEnv(env: NodeJS.ProcessEnv): ManagedGatewayBinding {
  return {
    profile: normalizeFenceProfile(env.OPENCLAW_PROFILE),
    env: env as GatewayServiceEnv,
  };
}

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

function dedupeBindings(bindings: readonly ManagedGatewayBinding[]): ManagedGatewayBinding[] {
  const seen = new Set<string>();
  const out: ManagedGatewayBinding[] = [];
  for (const binding of bindings) {
    const key = bindingSelectorKey(binding);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(binding);
  }
  return out;
}

function formatStopHint(profile: string): string {
  return profile === "default"
    ? "`openclaw gateway stop`"
    : `\`openclaw gateway stop --profile ${profile}\``;
}

function formatRefuseMessage(params: {
  profiles: readonly string[];
  entrypoint?: string;
  unit?: string;
}): string {
  const profiles = params.profiles.toSorted((left, right) =>
    (left ?? "").localeCompare(right ?? ""),
  );
  const profileText =
    profiles.length === 1 ? ` (profile ${profiles[0]})` : ` (profiles ${profiles.join(", ")})`;
  const entry = params.entrypoint ? ` (${params.entrypoint})` : "";
  const unit = params.unit ? ` unit ${params.unit}` : "";
  const stopHints = profiles.map((profile) => formatStopHint(profile)).join(", ");
  return (
    `[openclaw] Refusing to rebuild dist while a managed Gateway${profileText}${unit} is still running from this checkout's dist${entry}. ` +
    `Stop the Gateway first (${stopHints} or the matching service stop) or run \`openclaw update\`, then rebuild and start. ` +
    `Set ${ALLOW_ENV}=1 only for intentional live mutations.`
  );
}

async function tryRealpath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await fs.realpath(resolved);
  } catch {
    return resolved;
  }
}

async function loadFenceRuntime() {
  try {
    const [layout, service, pathGuards] = await Promise.all([
      import("../../src/daemon/service-layout.ts"),
      import("../../src/daemon/service.ts"),
      import("../../src/infra/path-guards.ts"),
    ]);
    return {
      summarizeGatewayServiceLayout: layout.summarizeGatewayServiceLayout,
      resolveServiceEntrypoint: layout.resolveServiceEntrypoint,
      readGatewayServiceState: service.readGatewayServiceState,
      resolveGatewayService: service.resolveGatewayService,
      isPathInside: pathGuards.isPathInside,
    };
  } catch {
    return null;
  }
}

async function samePathIdentity(left: string, right: string): Promise<boolean> {
  if (left === right) {
    return true;
  }
  const [leftStat, rightStat] = await Promise.all([
    fs.stat(left).catch(() => null),
    fs.stat(right).catch(() => null),
  ]);
  return Boolean(
    leftStat && rightStat && leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino,
  );
}

/**
 * True when this checkout's dist physically overlaps the serving Gateway
 * artifacts. Logical current/releases ownership is not enough.
 */
export async function gatewayServiceCommandOverlapsPhysicalCheckout(
  checkoutRoot: string,
  command: GatewayServiceState["command"],
): Promise<boolean | null> {
  const runtime = await loadFenceRuntime();
  if (!runtime) {
    return null;
  }
  const layout = await runtime.summarizeGatewayServiceLayout(command);
  const servingRoot = layout?.packageRootReal ?? layout?.packageRoot;
  const servingEntry = layout?.entrypointReal ?? layout?.entrypoint;
  if (
    !servingRoot ||
    !servingEntry ||
    (!path.isAbsolute(servingEntry) && !path.win32.isAbsolute(servingEntry))
  ) {
    return null;
  }

  const checkoutReal = await tryRealpath(checkoutRoot);
  const checkoutDist = await tryRealpath(path.join(checkoutRoot, "dist"));
  const servingDist = await tryRealpath(path.join(servingRoot, "dist"));
  const servingEntryReal = await tryRealpath(servingEntry);

  if (await samePathIdentity(checkoutReal, servingRoot)) {
    return true;
  }
  if (await samePathIdentity(checkoutDist, servingDist)) {
    return true;
  }
  return (
    runtime.isPathInside(checkoutDist, servingEntryReal) ||
    runtime.isPathInside(checkoutDist, servingDist) ||
    runtime.isPathInside(servingDist, checkoutDist)
  );
}

async function resolveFenceBindings(
  env: NodeJS.ProcessEnv,
  deps: LiveGatewayDistFenceDeps,
): Promise<readonly ManagedGatewayBinding[] | null> {
  try {
    if (deps.listBindings) {
      return await deps.listBindings(env as GatewayServiceEnv);
    }
    const current = bindingFromProcessEnv(env);
    if (deps.readState) {
      return [current];
    }
    const inspect = await import("../../src/daemon/managed-gateway-bindings.ts");
    const discovered = await inspect.discoverManagedGatewayBindings(env);
    return dedupeBindings([current, ...discovered]);
  } catch {
    return null;
  }
}

/**
 * Returns a refuse decision when a managed Gateway ExecStart resolves into
 * `checkoutRoot` and the service still holds a live process.
 */
export async function resolveLiveManagedGatewayDistFence(
  checkoutRoot: string,
  deps: LiveGatewayDistFenceDeps = {},
): Promise<LiveGatewayDistFenceResult> {
  const env = deps.env ?? process.env;
  if (env[ALLOW_ENV] === "1") {
    return { refuse: false };
  }

  const bindings = await resolveFenceBindings(env, deps);
  if (!bindings) {
    return { refuse: false };
  }

  const readState =
    deps.readState ??
    (async (binding?: ManagedGatewayBinding) => {
      const runtime = await loadFenceRuntime();
      if (!runtime) {
        throw new Error("gateway service inspection unavailable");
      }
      // Binding env is the selector census. Do not merge ambient profile/unit
      // overrides on top or a discovered sibling inherits the caller selectors.
      return await runtime.readGatewayServiceState(runtime.resolveGatewayService(), {
        env: (binding?.env ?? env) as GatewayServiceEnv,
        ...(binding?.systemdReadTarget ? { systemdReadTarget: binding.systemdReadTarget } : {}),
      });
    });
  const matchesRoot =
    deps.matchesRoot ??
    ((root, command) => gatewayServiceCommandOverlapsPhysicalCheckout(root, command));

  const root = path.resolve(checkoutRoot);
  const holds: Array<{ profile: string; state: GatewayServiceState }> = [];
  for (const binding of bindings) {
    try {
      const state = await readState(binding);
      const matches = await matchesRoot(root, state.command);
      if (matches !== true) {
        continue;
      }
      if (!isLiveManagedGatewayHoldingDist(state, { isPidAlive: deps.isPidAlive })) {
        continue;
      }
      holds.push({ profile: normalizeFenceProfile(binding.profile), state });
    } catch {
      // Fail open per binding.
    }
  }
  if (holds.length === 0) {
    return { refuse: false };
  }

  const runtime = await loadFenceRuntime();
  let entrypoint: string | undefined;
  let unit: string | undefined;
  for (const hold of holds) {
    if (!entrypoint && hold.state.command && runtime) {
      entrypoint = runtime.resolveServiceEntrypoint(hold.state.command);
    }
    if (!unit && hold.state.runtime?.systemd?.unit) {
      unit = hold.state.runtime.systemd.unit;
    }
  }

  return {
    refuse: true,
    message: formatRefuseMessage({
      profiles: holds.map((hold) => hold.profile),
      ...(entrypoint ? { entrypoint } : {}),
      ...(unit ? { unit } : {}),
    }),
  };
}
