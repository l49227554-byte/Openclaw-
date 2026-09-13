import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { getWindowsCmdExePath } from "../infra/windows-install-roots.js";
import { withEnvAsync } from "../test-utils/env.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  buildTaskScript,
  encodeWindowsLauncherScript,
  readScheduledTaskCommand,
} from "./schtasks-layout.js";
import {
  readWindowsProcessSnapshot,
  resolveScheduledTaskOwnedGatewayPids,
} from "./schtasks-process.js";
import { startStartupEntry } from "./schtasks-runtime.js";

type ChildEnvironment = { pid: number; value?: string; control?: string };
type LaunchedChild = {
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

const launchCapture = vi.hoisted(() => ({
  observe: undefined as ((child: ChildProcess, options?: SpawnOptions) => void) | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      launchCapture.observe?.(child, args[2]);
      return child;
    },
  };
});

describe.skipIf(process.platform !== "win32")("Windows launcher redirection ownership", () => {
  it.each([
    { message: "a >b & c", normalized: true, extraArgument: "" },
    { message: 'a "q" >b', normalized: false, extraArgument: "" },
    { message: "comma target", normalized: false, extraArgument: ",extra" },
  ])(
    "checks real cmd and CIM argv for $message",
    async ({ message, normalized, extraArgument }) => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw launcher proof "));
      const scriptPath = path.join(dir, "gateway.cmd");
      const childPath = path.join(dir, "gateway-child.cjs");
      const reportPath = path.join(dir, "child.json");
      const stopPath = path.join(dir, "stop");
      const outputPath = path.join(dir, extraArgument ? "gateway.log" : "gateway output.log");
      const redirectTarget = extraArgument ? `gateway.log${extraArgument}` : `"${outputPath}"`;
      let launched: LaunchedChild | undefined;
      onTestFinished(async () => {
        await fs.writeFile(stopPath, "");
        if (launched) {
          await withTestTimeout(
            launched.closed,
            10_000,
            "Launcher fixture did not close; retaining its directory",
          );
        }
        await fs.rm(dir, { recursive: true });
      });
      const port = await getFreePort();
      await fs.writeFile(
        childPath,
        `
const fs = require("node:fs");
const net = require("node:net");
const report = process.argv[2];
const stop = process.argv[3];
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const server = net.createServer(socket => socket.end("ready"));
const deadline = setTimeout(() => process.exit(1), 30_000);
const poll = setInterval(() => {
  if (fs.existsSync(stop)) {
    clearInterval(poll);
    clearTimeout(deadline);
    server.close();
  }
}, 50);
server.listen(port, "127.0.0.1", () => {
  console.log("launcher-stdout");
  console.error("launcher-stderr");
  fs.writeFileSync(report + ".tmp", JSON.stringify({
    pid: process.pid, argv: process.argv, cwd: process.cwd(),
    value: process.env.OPENCLAW_TEST_LAUNCHER_VALUE, port: server.address().port,
  }));
  fs.renameSync(report + ".tmp", report);
});
`,
      );
      const programArguments = [
        process.execPath,
        childPath,
        reportPath,
        stopPath,
        "gateway",
        "--port",
        String(port),
        "--msg",
        message,
      ];
      const content =
        buildTaskScript({
          programArguments,
          workingDirectory: dir,
          environment: { OPENCLAW_TEST_LAUNCHER_VALUE: "retained", NODE_OPTIONS: "" },
        }).trimEnd() + ` >> ${redirectTarget} 2>&1\r\n`;
      const originalBytes = encodeWindowsLauncherScript({ format: "cmd", content });
      await fs.writeFile(scriptPath, originalBytes);
      const env = { OPENCLAW_TASK_SCRIPT: scriptPath };
      const child = spawn(
        getWindowsCmdExePath(),
        ["/d", "/s", "/v:off", "/c", '""%OPENCLAW_TASK_SCRIPT%""'],
        {
          env: { ...process.env, ...env },
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: "ignore",
        },
      );
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      launched = { child, closed };
      await Promise.race([
        expect.poll(() => fs.readFile(reportPath, "utf8"), { timeout: 10_000 }).toBeTruthy(),
        closed.then(() => {
          throw new Error("Launcher fixture exited before reporting readiness");
        }),
      ]);
      const observed: { pid: number; argv: string[]; cwd: string; value: string; port: number } =
        JSON.parse(await fs.readFile(reportPath, "utf8"));
      expect(observed).toMatchObject({
        argv: extraArgument ? [...programArguments, extraArgument] : programArguments,
        cwd: dir,
        value: "retained",
        port,
      });
      expect(observed.pid).not.toBe(child.pid);
      const snapshot = readWindowsProcessSnapshot();
      expect(snapshot?.some((entry) => entry.ProcessId === observed.pid)).toBe(true);
      const installed = await readScheduledTaskCommand(env, { requireEffective: true });
      expect(installed?.workingDirectory).toBe(dir);
      expect(installed?.environment?.OPENCLAW_TEST_LAUNCHER_VALUE).toBe("retained");
      if (normalized) {
        expect(installed?.programArguments).toEqual(programArguments);
        await expect(resolveScheduledTaskOwnedGatewayPids(env, { port })).resolves.toEqual([
          observed.pid,
        ]);
        await expect(
          resolveScheduledTaskOwnedGatewayPids(
            env,
            { port },
            {
              ...expectDefined(installed, "installed launcher"),
              programArguments: [...programArguments, "--foreign"],
            },
          ),
        ).resolves.toEqual([]);
      } else {
        // Ambiguous quoting and filename delimiters must not manufacture a
        // shortened installed command that could authorize another process.
        expect(installed?.programArguments).toEqual([
          ...programArguments,
          "<",
          "NUL",
          ">>",
          extraArgument ? redirectTarget : outputPath,
          "2>&1",
        ]);
        await expect(resolveScheduledTaskOwnedGatewayPids(env, { port })).resolves.toEqual([]);
      }
      expect(await fs.readFile(scriptPath)).toEqual(originalBytes);
      await fs.writeFile(stopPath, "");
      expect(await withTestTimeout(closed, 10_000, "Launcher fixture did not close")).toEqual({
        code: 0,
        signal: null,
      });
      expect(await fs.readFile(outputPath, "utf8")).toContain("launcher-stdout");
      expect(await fs.readFile(outputPath, "utf8")).toContain("launcher-stderr");
    },
    30_000,
  );
});

