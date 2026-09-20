import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { InlineConfig } from "vite";
import type { ControlUiBuildInfo } from "../build-info.ts";

function resolveRepoRoot(): string {
  return path.resolve(import.meta.dirname, "../../..");
}

export const DEFAULT_CONTROL_UI_E2E_BUILD_INFO: ControlUiBuildInfo = {
  version: "2026.7.10",
  commit: "0123456789abcdef0123456789abcdef01234567",
  commitAt: "2026-07-10T11:22:33.000Z",
  builtAt: "2026-07-10T12:34:56.000Z",
  branch: null,
  dirty: false,
  release: false,
  buildId: "e2e",
};

export function createBundledControlUiE2eConfig(
  controlUiViteConfig: (options: { outDir?: string }) => InlineConfig,
  outDir: string,
): InlineConfig {
  const config = controlUiViteConfig({ outDir });
  const uiRoot = path.join(resolveRepoRoot(), "ui");
  return {
    ...config,
    base: "/",
    configFile: false,
    define: {
      ...config.define,
      "globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO": JSON.stringify(
        DEFAULT_CONTROL_UI_E2E_BUILD_INFO,
      ),
    },
    logLevel: "error" as const,
    root: uiRoot,
  };
}

export async function buildProductionControlUiE2e(outDir: string, buildId: string): Promise<void> {
  // Keep the production config outside Vitest, but write directly to the
  // caller-owned output so concurrent E2E builds cannot replace its worker.
  const repoRoot = resolveRepoRoot();
  const uiRoot = path.join(repoRoot, "ui");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    OPENCLAW_CONTROL_UI_BUILD_ID: buildId,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("VITEST")) {
      delete env[key];
    }
  }
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", fileURLToPath(import.meta.url), "--production-build", outDir],
    {
      cwd: uiRoot,
      encoding: "utf8",
      env,
      // Forward build activity while spawnSync waits; retain stderr for failures.
      stdio: ["ignore", "inherit", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Production Control UI build failed (exit ${result.status ?? "unknown"}):\n${result.stderr || result.error?.message || "See streamed build output above."}`,
    );
  }
}

async function runProductionControlUiBuild(outDir: string): Promise<void> {
  const [{ build }, { default: controlUiViteConfig }] = await Promise.all([
    import("vite"),
    import("../../vite.config.ts"),
  ]);
  await build({
    ...controlUiViteConfig({ outDir }),
    configFile: false,
    logLevel: "info",
    root: path.join(resolveRepoRoot(), "ui"),
  });
}

export async function buildBundledControlUiE2e(outDir: string): Promise<void> {
  const [{ build }, { default: controlUiViteConfig }] = await Promise.all([
    import("vite"),
    import("../../vite.config.ts"),
  ]);
  await build({
    ...createBundledControlUiE2eConfig(controlUiViteConfig, outDir),
    logLevel: "info",
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, outDir] = process.argv.slice(2);
  if (!outDir || (command !== "--production-build" && command !== "--bundle-build")) {
    throw new Error("Usage: control-ui-e2e-build.ts <--production-build|--bundle-build> <out-dir>");
  }
  if (command === "--bundle-build") {
    await buildBundledControlUiE2e(path.resolve(outDir));
  } else {
    await runProductionControlUiBuild(outDir);
  }
}
