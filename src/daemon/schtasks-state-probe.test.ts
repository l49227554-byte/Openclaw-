import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeScheduledTaskState } from "./schtasks-state-probe.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));

beforeEach(() => vi.mocked(spawnSync).mockReset());

it("reads task state when PowerShell rejects a no-console launch", () => {
  vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
    const hidden = options?.windowsHide === true;
    const stdout = hidden ? "" : JSON.stringify({ state: 4, lastRunResult: 267009 });
    return {
      pid: 0,
      output: [null, stdout, ""],
      stdout,
      stderr: "",
      status: hidden ? 2 : 0,
      signal: null,
    };
  });

  expect(probeScheduledTaskState("OpenClaw Gateway")).toEqual({
    status: "found",
    state: 4,
    lastRunResult: "267009",
  });
  expect(spawnSync).toHaveBeenCalledTimes(1);
});

it("releases registered-task COM wrappers before returning the probe result", () => {
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    output: [null, JSON.stringify({ state: 3, enabled: true }), ""],
    stdout: JSON.stringify({ state: 3, enabled: true }),
    stderr: "",
    status: 0,
    signal: null,
  });

  expect(probeScheduledTaskState("OpenClaw Gateway")).toMatchObject({ status: "found" });
  const encoded = vi.mocked(spawnSync).mock.calls[0]?.[1]?.at(-1);
  expect(typeof encoded).toBe("string");
  const script = Buffer.from(encoded as string, "base64").toString("utf16le");
  const outputIndex = script.indexOf("Write-Output $json");
  for (const name of ["$task", "$folder", "$service"]) {
    const releaseIndex = script.indexOf(`FinalReleaseComObject(${name})`);
    expect(releaseIndex).toBeGreaterThan(-1);
    expect(releaseIndex).toBeLessThan(outputIndex);
  }
});

it.each(["", " \r\n"])("explains an empty exit-2 result: %j", (output) => {
  vi.mocked(spawnSync).mockReturnValue({
    pid: 0,
    output: [null, output, output],
    stdout: output,
    stderr: output,
    status: 2,
    signal: null,
  });
  expect(probeScheduledTaskState("OpenClaw Gateway")).toEqual({
    status: "unknown",
    detail: "Scheduled Task probe failed (exit 2): no output from PowerShell.",
  });
});

describe("Scheduled Task probe timeout", () => {
  it.each([
    { budget: undefined, expected: 5_000 },
    { budget: 0, expected: 5_000 },
    { budget: -1, expected: 5_000 },
    { budget: Number.POSITIVE_INFINITY, expected: 5_000 },
    { budget: 200, expected: 200 },
    { budget: 30_000, expected: 30_000 },
  ])("uses a bounded caller budget: $budget -> $expected ms", ({ budget, expected }) => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0,
      output: [null, "", ""],
      stdout: "",
      stderr: "",
      status: null,
      signal: "SIGTERM",
      error: Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" }),
    });

    const result = probeScheduledTaskState("OpenClaw Gateway", budget);

    expect(vi.mocked(spawnSync).mock.calls[0]?.[2]?.timeout).toBe(expected);
    expect(result).toEqual({
      status: "unknown",
      detail: `Scheduled Task probe timed out after ${expected} ms (ETIMEDOUT).`,
      timeoutMs: expected,
    });
    expect(spawnSync).toHaveBeenCalledTimes(1);
  });
});
