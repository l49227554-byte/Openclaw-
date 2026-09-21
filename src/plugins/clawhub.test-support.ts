import { beforeEach, vi } from "vitest";

export const DEMO_ARCHIVE_INTEGRITY = "sha256-qerEjGEpvES2+Tyan0j2xwDRkbcnmh4ZFfKN9vWbsa8=";

export const parseClawHubPluginSpecMock = vi.fn();
export const fetchClawHubPackageDetailMock = vi.fn();
export const fetchClawHubPackageArtifactMock = vi.fn();
export const fetchClawHubPackageSecurityMock = vi.fn();
export const fetchClawHubPackageVersionMock = vi.fn();
export const downloadClawHubPackageArchiveMock = vi.fn();
export const archiveCleanupMock = vi.fn();
export const resolveLatestVersionFromPackageMock = vi.fn();
export const resolveCompatibilityHostVersionMock = vi.fn();
export const installPluginFromArchiveMock = vi.fn();

vi.mock("../infra/clawhub-spec.js", () => ({
  parseClawHubPluginSpec: (...args: unknown[]) => parseClawHubPluginSpecMock(...args),
}));

vi.mock("../infra/clawhub-packages.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/clawhub-packages.js")>(
    "../infra/clawhub-packages.js",
  );
  return {
    ...actual,
    fetchClawHubPackageDetail: (...args: unknown[]) => fetchClawHubPackageDetailMock(...args),
    fetchClawHubPackageArtifact: (...args: unknown[]) => fetchClawHubPackageArtifactMock(...args),
    fetchClawHubPackageSecurity: (...args: unknown[]) => fetchClawHubPackageSecurityMock(...args),
    fetchClawHubPackageVersion: (...args: unknown[]) => fetchClawHubPackageVersionMock(...args),
    resolveLatestVersionFromPackage: (...args: unknown[]) =>
      resolveLatestVersionFromPackageMock(...args),
  };
});

vi.mock("../infra/clawhub-artifacts.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/clawhub-artifacts.js")>(
    "../infra/clawhub-artifacts.js",
  );
  return {
    ...actual,
    downloadClawHubPackageArchive: (...args: unknown[]) =>
      downloadClawHubPackageArchiveMock(...args),
  };
});

vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  resolveCompatibilityHostVersion: (...args: unknown[]) =>
    resolveCompatibilityHostVersionMock(...args),
}));

vi.mock("./install.js", () => ({
  PLUGIN_INSTALL_ERROR_CODE: {
    PLUGIN_ID_MISMATCH: "plugin_id_mismatch",
  },
  installPluginFromArchive: (...args: unknown[]) => installPluginFromArchiveMock(...args),
}));

vi.mock("../infra/archive.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/archive.js")>("../infra/archive.js");
  return {
    ...actual,
    DEFAULT_MAX_ENTRIES: 50_000,
    DEFAULT_MAX_EXTRACTED_BYTES: 512 * 1024 * 1024,
    DEFAULT_MAX_ENTRY_BYTES: 256 * 1024 * 1024,
  };
});

export function setupClawHubInstallMocks() {
  beforeEach(() => {
    parseClawHubPluginSpecMock.mockReset();
    fetchClawHubPackageDetailMock.mockReset();
    fetchClawHubPackageArtifactMock.mockReset();
    fetchClawHubPackageSecurityMock.mockReset();
    fetchClawHubPackageVersionMock.mockReset();
    downloadClawHubPackageArchiveMock.mockReset();
    archiveCleanupMock.mockReset();
    resolveLatestVersionFromPackageMock.mockReset();
    resolveCompatibilityHostVersionMock.mockReset();
    installPluginFromArchiveMock.mockReset();

    parseClawHubPluginSpecMock.mockReturnValue({ name: "demo" });
    fetchClawHubPackageDetailMock.mockResolvedValue({
      package: {
        name: "demo",
        displayName: "Demo",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    resolveLatestVersionFromPackageMock.mockReturnValue("2026.3.22");
    fetchClawHubPackageVersionMock.mockResolvedValue({
      version: {
        version: "2026.3.22",
        createdAt: 0,
        changelog: "",
        sha256hash: "a9eac48c6129bc44b6f93c9a9f48f6c700d191b7279a1e1915f28df6f59bb1af",
        compatibility: {
          pluginApiRange: ">=2026.3.22",
          minGatewayVersion: "2026.3.0",
        },
      },
    });
    fetchClawHubPackageArtifactMock.mockImplementation((params) =>
      fetchClawHubPackageVersionMock(params),
    );
    fetchClawHubPackageSecurityMock.mockImplementation(
      (params: { name?: string; version?: string }) =>
        Promise.resolve({
          package: {
            name: params.name ?? "demo",
            displayName: "Demo",
            family: "code-plugin",
          },
          release: {
            version: params.version ?? "2026.3.22",
          },
          overview: "No security analysis has been recorded yet.",
          securityAuditUrl: `https://clawhub.ai/plugins/${params.name ?? "demo"}/security-audit?version=${params.version ?? "2026.3.22"}`,
          trust: {
            scanStatus: "clean",
            moderationState: null,
            blockedFromDownload: false,
            reasons: [],
            pending: false,
            stale: false,
          },
        }),
    );
    downloadClawHubPackageArchiveMock.mockResolvedValue({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      integrity: DEMO_ARCHIVE_INTEGRITY,
      cleanup: archiveCleanupMock,
    });
    archiveCleanupMock.mockResolvedValue(undefined);
    resolveCompatibilityHostVersionMock.mockReturnValue("2026.3.22");
    installPluginFromArchiveMock.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/openclaw/plugins/demo",
      version: "2026.3.22",
    });
  });
}
