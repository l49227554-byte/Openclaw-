import { ChildProcess, type SpawnOptions } from "node:child_process";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRespawnedChild } from "../../node-runtime-recovery.mjs";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn<(file: string, args: string[], options: SpawnOptions) => ChildProcess>(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const exitSentinel = new Error("replacement exited");
let child: ChildProcess;

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
  child = new ChildProcess();
  mocks.spawn.mockReset().mockReturnValue(child);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw exitSentinel;
  });
});

afterEach(() => {
  if (child.listenerCount("exit")) {
    expect(() => child.emit("exit", 0, null)).toThrow(exitSentinel);
  }
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("runtime recovery child shutdown", () => {
  function start(env: NodeJS.ProcessEnv) {
    const kill = vi.spyOn(child, "kill").mockReturnValue(true);
    const before = new Set(process.listeners("SIGTERM"));
    runRespawnedChild(process.execPath, ["/fixture/openclaw.mjs", "gateway", "run"], env);
    const signal = expectDefined(
      process.listeners("SIGTERM").find((listener) => !before.has(listener)),
      "signal listener",
    );
    return { kill, signal };
  }

  it.each([
    { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "gateway" },
    { OPENCLAW_SERVICE_MARKER: " openclaw " },
  ])("preserves the managed Gateway drain budget for %j", (env) => {
    const { kill, signal } = start(env);
    signal("SIGTERM");
    vi.advanceTimersByTime(327_999);
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it.each([
    {},
    { OPENCLAW_SERVICE_MARKER: "other", OPENCLAW_SERVICE_KIND: "gateway" },
    { OPENCLAW_SERVICE_MARKER: "openclaw", OPENCLAW_SERVICE_KIND: "node" },
  ])("keeps unrelated recovery children on the short deadline for %j", (env) => {
    const { kill, signal } = start(env);
    signal("SIGTERM");
    vi.advanceTimersByTime(999);
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledTimes(2);
  });

  it("does not extend the managed deadline after repeated signals", () => {
    const { kill, signal } = start({
      OPENCLAW_SERVICE_MARKER: "openclaw",
      OPENCLAW_SERVICE_KIND: "gateway",
    });
    signal("SIGTERM");
    vi.advanceTimersByTime(200_000);
    signal("SIGTERM");
    expect(kill).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(128_000);
    expect(kill).toHaveBeenCalledTimes(3);
  });
});
