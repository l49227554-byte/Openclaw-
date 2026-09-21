import { beforeEach, expect, it, vi } from "vitest";
import {
  createAbortTestRunState,
  createActiveRun,
  createChatAbortContext,
} from "./chat.abort.test-helpers.js";

const persistence = vi.hoisted(() => ({
  persistAbortedPartials: vi.fn(async () => true),
}));

vi.mock("./chat-transcript-persistence.js", async () => ({
  ...(await vi.importActual<typeof import("./chat-transcript-persistence.js")>(
    "./chat-transcript-persistence.js",
  )),
  persistAbortedPartials: persistence.persistAbortedPartials,
}));

const { handleDirectExternalChatSend } = await import("./chat-send-external-entry.js");

beforeEach(() => {
  persistence.persistAbortedPartials.mockClear();
});

it("returns a warning when /stop cannot persist its streamed partial", async () => {
  const respond = vi.fn();
  const context = createChatAbortContext({
    chatAbortControllers: new Map([
      ["run-stop-failure", createActiveRun("main", { sessionId: "stop-session" })],
    ]),
    chatRunState: createAbortTestRunState([
      ["run-stop-failure", { buffer: "Unsaved /stop partial", deltaSentAt: Date.now() }],
    ]),
  });

  await handleDirectExternalChatSend({
    params: {
      sessionKey: "main",
      message: "/stop",
      idempotencyKey: "idem-stop-failure",
    },
    respond,
    context: context as never,
    req: {} as never,
    client: null,
    isWebchatConnect: () => false,
  });

  expect(persistence.persistAbortedPartials).toHaveBeenCalledOnce();
  expect(respond).toHaveBeenLastCalledWith(
    true,
    expect.objectContaining({
      aborted: true,
      runIds: ["run-stop-failure"],
      warning: expect.stringContaining("could not be saved to the transcript"),
    }),
    undefined,
  );
});
