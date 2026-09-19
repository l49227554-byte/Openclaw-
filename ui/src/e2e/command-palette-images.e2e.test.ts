import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  expectForegroundUnchanged,
  foregroundDraft,
  openFromForeground,
  scenario,
} from "./command-palette.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "./new-session-page.test-support.ts";

const suite = createControlUiE2eSuite({ name: "command palette pasted images" });
const shortText = "Compare these two screens.";
const longText = [
  "Compare these two screens and help me refine the layout.",
  "Keep the image previews small and leave the text easy to read.",
  "Check alignment, spacing, and the hierarchy of the existing controls.",
  "The new-session action should stay in the same place as this text grows.",
  "Do not add upload buttons, filenames, counters, or extra helper text.",
  "Keep the foreground conversation and its unsent draft untouched.",
  "Show me the proposed changes before making any unrelated edits.",
].join("\n");

async function pasteScreens(input: Locator, count = 1) {
  return input.evaluate((element, fileCount) => {
    const clipboard = new DataTransfer();
    const attachments = [];
    for (let index = 0; index < fileCount; index += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const draw = canvas.getContext("2d")!;
      draw.fillStyle = "#12171c";
      draw.fillRect(0, 0, 320, 240);
      draw.fillStyle = "#202b32";
      draw.fillRect(0, 0, 65, 240);
      draw.fillStyle = index % 2 ? "#ee8864" : "#66c5b5";
      draw.fillRect(16, 18, 32, 7);
      draw.fillRect(85, 25, 130, 14);
      for (let row = 0; row < 4; row += 1) {
        draw.fillStyle = "#35434d";
        draw.fillRect(16, 52 + row * 22, 32, 5);
        draw.fillStyle = "#293943";
        draw.fillRect(85, 65 + row * 37, 212, 26);
        draw.fillStyle = "#879da5";
        draw.fillRect(98, 74 + row * 37, 76 + row * 21, 5);
      }
      const content = canvas.toDataURL("image/png").split(",")[1]!;
      const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0));
      const fileName = "screen-" + (index + 1) + ".png";
      clipboard.items.add(new File([bytes], fileName, { type: "image/png" }));
      attachments.push({ type: "image", mimeType: "image/png", fileName, content });
    }
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: clipboard }),
    );
    return attachments;
  }, count);
}

function captureStates(palette: Locator, label: string) {
  const directory =
    process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
      ? createControlUiE2eArtifactDir("palette-images-" + label, suite.artifactDir)
      : undefined;
  return async (name: string) => {
    if (!directory) {
      return;
    }
    await palette.evaluate(async (element) => {
      await document.fonts.ready;
      await Promise.all(Array.from(element.querySelectorAll("img"), (image) => image.decode()));
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    });
    await palette
      .locator(".cmd-palette")
      .screenshot({ path: path.join(directory, name + ".png"), animations: "disabled" });
  };
}

