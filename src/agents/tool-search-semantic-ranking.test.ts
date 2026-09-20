import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { DecisionBatch, DecisionOutcome, DecisionRuntimeV1 } from "../decisions/types.js";
import { ToolSearchRuntime } from "./tool-search-runtime.js";
import type { ToolSearchToolContext } from "./tool-search-types.js";
import {
  createToolSearchCatalogRef,
  createToolSearchTools,
  registerHeadlessToolSearchCatalog,
  resolveToolSearchConfig,
  TOOL_SEARCH_RAW_TOOL_NAME,
  TOOL_SEARCH_CODE_MODE_TOOL_NAME,
} from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

function fakeTool(name: string): AnyAgentTool {
  return {
    name,
    label: name,
    description: `Manage calendar events with ${name}`,
    parameters: Type.Object({
      calendarId: Type.String({ description: "Calendar to update" }),
    }),
    execute: vi.fn(async (_toolCallId, input) => jsonResult({ input })),
  };
}

function outcomeFor(batch: DecisionBatch, choice = "candidate_0"): DecisionOutcome {
  const question = batch.questions.bestCandidate;
  const probabilities =
    question?.type === "choice"
      ? Object.fromEntries(
          Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0]),
        )
      : { [choice]: 1 };
  return {
    status: "ok",
    result: {
      model: "fixture-semantic-v1",
      answers: {
        bestCandidate: {
          type: "choice",
          choice,
          probabilities,
        },
      },
    },
    provenance: {
      providerId: "fixture",
      rubricVersion: "tool-search-ranking-v1",
      runtimeGeneration: "test-generation",
    },
  };
}

function makeHarness(params: {
  count?: number;
  semanticRanking?: "off" | "shadow";
  bindOwnerSignal?: boolean;
  decisionRuntime?: Pick<DecisionRuntimeV1, "evaluate">;
}) {
  const catalogRef = createToolSearchCatalogRef();
  const abortController = new AbortController();
  const tools = Array.from({ length: params.count ?? 4 }, (_, index) =>
    fakeTool(`calendar_event_${index}`),
  );
  registerHeadlessToolSearchCatalog({ catalogRef, tools });
  const config = {
    tools: {
      toolSearch: {
        enabled: true,
        mode: "tools",
        ...(params.semanticRanking ? { semanticRanking: params.semanticRanking } : {}),
        maxSearchLimit: 20,
      },
    },
  } as never;
  const ctx: ToolSearchToolContext = {
    catalogRef,
    agentId: "semantic-test-agent",
    ...(params.semanticRanking === "shadow" && params.bindOwnerSignal !== false
      ? { abortSignal: abortController.signal }
      : {}),
    decisionRuntime: params.decisionRuntime,
  };
  return {
    catalogRef,
    tools,
    ctx,
    runtime: new ToolSearchRuntime(ctx, resolveToolSearchConfig(config), {
      validateInput: true,
    }),
    config,
    abortController,
  };
}

function decisionFixture(
  choose?: (batch: DecisionBatch) => string,
  onEvaluate?: (batch: DecisionBatch) => void,
): Pick<DecisionRuntimeV1, "evaluate"> & { evaluate: ReturnType<typeof vi.fn> } {
  return {
    evaluate: vi.fn(async (batch: DecisionBatch) => {
      onEvaluate?.(batch);
      return outcomeFor(batch, choose?.(batch) ?? "candidate_0");
    }),
  };
}