describe("Windows Startup fallback environment", () => {
  it.for([
    { name: "different casing", key: "openclaw_test_fallback_case" },
    { name: "matching casing", key: "OPENCLAW_TEST_FALLBACK_CASE" },
  ])("preserves the saved override with $name", async ({ key }, context) => {
    if (process.platform !== "win32" && key !== key.toUpperCase()) {
      context.skip("Case-insensitive environment names require Windows");
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw fallback env "));
    const output = new PassThrough();
    output.resume();
    const children: LaunchedChild[] = [];
    onTestFinished(async () => {
      launchCapture.observe = undefined;
      output.end();
      for (const { child } of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill();
        }
      }
      // Join the owned instances even after an assertion fails. An uncertain
      // close retains their inputs instead of treating PID disappearance as cleanup.
      await withTestTimeout(
        Promise.all(children.map(({ closed }) => closed)),
        10_000,
        "Startup fixture child did not close; retaining its directory",
      );
      await fs.rm(dir, { recursive: true });
    });
    const reportPath = path.join(dir, "child.json");
    const childPath = path.join(dir, "report-env.cjs");
    await fs.writeFile(
      childPath,
      `
const fs = require("node:fs");
const file = process.argv[2];
fs.writeFileSync(file + ".tmp", JSON.stringify({
  pid: process.pid,
  value: process.env.OPENCLAW_TEST_FALLBACK_CASE,
  control: process.env.OPENCLAW_TEST_FALLBACK_CONTROL,
}));
fs.renameSync(file + ".tmp", file);
`,
    );
    const scriptPath = path.join(dir, "gateway.cmd");
    await fs.writeFile(
      scriptPath,
      encodeWindowsLauncherScript({
        format: "cmd",
        content: buildTaskScript({
          programArguments: [process.execPath, childPath, reportPath],
          workingDirectory: dir,
          environment: {
            [key]: "configured",
            OPENCLAW_TEST_FALLBACK_CONTROL: "control",
          },
        }),
      }),
    );
    launchCapture.observe = (child, options) => {
      if (options?.cwd !== dir && options?.env?.OPENCLAW_TASK_SCRIPT !== scriptPath) {
        return;
      }
      // Observe close at spawn, before Startup discards its child handle.
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          child.once("close", (code, signal) => resolve({ code, signal }));
        },
      );
      children.push({ child, closed });
    };
    await withEnvAsync({ OPENCLAW_TEST_FALLBACK_CASE: "inherited" }, async () => {
      await startStartupEntry({ OPENCLAW_TASK_SCRIPT: scriptPath }, output);
      expect(children).toHaveLength(1);
      const { child, closed } = expectDefined(children[0], "Startup fixture child");
      expect(await withTestTimeout(closed, 10_000, "Startup fixture child did not close")).toEqual({
        code: 0,
        signal: null,
      });
      const observed: ChildEnvironment = JSON.parse(await fs.readFile(reportPath, "utf8"));
      expect(observed.pid).toBe(child.pid);
      expect(observed.control).toBe("control");
      expect(observed.value, "PR122658_ENV_OVERRIDE_LOST").toBe("configured");
    });
  });
});