suite.define(() => {
  it.each([
    { label: "desktop-dark", mode: "dark", width: 1280 },
    { label: "desktop-light", mode: "light", width: 1280 },
    { label: "narrow-dark", mode: "dark", width: 390 },
  ] as const)("keeps image states compact on $label", async ({ label, mode, width }) => {
    await suite.withPage(
      {
        ...createControlUiE2eContextOptions(),
        colorScheme: mode,
        viewport: { width, height: 900 },
        deviceScaleFactor: 2,
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, scenario());
        const { palette, input, composer, url } = await openFromForeground(
          page,
          suite.server.baseUrl,
        );
        const capture = captureStates(palette, label);
        const start = palette.getByRole("button", {
          name: "Start new session in background",
          exact: true,
        });
        const images = palette.locator(".chat-attachment-thumb img");
        const settleSearch = async () => {
          await expect
            .poll(() => palette.locator(".cmd-palette__results").getAttribute("aria-busy"))
            .toBe("false");
        };
        await settleSearch();
        expect(await start.isEnabled()).toBe(false);
        await capture("01-empty");
        await input.fill(shortText);
        await settleSearch();
        await expect.poll(() => start.isEnabled()).toBe(true);
        await capture("02-short-text");
        await input.fill(longText);
        await settleSearch();
        await input.evaluate((element) => {
          element.scrollTop = 0;
        });
        await capture("03-long-text");
        await input.fill("");
        await settleSearch();
        await pasteScreens(input);
        // Capture the same user action before the assertion: on the parent this
        // records the absent preview, rather than synthesizing a before state.
        await capture("04-image-only");
        await expect.poll(() => images.count()).toBe(1);
        await expect.poll(() => start.isEnabled()).toBe(true);
        await input.fill(shortText);
        await settleSearch();
        await capture("05-short-text-image");
        await pasteScreens(input);
        await expect.poll(() => images.count()).toBe(2);
        await input.fill(longText);
        await settleSearch();
        await input.evaluate((element) => {
          element.scrollTop = 0;
        });
        await capture("06-long-text-images");
        const geometry = await palette.evaluate((element) => {
          const field = element.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
          const strip = element.querySelector<HTMLElement>(".chat-attachments-preview")!;
          const box = element.querySelector<HTMLElement>(".cmd-palette")!.getBoundingClientRect();
          return {
            lines: field.clientHeight / Number.parseFloat(getComputedStyle(field).lineHeight),
            stripBottom: strip.getBoundingClientRect().bottom,
            textTop: field.getBoundingClientRect().top,
            left: box.left,
            right: box.right,
            bottom: box.bottom,
          };
        });
        expect(geometry.lines).toBeLessThanOrEqual(3.1);
        expect(geometry.stripBottom).toBeLessThanOrEqual(geometry.textTop);
        expect(geometry.left).toBeGreaterThanOrEqual(0);
        expect(geometry.right).toBeLessThanOrEqual(width);
        expect(geometry.bottom).toBeLessThanOrEqual(900);
        await input.fill("");
        await settleSearch();
        await capture("07-images-only");
        await images.first().hover();
        await capture("08-remove-hover");
        await palette
          .getByRole("button", { name: /^Remove screen-/ })
          .first()
          .click();
        await expect.poll(() => images.count()).toBe(1);
        await palette
          .getByRole("button", { name: /^Remove screen-/ })
          .first()
          .click();
        await expect.poll(() => images.count()).toBe(0);
        expect(await start.isEnabled()).toBe(false);
        await capture("09-last-image-removed");
        expect(await palette.locator('input[type="file"]').count()).toBe(0);
        expect(
          await palette
            .getByRole("button", { name: /Add attachment|Upload|Attach images/ })
            .count(),
        ).toBe(0);
        expect(await palette.locator(".chat-attachment-file__name").count()).toBe(0);
        expect(await gateway.getRequests("sessions.create")).toEqual([]);
        expect(await composer.inputValue()).toBe(foregroundDraft);
        expect(page.url()).toBe(url);
        await input.press("Escape");
        await input.waitFor({ state: "hidden" });
        await expectForegroundUnchanged(page, composer, url);
        await page.keyboard.press("ControlOrMeta+K");
        await input.waitFor({ state: "visible" });
        await pasteScreens(input, 12);
        await expect.poll(() => images.count()).toBe(12);
        const strip = palette.locator(".chat-attachments-preview");
        expect(await strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          true,
        );
        await capture("12-many-images-overflow");
        await strip.evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
        });
        await capture("13-overflow-scrolled");
        // Escape first dismisses a hovered tooltip. Leave the thumbnail before
        // asserting that an unclaimed Escape closes the palette.
        // The action rail overlays the field center on narrow screens.
        await input.hover({ position: { x: 8, y: 8 } });
        await expect.poll(() => page.locator("openclaw-tooltip[open]").count()).toBe(0);
        await input.press("Escape");
        await input.waitFor({ state: "hidden" });
        await page.keyboard.press("ControlOrMeta+K");
        await input.waitFor({ state: "visible" });
        expect(await images.count()).toBe(0);
      },
    );
  });

  it.each(["", shortText])(
    "submits pasted images once and retains them after rejection (text: %s)",
    async (message) => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const gateway = await installMockGateway(
          page,
          scenario({
            "sessions.create": {
              key: "agent:main:dashboard:palette-image-created",
              runStarted: true,
            },
          }),
        );
        const { palette, input, composer, url } = await openFromForeground(
          page,
          suite.server.baseUrl,
        );
        const capture = captureStates(
          palette,
          message ? "submission-text-images" : "submission-image-only",
        );
        await input.fill(message);
        const attachments = await pasteScreens(input, 2);
        const images = palette.locator(".chat-attachment-thumb img");
        await expect.poll(() => images.count()).toBe(2);
        const start = palette.getByRole("button", {
          name: "Start new session in background",
          exact: true,
        });
        await expect.poll(() => start.isEnabled()).toBe(true);
        await gateway.deferNext("sessions.create");
        await input.press("ControlOrMeta+Enter");
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({ message, attachments });
        expect(await input.isDisabled()).toBe(true);
        expect(await start.isEnabled()).toBe(false);
        await capture("10-submitting");
        await page.keyboard.press("ControlOrMeta+Enter");
        expect(await gateway.getRequests("sessions.create")).toHaveLength(1);
        await gateway.rejectDeferred("sessions.create", {
          code: "INVALID_REQUEST",
          message: "Could not create session. Please try again.",
        });
        await expect
          .poll(() => palette.getByRole("alert").textContent())
          .toContain("Could not create session");
        expect(await images.count()).toBe(2);
        expect(await input.inputValue()).toBe(message);
        await capture("11-failed-retains-images");
        await input.press("Escape");
        await input.waitFor({ state: "hidden" });
        await page.keyboard.press("ControlOrMeta+K");
        await input.waitFor({ state: "visible" });
        expect(await images.count()).toBe(2);
        await expect.poll(() => start.isEnabled()).toBe(true);
        await input.press("ControlOrMeta+Enter");
        const retry = await gateway.waitForRequest("sessions.create", { after: 1 });
        expect(retry.params).toMatchObject({ message, attachments });
        await input.waitFor({ state: "hidden" });
        await expectForegroundUnchanged(page, composer, url);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        await page.keyboard.press("ControlOrMeta+K");
        await input.waitFor({ state: "visible" });
        expect(await images.count()).toBe(0);
        expect(await input.inputValue()).toBe("");
      });
    },
  );
  it("blocks creation while a pasted image is reading and lets a failed slot be removed", async () => {
    await suite.withPage(
      { ...createControlUiE2eContextOptions(), colorScheme: "dark", deviceScaleFactor: 2 },
      async ({ page }) => {
        const gateway = await installMockGateway(page, scenario());
        const { palette, input } = await openFromForeground(page, suite.server.baseUrl);
        const capture = captureStates(palette, "reading");
        await page.evaluate(() => {
          const descriptor = Object.getOwnPropertyDescriptor(FileReader.prototype, "readAsDataURL");
          if (!descriptor) {
            throw new Error("FileReader.readAsDataURL is unavailable");
          }
          FileReader.prototype.readAsDataURL = function (this: FileReader) {
            Object.defineProperty(FileReader.prototype, "readAsDataURL", descriptor);
            (window as unknown as { paletteHeldReader: FileReader }).paletteHeldReader = this;
          };
        });
        await pasteScreens(input);
        const start = palette.getByRole("button", {
          name: "Start new session in background",
          exact: true,
        });
        await palette.locator('.chat-attachment-thumb[aria-busy="true"]').waitFor();
        expect(await start.isEnabled()).toBe(false);
        await capture("14-image-reading");
        await input.press("ControlOrMeta+Enter");
        expect(await gateway.getRequests("sessions.create")).toEqual([]);
        await page.evaluate(() => {
          (window as unknown as { paletteHeldReader: FileReader }).paletteHeldReader.dispatchEvent(
            new Event("error"),
          );
        });
        await palette.locator(".chat-attachment-thumb--error").waitFor();
        expect(await start.isEnabled()).toBe(false);
        await capture("15-image-read-error");
        await palette.getByRole("button", { name: /^Remove screen-/ }).click();
        expect(await palette.locator(".chat-attachment-thumb").count()).toBe(0);
        await pasteScreens(input);
        await expect.poll(() => palette.locator(".chat-attachment-thumb img").count()).toBe(1);
        await expect.poll(() => start.isEnabled()).toBe(true);
        expect(await gateway.getRequests("sessions.create")).toEqual([]);
      },
    );
  });
});
