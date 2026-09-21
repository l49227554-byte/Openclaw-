/* @vitest-environment jsdom */

import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetChatViewState } from "./chat-view-state.ts";
import { renderChatView, stubAnimationFrames } from "./chat-view.test-helpers.ts";
import { resetChatComposerState } from "./components/chat-composer.ts";

function getComposerElements(container: Element) {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    ".agent-chat__composer-combobox > textarea",
  );
  const thread = container.querySelector<HTMLElement>(".chat-thread");
  if (!textarea || !thread) {
    throw new Error("expected composer textarea and chat thread");
  }
  return { textarea, thread };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetChatComposerState();
  resetChatViewState();
});

describe("native chat composer sizing", () => {
  beforeEach(() => vi.spyOn(CSS, "supports").mockReturnValue(true));

  it("avoids transcript layout reads on draft input", async () => {
    const container = renderChatView({});
    const { textarea, thread } = getComposerElements(container);
    document.body.append(container);
    await Promise.resolve();
    let transcriptLayoutReads = 0;
    Object.defineProperty(thread, "scrollHeight", {
      configurable: true,
      get: () => {
        transcriptLayoutReads += 1;
        return 2_000;
      },
    });
    textarea.style.height = "42px";

    textarea.value = "responsive draft";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(transcriptLayoutReads).toBe(0);
    expect(textarea.style.height).toBe("");
  });

  it("restores the transcript end anchor after native sizing paints", () => {
    const flushAnimationFrames = stubAnimationFrames();
    const container = renderChatView({});
    const { textarea, thread } = getComposerElements(container);
    let scrollTop = 1_500;
    Object.defineProperties(thread, {
      scrollHeight: { configurable: true, get: () => 2_000 },
      clientHeight: { configurable: true, get: () => 500 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });

    textarea.value = "line 1\nline 2\nline 3";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(scrollTop).toBe(1_500);
    flushAnimationFrames();
    expect(scrollTop).toBe(1_500);
    flushAnimationFrames();
    expect(scrollTop).toBe(2_000);
  });

  it("leaves reader navigation in control while bottom anchoring is pending", () => {
    const flushAnimationFrames = stubAnimationFrames();
    const container = renderChatView({});
    const { textarea, thread } = getComposerElements(container);
    let scrollTop = 1_500;
    Object.defineProperties(thread, {
      scrollHeight: { configurable: true, get: () => 2_000 },
      clientHeight: { configurable: true, get: () => 500 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });

    textarea.value = "line 1\nline 2\nline 3";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flushAnimationFrames();
    thread.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "PageUp" }));
    scrollTop = 1_000;
    flushAnimationFrames();

    expect(scrollTop).toBe(1_000);
  });

  it("honors a remote-input follow lock before applying the deferred anchor", () => {
    const flushAnimationFrames = stubAnimationFrames();
    const container = renderChatView({});
    const { textarea, thread } = getComposerElements(container);
    let scrollTop = 1_500;
    Object.defineProperties(thread, {
      scrollHeight: { configurable: true, get: () => 2_000 },
      clientHeight: { configurable: true, get: () => 500 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value;
        },
      },
    });
    let followLocked = false;
    const requestComposerBottomAnchor = vi.fn(() => !followLocked);
    const pane = Object.assign(document.createElement("openclaw-chat-pane"), {
      requestComposerBottomAnchor,
    });
    pane.append(container);

    textarea.value = "line 1\nline 2\nline 3";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flushAnimationFrames();
    followLocked = true;
    flushAnimationFrames();

    expect(requestComposerBottomAnchor).toHaveBeenCalledOnce();
    expect(scrollTop).toBe(1_500);
  });
});

describe("manual chat composer sizing fallback", () => {
  beforeEach(() => vi.spyOn(CSS, "supports").mockReturnValue(false));

  it("sizes restored drafts after the rendered value is committed", async () => {
    const container = renderChatView({ draft: "A restored long draft" });
    const textarea = getComposerElements(container).textarea;
    Object.defineProperties(textarea, {
      scrollHeight: { configurable: true, value: 180 },
      clientHeight: { configurable: true, value: 150 },
    });
    document.body.append(container);

    await Promise.resolve();

    expect(textarea.style.height).toBe("150px");
    expect(textarea.style.overflowY).toBe("auto");
    container.remove();
  });

  it("shows the textarea scrollbar only when the draft overflows", () => {
    const container = renderChatView({});
    const textarea = getComposerElements(container).textarea;
    let scrollHeight = 42;
    let clientHeight = 42;
    Object.defineProperties(textarea, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => clientHeight },
    });

    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(textarea.style.height).toBe("42px");
    expect(textarea.style.overflowY).toBe("hidden");

    scrollHeight = 180;
    clientHeight = 150;
    textarea.value = "A long draft";
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));

    expect(textarea.style.height).toBe("150px");
    expect(textarea.style.overflowY).toBe("auto");
  });

  it("resizes the draft when responsive layout changes the textarea width", () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    let animationFrameCallback: FrameRequestCallback | undefined;
    let nextAnimationFrameId = 0;
    const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
      animationFrameCallback = callback;
      nextAnimationFrameId += 1;
      return nextAnimationFrameId;
    });
    const cancelAnimationFrameMock = vi.fn();
    class TestResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords(): ResizeObserverEntry[] {
        return [];
      }
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrameMock);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrameMock);

    let width = 320;
    let scrollHeight = 42;
    let clientHeight = 42;
    vi.spyOn(HTMLTextAreaElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
      bottom: clientHeight,
      height: clientHeight,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }));

    const container = renderChatView({});
    const textarea = getComposerElements(container).textarea;
    Object.defineProperties(textarea, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => clientHeight },
    });
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true }));
    expect(textarea.style.height).toBe("42px");
    expect(textarea.style.overflowY).toBe("hidden");

    scrollHeight = 180;
    clientHeight = 150;
    resizeCallback?.([], {} as ResizeObserver);
    expect(textarea.style.overflowY).toBe("auto");
    expect(requestAnimationFrameMock).not.toHaveBeenCalled();

    width = 180;
    scrollHeight = 120;
    clientHeight = 120;
    resizeCallback?.([], {} as ResizeObserver);
    expect(requestAnimationFrameMock).toHaveBeenCalledOnce();
    expect(textarea.style.height).toBe("42px");

    animationFrameCallback?.(0);
    expect(textarea.style.height).toBe("120px");
    expect(textarea.style.overflowY).toBe("hidden");

    width = 160;
    resizeCallback?.([], {} as ResizeObserver);
    render(html``, container);
    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(2);
  });
});
