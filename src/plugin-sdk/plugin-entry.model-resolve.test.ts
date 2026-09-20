import { describe, expectTypeOf, it } from "vitest";
import type {
  PluginHookBeforeModelResolveAttachment,
  PluginHookBeforeModelResolveEvent,
  PluginHookBeforeModelResolveNotice,
  PluginHookBeforeModelResolveReasoningEffort,
  PluginHookBeforeModelResolveResult,
} from "./plugin-entry.js";

describe("public model-resolve hook SDK types", () => {
  it("exposes the classifier event and atomic route result through plugin-entry", () => {
    expectTypeOf<PluginHookBeforeModelResolveAttachment>().toMatchTypeOf<{
      kind: string;
      mimeType?: string;
    }>();
    expectTypeOf<PluginHookBeforeModelResolveEvent>().toMatchTypeOf<{
      prompt: string;
      routingCapabilities?: "model-effort-v1";
      signal?: AbortSignal;
    }>();
    expectTypeOf<PluginHookBeforeModelResolveNotice>().toMatchTypeOf<{ text: string }>();
    expectTypeOf<PluginHookBeforeModelResolveReasoningEffort>().toEqualTypeOf<
      "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
    >();
    expectTypeOf<PluginHookBeforeModelResolveResult>().toMatchTypeOf<{
      modelOverride?: string;
      providerOverride?: string;
      reasoningEffortOverride?: PluginHookBeforeModelResolveReasoningEffort;
      preDispatchNotice?: PluginHookBeforeModelResolveNotice;
    }>();
  });
});
