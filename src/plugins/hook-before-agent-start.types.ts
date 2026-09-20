// before_model_resolve hook
export type PluginHookBeforeModelResolveAttachment = {
  kind: "image" | "video" | "audio" | "document" | "other";
  mimeType?: string;
};

export type PluginHookBeforeModelResolveEvent = {
  /** User prompt for this run. No session messages are available yet in this phase. */
  prompt: string;
  /** Attachment metadata for file-aware model routing. */
  attachments?: PluginHookBeforeModelResolveAttachment[];
  /** Host capabilities exposed to hooks that need an atomic model/effort selection. */
  routingCapabilities?: "model-effort-v1";
  /** Cancels a classifier that is still running when the turn is cancelled. */
  readonly signal?: AbortSignal;
};

export type PluginHookBeforeModelResolveReasoningEffort =
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/**
 * A short host-delivered notice emitted after routing completes and before
 * model dispatch. The host owns delivery so channels render it as a normal
 * status update instead of treating it as assistant prompt text.
 */
export type PluginHookBeforeModelResolveNotice = {
  text: string;
};

export type PluginHookBeforeModelResolveResult = {
  /** Override the model for this agent run. E.g. "llama3.3:8b" */
  modelOverride?: string;
  /** Override the provider for this agent run. E.g. "local-provider" */
  providerOverride?: string;
  /** Apply this provider reasoning effort to the same run as the model override. */
  reasoningEffortOverride?: PluginHookBeforeModelResolveReasoningEffort;
  /** Render the hook's routing decision through the host's block-reply path. */
  preDispatchNotice?: PluginHookBeforeModelResolveNotice;
};

// before_prompt_build hook
export type PluginHookBeforePromptBuildEvent = {
  prompt: string;
  /** Current request before projection. Empty means no textual request; omission is legacy. */
  currentUserMessage?: string;
  /** Stable native admission identity across rebuilds; differs between admitted requests. */
  currentUserMessageId?: string;
  /** Session messages prepared for this run. */
  messages: unknown[];
};

export type PluginHookBeforePromptBuildResult = {
  systemPrompt?: string;
  prependContext?: string;
  appendContext?: string;
  /**
   * Narrows the tools submitted to the model for this turn.
   * An empty array disables optional tools; omitted leaves the existing tool policy unchanged.
   */
  toolsAllow?: string[];
  /**
   * Prepended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  prependSystemContext?: string;
  /**
   * Appended to the agent system prompt so providers can cache it (e.g. prompt caching).
   * Use for static plugin guidance instead of prependContext to avoid per-turn token cost.
   */
  appendSystemContext?: string;
};
