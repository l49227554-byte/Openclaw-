/**
 * @file Offline unit tests for the opt-in two-phase Feishu reply helper.
 * Pure data only: no network, no SDK, no host runtime.
 */
import { describe, expect, it } from "vitest";
import {
  TWO_PHASE_RESULT_TITLE,
  buildResultCard,
  createTwoPhase,
  eligible,
  fmtElapsed,
  fmtTokens,
  renderCollapsed,
  renderFooter,
  renderLiveTimeline,
  type TwoPhaseConfig,
} from "./two-phase.js";

let clock = 0;
const nextTick = (): void => {
  clock += 1000;
};
const make = (cfg?: TwoPhaseConfig | null) => createTwoPhase(cfg, { now: () => clock });

describe("createTwoPhase enablement", () => {
  it("is disabled by default / when cfg is absent or enabled=false", () => {
    expect(createTwoPhase(undefined).enabled).toBe(false);
    expect(createTwoPhase(null)).toMatchObject({ enabled: false });
    expect(createTwoPhase({}).enabled).toBe(false);
    expect(createTwoPhase({ enabled: false }).enabled).toBe(false);
    expect(createTwoPhase({ enabled: true }).enabled).toBe(true);
  });
});

describe("eligible()", () => {
  const base = {
    twoPhaseEnabled: true,
    kind: "final",
    text: "answer",
    hasActivity: true,
    hasIndependentPresentation: false,
    hasMedia: false,
    isError: false,
    withinCardLimit: true,
  } as const;

  it("accepts only an enabled, final, plain-text, in-limit turn with activity", () => {
    expect(eligible(base)).toBe(true);
    expect(eligible({ ...base, twoPhaseEnabled: false })).toBe(false);
    expect(eligible({ ...base, kind: "block" })).toBe(false);
    expect(eligible({ ...base, kind: undefined })).toBe(false);
    expect(eligible({ ...base, text: "" })).toBe(false);
    expect(eligible({ ...base, text: "   " })).toBe(false);
    expect(eligible({ ...base, hasActivity: false })).toBe(false);
    expect(eligible({ ...base, hasIndependentPresentation: true })).toBe(false);
    expect(eligible({ ...base, hasMedia: true })).toBe(false);
    expect(eligible({ ...base, isError: true })).toBe(false);
    expect(eligible({ ...base, withinCardLimit: false })).toBe(false);
  });
});

describe("tool timeline", () => {
  it("renders a running row, then flips it to done with check and elapsed", () => {
    const tp = make({ enabled: true });
    const live = tp.toolStart({ toolCallId: "a", name: "exec" });
    expect(live).toMatch(/⏳/);
    expect(live).toMatch(/exec/);
    nextTick(); // +1s
    tp.itemEvent({ toolCallId: "a", phase: "end", status: "completed", summary: "列目录" });
    const settled = tp.timeline();
    expect(settled).toMatch(/✅/);
    expect(settled).toMatch(/列目录/);
    expect(settled).toMatch(/`1\.0s`/);
    expect(tp.hasActivity()).toBe(true);
  });

  it("records a done row for a completed item event without a prior start", () => {
    const tp = make({ enabled: true });
    tp.itemEvent({ itemId: "b", name: "read", status: "completed" });
    expect(tp.timeline()).toMatch(/✅[\s\S]*read/);
  });

  it("reports no activity on a zero-tool turn so the caller stays official", () => {
    const tp = make({ enabled: true });
    expect(tp.hasActivity()).toBe(false);
  });

  it("renders at most the most recent rows", () => {
    const tp = make({ enabled: true });
    for (let i = 0; i < 12; i += 1) {
      const id = `t${i}`;
      tp.toolStart({ toolCallId: id, name: `tool${i}` });
      nextTick();
      tp.itemEvent({ toolCallId: id, phase: "end", status: "completed" });
    }
    expect(tp.timeline().split("\n").length).toBeLessThanOrEqual(8);
  });

  it("keeps the narration headline above tool rows and clears it on empty text", () => {
    const tp = make({ enabled: true });
    tp.setNarration("Working on it");
    tp.toolStart({ toolCallId: "a", name: "exec" });
    const withNarration = tp.timeline();
    expect(withNarration.startsWith("**Working on it**\n")).toBe(true);
    tp.setNarration("");
    expect(tp.timeline().startsWith("**")).toBe(false);
  });

  it("deduplicates a tool that restarts with the same id", () => {
    const tp = make({ enabled: true });
    tp.toolStart({ toolCallId: "a", name: "exec" });
    tp.itemEvent({ toolCallId: "a", phase: "end", status: "completed" });
    tp.toolStart({ toolCallId: "a", name: "exec" });
    expect(tp.timeline().match(/exec/g)?.length ?? 0).toBe(1);
  });
});

