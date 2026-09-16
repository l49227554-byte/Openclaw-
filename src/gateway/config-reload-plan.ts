import {
  type ChannelId,
  type ChannelPlugin,
  listChannelPlugins,
} from "../channels/plugins/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginLifecycleReason } from "../plugins/lifecycle.js";
import { getActivePluginRegistry, getActivePluginRegistryVersion } from "../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/account-id.js";
import { isTranscriptTitleOnlyConfigChange } from "../transcripts/config-reload.js";
import { isPlainObject } from "../utils.js";
import { canHotReloadGatewayAuthCredentials } from "./auth-resolve.js";

export type ChannelKind = ChannelId;

export type GatewayReloadPlan = {
  changedPaths: string[];
  restartGateway: boolean;
  restartReasons: string[];
  hotReasons: string[];
  reloadHooks: boolean;
  reloadInternalHooks?: boolean;
  /** Refresh the hook target-policy snapshot without invalidating transform modules. */
  refreshHooksPolicy?: boolean;
  restartGmailWatcher: boolean;
  restartCron: boolean;
  restartHeartbeat: boolean;
  reconcileSystemJobs?: boolean;
  reloadPlugins: boolean;
  /** Plugin owners whose undeclared channel settings require fresh registration. */
  reloadPluginIds?: Set<string>;
  pluginLifecycle?: {
    pluginIds: readonly string[];
    reason: PluginLifecycleReason;
    operationId: string;
    expectedSourceDigests?: Readonly<Record<string, string>>;
    expectedInstallHashes?: Readonly<Record<string, string>>;
  };
  restartChannels: Set<ChannelKind>;
  restartServices?: Set<string>;
  disposeMcpRuntimes: boolean;
  /** Account targets; absent means no targeted restarts for hand-built plans. */
  restartChannelAccounts?: Map<ChannelKind, Set<string>>;
  noopPaths: string[];
};

const RELOAD_ACTIONS = [
  "reloadHooks",
  "reloadInternalHooks",
  "refreshHooksPolicy",
  "restartGmailWatcher",
  "restartCron",
  "restartHeartbeat",
  "reconcileSystemJobs",
  "reloadPlugins",
  "disposeMcpRuntimes",
] as const;
type ReloadAction = (typeof RELOAD_ACTIONS)[number];

export function isNoopGatewayReloadPlan(plan: GatewayReloadPlan): boolean {
  return (
    !plan.restartGateway &&
    plan.hotReasons.length === 0 &&
    RELOAD_ACTIONS.every((action) => !plan[action]) &&
    plan.restartChannels.size === 0 &&
    (plan.restartServices?.size ?? 0) === 0 &&
    (plan.restartChannelAccounts?.size ?? 0) === 0
  );
}

type ReloadRule = {
  prefix: string;
  match?: "prefix" | "exact";
  kind: "restart" | "hot" | "none";
  actions?: readonly ReloadAction[];
  channels?: readonly ChannelPlugin[];
  services?: readonly string[];
  replaceChannelPlugins?: boolean;
  accountScoped?: boolean;
};
type ReloadRule = Omit<ReloadPolicy, "prefixes"> & { prefix: string };

type ConfigReloadMetadata = {
  kind: ReloadRule["kind"];
};

type GatewayReloadPlanOptions = {
  noopPaths?: Iterable<string>;
  forceChangedPaths?: Iterable<string>;
  /** Candidate config used to reject removed, unknown, or unresolvable account targets. */
  candidateConfig?: OpenClawConfig;
  previousConfig?: OpenClawConfig;
  /** Authored comparison snapshots retain intent that runtime overlays may hide. */
  previousCompareConfig?: OpenClawConfig;
  candidateCompareConfig?: OpenClawConfig;
};

const PLUGIN_INSTALL_TIMESTAMP_KEYS = ["installedAt", "resolvedAt"] as const;
const AUTH_CREDENTIAL_PATHS = ["gateway.auth.token", "gateway.auth.password"];
const SHARED_CHANNEL_PREFIXES = [
  "agents.defaults.mediaMaxMb",
  "channels.defaults",
  "channels.modelByChannel",
  "messages.inbound",
  "messages.ackReactionScope",
  "commands",
  "accessGroups",
  "tts",
  "surfaces",
  "acp.stream",
  "diagnostics.flags",
];

