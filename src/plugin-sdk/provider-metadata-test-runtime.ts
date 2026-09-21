import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata.test-support.js";
import * as jitiFactory from "../plugins/jiti-factory.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";

/** Supplies real manifest facts without cold runtime discovery in provider tests. */
export function useProviderCatalogMetadata(pluginRoot: URL, ...additionalPluginRoots: URL[]): void {
  const plugins = [pluginRoot, ...additionalPluginRoots].map((root) => {
    const loaded = loadPluginManifest(fileURLToPath(root));
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    return loaded.manifest;
  });
  const snapshot = createPluginMetadataSnapshotFixture({ plugins });
  beforeEach(() => {
    setCurrentPluginMetadataSnapshot(snapshot);
    const loader = vi.spyOn(jitiFactory, "createJiti").mockImplementation(() => {
      throw new Error("Provider catalog tests must use prepared metadata without Jiti");
    });
    return () => loader.mockRestore();
  });
  afterEach(() => setCurrentPluginMetadataSnapshot(undefined));
}
