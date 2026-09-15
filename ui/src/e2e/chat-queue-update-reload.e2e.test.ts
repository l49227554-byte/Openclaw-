import { expect, it } from "vitest";
import {
  startControlUiE2eServer,
  installMockGateway,
  createControlUiMockSameOriginGatewayScript,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  createControlUiE2eContextOptions,
} from "./control-ui-e2e-suite.test-support.ts";
const suite = createControlUiE2eSuite({
  name: "Queued correction update recovery",
  trackBrowserContexts: true,
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
suite.define(() => {
  it.each(["save", "cancel"] as const)(
    "protects an edit through update recovery until %s",
    async (resolution) => {
      const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
      const page = await context.newPage();
      await page.addInitScript({ content: createControlUiMockSameOriginGatewayScript() });
      const gateway = await installMockGateway(page, {
        sessions: [
          { key: "agent:main:main", label: "Main", kind: "direct", updatedAt: Date.now() },
          {
            key: "agent:main:other",
            label: "Other QA conversation",
            kind: "direct",
            updatedAt: Date.now(),
          },
        ],
      });
      try {
        await page.goto(`${suite.server.baseUrl}chat?session=main`);
        const composer = page.locator(
          ".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea",
        );
        await composer.waitFor({ state: "visible", timeout: 15000 });
        const originalPathname = new URL(page.url()).pathname;
        await gateway.setOnline(false);
        await composer.fill("Reply exactly ORIGINAL-RELOAD");
        await composer.press("Enter");
        const row = page.locator(".chat-queue__item", { hasText: "Reply exactly ORIGINAL-RELOAD" });
        await row.waitFor();
        await row.dblclick();
        const edit = page.locator(".chat-queue__edit-input");
        await edit.fill("Reply exactly CORRECTED-RELOAD");
        await composer.fill("Separate saved composer draft");
        await page.screenshot({
          path: `${suite.artifactDir}/${resolution}-before-update.png`,
          fullPage: true,
        });
        let reloads = 0;
        page.on("domcontentloaded", () => {
          reloads += 1;
        });
        await gateway.setOnline(true);
        await page
          .locator('[data-session-key="agent:main:other"] a.sidebar-recent-session__link')
          .click();
        await expect
          .poll(() =>
            page.locator(".chat-pane-cache__pane--active .chat-queue__edit-input").count(),
          )
          .toBe(0);
        await gateway.setOnline(false);
        await gateway.setServerBuildId("e2e-next-queued-edit");
        await gateway.setOnline(true);
        const refresh = page.getByRole("button", { name: /Server updated/u });
        await refresh.waitFor();
        await refresh.press("Enter");
        await page
          .getByText("Save or cancel your queued message edit before reloading.", { exact: true })
          .waitFor();
        await page.screenshot({
          path: `${suite.artifactDir}/${resolution}-after-update.png`,
          fullPage: true,
        });
        await page.getByRole("button", { name: "Review edit", exact: true }).click();
        await page.waitForURL((url) => url.pathname === originalPathname);
        await edit.waitFor();
        console.log(
          JSON.stringify({
            artifactDir: suite.artifactDir,
            reloads,
            url: page.url(),
            editedRows: await edit.count(),
            composerCount: await composer.count(),
          }),
        );
        expect(reloads, "automatic build recovery must not discard a queued correction").toBe(0);
        expect(await edit.inputValue()).toBe("Reply exactly CORRECTED-RELOAD");
        expect(await composer.inputValue()).toBe("Separate saved composer draft");
        await page.screenshot({
          path: `${suite.artifactDir}/${resolution}-reviewed-edit.png`,
          fullPage: true,
        });
        if (resolution === "save") {
          await page.locator(".chat-queue__edit-submit").click();
          await page
            .locator(".chat-queue__text", { hasText: "Reply exactly CORRECTED-RELOAD" })
            .waitFor();
        } else {
          await page.locator(".chat-queue__edit-cancel").click();
          await page
            .locator(".chat-queue__text", { hasText: "Reply exactly ORIGINAL-RELOAD" })
            .waitFor();
        }
        const reloaded = page.waitForEvent("domcontentloaded");
        await refresh.press("Enter");
        await reloaded;
        expect(reloads).toBe(1);
      } finally {
        await suite.closeBrowserContext(context);
      }
    },
    60000,
  );
});
