import { stripVTControlCharacters } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture, getMockCallOutput } from "../test-runtime-capture.js";

const { defaultRuntime: runtime, resetRuntimeCapture } = createCliRuntimeCapture();
vi.mock("../../runtime.js", () => ({ defaultRuntime: runtime }));
const { printDaemonStatus } = await import("./status.print.js");

function expectMockLineContains(mock: typeof runtime.log, expected: string) {
  expect(stripVTControlCharacters(getMockCallOutput(mock))).toContain(expected);
}

describe("daemon status versions", () => {
  beforeEach(() => {
    resetRuntimeCapture();
    vi.clearAllMocks();
  });

  it.each(["2026.4.23", undefined])(
    "prints local installation facts after a failed handshake (package version %s)",
    (packageVersion) => {
      printDaemonStatus(
        {
          cli: { version: "2026.5.6", entrypoint: "/usr/local/bin/openclaw" },
          service: {
            label: "systemd",
            loaded: true,
            loadState: { status: "loaded" },
            loadedText: "enabled",
            notLoadedText: "disabled",
            layout: {
              entrypoint: "/opt/old-openclaw/dist/index.js",
              packageVersion,
            },
          },
          rpc: { ok: false, error: "gateway closed (1002): protocol mismatch" },
          extraServices: [],
        },
        { json: false },
      );

      expectMockLineContains(runtime.log, "CLI version: 2026.5.6 (/usr/local/bin/openclaw)");
      expectMockLineContains(runtime.log, "Service entrypoint: /opt/old-openclaw/dist/index.js");
      const output = stripVTControlCharacters(getMockCallOutput(runtime.log));
      if (packageVersion) {
        expect(output).toContain(`Service package version: ${packageVersion} (installed on disk)`);
      } else {
        expect(output).not.toContain("Service package version:");
      }
      expect(output).not.toContain("Gateway version:");
    },
  );

  it("prints CLI and gateway versions with readable guidance when they differ", () => {
    printDaemonStatus(
      {
        cli: {
          version: "2026.4.23",
          entrypoint: "/usr/local/bin/openclaw",
        },
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadState: { status: "loaded" },
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
        },
        rpc: {
          ok: true,
          kind: "connect",
          capability: "write_capable",
          url: "ws://127.0.0.1:18789",
          server: { version: "2026.5.6", connId: "conn-1" },
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.log, "CLI version: 2026.4.23 (/usr/local/bin/openclaw)");
    expectMockLineContains(runtime.log, "Gateway version: 2026.5.6");
    expectMockLineContains(runtime.error, "this OpenClaw command is version 2026.4.23");
    expectMockLineContains(
      runtime.error,
      "if this mismatch is unexpected, update PATH so `openclaw` points to the version you want",
    );
  });

  it("prints gateway version from gathered gateway status when probe server metadata is absent", () => {
    printDaemonStatus(
      {
        cli: {
          version: "2026.4.23",
          entrypoint: "/usr/local/bin/openclaw",
        },
        service: {
          label: "LaunchAgent",
          loaded: true,
          loadState: { status: "loaded" },
          loadedText: "loaded",
          notLoadedText: "not loaded",
          runtime: { status: "running", pid: 8000 },
        },
        gateway: {
          bindMode: "loopback",
          bindHost: "127.0.0.1",
          port: 18789,
          portSource: "env/config",
          probeUrl: "ws://127.0.0.1:18789",
          version: "2026.5.7",
        },
        rpc: {
          ok: true,
          kind: "read",
          capability: "read_only",
          url: "ws://127.0.0.1:18789",
          version: "2026.5.7",
        },
        extraServices: [],
      },
      { json: false },
    );

    expectMockLineContains(runtime.log, "Gateway version: 2026.5.7");
    expectMockLineContains(runtime.error, "this OpenClaw command is version 2026.4.23");
  });
});
