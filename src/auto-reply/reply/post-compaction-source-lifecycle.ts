import type { SessionEntry } from "../../config/sessions/types.js";

export function assertPostCompactionSourceLifecycle(
  entry: { sourceSessionId?: string; sourceLifecycleRevision?: string },
  current: SessionEntry | undefined,
): asserts current is SessionEntry {
  if (
    !entry.sourceSessionId ||
    current?.sessionId !== entry.sourceSessionId ||
    current.lifecycleRevision !== entry.sourceLifecycleRevision
  ) {
    throw new Error("Continuation delegate source session lifecycle changed.");
  }
}
