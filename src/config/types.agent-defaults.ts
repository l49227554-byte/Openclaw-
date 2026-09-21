// Defines agent default configuration types shared by runtime schemas.
import type { z } from "zod";
import type {
  AgentRuntimePolicyConfig,
  AgentSandboxConfig,
  AgentToolModelConfig,
} from "./types.agents-shared.js";
import type {
  BlockStreamingChunkConfig,
  BlockStreamingCoalesceConfig,
  HumanDelayConfig,
  TypingMode,
} from "./types.base.js";
import type { AgentDefaultsBaseSchema } from "./zod-schema.agent-defaults-base.js";
import type { AgentContextLimitsSchema, HeartbeatSchema } from "./zod-schema.agent-runtime.js";

type SchemaAgentDefaultsConfig = z.input<typeof AgentDefaultsBaseSchema>;

/** Workspace bootstrap-file injection policy for agent system prompts. */
export type AgentContextInjection = "always" | "continuation-skip" | "never";
/**
 * Optional bootstrap files that setup can skip while still creating required
 * agent files. "HEARTBEAT.md" stays accepted as legacy config input even
 * though workspace setup no longer writes it.
 */
export type OptionalBootstrapFileName = "SOUL.md" | "USER.md" | "HEARTBEAT.md" | "IDENTITY.md";
/** Embedded runner behavior contract used by strict-agentic provider flows. */
export type EmbeddedAgentExecutionContract = "default" | "strict-agentic";
/** Prompt-only default for how strongly agents should delegate to sub-agents. */
export type SubagentDelegationMode = "suggest" | "prefer";
/** Image compression/detail preference used before sending image inputs to models. */
export type AgentImageQualityPreference = "auto" | "efficient" | "balanced" | "high";
/** Scope of an interactive model selection when no explicit scope is supplied. */
export type ModelSelectionScope = "session" | "agent" | "global";
/** Canonical thinking levels accepted by agent defaults and compaction overrides. */
export type AgentThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "adaptive"
  | "max"
  | "ultra";

export type AgentModelEntryConfig = NonNullable<SchemaAgentDefaultsConfig["models"]>[string];

export type AgentModelPolicyConfig = NonNullable<SchemaAgentDefaultsConfig["modelPolicy"]>;

export type AgentModelListConfig = {
  /** Primary provider/model ref. */
  primary?: string;
  /** Ordered provider/model fallback refs. */
  fallbacks?: string[];
};

export type AgentContextPruningConfig = NonNullable<SchemaAgentDefaultsConfig["contextPruning"]>;

export type AgentStartupContextConfig = NonNullable<SchemaAgentDefaultsConfig["startupContext"]>;

export type AgentContextLimitsConfig = NonNullable<z.input<typeof AgentContextLimitsSchema>>;

