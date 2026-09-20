import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { AgentRunTerminalDeliverySnapshot } from "../../agents/agent-run-terminal-delivery.js";
import type { AgentRunTerminalOutcome } from "../../agents/agent-run-terminal-outcome.js";
import type { AgentRunTerminalReceipt } from "../../agents/agent-run-terminal-receipt.js";
import type { AgentRunTerminalReplySnapshot } from "../../agents/agent-run-terminal-reply.types.js";
import type { MainSessionRecoveryPendingTarget } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import type {
  PreparedModelRuntimeLease,
  PreparedReplyDispatchRuntime,
} from "../../agents/prepared-model-runtime.js";
import type { TrustedSubagentCompletionHandoff } from "../../agents/subagents/announce/subagent-announce-handoff.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import type { SessionWorkAdmissionLease } from "../../sessions/session-lifecycle-admission.js";
import type { ChatAbortControllerEntry, registerChatAbortController } from "../chat-abort.js";
import type { ChatImageContent, OffloadedRef } from "../chat-attachments.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import type { GatewayCronCreatorAuthorityAdmission } from "../server-methods/cron-creator-authority-admission.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  RespondFn,
} from "../server-methods/shared-types.js";
import type { AgentDeliveryPhaseResult } from "./agent-delivery-phase.js";
import type { RestoredCronContinuation } from "./agent-handler-helpers.js";
import type { GatewayAgentDispatchTaskTracking } from "./agent-run-task-tracking.js";
import type { PreparedAgentRunUserTurn } from "./agent-run-user-turn.js";

export type AgentTurnFrame = readonly [
  ok: Parameters<RespondFn>[0],
  payload: Parameters<RespondFn>[1],
  error: Parameters<RespondFn>[2],
];

type AgentTurnAcceptance = AgentTurnFrame;
type AgentTurnFinal = AgentTurnFrame;

export type AgentTurnIo = {
  emitAcceptance: (acceptance: AgentTurnAcceptance, meta?: Parameters<RespondFn>[3]) => void;
  /** Publishes the exact controller before asynchronous runtime preparation. */
  emitStartOwner?: (runId: string, entry: ChatAbortControllerEntry) => void;
  /** Internal lifecycle observer; public transports do not expose this callback. */
  emitExecutionStarted?: () => void;
  emitFinal: (final: AgentTurnFinal, meta?: Parameters<RespondFn>[3]) => void;
};

export type AgentTurnPrincipal = Pick<
  GatewayClient,
  | "authenticatedUserId"
  | "authenticatedUserProfile"
  | "connId"
  | "connect"
  | "internal"
  | "isDeviceTokenAuth"
>;

export type AgentTurnContext = Pick<
  GatewayRequestContext,
  | "addChatRun"
  | "agentRunSeq"
  | "broadcast"
  | "broadcastToConnIds"
  | "cancelRunBoundApprovals"
  | "chatAbortControllers"
  | "chatQueuedTurns"
  | "chatRunState"
  | "dedupe"
  | "deps"
  | "getRuntimeConfig"
  | "getSessionEventSubscriberConnIds"
  | "loadGatewayModelCatalog"
  | "loadGatewayModelCatalogSnapshot"
  | "logGateway"
  | "nodeSendToSession"
  | "removeChatRun"
  | "requestEntryLifetime"
  | "resolveGatewayContext"
  | "validateAgentRuntimeApprovalAuthority"
>;

export type AgentJobTerminalSnapshot = {
  status: "ok" | "error" | "timeout";
  startedAt?: number;
  endedAt?: number;
  error?: string;
  stopReason?: string;
  livenessState?: string;
  yielded?: boolean;
  pendingError?: boolean;
  timeoutPhase?: AgentRunTerminalOutcome["timeoutPhase"];
  providerStarted?: boolean;
  terminalDelivery?: AgentRunTerminalDeliverySnapshot;
  terminalReceipt?: AgentRunTerminalReceipt;
  terminalReply?: AgentRunTerminalReplySnapshot;
};

