import { isDeepStrictEqual } from "node:util";
import type { ConfigFileSnapshot } from "./types.js";

/** Compare authored revisions and env-resolved inputs, never runtime defaults. */
export function describeConfigSnapshotInputChange(
  before: ConfigFileSnapshot,
  after: ConfigFileSnapshot,
  options: { allowPathChange?: boolean; compareResolvedConfig?: boolean } = {},
): string | undefined {
  if (!options.allowPathChange && before.path !== after.path) {
    return "config file path changed";
  }
  if (before.exists !== after.exists) {
    return "config file was created or removed";
  }
  if ((before.hash ?? before.raw) !== (after.hash ?? after.raw)) {
    return before.raw !== after.raw
      ? "authored config file contents changed"
      : "included config contents or targets changed";
  }
  // The revision excludes env substitutions, which can change migration destinations.
  if (
    options.compareResolvedConfig !== false &&
    !isDeepStrictEqual(before.sourceConfig, after.sourceConfig)
  ) {
    return "resolved config values changed";
  }
  return undefined;
}
