import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

describe("managed command signal ownership", () => {
  it.each([undefined, 0, -1, Number.POSITIVE_INFINITY])(
    "requires a finite cleanup deadline before caller ownership (%s)",
    async (timeoutMs) => {
      const ready = vi.fn();
      await expect(
        runManagedCommand({
          bin: process.execPath,
          args: ["-e", "process.exit(0)"],
          signalHandling: "caller",
          timeoutMs,
          onReady: ready,
        }),
      ).rejects.toThrow("finite positive command timeout");
      expect(ready).not.toHaveBeenCalled();
    },
  );

  it.skipIf(process.platform === "win32").each([
    { policy: "forward", expected: 143, forwards: 1 },
    { policy: "caller", expected: 0, forwards: 0 },
  ] as const)(
    "keeps real SIGTERM with the $policy owner",
    { timeout: 20_000 },
    async ({ policy, expected, forwards }) => {
      const directory = createTempDir("managed-signal-owner-");
      const runner = path.join(directory, "runner.mjs");
      const child = [
        'process.on("SIGTERM", () => {});',
        'process.stdin.once("data", () => { process.stdout.write("finished"); process.exit(0); });',
        'process.stdout.write("ready");',
      ].join("\n");
      const module = pathToFileURL(path.resolve("scripts/lib/managed-child-process.mts")).href;
      fs.writeFileSync(
        runner,
        [
          "import { runManagedCommand } from " + JSON.stringify(module) + ";",
          'let child; let received = 0; let forwarded = 0; let output = ""; let sent = false;',
          'process.on("SIGTERM", () => { received++; setImmediate(() => child?.stdin?.end("finish")); });',
          "const code = await runManagedCommand({",
          'bin: process.execPath, args: ["-e", ' + JSON.stringify(child) + "],",
          "signalHandling: " +
            JSON.stringify(policy) +
            ', timeoutMs: 5_000, stdio: ["pipe", "pipe", "pipe"],',
          "onSignal() { forwarded++; },",
          'onReady(spawned) { child = spawned; spawned.stdin?.on("error", () => {});',
          'spawned.stdout?.on("data", chunk => { output += chunk.toString("utf8");',
          'if (!sent && output.includes("ready")) { sent = true; process.kill(process.pid, "SIGTERM"); } }); }',
          "});",
          "console.log(JSON.stringify({ code, received, forwarded, output }));",
        ].join("\n"),
      );
      let output = "";
      let errors = "";
      const code = await runManagedCommand({
        bin: resolveTestNodeExecPath(),
        args: [runner],
        stdio: ["ignore", "pipe", "pipe"],
        timeoutMs: 15_000,
        requireProcessTreeExit: true,
        onReady(process) {
          process.stdout?.on("data", (chunk: Buffer) => {
            output += chunk.toString("utf8");
          });
          process.stderr?.on("data", (chunk: Buffer) => {
            errors += chunk.toString("utf8");
          });
        },
      });
      expect(code, errors).toBe(0);
      const result = JSON.parse(output.trim());
      expect(result).toMatchObject({ code: expected, received: 1, forwarded: forwards });
      if (policy === "caller") {
        expect(result.output).toContain("finished");
      }
    },
  );
});
