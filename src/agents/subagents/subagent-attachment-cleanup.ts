/** Removes host-owned subagent attachment artifacts by generated identity. */
import { privateFileStore } from "../../infra/private-file-store.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveSubagentSessionAttachmentRootDir } from "./subagent-attachment-paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function cleanupMaterializedSubagentAttachments(params: {
  childSessionKey: string;
  attachmentId: string;
}): Promise<void> {
  if (!UUID_RE.test(params.attachmentId)) {
    throw new Error("invalid subagent attachment identity");
  }
  const rootDir = resolveSubagentSessionAttachmentRootDir({
    agentId: resolveAgentIdFromSessionKey(params.childSessionKey),
    childSessionKey: params.childSessionKey,
  });
  await privateFileStore(rootDir).remove(params.attachmentId);
}
