import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  createAssistantMessage,
  createMessageEntry,
  createToolCall,
  createToolGroup,
  createToolResultBlock,
} from "./chat-message.test-support.ts";
import { renderActivityGroup, renderWorkGroupSummary } from "./chat-message.ts";

describe("quiet completed-work disclosure", () => {
  it("keeps the heading quiet while expanded details retain failed commands and output", () => {
    const container = document.createElement("div");
    const command = "pnpm test ui/src/pages/chat/chat-thread.test.ts";
    const group = createToolGroup("exec-group", [
      createMessageEntry(
        "exec-message",
        createAssistantMessage(
          [
            createToolCall("exec-one", "exec", { command }),
            createToolResultBlock("exec-one", "exec", "Test output remains inspectable", {
              isError: true,
            }),
          ],
          {
            activity: [
              {
                itemId: "exec-one",
                toolCallId: "exec-one",
                kind: "tool",
                name: "exec",
                phase: "end",
                status: "failed",
                title: "Run chat tests",
              },
            ],
          },
        ),
      ),
    ]);
    const onToggle = vi.fn();
    const work = { key: "work-exec", durationMs: 1_726_000, groups: [group] };
    for (const expanded of [false, true]) {
      render(
        html`${renderWorkGroupSummary(work, { expanded, onToggle })}
        ${expanded ? renderActivityGroup([group], { showReasoning: false, showToolCalls: true, isToolMessageExpanded: () => true, isToolExpanded: () => true }) : ""}`,
        container,
      );
      const header = container.querySelector<HTMLButtonElement>(".chat-work-group button")!;
      expect(header.textContent?.trim()).toBe("Worked for 28m 46s");
      expect(header.getAttribute("aria-expanded")).toBe(String(expanded));
      expect(header.hasAttribute("aria-description")).toBe(false);
      expect(header.hasAttribute("title")).toBe(false);
      expect(header.querySelector("[title], [data-tooltip], .chat-tool-failure")).toBeNull();
      header.click();
      if (expanded) {
        expect(container.textContent).toContain(command);
        expect(container.textContent).toContain("Test output remains inspectable");
        expect(container.textContent).toContain("1 failed");
      } else {
        expect(container.textContent).not.toContain(command);
        expect(container.textContent).not.toContain("failed");
      }
    }
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it.each([null, 0])("does not invent elapsed time when the duration is %s", (durationMs) => {
    const container = document.createElement("div");
    render(
      renderWorkGroupSummary(
        { key: "unknown", durationMs, groups: [] },
        { expanded: false, onToggle: () => {} },
      ),
      container,
    );
    expect(container.querySelector("button")?.textContent?.trim()).toBe("Worked");
  });
});