describe("Tool Search semantic ranking shadow", () => {
  it("is off by default and keeps the exact-name fast path free of semantic calls", async () => {
    const decisionRuntime = decisionFixture();
    const { runtime } = makeHarness({ decisionRuntime });

    await expect(runtime.search("calendar events", { limit: 2 })).resolves.toHaveLength(2);
    await expect(runtime.search("calendar_event_0", { limit: 1 })).resolves.toEqual([
      expect.objectContaining({ name: "calendar_event_0" }),
    ]);
    expect(decisionRuntime.evaluate).not.toHaveBeenCalled();
  });

  it("observes only the permitted BM25 results, without widening the requested limit or exposing schemas", async () => {
    const decisionRuntime = decisionFixture((batch) => {
      const question = batch.questions.bestCandidate;
      return question?.type === "choice"
        ? (Object.keys(question.criteria).at(-1) ?? "candidate_0")
        : "candidate_0";
    });
    const { runtime, catalogRef } = makeHarness({
      count: 12,
      semanticRanking: "shadow",
      decisionRuntime,
    });
    const entries = catalogRef.current?.entries ?? [];
    const permitted = new Set(entries.slice(0, 10).map((entry) => entry.id));
    const results = await runtime.search("calendar events", { limit: 10, allowedIds: permitted });

    expect(results).toHaveLength(10);
    expect(results.map((result) => result.id)).toEqual(
      entries.slice(0, 10).map((entry) => entry.id),
    );
    expect(decisionRuntime.evaluate).toHaveBeenCalledOnce();
    const batch = decisionRuntime.evaluate.mock.calls[0]?.[0] as DecisionBatch;
    const state = batch.state as { candidates: Array<Record<string, unknown>> };
    expect(state.candidates).toHaveLength(8);
    expect(state.candidates.every((candidate) => permitted.has(candidate.id as string))).toBe(true);
    expect(
      state.candidates.every(
        (candidate) =>
          Object.keys(candidate).toSorted().join(",") === "description,id,index,name,source",
      ),
    ).toBe(true);
    expect(batch.questions.bestCandidate).toEqual(expect.objectContaining({ type: "choice" }));
    const telemetry = new ToolSearchRuntime(
      { catalogRef },
      resolveToolSearchConfig({
        tools: { toolSearch: { enabled: true, mode: "tools", semanticRanking: "shadow" } },
      } as never),
    ).telemetry();
    expect(telemetry).toMatchObject({
      semanticRankingShadowCalls: 1,
      semanticRankingShadowCandidates: 8,
      semanticRankingShadowSucceeded: 1,
    });
    expect(JSON.stringify(telemetry)).not.toContain("calendar events");
  });

  it("records stable full-order displacement without changing lexical output", async () => {
    const { runtime } = makeHarness({
      semanticRanking: "shadow",
      decisionRuntime: decisionFixture(() => "candidate_1"),
    });
    const results = await runtime.search("calendar events", { limit: 4 });
    expect(results[0]?.name).toBe("calendar_event_0");
    expect(runtime.telemetry()).toMatchObject({
      semanticRankingShadowTop1Disagreement: 1,
      semanticRankingShadowOrderingDisplacement: 2,
    });
  });
  it("preserves exact-name precedence with shadow enabled without inference", async () => {
    const decisionRuntime = decisionFixture();
    const { runtime } = makeHarness({ semanticRanking: "shadow", decisionRuntime });
    for (const limit of [1, 4]) {
      const results = await runtime.search("calendar_event_2", { limit });
      expect(results[0]?.name).toBe("calendar_event_2");
    }
    expect(decisionRuntime.evaluate).not.toHaveBeenCalled();
  });
  it("refreshes descriptors mutated in place during the awaited observation", async () => {
    let mutate = () => {};
    const decisionRuntime = decisionFixture(undefined, () => mutate());
    const { runtime, catalogRef } = makeHarness({ semanticRanking: "shadow", decisionRuntime });
    const entry = catalogRef.current?.entries[0];
    if (!entry) {
      throw new Error("Expected synthetic catalog entry");
    }
    mutate = () => {
      entry.description = "Updated calendar events description";
    };
    const results = await runtime.search("calendar events", { limit: 4 });
    expect(results.find((result) => result.id === entry.id)?.description).toBe(entry.description);
    expect(decisionRuntime.evaluate).toHaveBeenCalledOnce();
  });
  it("does not invoke semantic ranking for an empty lexical result", async () => {
    const decisionRuntime = decisionFixture();
    const { runtime } = makeHarness({ semanticRanking: "shadow", decisionRuntime });

    await expect(runtime.search("the and with", { limit: 4 })).resolves.toEqual([]);
    expect(decisionRuntime.evaluate).not.toHaveBeenCalled();
  });

  it("does not invent an owner signal for optional shadow inference", async () => {
    const decisionRuntime = decisionFixture();
    const { runtime: noOwner } = makeHarness({
      semanticRanking: "shadow",
      bindOwnerSignal: false,
      decisionRuntime,
    });
    await expect(noOwner.search("calendar events", { limit: 2 })).resolves.toHaveLength(2);
    expect(decisionRuntime.evaluate).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "unavailable",
      outcome: { status: "unavailable", reason: "not-configured" } as const,
      counter: "semanticRankingShadowUnavailable",
    },
    {
      label: "incomplete",
      outcome: {
        status: "ok",
        result: {
          model: "fixture-semantic-v1",
          answers: {},
        },
        provenance: {
          providerId: "fixture",
          rubricVersion: "tool-search-ranking-v1",
          runtimeGeneration: "test-generation",
        },
      } satisfies DecisionOutcome,
      counter: "semanticRankingShadowIncomplete",
    },
  ])("returns the original results when the decision is $label", async ({ outcome, counter }) => {
    const decisionRuntime: Pick<DecisionRuntimeV1, "evaluate"> = {
      evaluate: vi.fn(async () => outcome),
    };
    const { runtime } = makeHarness({ semanticRanking: "shadow", decisionRuntime });
    const results = await runtime.search("calendar events", { limit: 3 });

    expect(results.map((result) => result.name)).toEqual([
      "calendar_event_0",
      "calendar_event_1",
      "calendar_event_2",
    ]);
    expect(runtime.telemetry()).toMatchObject({ [counter]: 1 });
  });

  it("awaits a canceled decision provider before rejecting the caller", async () => {
    let settled = false;
    let sawSignal: AbortSignal | undefined;
    const decisionRuntime: Pick<DecisionRuntimeV1, "evaluate"> = {
      evaluate: vi.fn(
        async (_batch: DecisionBatch, options: Parameters<DecisionRuntimeV1["evaluate"]>[1]) => {
          sawSignal = options.signal;
          return await new Promise<DecisionOutcome>((resolve) => {
            options.signal.addEventListener(
              "abort",
              () => {
                queueMicrotask(() => {
                  settled = true;
                  resolve({ status: "unavailable", reason: "deadline" });
                });
              },
              { once: true },
            );
          });
        },
      ),
    };
    const { runtime, abortController } = makeHarness({
      semanticRanking: "shadow",
      decisionRuntime,
    });
    const pending = runtime.search("calendar events", { limit: 3 });
    await vi.waitFor(() => expect(sawSignal).toBeDefined());
    abortController.abort(new Error("caller canceled"));

    await expect(pending).rejects.toThrow("caller canceled");
    expect(settled).toBe(true);
    expect(runtime.telemetry()).toMatchObject({ semanticRankingShadowCanceled: 1 });
  });

  it.each(["abort", "timeout"] as const)(
    "joins code-mode shadow provider work after %s",
    async (reason) => {
      let started!: () => void;
      const startedPromise = new Promise<void>((resolve) => {
        started = resolve;
      });
      let release!: () => void;
      let providerSignal: AbortSignal | undefined;
      const decisionRuntime: DecisionRuntimeV1 = {
        evaluate: async (_batch, options) => {
          providerSignal = options.signal;
          started();
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return { status: "unavailable", reason: "deadline" };
        },
      };
      const harness = makeHarness({ semanticRanking: "shadow", decisionRuntime });
      const codeConfig = {
        tools: {
          toolSearch: {
            enabled: true,
            mode: "code" as const,
            semanticRanking: "shadow" as const,
            codeTimeoutMs: reason === "timeout" ? 1000 : 5000,
          },
        },
      };
      const tool = createToolSearchTools({ ...harness.ctx, config: codeConfig }).find(
        (entry) => entry.name === TOOL_SEARCH_CODE_MODE_TOOL_NAME,
      )!;
      let settled = false;
      const pending = tool.execute(
        "shadow-code",
        { code: 'return await openclaw.tools.search("calendar events", {limit: 2});' },
        harness.abortController.signal,
      );
      const observed = pending.then(
        (value) => {
          settled = true;
          return value;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      await startedPromise;
      if (reason === "abort") {
        harness.abortController.abort(new Error("caller canceled"));
      }
      await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true), { timeout: 5000 });
      expect(settled).toBe(false);
      release();
      const result = await observed;
      expect(settled).toBe(true);
      expect(result instanceof Error || (result as { isError?: boolean }).isError).toBe(true);
    },
  );

  it("recomputes deterministic results when the catalog changes during shadow evaluation", async () => {
    const holder: { catalogRef?: ReturnType<typeof createToolSearchCatalogRef> } = {};
    const decisionRuntime = decisionFixture(undefined, () => {
      const catalog = holder.catalogRef?.current;
      if (catalog) {
        catalog.entries = catalog.entries.slice(1);
      }
    });
    const harness = makeHarness({
      count: 6,
      semanticRanking: "shadow",
      decisionRuntime,
    });
    holder.catalogRef = harness.catalogRef;

    const results = await harness.runtime.search("calendar events", { limit: 3 });
    expect(results.map((result) => result.name)).toEqual([
      "calendar_event_1",
      "calendar_event_2",
      "calendar_event_3",
    ]);
    expect(decisionRuntime.evaluate).toHaveBeenCalledOnce();
  });

  it("uses the same owner through the structured search control, including batch searches", async () => {
    const decisionRuntime = decisionFixture();
    const { catalogRef, config, abortController } = makeHarness({
      semanticRanking: "shadow",
      decisionRuntime,
    });
    const searchTool = createToolSearchTools({
      catalogRef,
      config,
      decisionRuntime,
      agentId: "semantic-test-agent",
      abortSignal: abortController.signal,
    }).find((tool) => tool.name === TOOL_SEARCH_RAW_TOOL_NAME);

    expect(searchTool).toBeDefined();
    await searchTool!.execute("structured-shadow", {
      queries: [
        { query: "calendar events", limit: 2 },
        { query: "manage calendar", limit: 2 },
      ],
    });
    expect(decisionRuntime.evaluate).toHaveBeenCalledTimes(2);
  });
});
