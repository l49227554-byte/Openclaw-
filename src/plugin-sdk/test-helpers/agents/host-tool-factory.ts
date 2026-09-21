import { onTestFinished, vi } from "vitest";
import type { createOpenClawCodingToolsInternal } from "../../../agents/agent-tools.js";

type CreateTools = typeof createOpenClawCodingToolsInternal;
/** Receives the real builder so a test can extend the production surface without re-entering this spy. */
type ToolsFactory = (
  options: Parameters<CreateTools>[0],
  actual: CreateTools,
) => ReturnType<CreateTools>;
let createTools: CreateTools | undefined;
const factories = new Map<string, ToolsFactory>();

/** Substitutes construction while preserving the real host's private authority and bindings. */
export async function setHostToolFactoryForTest(
  params: { runId: string },
  factory: ToolsFactory,
): Promise<void> {
  const agentTools = await import("../../../agents/agent-tools.js");
  const actual = (createTools ??= agentTools.createOpenClawCodingToolsInternal);
  factories.set(params.runId, factory);
  const spy = vi
    .spyOn(agentTools, "createOpenClawCodingToolsInternal")
    .mockImplementation((...args) => {
      const runFactory = args[0]?.runId ? factories.get(args[0].runId) : undefined;
      return runFactory ? runFactory(args[0], actual) : actual(...args);
    });
  onTestFinished(() => {
    factories.clear();
    spy.mockRestore();
  });
}
