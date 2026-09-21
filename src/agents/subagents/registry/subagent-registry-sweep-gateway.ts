import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { callGateway } from "../../../gateway/call.js";
import { subagentRegistryDeps } from "./subagent-registry-deps.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { hasContinuationWorkForSweepEntry } from "./subagent-registry-sweep-guards.js";

export async function callGatewayForSweep<T>(
  request: Parameters<typeof callGateway>[0],
): Promise<T> {
  if (request.method === "sessions.delete") {
    const key = asOptionalRecord(request.params)?.key;
    if (typeof key === "string") {
      const entry = [...subagentRuns.values()].find(
        (candidate) => candidate.childSessionKey === key,
      );
      if (entry && hasContinuationWorkForSweepEntry(entry)) {
        throw new Error("subagent session still owns live continuation work");
      }
    }
  }
  return await subagentRegistryDeps.callGateway<T>(request);
}
