import { describe, expect, it } from "vitest";
import {
  fetchClawHubPackageDetailMock,
  fetchClawHubPackageArtifactMock,
  downloadClawHubPackageArchiveMock,
  archiveCleanupMock,
  installPluginFromArchiveMock,
  DEMO_ARCHIVE_INTEGRITY,
  setupClawHubInstallMocks,
} from "./clawhub.test-support.js";

const { installPluginFromClawHub } = await import("./clawhub.js");

function expectSuccessfulClawHubInstall(result: unknown) {
  expect(result).toMatchObject({
    ok: true,
    pluginId: "demo",
    version: "2026.3.22",
    clawhub: {
      source: "clawhub",
      clawhubPackage: "demo",
      clawhubFamily: "code-plugin",
      clawhubChannel: "official",
      integrity: DEMO_ARCHIVE_INTEGRITY,
    },
  });
}

describe("ClawHub install cancellation", () => {
  setupClawHubInstallMocks();

  it("rethrows startup cancellation instead of mapping a package lookup failure", async () => {
    const controller = new AbortController();
    const reason = new Error("Gateway startup interrupted by SIGTERM");
    fetchClawHubPackageDetailMock.mockImplementationOnce(
      async ({ signal }: { signal?: AbortSignal }) => {
        expect(signal).toBe(controller.signal);
        controller.abort(reason);
        throw reason;
      },
    );

    await expect(
      installPluginFromClawHub({ spec: "clawhub:demo", signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(fetchClawHubPackageArtifactMock).not.toHaveBeenCalled();
    expect(downloadClawHubPackageArchiveMock).not.toHaveBeenCalled();
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
  });

  it("does not begin archive installation after a completed download observes cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("Gateway startup interrupted by SIGTERM");
    downloadClawHubPackageArchiveMock.mockImplementationOnce(async () => {
      controller.abort(reason);
      return {
        archivePath: "/tmp/clawhub-demo/archive.zip",
        integrity: DEMO_ARCHIVE_INTEGRITY,
        cleanup: archiveCleanupMock,
      };
    });

    await expect(
      installPluginFromClawHub({ spec: "clawhub:demo", signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(installPluginFromArchiveMock).not.toHaveBeenCalled();
    expect(archiveCleanupMock).toHaveBeenCalledOnce();
  });

  it.each(["install", "update"] as const)(
    "settles a published %s when cancellation lands after publication",
    async (mode) => {
      const controller = new AbortController();
      const reason = new Error("Gateway startup interrupted by SIGTERM");
      installPluginFromArchiveMock.mockImplementationOnce(async () => {
        // The archive installer resolves only once the replacement is published,
        // so a cancellation observed here must not discard the settled result:
        // its record carries the deferred transaction that commits or rolls
        // back the displaced package.
        controller.abort(reason);
        return {
          ok: true,
          pluginId: "demo",
          targetDir: "/tmp/openclaw/plugins/demo",
          version: "2026.3.22",
        };
      });

      const result = await installPluginFromClawHub({
        spec: "clawhub:demo",
        mode,
        signal: controller.signal,
      });

      expect(controller.signal.aborted).toBe(true);
      expectSuccessfulClawHubInstall(result);
      expect(archiveCleanupMock).toHaveBeenCalledOnce();
    },
  );
});
