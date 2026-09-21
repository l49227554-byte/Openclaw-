import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import type { SpawnResult } from "../process/exec.js";
import {
  attachPluginInstallTransaction,
  requestDeferredPluginInstall,
  resolvePluginInstallTransactionRequest,
  settlePluginInstallTransactions,
  type PluginInstallTransaction,
} from "./install-transaction.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";

const mocks = vi.hoisted(() => ({ npm: vi.fn(), clawhub: vi.fn(), command: vi.fn() }));
vi.mock("./install.js", () => ({
  installPluginFromNpmSpec: mocks.npm,
  resolvePluginInstallDir: (pluginId: string, extensionsDir = "/tmp") =>
    path.join(extensionsDir, pluginId),
  PLUGIN_INSTALL_ERROR_CODE: {
    NPM_METADATA_FAILURE: "npm_metadata_failure",
    NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  },
}));
vi.mock("./clawhub.js", () => ({
  installPluginFromClawHub: mocks.clawhub,
  CLAWHUB_INSTALL_ERROR_CODE: {
    PACKAGE_NOT_FOUND: "package_not_found",
    VERSION_NOT_FOUND: "version_not_found",
    ARTIFACT_UNAVAILABLE: "artifact_unavailable",
    ARCHIVE_INTEGRITY_MISMATCH: "archive_integrity_mismatch",
    ARTIFACT_DOWNLOAD_UNAVAILABLE: "artifact_download_unavailable",
    CLAWHUB_SECURITY_UNAVAILABLE: "clawhub_security_unavailable",
    CLAWHUB_DOWNLOAD_BLOCKED: "clawhub_download_blocked",
  },
}));
vi.mock("./update-capability-consent.js", () => ({
  preparePluginUpdateCapabilityConsent: () => ({
    onBeforePluginArtifactCommit: async () => {},
    acceptInstallRecord: <T extends PluginInstallRecord>(record: T): T => record,
  }),
}));
vi.mock("./bundled-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bundled-sources.js")>()),
  resolveBundledPluginSources: () => new Map(),
}));
vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: vi.fn(),
}));
vi.mock("../state/claw-package-adoption.js", () => ({
  markClawPackageIndependentlyOwned: vi.fn(),
}));
vi.mock("../state/claw-package-lifecycle-lease.js", () => ({
  withClawPackageLifecycleLease: async (_artifact: unknown, operation: () => Promise<unknown>) =>
    await operation(),
}));
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandWithTimeout: mocks.command,
}));
const { updateNpmInstalledPlugins } = await import("./update.js");
const cancellationDirs = useAutoCleanupTempDirTracker(afterEach);
const failedNpmVersionQueryResult: SpawnResult = {
  code: 1,
  stdout: "",
  stderr: "npm version query failed",
  signal: null,
  killed: false,
  termination: "exit",
};
function writePackage(dir: string, version: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", version }));
}
beforeEach(() => {
  mocks.npm.mockReset();
  mocks.clawhub.mockReset();
  mocks.command.mockReset();
});
describe("published plugin update cancellation", () => {
  it.each(
    (["npm", "clawhub", "clawhub-fallback"] as const).flatMap((source) =>
      [false, true].map((deferred) => ({ source, deferred })),
    ),
  )(
    "retains rollback custody for a published $source update on late cancellation (deferred=$deferred)",
    async ({ source, deferred }) => {
      const root = cancellationDirs.make("openclaw-update-cancel-");
      const installPath = path.join(root, "extensions", "demo");
      const sourceDir = path.join(root, "source");
      writePackage(installPath, "1.0.0");
      writePackage(sourceDir, "2.0.0");
      const previousManifest = fs.readFileSync(path.join(installPath, "package.json"), "utf8");
      const config: OpenClawConfig = {
        plugins: {
          installs: {
            demo:
              source === "npm"
                ? { source: "npm", spec: "demo", installPath }
                : {
                    source: "clawhub",
                    spec: "clawhub:demo",
                    installPath,
                    clawhubUrl: "https://clawhub.ai",
                    clawhubPackage: "demo",
                    clawhubFamily: "code-plugin",
                    clawhubChannel: "official",
                  },
          },
        },
      };
      const previousConfig = structuredClone(config);
      const controller = new AbortController();
      const reason = new Error("startup SIGTERM after publication");
      const publishThenAbort = async (params: object) => {
        const published = await installPackageDir(
          requestDeferredPackageDirInstall(
            {
              sourceDir,
              targetDir: installPath,
              mode: "update",
              timeoutMs: 1000,
              hasDeps: false,
              copyErrorPrefix: "copy failed",
              depsLogMessage: "",
              signal: controller.signal,
            },
            resolvePluginInstallTransactionRequest(params)?.assertOwned,
          ),
        );
        expect(published.ok).toBe(true);
        expect(fs.readFileSync(path.join(installPath, "package.json"), "utf8")).not.toBe(
          previousManifest,
        );
        const transaction = expectDefined(
          resolvePackageDirInstallTransaction(published),
          "published update transaction",
        );
        controller.abort(reason);
        const result = {
          ok: true,
          pluginId: "demo",
          targetDir: installPath,
          version: "2.0.0",
          extensions: ["index.ts"],
          ...(source === "npm"
            ? {}
            : {
                packageName: "demo",
                clawhub: {
                  source: "clawhub",
                  clawhubUrl: "https://clawhub.ai",
                  clawhubPackage: "demo",
                  clawhubFamily: "code-plugin",
                  clawhubChannel: "official",
                  version: "2.0.0",
                  integrity: "sha256-clawpack",
                  resolvedAt: "2026-05-01T00:00:00.000Z",
                  artifactKind: "npm-pack",
                  artifactFormat: "tgz",
                  npmIntegrity: "sha512-clawpack",
                  npmShasum: "2".repeat(40),
                  npmTarballName: "demo-2.0.0.tgz",
                  clawpackSha256: "a".repeat(64),
                  clawpackSpecVersion: 1,
                  clawpackManifestSha256: "b".repeat(64),
                  clawpackSize: 4096,
                },
              }),
        };
        return attachPluginInstallTransaction(result, transaction);
      };
      if (source === "npm") {
        mocks.command.mockResolvedValue(failedNpmVersionQueryResult);
        mocks.npm.mockImplementation(publishThenAbort);
      } else {
        if (source === "clawhub-fallback") {
          mocks.clawhub.mockResolvedValueOnce({
            ok: false,
            code: "version_not_found",
            error: "version not found: beta",
          });
        }
        mocks.clawhub.mockImplementation(publishThenAbort);
      }
      const transactions: PluginInstallTransaction[] = [];
      const options: Parameters<typeof updateNpmInstalledPlugins>[0] = {
        config,
        pluginIds: ["demo"],
        signal: controller.signal,
        ...(source === "clawhub-fallback" ? { updateChannel: "beta" } : {}),
      };
      await withPluginLifecycleLease({}, async () => {
        await expect(
          updateNpmInstalledPlugins(
            deferred ? requestDeferredPluginInstall(options, transactions) : options,
          ),
        ).rejects.toBe(reason);
        if (deferred) {
          expect(transactions).toHaveLength(1);
          await settlePluginInstallTransactions(transactions, "rollback");
        }
        expect(fs.readFileSync(path.join(installPath, "package.json"), "utf8")).toBe(
          previousManifest,
        );
        expect(config).toEqual(previousConfig);
        expect(fs.readdirSync(path.join(root, "extensions", ".openclaw-install-backups"))).toEqual(
          [],
        );
        expect(
          fs
            .readdirSync(path.join(root, "extensions"))
            .filter(
              (name) =>
                name.startsWith(".openclaw-install-stage-") ||
                name.startsWith(".openclaw-install-rollback-"),
            ),
        ).toEqual([]);
      });
    },
  );
});
