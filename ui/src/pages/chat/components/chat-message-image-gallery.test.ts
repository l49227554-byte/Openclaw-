/* @vitest-environment jsdom */

import { nothing, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ImageLightboxItem } from "../../../components/image-lightbox.ts";
import { renderMessageImages } from "./chat-message-images.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";

let container: HTMLDivElement;
let onRequestUpdate: () => void;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  onRequestUpdate = vi.fn();
});

afterEach(() => {
  render(nothing, container);
  releaseChatMediaResourceSubscriber(onRequestUpdate);
  container.remove();
  vi.unstubAllGlobals();
});

describe("message image gallery loading", () => {
  it.each([false, true])(
    "waits for local-image metadata and discards it after owner removal=%s",
    async (removeOwner) => {
      const metadata = createDeferred<Response>();
      const fetchMetadata = vi.fn(() => metadata.promise);
      vi.stubGlobal("fetch", fetchMetadata);
      const localSource = `/home/node/.openclaw/media/outbound/${crypto.randomUUID()}.png`;
      const onOpenImage = vi.fn<(item: ImageLightboxItem) => void>();
      render(
        renderMessageImages(
          [
            { url: "data:image/png;base64,cG5n", alt: "First image" },
            { url: localSource, alt: "Local neighbor" },
          ],
          { onOpenImage, onRequestUpdate, sessionKey: "main", resourceBasePath: "/openclaw" },
        ),
        container,
      );
      container.querySelector<HTMLButtonElement>(".chat-message-image-button")!.click();
      const opened = onOpenImage.mock.calls[0]?.[0];
      expect(opened?.gallery?.index).toBe(0);
      const loadNeighbor = opened?.gallery?.items[1];
      if (!loadNeighbor) {
        throw new Error("Opening the first tile did not expose its message gallery");
      }
      const settled = vi.fn();
      const neighbor = loadNeighbor().then((item) => {
        settled(item);
        return item;
      });
      // Cross a task boundary while the metadata response remains explicitly held.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(settled).not.toHaveBeenCalled();
      expect(fetchMetadata).toHaveBeenCalledOnce();

      if (removeOwner) {
        render(nothing, container);
        releaseChatMediaResourceSubscriber(onRequestUpdate);
      }
      metadata.resolve(
        new Response(
          JSON.stringify({
            available: true,
            mediaTicket: "gallery-neighbor-ticket",
            mediaTicketExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
      const result = await neighbor;
      if (removeOwner) {
        expect(result).toBeNull();
      } else {
        expect(result?.title).toBe("Local neighbor");
        const url = new URL(result!.src, window.location.href);
        expect(url.pathname).toBe("/openclaw/__openclaw__/assistant-media");
        expect(url.searchParams.get("source")).toBe(localSource);
        expect(url.searchParams.get("mediaTicket")).toBe("gallery-neighbor-ticket");
        expect(url.searchParams.get("sessionKey")).toBe("main");
      }
    },
  );
});
