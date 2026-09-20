// Keep this real-process proof separate from the mocked recovery discovery suite.
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";

const testNodeExecPath = resolveTestNodeExecPath();

describe("runtime recovery Gateway drain (real child)", () => {
  it.runIf(process.platform === "linux")(
    "preserves a real HTTP final response and persisted effect beyond two seconds",
    async () => {
      const child = spawn(
        testNodeExecPath,
        [
          path.resolve("scripts/proof/gateway-launcher-drain-shutdown-proof.mjs"),
          "--mode=recovery",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (data: string) => {
        stdout += data;
      });
      child.stderr.setEncoding("utf8").on("data", (data: string) => {
        stderr += data;
      });
      const [code, signal] = await once(child, "exit");
      expect({ code, signal }, stderr).toEqual({ code: 0, signal: null });
      expect(JSON.parse(stdout)).toMatchObject({
        mode: "recovery",
        finalEffect: true,
        deniedAdmission: 503,
      });
    },
    20_000,
  );
});