export type AgentDefaultsConfig = SchemaAgentDefaultsConfig & {
  /** @deprecated Doctor-only legacy input. */
  imageGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  videoGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  musicGenerationModel?: AgentToolModelConfig;
  /** @deprecated Doctor-only legacy input. */
  envelopeTimezone?: string;
  /** @deprecated Doctor-only legacy input. */
  envelopeTimestamp?: "on" | "off";
  /** @deprecated Doctor-only legacy input. */
  envelopeElapsed?: "on" | "off";
  /** @deprecated Doctor-only legacy input. */
  timeFormat?: "auto" | "12" | "24";
  /** @deprecated Doctor-only legacy input. */
  promptOverlays?: { gpt5?: { personality?: "friendly" | "on" | "off" } };
  /**
   * @deprecated Legacy raw config accepted only by doctor/migration repair.
   * Normal schema parsing rejects this key; use per-model agentRuntime instead.
   */
  agentRuntime?: AgentRuntimePolicyConfig;
  contextLimits?: AgentContextLimitsConfig;
  blockStreamingChunk?: BlockStreamingChunkConfig;
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig;
  humanDelay?: HumanDelayConfig;
  typingMode?: TypingMode;
  heartbeat?: NonNullable<z.input<typeof HeartbeatSchema>> & {
    agentId?: string;
  };
  sandbox?: AgentSandboxConfig;
  /** Agent self-elected turn continuation (CONTINUE_WORK signal). */
  continuation?: {
    enabled?: boolean;
    defaultDelayMs?: number;
    minDelayMs?: number;
    maxDelayMs?: number;
    maxChainLength?: number;
    costCapTokens?: number;
    /** Maximum number of continue_delegate tool calls per agent turn (default: 5). */
    maxDelegatesPerTurn?: number;
    /**
     * Maximum concurrent undelivered continue_work flows per session
     * (default: 32). Enforced at enqueue; bounds the multi-continue_work flood
     * independently of maxChainLength (lineage depth).
     */
    maxPendingWork?: number;
    /**
     * Context-pressure awareness threshold (exclusive (0.0, 1.0]). When the session's token
     * usage exceeds this fraction of the context window, a [system:context-pressure]
     * event is injected pre-run so the agent can elect evacuation. Disabled when
     * unset. Recommended: 0.8 (80%).
     */
    contextPressureThreshold?: number;
    /**
     * Early-warning band as a fraction of contextPressureThreshold (default: 0.3125,
     * which fires at 25% when the threshold is 0.8). Set to 0 to opt out.
     */
    earlyWarningBand?: number;
    /**
     * Busy-skip exponential backoff bounds for the continue_work re-arm (rate-cap,
     * not a safety invariant). `baseMs` (default 1000) is the first re-arm delay,
     * multiplied by `factor` (default 2) per consecutive busy-skip up to
     * `ceilingMs` (default: maxDelayMs). The ceiling is the give-up rate-cap —
     * the flow keeps deferring at this rate forever, never dropped.
     */
    busySkipBackoff?: {
      /** First re-arm delay in ms (default 1000). */
      baseMs?: number;
      /** Maximum re-arm delay / give-up rate-cap in ms (default: maxDelayMs). */
      ceilingMs?: number;
      /** Exponential growth factor per consecutive busy-skip (default 2, must be > 1). */
      factor?: number;
    };
    /**
     * Orphan-reap confidence-gate floor in ms. An unended subagent run is
     * treated as confident-terminal (reap-eligible) only after it ages past this
     * cutoff; unset uses the subagent-registry default (2h). The per-run timeout
     * is always respected. Safety invariants (uncertain→quiesce,
     * never-wrongful-reap) are fixed — only this confidence window is tunable.
     */
    orphanReapStaleCutoffMs?: number;
    /**
     * Cross-session delegate targeting policy.
     * - `"disabled"` (default): delegates can return to the dispatching session or
     *   use `fanoutMode: "tree"` for lineage-only routing. Non-self `targetSessionKey`,
     *   `targetSessionKeys` containing any non-self session, and `fanoutMode: "all"`
     *   are rejected with a tool error.
     * - `"enabled"`: all targeting modes are available, including cross-session
     *   `targetSessionKey`, `targetSessionKeys`, and `fanoutMode: "all"`.
     *
     * `fanoutMode: "tree"` (lineage-only return) is always allowed regardless of this setting.
     * Self-targeting (`targetSessionKey` matching the dispatching session) is always allowed.
     */
    crossSessionTargeting?: "disabled" | "enabled";
  };
};
export type AgentCompactionMode = "default" | "safeguard";
export type AgentCompactionPostIndexSyncMode = "off" | "async" | "await";
export type AgentCompactionIdentifierPolicy = "strict" | "off";
export type AgentCompactionQualityGuardConfig = NonNullable<AgentCompactionConfig["qualityGuard"]>;

export type AgentCompactionMidTurnPrecheckConfig = NonNullable<
  AgentCompactionConfig["midTurnPrecheck"]
>;

export type AgentCompactionConfig = NonNullable<SchemaAgentDefaultsConfig["compaction"]>;

export type AgentCompactionMemoryFlushConfig = NonNullable<AgentCompactionConfig["memoryFlush"]>;
