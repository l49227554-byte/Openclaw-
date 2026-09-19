/* @vitest-environment jsdom */

import { expectDefined } from "@openclaw/normalization-core";
import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  CommandPaletteLoadingState,
  renderCommandPaletteLoading,
} from "../app/app-shell-command-palette-loading.ts";
import { createWebPushCapability } from "../app/web-push.ts";
import * as toast from "../lib/toast.ts";
import * as payloads from "../pages/chat/attachment-payload-store.ts";
import { createDraftFixture } from "../pages/new-session/draft-submission-flow.test-support.ts";
import { createApplicationGateway } from "../test-helpers/application-context.ts";
import { installDialogPolyfill } from "../test-helpers/modal-dialog.ts";
import { mountPalette } from "./command-palette.test-support.ts";
import "./command-palette.ts";

let restoreDialog: () => void;
let readers: FileReader[];

beforeEach(() => {
  restoreDialog = installDialogPolyfill();
  readers = [];
  vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
    readers.push(this);
  });
  vi.spyOn(toast, "showToast").mockReturnValue(true);
});

afterEach(() => {
  document.body.replaceChildren();
  restoreDialog();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

function paste(input: HTMLTextAreaElement, files: File[] = [], text = "") {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      items: files.map((file) => ({ type: file.type, getAsFile: () => file })),
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  input.dispatchEvent(event);
  return event;
}

function image(name = "pasted.png") {
  return new File(["image"], name, { type: "image/png" });
}

function finishRead(index: number) {
  const reader = readers[index]!;
  Object.defineProperty(reader, "result", { value: "data:image/png;base64,aW1hZ2U=" });
  reader.dispatchEvent(new ProgressEvent("load"));
}

function key(input: HTMLTextAreaElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(event);
  return event;
}

function textOutsideHiddenDescriptions(element: Element) {
  // Tooltips add hidden accessible descriptions in light DOM. They are not
  // filenames/helper copy on the thumbnail surface.
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest("[hidden]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let text = "";
  while (walker.nextNode()) {
    text += walker.currentNode.textContent;
  }
  return text.trim();
}

async function mount() {
  const fixture = createDraftFixture();
  const { context } = fixture;
  const connection = createApplicationGateway(context.gateway.snapshot);
  Object.assign(connection.gateway, {
    connectionRevision: 1,
    connection: context.gateway.connection,
    setSessionKey: context.gateway.setSessionKey,
  });
  const webPush = createWebPushCapability(connection.gateway);
  onTestFinished(() => webPush.dispose());
  Object.assign(context, { gateway: connection.gateway, webPush });
  Object.assign(context.agentSelection, { subscribe: () => () => {} });
  Object.assign(context.agents, { subscribe: () => () => {} });
  Object.assign(context.agents.state, { connected: true, client: context.gateway.snapshot.client });
  Object.assign(context.sessions, { subscribe: () => () => {}, list: vi.fn(async () => null) });
  Object.assign(context.config, { subscribe: () => () => {} });
  Object.assign(context, {
    agentIdentity: {
      subscribe: () => () => {},
      ensure: vi.fn(async () => {}),
      get: () => undefined,
    },
    navigate: vi.fn(),
  });
  vi.mocked(context.sessions.createResult).mockResolvedValue({
    key: "agent:main:dashboard:image-task",
    initialRun: { status: "idle" },
  });
  const { palette } = await mountPalette(context);
  palette.openPalette();
  await palette.updateComplete;
  const input = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
  input.focus();
  const start = () => palette.querySelector<HTMLButtonElement>(".cmd-palette__create")!;
  return {
    ...fixture,
    palette,
    input,
    start,
    publish: () => connection.publish(context.gateway.snapshot),
  };
}

describe("command palette paste-only images", () => {
  it.each(["", "Describe these images"])(
    "submits an image prompt in the background (%j)",
    async (message) => {
      const foreground = document.createElement("textarea");
      foreground.value = "Keep my foreground draft";
      document.body.append(foreground);
      foreground.focus();
      foreground.setSelectionRange(5, 10, "backward");
      const { palette, input, context, start } = await mount();
      input.value = message;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.setSelectionRange(0, Math.min(5, message.length), "backward");
      const selection = [input.selectionStart, input.selectionEnd];
      expect(paste(input, [image()]).defaultPrevented).toBe(true);
      await palette.updateComplete;
      expect(start().disabled).toBe(true);
      expect(palette.querySelector('.chat-attachment-thumb[aria-busy="true"]')).not.toBeNull();
      key(input, { key: "Enter", ctrlKey: true });
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      finishRead(0);
      await vi.waitFor(() => expect(start().disabled).toBe(false));
      expect(palette.querySelector("textarea")).toBe(input);
      expect([input.selectionStart, input.selectionEnd]).toEqual(selection);
      const rail = palette.querySelector(".cmd-palette__attachments")!;
      expect(rail.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(rail.querySelectorAll(".chat-attachment-thumb img")).toHaveLength(1);
      expect(textOutsideHiddenDescriptions(rail)).toBe("");
      expect(
        palette.querySelector(
          'input[type="file"], .agent-chat__input-btn--attach, .chat-attachment-file__name',
        ),
      ).toBeNull();
      expect(palette.querySelector(".chat-attachments-status")).toBeNull();
      key(input, { key: "Enter", metaKey: true });
      await vi.waitFor(() => expect(palette.isOpen).toBe(false));
      expect(context.sessions.createResult).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          message,
          attachments: [
            expect.objectContaining({
              type: "image",
              mimeType: "image/png",
              fileName: "pasted.png",
              content: "aW1hZ2U=",
            }),
          ],
        }),
        { reconciliation: "background" },
      );
      expect(context.navigateAndWait).not.toHaveBeenCalled();
      expect(context.gateway.setSessionKey).not.toHaveBeenCalled();
      expect(foreground.value).toBe("Keep my foreground draft");
      expect([foreground.selectionStart, foreground.selectionEnd]).toEqual([5, 10]);
    },
  );

  it("keeps text and non-image paste native, including long search prompts", async () => {
    const { palette, input, context } = await mount();
    for (const text of ["ordinary search", "long search ".repeat(200)]) {
      expect(paste(input, [], text).defaultPrevented).toBe(false);
    }
    expect(
      paste(input, [new File(["pdf"], "document.pdf", { type: "application/pdf" })])
        .defaultPrevented,
    ).toBe(false);
    expect(readers).toHaveLength(0);
    expect(palette.querySelector(".chat-attachments-preview")).toBeNull();
    expect(context.sessions.createResult).not.toHaveBeenCalled();
  });

  it("keeps same-name images ordered across overlapping reads and removes only one", async () => {
    const { palette, input, context, start } = await mount();
    paste(input, [image(), image()]);
    paste(input, [image("later.png")]);
    finishRead(2);
    finishRead(0);
    await palette.updateComplete;
    const remove = palette.querySelectorAll<HTMLButtonElement>(".chat-attachment-remove");
    expect(remove).toHaveLength(3);
    remove[1]!.focus();
    remove[1]!.click();
    finishRead(1);
    await vi.waitFor(() => expect(start().disabled).toBe(false));
    expect(palette.querySelectorAll(".chat-attachment-thumb")).toHaveLength(2);
    start().click();
    await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
    const params = expectDefined(
      vi.mocked(context.sessions.createResult).mock.calls[0]?.[0],
      "image creation parameters",
    );
    const attachments = params.attachments;
    expect(attachments?.map(({ fileName }) => fileName)).toEqual(["pasted.png", "later.png"]);
  });

  it.each(["dismiss", "disconnect", "owner"])(
    "retires ready payloads and ignores late reads after %s",
    async (reason) => {
      const registered = vi.spyOn(payloads, "registerChatAttachmentPayload");
      const { palette, input, context, publish } = await mount();
      paste(input, [image("ready.png"), image("pending.png")]);
      finishRead(0);
      await palette.updateComplete;
      const attachment = registered.mock.calls[0]![0].attachment;
      expect(payloads.getChatAttachmentDataUrl(attachment)).not.toBeNull();
      if (reason === "dismiss") {
        key(input, { key: "Escape" });
      } else if (reason === "disconnect") {
        palette.remove();
      } else {
        Object.assign(context.gateway, { connectionRevision: 2 });
        publish();
        await palette.updateComplete;
      }
      finishRead(1);
      expect(payloads.getChatAttachmentDataUrl(attachment)).toBeNull();
      expect(registered).toHaveBeenCalledOnce();
      if (reason !== "disconnect") {
        palette.openPalette();
        await palette.updateComplete;
        expect(palette.querySelector(".chat-attachments-preview")).toBeNull();
      }
      expect(context.sessions.createResult).not.toHaveBeenCalled();
    },
  );

  it("keeps failed read slots visible and permits removal and repaste", async () => {
    const { palette, input, context, start } = await mount();
    paste(input, [image("unreadable.png")]);
    readers[0]!.dispatchEvent(new ProgressEvent("error"));
    await palette.updateComplete;
    const failed = palette.querySelector(".chat-attachment-thumb--error")!;
    expect(failed.querySelector('[role="img"]')?.getAttribute("aria-label")).toContain(
      "unreadable.png",
    );
    expect(textOutsideHiddenDescriptions(failed)).toBe("");
    expect(start().disabled).toBe(true);
    failed.querySelector<HTMLButtonElement>(".chat-attachment-remove")!.click();
    paste(input, [image("retry.png")]);
    finishRead(1);
    await vi.waitFor(() => expect(start().disabled).toBe(false));
    expect(palette.querySelectorAll(".chat-attachment-thumb")).toHaveLength(1);
    expect(palette.querySelector(".chat-attachment-thumb--error")).toBeNull();
    start().click();
    await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
  });

  it("retains image-only failed creation across reopen and retries the same bytes", async () => {
    const { palette, input, context, start } = await mount();
    vi.mocked(context.sessions.createResult).mockResolvedValueOnce(null);
    Object.assign(context.sessions.state, { error: "Creation denied" });
    paste(input, [image()]);
    finishRead(0);
    await vi.waitFor(() => expect(start().disabled).toBe(false));
    start().click();
    await vi.waitFor(() =>
      expect(palette.querySelector('[role="alert"]')?.textContent).toContain("Creation denied"),
    );
    const src = palette.querySelector(".chat-attachment-thumb img")?.getAttribute("src");
    key(input, { key: "Escape" });
    await palette.updateComplete;
    palette.openPalette();
    await palette.updateComplete;
    expect(palette.querySelector(".chat-attachment-thumb img")?.getAttribute("src")).toBe(src);
    start().click();
    await vi.waitFor(() => expect(palette.isOpen).toBe(false));
    const calls = vi.mocked(context.sessions.createResult).mock.calls;
    expect(calls).toHaveLength(2);
    const original = expectDefined(calls[0]?.[0], "original creation parameters");
    const retry = expectDefined(calls[1]?.[0], "retried creation parameters");
    expect(retry.attachments).toEqual(original.attachments);
  });

  it("keeps a rejected image prompt visible without creating a duplicate session", async () => {
    const { palette, input, context, start } = await mount();
    vi.mocked(context.sessions.createResult).mockResolvedValueOnce({
      key: "agent:main:dashboard:rejected-images",
      initialRun: { status: "rejected", error: "Image turn rejected" },
    });
    paste(input, [], "data:image/png;base64,aW1hZ2U=");
    await vi.waitFor(() => expect(start().disabled).toBe(false));
    start().click();
    await vi.waitFor(() =>
      expect(palette.querySelector('[role="alert"]')?.textContent).toContain("Image turn rejected"),
    );
    expect(start().disabled).toBe(true);
    expect(palette.querySelector(".chat-attachment-thumb img")).not.toBeNull();
    key(input, { key: "Enter", metaKey: true });
    expect(context.sessions.createResult).toHaveBeenCalledOnce();
    key(input, { key: "Escape" });
    await palette.updateComplete;
    palette.openPalette();
    await palette.updateComplete;
    expect(palette.querySelector(".chat-attachment-thumb img")).not.toBeNull();
    expect(palette.querySelector(".cmd-palette__footer button")?.textContent).toContain(
      "Open session",
    );
    palette.querySelector<HTMLButtonElement>(".chat-attachment-remove")!.click();
    await palette.updateComplete;
    expect(palette.querySelector('[role="alert"]')).toBeNull();
  });

  it.each(["ready", "failed", "dismissed", "oversized"] as const)(
    "settles a cold image submit exactly once after %s preparation",
    async (outcome) => {
      const { palette, context } = await mount();
      palette.togglePalette();
      await palette.updateComplete;
      if (outcome === "oversized") {
        Object.assign(context.gateway.snapshot.hello!, {
          policy: { attachments: { maxBytes: 2, maxImageBytes: 2 } },
        });
      }
      const state = new CommandPaletteLoadingState({ requestUpdate: () => {} });
      const loader = document.body.appendChild(document.createElement("div"));
      state.begin();
      render(
        renderCommandPaletteLoading(state, () => state.clear()),
        loader,
      );
      const coldInput = loader.querySelector("textarea")!;
      paste(coldInput, [image()]);
      key(coldInput, { key: "Enter", metaKey: true });
      const take = state.captureHandoff();
      palette.openPalette(take);
      await palette.updateComplete;
      const replacement = palette.querySelector<HTMLTextAreaElement>(".cmd-palette__input")!;
      replacement.focus();
      await palette.updateComplete;
      expect(take()).toBeUndefined();
      expect(context.sessions.createResult).not.toHaveBeenCalled();
      if (outcome === "dismissed") {
        key(replacement, { key: "Escape" });
      }
      if (outcome === "failed") {
        readers[0]!.dispatchEvent(new ProgressEvent("error"));
      } else if (outcome !== "oversized") {
        finishRead(0);
      }
      await palette.updateComplete;
      await palette.updateComplete;
      if (outcome === "ready") {
        await vi.waitFor(() => expect(context.sessions.createResult).toHaveBeenCalledOnce());
      } else {
        expect(context.sessions.createResult).not.toHaveBeenCalled();
      }
      render(nothing, loader);
    },
  );
});
