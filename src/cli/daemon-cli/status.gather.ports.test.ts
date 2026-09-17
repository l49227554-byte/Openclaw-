import { describe, expect, it, vi } from "vitest";
import { renderPortDiagnosticsForCli } from "./status.gather.js";

const formatPortDiagnostics = vi.hoisted(() => vi.fn(() => ["port diagnostics"]));
vi.mock("../../infra/ports-format.js", () => ({ formatPortDiagnostics }));

describe("daemon status port diagnostics", () => {
  it("reports indeterminate port availability unless the RPC probe succeeded", () => {
    const status = {
      service: {
        label: "Scheduled Task",
        loaded: true,
        loadState: { status: "loaded" as const },
        loadedText: "registered",
        notLoadedText: "not registered",
      },
      port: { port: 18789, status: "unknown" as const, listeners: [], hints: [] },
      extraServices: [],
    };

    expect(renderPortDiagnosticsForCli(status, false)).toEqual(["port diagnostics"]);
    expect(formatPortDiagnostics).toHaveBeenCalledWith(status.port);
    expect(renderPortDiagnosticsForCli(status, true)).toEqual([]);
    expect(
      renderPortDiagnosticsForCli({ ...status, port: { ...status.port, status: "free" } }, false),
    ).toEqual([]);
  });
});