const BASE_RELOAD_RULES_TAIL: ReloadRule[] = [
  { prefix: "meta", kind: "none" },
  { prefix: "identity", kind: "none" },
  { prefix: "wizard", kind: "none" },
  { prefix: "logging", kind: "none" },
  { prefix: "agents", kind: "none" },
  { prefix: "tools", kind: "hot" },
  { prefix: "bindings", kind: "none" },
  { prefix: "audio", kind: "none" },
  { prefix: "agent", kind: "none" },
  { prefix: "routing", kind: "none" },
  { prefix: "messages", kind: "none" },
  { prefix: "session", kind: "none" },
  { prefix: "talk", kind: "none" },
  { prefix: "skills", kind: "none" },
  { prefix: "secrets", kind: "none" },
  { prefix: "plugins", kind: "hot", actions: ["reload-plugins", "dispose-mcp-runtimes"] },
  { prefix: "tui", kind: "none" },
  { prefix: "ui", kind: "none" },
  { prefix: "gateway", kind: "restart" },
  { prefix: "discovery", kind: "restart" },
];

let cachedReloadRules: ReloadRule[] | null = null;
let cachedRegistry: ReturnType<typeof getActivePluginHttpRouteRegistry> | null = null;
let cachedGatewayRegistryVersion = -1;

function isOwnedChannelConfigPath(path: string, channelId: ChannelId): boolean {
  return path.startsWith(`channels.${channelId}.`);
}

function listReloadRules(): ReloadRule[] {
  // Reload metadata is gateway policy owned by the process-root registry.
  const registry = getActivePluginHttpRouteRegistry();
  const gatewayRegistryVersion = getActivePluginHttpRouteRegistryVersion();
  // Plugin/channel reload rules are process-stable until the root registry
  // version changes; cache them to keep every config diff cheap.
  if (registry !== cachedRegistry || gatewayRegistryVersion !== cachedGatewayRegistryVersion) {
    cachedReloadRules = null;
    cachedRegistry = registry;
    cachedGatewayRegistryVersion = gatewayRegistryVersion;
  }
  if (cachedReloadRules) {
    return cachedReloadRules;
  }
  // Channel docking: plugins contribute hot reload/no-op prefixes here.
  const channelReloadRules: ReloadRule[] = listChannelPlugins().flatMap((plugin) => {
    const restartAction = plugin.reload?.accountScopedRestart
      ? (`restart-channel-account:${plugin.id}` as ReloadAction)
      : (`restart-channel:${plugin.id}` as ReloadAction);
    const hotPrefixRules = (plugin.reload?.configPrefixes ?? []).map((prefix): ReloadRule => {
      const rule: ReloadRule = {
        prefix,
        kind: "hot",
        actions: [restartAction],
      };
      if (plugin.reload?.accountScopedRestart) {
        rule.accountScopedPlugin = plugin;
      }
      return rule;
    });
    const accountIndexRules = (plugin.reload?.accountIndexReloadPaths ?? [])
      .filter((prefix) => isOwnedChannelConfigPath(prefix, plugin.id))
      .map((prefix): ReloadRule => {
        const rule: ReloadRule = {
          prefix,
          match: "exact",
          kind: "hot",
          actions: [restartAction],
        };
        if (plugin.reload?.accountScopedRestart) {
          rule.accountScopedPlugin = plugin;
        }
        return rule;
      });
    return hotPrefixRules.concat(accountIndexRules).concat(
      (plugin.reload?.noopPrefixes ?? []).map(
        (prefix): ReloadRule => ({
          prefix,
          kind: "none",
        }),
      ),
    );
  });
  const channelPluginStateRules: ReloadRule[] = listChannelPlugins().flatMap((plugin) => [
    {
      prefix: `plugins.entries.${plugin.id}`,
      kind: "hot",
      actions: [
        "reload-plugins",
        "dispose-mcp-runtimes",
        `restart-channel:${plugin.id}` as ReloadAction,
      ],
    },
  ]);
  const pluginReloadRules: ReloadRule[] = (registry?.reloads ?? []).flatMap((entry) =>
    (entry.registration.restartPrefixes ?? [])
      .map(
        (prefix): ReloadRule => ({
          prefix,
          kind: "restart",
        }),
      )
      .concat(
        (entry.registration.hotPrefixes ?? []).map(
          (prefix): ReloadRule => ({
            prefix,
            kind: "hot",
          }),
        ),
        (entry.registration.noopPrefixes ?? []).map(
          (prefix): ReloadRule => ({
            prefix,
            kind: "none",
          }),
        ),
      ),
  );
  const rules = [
    ...BASE_RELOAD_RULES,
    ...pluginReloadRules,
    ...channelReloadRules,
    ...channelPluginStateRules,
    ...BASE_RELOAD_RULES_TAIL,
  ];
  // Narrow config contracts must override broad owner fallbacks. Sort once per
  // registry snapshot so the hot path can retain first-match semantics.
  rules.sort((a, b) => b.prefix.length - a.prefix.length);
  cachedReloadRules = rules;
  return rules;
}

