import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import type { PendingContinuationDelegate } from "./types.js";

type StoredDelegateState = PendingContinuationDelegate & {
  attachmentCount?: number;
  childSessionKey?: string;
  postCompaction?: boolean;
  releasedAt?: number;
  silent?: boolean;
  silentWake?: boolean;
  traceparentProvenance?: "internal";
};

const payloads = new Map<string, Pick<PendingContinuationDelegate, "attachments" | "attachAs">>();

export function storeDelegateAttachmentPayload(
  flowId: string,
  state: Pick<PendingContinuationDelegate, "attachments" | "attachAs">,
): void {
  if (state.attachments) {
    payloads.set(flowId, {
      attachments: state.attachments,
      ...(state.attachAs ? { attachAs: state.attachAs } : {}),
    });
  }
}

export function releaseDelegateAttachmentPayload(flowId: string): void {
  payloads.delete(flowId);
}

export function resetDelegateAttachmentPayloadsForTests(): void {
  payloads.clear();
}

export function projectDelegateFlow(
  flow: TaskFlowRecord,
  state: StoredDelegateState,
  options: { requireAttachmentPayload: boolean },
): PendingContinuationDelegate | undefined {
  const payload = payloads.get(flow.flowId);
  const attachments = state.attachments ?? payload?.attachments;
  const attachAs = state.attachAs ?? payload?.attachAs;
  if (
    options.requireAttachmentPayload &&
    state.attachmentCount !== undefined &&
    (!attachments || attachments.length !== state.attachmentCount)
  ) {
    return undefined;
  }

  const mode =
    state.postCompaction === true
      ? "post-compaction"
      : state.silentWake === true
        ? "silent-wake"
        : state.silent === true
          ? "silent"
          : undefined;
  return {
    task: state.task,
    ...(state.delayMs !== undefined ? { delayMs: state.delayMs } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(state.firstArmedAt !== undefined ? { firstArmedAt: state.firstArmedAt } : {}),
    ...(attachments ? { attachments: structuredClone(attachments) } : {}),
    ...(attachAs ? { attachAs: { ...attachAs } } : {}),
    ...(state.targetSessionKey ? { targetSessionKey: state.targetSessionKey } : {}),
    ...(state.targetSessionKeys?.length ? { targetSessionKeys: state.targetSessionKeys } : {}),
    ...(state.fanoutMode ? { fanoutMode: state.fanoutMode } : {}),
    ...(state.recipientAuthorityBinding
      ? { recipientAuthorityBinding: state.recipientAuthorityBinding }
      : {}),
    ...(state.returnOptions ? { returnOptions: state.returnOptions } : {}),
    ...(state.recipientContext ? { recipientContext: state.recipientContext } : {}),
    ...(state.traceparent && state.traceparentProvenance === "internal"
      ? { traceparent: state.traceparent }
      : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.chainTokensFold !== undefined ? { chainTokensFold: state.chainTokensFold } : {}),
    ...(state.persistedChainState ? { persistedChainState: state.persistedChainState } : {}),
    ...(state.persistedChainStateKind
      ? { persistedChainStateKind: state.persistedChainStateKind }
      : {}),
    ...(state.inheritedSilent ? { inheritedSilent: true } : {}),
    ...(state.inheritedWake ? { inheritedWake: true } : {}),
    ...(state.originRunId ? { originRunId: state.originRunId } : {}),
    flowId: flow.flowId,
    expectedRevision: flow.revision,
  };
}
