import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { waitForChatScrollIdle } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { catalog, pluginModule } from "./native-plugin-ui.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI comment lifecycle" });
const passage = "Review the deployment checklist.";

async function selectText(text: Locator) {
  await text.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await text.dispatchEvent("pointerup", { button: 0, pointerType: "mouse" });
}

suite.define(() => {
  it("keeps comment actions alive when a plugin replaces the transcript", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: passage }],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "plugins.controlUi.list": catalog("one"),
            "plugins.controlUi.report": { ok: true },
          },
        });
        await page.route("**/__openclaw__/plugins/control-ui/ui-fixture/*/index.js", (route) =>
          route.fulfill({
            status: 200,
            contentType: "text/javascript",
            body: pluginModule("one")
              .replace(
                "container.append(output); update(context);",
                `const replace = document.createElement("button"); replace.textContent = "Replace transcript"; replace.onclick = () => host.ui.selectReplacement("transcript", "comment-transcript"); container.append(output, replace); update(context);`,
              )
              .replace(
                "const registerComposer =",
                `host.ui.registerReplacement({id: "comment-transcript", label: "Comment transcript", surface: "transcript", mount(container) { container.textContent = "Replacement transcript"; }}); const registerComposer =`,
              ),
          }),
        );
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__composer-shell textarea");
        await composer.fill("Keep this draft.");
        const source = page.locator(".chat-bubble .chat-text p").filter({ hasText: passage });
        await selectText(source);
        await page
          .getByRole("toolbar", { name: "Selection actions" })
          .getByRole("button", { name: "Add to chat", exact: true })
          .click();
        const editor = page.getByRole("dialog", { name: "Comment", exact: true });
        await editor.getByRole("textbox").fill("Check the rollback steps.");
        await editor.getByRole("textbox").press("Enter");
        await page.getByRole("button", { name: "Replace transcript", exact: true }).click();
        await page
          .getByText("Replacement transcript", { exact: true })
          .waitFor({ state: "visible" });
        expect(await page.locator(".chat-thread").count()).toBe(0);
        const chip = page.locator(".chat-selection-annotations__chip");
        await chip.hover();
        const preview = page.getByRole("region", { name: "Comments", exact: true });
        await preview.getByRole("button", { name: "Edit comment 1", exact: true }).click();
        await editor.getByRole("textbox").fill("Edited with a replacement transcript.");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await chip.hover();
        await preview
          .getByText("Edited with a replacement transcript.", { exact: true })
          .waitFor({ state: "visible" });
        await preview.getByRole("button", { name: "Delete comment", exact: true }).click();
        await chip.waitFor({ state: "detached" });
        expect(await composer.inputValue()).toBe("Keep this draft.");
        await page.getByRole("button", { name: "Send message", exact: true }).click();
        const request = await gateway.waitForRequest("chat.send");
        expect((request.params as { attachments?: unknown[] }).attachments ?? []).toHaveLength(0);
      },
    );
  });

  it("opens an offscreen comment from the composer without dismissing its own editor", async () => {
    await suite.withPage(
      { viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" },
      async ({ page }) => {
        const filler = Array.from(
          { length: 35 },
          (_, i) => `Deployment context paragraph ${i + 1}.`,
        ).join("\n\n");
        await installMockGateway(page, {
          historyMessages: [{ role: "assistant", content: `${passage}\n\n${filler}` }],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const source = page.locator(".chat-bubble .chat-text p").filter({ hasText: passage });
        await source.scrollIntoViewIfNeeded();
        await waitForChatScrollIdle(page);
        await selectText(source);
        await page
          .getByRole("toolbar", { name: "Selection actions" })
          .getByRole("button", { name: "Add to chat", exact: true })
          .click();
        const editor = page.getByRole("dialog", { name: "Comment", exact: true });
        await editor.getByRole("textbox").fill("Keep the source context.");
        await editor.getByRole("textbox").press("Enter");
        const thread = page.locator(".chat-thread");
        await thread.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        await waitForChatScrollIdle(page);
        const sourceBox = await source.boundingBox();
        const threadBox = await thread.boundingBox();
        expect(sourceBox!.y + sourceBox!.height).toBeLessThan(threadBox!.y);
        const chip = page.locator(".chat-selection-annotations__chip");
        await chip.hover();
        const preview = page.getByRole("region", { name: "Comments", exact: true });
        await preview.getByRole("button", { name: "Edit comment 1", exact: true }).click();
        await waitForChatScrollIdle(page);
        await editor.getByRole("textbox").fill("Edited from the composer.");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await chip.hover();
        await preview
          .getByText("Edited from the composer.", { exact: true })
          .waitFor({ state: "visible" });
      },
    );
  });
});