function matchRule(path: string): ReloadRule | null {
  for (const rule of listReloadRules()) {
    const exactOnly = rule.match === "exact";
    if (path === rule.prefix || (!exactOnly && path.startsWith(`${rule.prefix}.`))) {
      return rule;
    }
  | undefined;

function getReloadPolicyCatalog() {
  const registry = getActivePluginRegistry();
  const version = getActivePluginRegistryVersion();
  // Only process-root registry publication changes plugin/channel policy.
  if (cachedCatalog?.registry === registry && cachedCatalog.version === version) {
    return cachedCatalog;
  }
  const channelPlugins = listChannelPlugins();
  const servicePolicies = (registry?.services ?? []).map(({ service }) => ({
    prefixes: service.reload?.configPrefixes ?? [],
    services: [service.id],
  }));
  const channelPolicies = channelPlugins.flatMap((plugin): ReloadPolicy[] => [
    {
      prefixes: plugin.reload?.configPrefixes ?? [],
      kind: "hot",
      channels: [plugin],
      accountScoped: plugin.reload?.accountScopedRestart,
    },
    { prefixes: plugin.reload?.noopPrefixes ?? [], kind: "none", channels: [plugin] },
  ]);
  const channelRules = expandReloadPolicies(channelPolicies);
  const sharedPrefixes = new Set([
    ...SHARED_CHANNEL_PREFIXES,
    ...channelRules
      .filter(({ prefix }) =>
        SHARED_CHANNEL_PREFIXES.some((root) => matchesReloadPrefix(prefix, root)),
      )
      .map(({ prefix }) => prefix),
  ]);
  const policies: ReloadPolicy[] = [
    ...CORE_RELOAD_POLICIES,
    ...(registry?.reloads ?? []).flatMap(({ registration }) =>
      (
        [
          ["restart", registration.restartPrefixes],
          ["hot", registration.hotPrefixes],
          ["none", registration.noopPrefixes],
        ] as const
      ).map(([kind, prefixes]) => ({ kind, prefixes: prefixes ?? [] })),
    ),
    // Shared policy belongs to every loaded channel. One owner's opt-out must
    // not suppress sibling refreshes; undeclared owners remain restart-bound.
    ...Array.from(sharedPrefixes, (prefix): ReloadPolicy => {
      const channels = channelPlugins.filter(
        (plugin) =>
          channelRules.find(
            (rule) => rule.channels?.includes(plugin) && matchesReloadPrefix(prefix, rule.prefix),
          )?.kind !== "none",
      );
      const hasService = servicePolicies.some(({ prefixes }) =>
        prefixes.some((owner) => matchesReloadPrefix(prefix, owner)),
      );
      return { prefixes: [prefix], kind: channels.length || hasService ? "hot" : "none", channels };
    }),
    ...channelPolicies,
    ...channelPlugins.map((plugin): ReloadPolicy => ({
      prefixes: [`plugins.entries.${plugin.id}`],
      kind: "hot",
      actions: ["reloadPlugins", "disposeMcpRuntimes"],
      channels: [plugin],
    })),
    { prefixes: ["session.scope", "session.store"], kind: "hot", actions: ["refreshHooksPolicy"] },
    ...DEFAULT_RELOAD_POLICIES,
  ];
  const ownedRules = expandReloadPolicies(policies);
  const rules = [
    ...ownedRules,
    // Narrow service declarations retain existing owner actions, including
    // channel account targeting, while supplying their own hot classification.
    ...servicePolicies.flatMap(({ prefixes }) =>
      prefixes.map((prefix): ReloadRule => ({
        ...ownedRules.find((owner) => matchesReloadPrefix(prefix, owner.prefix)),
        kind: "hot",
        prefix,
      })),
    ),
  ];
  for (const rule of rules) {
    rule.services = servicePolicies
      .filter((service) =>
        service.prefixes.some((owner) => matchesReloadPrefix(rule.prefix, owner)),
      )
      .flatMap((service) => service.services);
  }
  // Narrow config contracts must override broad owner fallbacks. Sort once per
  // registry snapshot so the hot path can retain first-match semantics.
  rules.sort(compareReloadRules);
  cachedCatalog = {
    registry,
    version,
    rules,
    refinementPrefixes: rules.map((rule) => rule.prefix),
  };
  return cachedCatalog;
}

export function listConfigReloadRefinementPrefixes(): string[] {
  return getReloadPolicyCatalog().refinementPrefixes;
}

function matchRule(path: string): ReloadRule | undefined {
  return getReloadPolicyCatalog().rules.find(({ prefix }) => matchesReloadPrefix(path, prefix));
}

export function resolveConfigReloadMetadata(path: string): ConfigReloadMetadata {
  if (isPluginInstallTimestampPath(path)) {
    return { kind: "none" };
  }
  return { kind: matchRule(path)?.kind ?? "restart" };
}

function isPluginInstallTimestampPath(path: string): boolean {
  // Legacy compatibility only: new plugin install metadata lives in the
  // managed plugin index, but old config writes may still touch this path.
  return /^plugins\.installs\..+\.(installedAt|resolvedAt)$/.test(path);
}

function getPluginInstallRecords(config: unknown): Record<string, unknown> {
  if (!isPlainObject(config)) {
    return {};
  }
  const plugins = config.plugins;
  if (!isPlainObject(plugins)) {
    return {};
  }
  // Keep legacy config install records out of gateway restart decisions while
  // migration/doctor moves them into the managed plugin index install records.
  const installs = plugins.installs;
  return isPlainObject(installs) ? installs : {};
}

export function resolvePluginInstallReloadMetadata(prevConfig: unknown, nextConfig: unknown) {
  const prevInstalls = getPluginInstallRecords(prevConfig);
  const nextInstalls = getPluginInstallRecords(nextConfig);
  const ids = new Set([...Object.keys(prevInstalls), ...Object.keys(nextInstalls)]);
  const noopPaths: string[] = [];
  const forceChangedPaths: string[] = [];

  for (const id of ids) {
    const prevRecord = prevInstalls[id];
    const nextRecord = nextInstalls[id];
    if (!isPlainObject(prevRecord) || !isPlainObject(nextRecord)) {
      // A dotted install id can collide with a timestamp path; whole records must still reload.
      forceChangedPaths.push(`plugins.installs.${id}`);
      continue;
    }
    for (const key of PLUGIN_INSTALL_TIMESTAMP_KEYS) {
      if (prevRecord[key] !== nextRecord[key]) {
        noopPaths.push(`plugins.installs.${id}.${key}`);
      }
    }
  }

  return { noopPaths, forceChangedPaths };
}

function extractAccountIdFromPath(channel: ChannelId, path: string): string | null {
  const prefix = `channels.${channel}.accounts.`;
  const id = path.startsWith(prefix) ? path.slice(prefix.length).split(".", 1)[0] : undefined;
  // Default config is the inheritance base, so it can change every account.
  return id && id !== DEFAULT_ACCOUNT_ID ? id : null;
}

function isInspectableChannelAccount(params: {
  plugin: ChannelPlugin;
  accountId: string;
  config: OpenClawConfig;
}): boolean {
  try {
    if (!params.plugin.config.listAccountIds(params.config).includes(params.accountId)) {
      return false;
    }
    const inspectAccount =
      params.plugin.config.inspectAccount ?? params.plugin.config.resolveAccount;
    inspectAccount(params.config, params.accountId);
    return true;
  } catch {
    return false;
  }
}

export function buildGatewayReloadPlan(
  changedPaths: string[],
  options: GatewayReloadPlanOptions = {},
): GatewayReloadPlan {
  const noopPaths = new Set(options.noopPaths);
  const forceChangedPaths = new Set(options.forceChangedPaths);
  const restartChannelAccounts = new Map<ChannelKind, Set<string>>();
  const plan: GatewayReloadPlan = {
    changedPaths,
    restartGateway: false,
    restartReasons: [],
    hotReasons: [],
    reloadHooks: false,
    reloadInternalHooks: false,
    restartGmailWatcher: false,
    restartCron: false,
    restartHeartbeat: false,
    reconcileSystemJobs: false,
    reloadPlugins: false,
    restartChannels: new Set(),
    restartServices: new Set(),
    disposeMcpRuntimes: false,
    restartChannelAccounts,
    noopPaths: [],
  };

  for (const path of changedPaths) {
    // Arrays diff at their parent path. Titles configure future admissions;
    // retaining this exact live capture must not rename or finalize its archive.
    if (
      path === "transcripts.autoStart" &&
      !forceChangedPaths.has(path) &&
      options.previousConfig &&
      options.candidateConfig &&
      options.candidateConfig.gateway?.reload?.mode !== "off" &&
      isTranscriptTitleOnlyConfigChange(
        options.previousCompareConfig ?? options.previousConfig,
        options.candidateCompareConfig ?? options.candidateConfig,
      )
    ) {
      plan.noopPaths.push(path);
      continue;
    }
    const isTimestampNoop =
      !forceChangedPaths.has(path) &&
      (noopPaths.size > 0 ? noopPaths.has(path) : isPluginInstallTimestampPath(path));
    if (isTimestampNoop) {
      plan.noopPaths.push(path);
      continue;
    }
    const rule = matchRule(path);
    const kind = rule?.kind ?? "restart";
    const isCredentialRotation =
      rule &&
      AUTH_CREDENTIAL_PATHS.includes(rule.prefix) &&
      canHotReloadGatewayAuthCredentials(options.previousConfig, options.candidateConfig);
    if (kind === "restart" && !isCredentialRotation) {
      plan.restartGateway = true;
      plan.restartReasons.push(path);
      continue;
    }
    if (kind === "none") {
      plan.noopPaths.push(path);
      continue;
    }
    plan.hotReasons.push(path);
    for (const action of rule?.actions ?? []) {
      plan[action] = true;
    }
    if (rule?.replaceChannelPlugins) {
      // Manifest channel IDs survive even when registration has no active channel.
      for (const record of getReloadPolicyCatalog().registry?.plugins ?? []) {
        if (
          record.channelIds.some(
            (id) => path === "channels" || matchesReloadPrefix(path, `channels.${id}`),
          )
        ) {
          (plan.reloadPluginIds ??= new Set()).add(record.id);
        }
      }
    }
    for (const service of rule?.services ?? []) {
      plan.restartServices?.add(service);
    }
    for (const plugin of rule?.channels ?? []) {
      const accountId = rule?.accountScoped ? extractAccountIdFromPath(plugin.id, path) : null;
      if (
        accountId === null ||
        (options.candidateConfig &&
          !isInspectableChannelAccount({ plugin, accountId, config: options.candidateConfig }))
      ) {
        plan.restartChannels.add(plugin.id);
        continue;
      }
      const accounts = restartChannelAccounts.get(plugin.id) ?? new Set<string>();
      accounts.add(accountId);
      restartChannelAccounts.set(plugin.id, accounts);
    }
  }

  // A wholesale restart covers its account targets and must run only once.
  for (const channel of plan.restartChannels) {
    restartChannelAccounts.delete(channel);
  }

  return plan;
}
