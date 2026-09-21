import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";

const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

const { listMarketplacePlugins } = await import("./marketplace.js");

it("removes the marketplace clone directory when acquisition throws", async () => {
  const reason = new Error("Gateway startup interrupted by SIGTERM");
  let clonedTmpDir = "";
  runCommandWithTimeoutMock.mockImplementationOnce(async (argv: string[]) => {
    const repoDir = argv.at(-1);
    expect(typeof repoDir).toBe("string");
    clonedTmpDir = path.dirname(repoDir as string);
    expect(clonedTmpDir).toContain("openclaw-marketplace-");
    // Acquisition rejections bypass cleanupOnFailure, mirroring the abort
    // path where runCommandWithTimeout forwards cancellation by throwing.
    throw reason;
  });

  await expect(listMarketplacePlugins({ marketplace: "owner/repo" })).rejects.toBe(reason);
  await expect(fs.access(clonedTmpDir)).rejects.toMatchObject({ code: "ENOENT" });
});