describe("collapse()", () => {
  it("settles running rows and returns one line with steps and elapsed", () => {
    const tp = make({ enabled: true });
    tp.toolStart({ toolCallId: "a", name: "exec" });
    nextTick();
    tp.itemEvent({ toolCallId: "a", phase: "end", status: "completed" });
    tp.toolStart({ toolCallId: "b", name: "edit" });
    nextTick();
    const line = tp.collapse();
    expect(line).toMatch(/已完成/);
    expect(line).toMatch(/2\/2 步/);
    expect(line).toMatch(/2\.0s`/);
    expect(line).not.toMatch(/\n/);
  });

  it("derives the source from the last finished tool", () => {
    const tp = make({ enabled: true });
    for (let i = 0; i < 12; i += 1) {
      const id = `t${i}`;
      tp.toolStart({ toolCallId: id, name: `tool${i}` });
      nextTick();
      tp.itemEvent({ toolCallId: id, phase: "end", status: "completed" });
    }
    expect(tp.collapse()).toMatch(/来源:tool11/);
  });

  it("prefers a finished tool summary as the source", () => {
    const tp = make({ enabled: true });
    tp.toolStart({ toolCallId: "a", name: "exec" });
    nextTick();
    tp.itemEvent({ toolCallId: "a", phase: "end", status: "completed", summary: "done listing" });
    expect(tp.collapse()).toMatch(/来源:done listing/);
  });
});

describe("footer", () => {
  it("is empty when nothing is available and never invents values", () => {
    expect(renderFooter({})).toBe("");
    const tp = make({ enabled: true });
    const footer = tp.footer({ durationMs: 0 });
    // 0ms renders no duration and there are no tokens, so no footer segment exists.
    expect(footer === "" || /<font color='grey'>/.test(footer)).toBe(true);
  });

  it("shows captured provider/model plus injected tokens and duration", () => {
    const tp = make({ enabled: true, footerMeta: true });
    tp.noteModel({ provider: "ark", model: "ark-code" });
    tp.toolStart({ toolCallId: "a", name: "exec" });
    nextTick();
    const footer = tp.footer({ totalTokens: 12345, durationMs: 3200 });
    expect(footer).toMatch(/Provider: ark/);
    expect(footer).toMatch(/Model: ark-code/);
    expect(footer).toMatch(/12k tokens/);
    expect(footer).toMatch(/耗时 3\.2s/);
  });

  it("sums input/output tokens when no total is supplied", () => {
    expect(renderFooter({ inputTokens: 400, outputTokens: 200 })).toMatch(/600 tokens/);
  });

  it("prefers totalTokens over input/output sums", () => {
    expect(renderFooter({ totalTokens: 999, inputTokens: 400, outputTokens: 200 })).toMatch(
      /999 tokens/,
    );
  });

  it("is fully disabled when footerMeta=false", () => {
    const tp = make({ enabled: true, footerMeta: false });
    tp.noteModel({ provider: "ark", model: "m" });
    expect(tp.footer({ totalTokens: 999, durationMs: 5000 })).toBe("");
  });

  it("ignores invalid token and duration inputs", () => {
    expect(renderFooter({ totalTokens: -1, durationMs: -5 })).toBe("");
    expect(renderFooter({ totalTokens: Number.NaN })).toBe("");
  });

  it("renders an injected agent label", () => {
    expect(renderFooter({ agent: "main", durationMs: 1500 })).toMatch(/Agent: main/);
  });
});

describe("formatting helpers", () => {
  it("formats elapsed time with ms / one-decimal / rounded buckets", () => {
    expect(fmtElapsed(0, 0)).toBe("0ms");
    expect(fmtElapsed(0, 999)).toBe("999ms");
    expect(fmtElapsed(0, 1000)).toBe("1.0s");
    expect(fmtElapsed(0, 2000)).toBe("2.0s");
    expect(fmtElapsed(0, 9900)).toBe("9.9s");
    expect(fmtElapsed(0, 10_000)).toBe("10s");
    expect(fmtElapsed(5, 1)).toBe("");
    expect(fmtElapsed("x", 2)).toBe("");
  });

  it("formats token counts compactly", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
    expect(fmtTokens(1000)).toBe("1.0k");
    expect(fmtTokens(12345)).toBe("12k");
    expect(fmtTokens(1_500_000)).toBe("1.50m");
    expect(fmtTokens(-1)).toBe("");
    expect(fmtTokens(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("buildResultCard", () => {
  it("builds a green card with the full answer and optional footer", () => {
    const answer = "# 最终答案\n这是完整正文。";
    const card = buildResultCard(answer, {
      footer: renderFooter({ model: "m", totalTokens: 100, durationMs: 1000 }),
      title: TWO_PHASE_RESULT_TITLE,
    }) as {
      schema: string;
      header: { template: string; title: { content: string } };
      body: { elements: Array<{ tag: string; content?: string }> };
    };
    expect(card.schema).toBe("2.0");
    expect(card.header.template).toBe("green");
    expect(card.header.title.content).toBe("结果");
    expect(card.body.elements[0]?.content).toBe(answer);
    const footerElement = card.body.elements[card.body.elements.length - 1];
    expect(footerElement?.content).toMatch(/耗时 1\.0s/);
  });

  it("omits footer elements when the footer is empty", () => {
    const card = buildResultCard("x", { footer: "" }) as {
      body: { elements: unknown[] };
    };
    expect(card.body.elements.length).toBe(1);
  });

  it("defaults the title and footer", () => {
    const card = buildResultCard("x") as {
      header: { title: { content: string } };
    };
    expect(card.header.title.content).toBe(TWO_PHASE_RESULT_TITLE);
  });
});

describe("renderLiveTimeline / renderCollapsed standalone", () => {
  it("renders a blank space when there is nothing to show", () => {
    expect(renderLiveTimeline({ tools: [] })).toBe(" ");
  });

  it("truncates a collapsed line to the character budget", () => {
    const longSummary = "x".repeat(200);
    const line = renderCollapsed(
      {
        tools: [
          {
            toolCallId: "a",
            name: "exec",
            status: "done",
            startedAt: 0,
            endedAt: 1000,
            summary: longSummary,
          },
        ],
        createdAt: 0,
      },
      { now: 1000, maxChars: 50 },
    );
    expect(line.length).toBeLessThanOrEqual(50);
    expect(line).toMatch(/…$/);
    expect(line).not.toMatch(/\n/);
  });
});

describe("controller idempotence and defensive inputs", () => {
  it("allows markFinalSent to fire at most once", () => {
    const tp = make({ enabled: true });
    expect(tp.markFinalSent()).toBe(true);
    expect(tp.markFinalSent()).toBe(false);
    expect(tp.finalSent).toBe(true);
  });

  it("ignores non-object or partial model payloads without throwing", () => {
    const tp = make({ enabled: true });
    tp.noteModel(undefined);
    tp.noteModel(null);
    // A structural mismatch would be a compile error; runtime callers may still
    // pass primitives through untyped host boundaries.
    tp.noteModel("str" as unknown as { provider: string });
    tp.noteModel({});
    expect(typeof tp.footer({ durationMs: 0 })).toBe("string");
  });

  it("treats a toolStart without an id as a no-op without throwing", () => {
    const tp = make({ enabled: true });
    expect(tp.toolStart({ name: "noId" })).toBe(" ");
    expect(tp.hasActivity()).toBe(false);
  });

  it("item events without an id never throw and leave rows untouched", () => {
    const tp = make({ enabled: true });
    expect(() => tp.itemEvent({ status: "completed" })).not.toThrow();
    expect(tp.hasActivity()).toBe(false);
  });

  it("collapse() is idempotent: a second collapse keeps every row done", () => {
    const tp = make({ enabled: true });
    tp.toolStart({ toolCallId: "a", name: "exec" });
    nextTick();
    tp.collapse();
    const again = tp.collapse();
    expect(again).toMatch(/1\/1 步/);
    expect(again).not.toMatch(/⏳/);
  });

  it("progress text renders on running rows and is replaced by the summary on done rows", () => {
    const tp = make({ enabled: true });
    tp.toolStart({ toolCallId: "a", name: "exec" });
    tp.itemEvent({ toolCallId: "a", progressText: "reading files" });
    expect(tp.timeline()).toMatch(/reading files/);
    nextTick();
    tp.itemEvent({ toolCallId: "a", phase: "end", status: "completed", summary: "finished" });
    const settled = tp.timeline();
    expect(settled).toMatch(/finished/);
    expect(settled).not.toMatch(/reading files/);
  });

  it("measures elapsed time from controller creation when footer omits durationMs", () => {
    const tp = make({ enabled: true });
    nextTick();
    nextTick();
    expect(tp.footer({ model: "m" })).toMatch(/耗时 2\.0s/);
  });
});