export type AgentJobSession = {
  sessionKey: string;
  sessionId: string;
  agentId?: string;
  lifecycleGeneration: string;
};

export type AgentJobObservation = AgentJobTerminalSnapshot & {
  readonly session?: Readonly<AgentJobSession>;
};

export type PreparedAgentRunDispatch = {
  activeGatewayWorkAdmission: SessionWorkAdmissionLease;
  activeRunAbort: ReturnType<typeof registerChatAbortController>;
  cronCreatorAuthority?: GatewayCronCreatorAuthorityAdmission;
  releaseCallerAuthority?: () => void;
  operationalRunInstance: OperationalRunInstanceRef;
  effectiveProviderOverride?: string;
  effectiveModelOverride?: string;
  effectiveThinking?: string;
  effectiveAllowModelOverride: boolean;
  trustedInternalHandoff?: TrustedSubagentCompletionHandoff;
  restoredCronContinuationLifecycleRevision?: string;
  lifecycleStorePath: string;
  resolvedThreadId?: string | number;
  dispatchTaskTrackingMode: GatewayAgentDispatchTaskTracking;
  preparedModelRuntimeLease: PreparedModelRuntimeLease;
  replyDispatchRuntime: PreparedReplyDispatchRuntime;
  unpersistedOffloadedRefs: OffloadedRef[];
  userTurn: PreparedAgentRunUserTurn;
  workspaceOverride?: string;
  restoreAdmittedRestartRecoveryInterrupted?: () => Promise<
    MainSessionRecoveryPendingTarget | undefined
  >;
};

export type PrepareAgentRunDispatchParams = {
  assertAdmissionCurrent?: () => void;
  hasCurrentClientAuthority?: () => boolean;
  promptedAt: number;
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  cfgForAgent?: OpenClawConfig;
  sessionEntry?: SessionEntry;
  resolvedSessionKey?: string;
  requestedSessionKeyRaw?: string;
  requestedSessionKey?: string;
  preAcceptedReservedSessionKey?: string;
  activeSessionAgentId: string;
  delivery: AgentDeliveryPhaseResult;
  restoredCronContinuationIdentity?: Pick<
    RestoredCronContinuation,
    "lifecycleRevision" | "sessionId"
  >;
  restoredCronContinuation?: RestoredCronContinuation;
  providerOverride?: string;
  modelOverride?: string;
  allowModelOverride: boolean;
  lifecycleGeneration: string;
  getAdmittedSessionId: () => string;
  ownerConnId?: string;
  ownerDeviceId?: string;
  suppressVisibleSessionEffects: boolean;
  pendingChatRun?: { sessionKey: string; agentId?: string };
  inputProvenance?: InputProvenance;
  isOneShotModelRun: boolean;
  isRestartRecoveryResumeRun: boolean;
  canUseInternalRuntimeHandoff: boolean;
  execApprovalFollowupApprovalId?: string;
  message: string;
  effectiveTranscriptInputText: string;
  images: ChatImageContent[];
  offloadedRefs: OffloadedRef[];
  onUserTurnMediaPersisted: () => void;
  requestedPromptPersistenceSuppression: boolean;
  privateCompletion?: true;
  runId: string;
  agentDedupeKeys: readonly string[];
  context: AgentTurnContext;
  client: AgentTurnPrincipal | null;
  io: AgentTurnIo;
  abortForLifecycleRotation: (target?: { sessionKey?: string; agentId?: string }) => boolean;
  acquireGatewayWorkAdmission: (scope: string) => Promise<void>;
  assertGatewayWorkAdmissionAllowed: () => void;
  hasGatewayAdmissionOutcome: () => boolean;
  respondToGatewayAdmissionOutcome: () => boolean;
  admissionAgentId: () => string | undefined;
  getGatewayWorkAdmission: () => SessionWorkAdmissionLease | undefined;
  setAdmittedRunAbort: (value: ReturnType<typeof registerChatAbortController>) => void;
  getAdmittedRunAbort: () => ReturnType<typeof registerChatAbortController> | undefined;
  markAgentRunAccepted: (accepted: boolean) => void;
};
