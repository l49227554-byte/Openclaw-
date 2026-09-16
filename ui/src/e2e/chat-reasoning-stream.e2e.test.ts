import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI reasoning stream" });

// Replays the gateway event order captured from a real tool-using turn: the
// `thinking` stream arrives block by block while the run works, mid-turn
// assistant rows land through session.message without a top-level runId, and
// the final row precedes the text-only chat final.
suite.define(() => {
  it.each([{ reasoningLevel: "stream" }, { reasoningLevel: "on" }])(
    "renders live reasoning only for /reasoning stream: %o",
    async ({ reasoningLevel }) => {
      const context = await suite.newBrowserContext({
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
      });
      try {
        const page = await context.newPage();
        const sessionKey = "agent:main:dashboard:reasoning-stream";
        const sessionId = "reasoning-stream-session";
        const prompt = "What does the file say?";
        const toolReasoning = "The user wants the file contents, so read it first.";
        const finalReasoning = "The file is read; the heading is the answer.";
        const answer = "The file says Agent Instructions.";
        const sessionRow = {
          key: sessionKey,
          kind: "direct",
          sessionId,
          reasoningLevel,
          thinkingLevel: "low",
          updatedAt: 1_000,
        };
        const gateway = await installMockGateway(page, {
          sessionKey,
          sessionInfo: { reasoningLevel, thinkingLevel: "low" },
          sessions: [sessionRow],
          historyMessages: [],
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
        await pane.locator(".agent-chat__composer-combobox textarea").fill(prompt);
        await page.getByRole("button", { name: "Send message" }).click();
        const send = await gateway.waitForRequest("chat.send");
        const runId = (send.params as { idempotencyKey?: unknown }).idempotencyKey as string;
        expect(typeof runId).toBe("string");
        let seq = 0;
        const agent = async (stream: string, data: Record<string, unknown>, ts: number) => {
          seq += 1;
          await gateway.emitGatewayEvent("agent", { runId, seq, stream, ts, sessionKey, data });
        };
        const thinking = async (text: string, delta: string, ts: number) =>
          agent("thinking", { text, delta }, ts);
        const liveToolReasoning = pane.locator(".chat-thinking", { hasText: toolReasoning });
        const liveFinalReasoning = pane.locator(".chat-thinking", { hasText: finalReasoning });
        const persisted: unknown[] = [
          {
            role: "user",
            content: prompt,
            timestamp: 1_000,
            __openclaw: { id: "durable-user", seq: 1, idempotencyKey: `${runId}:user` },
          },
        ];
        const persist = async (row: unknown, active: boolean) => {
          persisted.push(row);
          const history = {
            messages: [...persisted],
            sessionId,
            sessionInfo: { ...sessionRow, hasActiveRun: active },
            thinkingLevel: "low",
          };
          await gateway.setHistoryMessages(history.messages);
          await gateway.setMethodResponse("chat.startup", history);
          await gateway.setMethodResponse("chat.history", history);
        };

        await agent("lifecycle", { phase: "start" }, 1_100);
        const [head, tail] = [toolReasoning.slice(0, 20), toolReasoning.slice(20)];
        await thinking(head, head, 1_150);
        await thinking(toolReasoning, tail, 1_160);
        if (reasoningLevel === "stream") {
          await liveToolReasoning.waitFor({ timeout: 10_000 });
        } else {
          await page.waitForTimeout(400);
          expect(await liveToolReasoning.count()).toBe(0);
        }

        const toolRow = {
          role: "assistant",
          content: [
            { type: "thinking", thinking: `\n\n${toolReasoning}\n` },
            {
              type: "toolCall",
              id: "chatcmpl-tool-1",
              name: "read",
              arguments: { path: "AGENTS.md" },
            },
          ],
          stopReason: "toolUse",
          timestamp: 1_200,
          __openclaw: { runId, id: "durable-tool", seq: 2, recordTimestampMs: 1_200 },
        };
        await persist(toolRow, true);
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          hasActiveRun: true,
          session: { ...sessionRow, hasActiveRun: true, status: "running" },
          messageId: "durable-tool",
          messageSeq: 2,
          message: toolRow,
        });
        await agent(
          "tool",
          {
            toolCallId: "chatcmpl-tool-1",
            name: "read",
            phase: "start",
            args: { path: "AGENTS.md" },
          },
          1_210,
        );
        await agent(
          "tool",
          {
            toolCallId: "chatcmpl-tool-1",
            name: "read",
            phase: "result",
            result: { content: [{ type: "text", text: "# Agent Instructions" }] },
          },
          1_250,
        );
        await persist(
          {
            role: "toolResult",
            toolCallId: "chatcmpl-tool-1",
            toolName: "read",
            content: [{ type: "text", text: "# Agent Instructions" }],
            timestamp: 1_250,
            __openclaw: { runId, id: "durable-result", seq: 3, recordTimestampMs: 1_250 },
          },
          true,
        );
        // The second block restarts the cumulative text.
        await thinking(finalReasoning, finalReasoning, 1_300);
        if (reasoningLevel === "stream") {
          await liveFinalReasoning.waitFor({ timeout: 10_000 });
          // The earlier block stays on screen while the run continues.
          expect(await liveToolReasoning.count()).toBe(1);
        }
        const finalRow = {
          role: "assistant",
          content: [
            { type: "thinking", thinking: `\n\n${finalReasoning}\n` },
            { type: "text", text: `\n\n${answer}` },
          ],
          stopReason: "stop",
          timestamp: 1_400,
          __openclaw: { runId, id: "durable-final", seq: 4, recordTimestampMs: 1_400 },
        };
        await persist(finalRow, true);
        await gateway.emitGatewayEvent("session.message", {
          sessionKey,
          runId,
          hasActiveRun: true,
          session: { ...sessionRow, hasActiveRun: true, status: "running" },
          messageId: "durable-final",
          messageSeq: 4,
          message: finalRow,
        });
        await gateway.emitGatewayEvent("chat", {
          deltaText: answer,
          message: {
            content: [{ text: answer, type: "text" }],
            role: "assistant",
            timestamp: 1_400,
          },
          runId,
          sessionKey,
          state: "delta",
        });
        await agent("lifecycle", { phase: "end" }, 1_401);
        await gateway.emitChatFinal({ runId, sessionKey, text: answer });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          phase: "end",
          session: { ...sessionRow, hasActiveRun: false, updatedAt: 1_402 },
        });
        await pane.getByText(answer, { exact: true }).first().waitFor({ timeout: 10_000 });
        await expect
          .poll(() => page.getByRole("button", { name: "Stop generating" }).count())
          .toBe(0);

        // After the turn settles the saved rows own the reasoning: exactly one
        // copy of the final block, and the tool block only inside the worked
        // rollup once expanded.
        await expect.poll(() => liveFinalReasoning.count()).toBe(1);
        expect(await liveFinalReasoning.isVisible()).toBe(true);
        const worked = pane.locator(".chat-work-group > .chat-activity-group__summary");
        await worked.first().waitFor({ timeout: 10_000 });
        expect(await liveToolReasoning.count()).toBeLessThanOrEqual(1);
        await worked.first().click();
        await expect.poll(() => worked.first().getAttribute("aria-expanded")).toBe("true");
        await expect.poll(() => liveToolReasoning.count()).toBe(1);
        expect(await pane.getByText(answer, { exact: true }).count()).toBe(1);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
  );
});
